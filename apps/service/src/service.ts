/**
 * Self-hosted speech service.
 *
 *   apps/web → apps/service → SyntheticSpeechProvider → CosyVoice
 *
 * The PWA talks only to this service; it never reaches CosyVoice directly and
 * never learns a filesystem path. Audio is addressed by content hash.
 *
 * Routes:
 *   POST /speech/synthesise      { text, language, voice?, speed? } → descriptor
 *   GET  /speech/audio/:audioId  cached bytes
 *   GET  /speech/health          engine reachability + configuration identity
 *
 * Cache-first by design: a clip that already exists is served without touching
 * CosyVoice, which is exactly what makes previously-generated speech work when
 * the engine (or the whole machine) is offline.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import {
  SynthesisError,
  type SynthesisRequest,
  type SyntheticSpeechProvider,
} from "@dyr/senses";
import { SpeechCache, cacheKey, normaliseText, type CacheEntryMeta } from "./cache.ts";
import { transcode } from "./audio/transcode.ts";
import type { ServiceConfig } from "./config.ts";

export interface SynthesiseResponse {
  audioId: string;
  /** Service-relative URL the PWA can play. Never a filesystem path. */
  url: string;
  mimeType: string;
  durationMs?: number;
  cached: boolean;
  speedApplied: boolean;
  provenance: CacheEntryMeta["provenance"];
}

export interface SpeechServiceDeps {
  config: ServiceConfig;
  provider: SyntheticSpeechProvider;
  cache: SpeechCache;
  now?: () => number;
}

export class SpeechService {
  private readonly deps: SpeechServiceDeps;
  private readonly now: () => number;

  constructor(deps: SpeechServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** Content address for a request under the current provider/model/format. */
  keyFor(request: Required<Pick<SynthesisRequest, "text" | "language">> & { voice: string; speed: number }): string {
    const { config, provider } = this.deps;
    return cacheKey({
      text: request.text,
      language: request.language,
      voice: request.voice,
      speed: request.speed,
      provider: provider.providerId,
      providerVersion: provider.providerVersion,
      modelVersion: provider.modelVersion,
      format: config.outputFormat,
    });
  }

  /**
   * Synthesise (or serve from cache). Throws SynthesisError so callers can
   * degrade gracefully; it never returns audio lacking synthetic provenance.
   */
  async synthesise(input: SynthesisRequest): Promise<SynthesiseResponse> {
    const { config, provider, cache } = this.deps;
    const text = normaliseText(input.text ?? "");
    if (text.length === 0) throw new SynthesisError("invalid_request", "text is required");
    if (input.language !== "zh-CN") throw new SynthesisError("unsupported_language", `unsupported language: ${input.language}`);

    const voice = input.voice ?? config.defaultVoice;
    const speed = clampSpeed(input.speed ?? 1);
    const audioId = this.keyFor({ text, language: input.language, voice, speed });

    // Cache first — this is what keeps generated speech available offline.
    const hit = cache.read(audioId);
    if (hit) {
      return {
        audioId,
        url: `/speech/audio/${audioId}`,
        mimeType: hit.meta.mimeType,
        durationMs: hit.meta.durationMs,
        cached: true,
        speedApplied: hit.meta.speedApplied,
        provenance: hit.meta.provenance,
      };
    }

    const generated = await provider.synthesise({ text, language: input.language, voice, speed });
    if (!generated.audio) throw new SynthesisError("synthesis_failed", "provider returned no audio bytes");

    const converted = await transcode(generated.audio, {
      ffmpegPath: config.ffmpegPath,
      format: config.outputFormat,
      speed,
    });

    const meta = cache.write(
      audioId,
      converted.audio,
      {
        mimeType: converted.mimeType,
        durationMs: generated.durationMs,
        speedApplied: converted.speedApplied,
        // Provenance always says synthetic — it is a literal in the contract.
        provenance: generated.provenance,
      },
      this.now(),
    );

    return {
      audioId,
      url: `/speech/audio/${audioId}`,
      mimeType: meta.mimeType,
      durationMs: meta.durationMs,
      cached: false,
      speedApplied: meta.speedApplied,
      provenance: meta.provenance,
    };
  }

  /** Bytes for a previously generated clip. */
  read(audioId: string): { meta: CacheEntryMeta; audio: Uint8Array } | undefined {
    return this.deps.cache.read(audioId);
  }

  async health(): Promise<{ ok: boolean; engineReachable: boolean; provider: string; modelVersion: string; format: string }> {
    const { provider, config } = this.deps;
    return {
      ok: true,
      engineReachable: await provider.available(),
      provider: provider.providerId,
      modelVersion: provider.modelVersion,
      format: config.outputFormat,
    };
  }
}

export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1;
  return Math.min(2, Math.max(0.5, speed));
}

const ERROR_STATUS: Record<string, number> = {
  speech_service_unavailable: 503,
  synthesis_failed: 502,
  text_too_long: 413,
  unsupported_language: 400,
  invalid_request: 400,
};

/** Wire the service into a plain node:http server (no framework dependency). */
export function createSpeechServer(service: SpeechService, config: ServiceConfig): Server {
  return createServer((req, res) => { void handle(req, res, service, config); });
}

async function handle(req: IncomingMessage, res: ServerResponse, service: SpeechService, config: ServiceConfig): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  // Echo back only an explicitly allow-listed local origin.
  const origin = req.headers.origin;
  if (origin && config.allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

  try {
    if (req.method === "GET" && url.pathname === "/speech/health") {
      return json(res, 200, await service.health());
    }

    if (req.method === "POST" && url.pathname === "/speech/synthesise") {
      const body = await readJson(req);
      const result = await service.synthesise(body as SynthesisRequest);
      return json(res, 200, result);
    }

    if (req.method === "GET" && url.pathname.startsWith("/speech/audio/")) {
      const audioId = url.pathname.slice("/speech/audio/".length);
      if (!SpeechCache.isValidId(audioId)) return json(res, 400, { error: "invalid_audio_id" });
      const hit = service.read(audioId);
      if (!hit) return json(res, 404, { error: "not_found" });
      res.writeHead(200, {
        "content-type": hit.meta.mimeType,
        "content-length": String(hit.audio.length),
        // Content-addressed: safe to cache forever in the browser.
        "cache-control": "public, max-age=31536000, immutable",
        // Make the synthetic origin visible even at the transport layer.
        "x-dyr-source-type": hit.meta.provenance.sourceType,
        "x-dyr-provider": hit.meta.provenance.provider,
        "x-dyr-model-version": hit.meta.provenance.modelVersion,
      });
      res.end(Buffer.from(hit.audio));
      return;
    }

    return json(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof SynthesisError) {
      return json(res, ERROR_STATUS[error.code] ?? 500, { error: error.code, message: error.message });
    }
    return json(res, 500, { error: "internal_error", message: (error as Error).message });
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new SynthesisError("invalid_request", "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SynthesisError("invalid_request", "body must be JSON");
  }
}
