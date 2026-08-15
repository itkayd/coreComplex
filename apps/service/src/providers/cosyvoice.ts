/**
 * CosyVoice adapter — the ONLY place that knows how CosyVoice speaks.
 *
 * Verified against the upstream runtime (github.com/QwenAudio/CosyVoice,
 * `runtime/python/fastapi/server.py`):
 *
 *   POST /inference_sft   multipart form: tts_text, spk_id
 *   → StreamingResponse of HEADERLESS little-endian PCM int16, mono
 *     (`(tts_speech.numpy() * 2**15).astype(np.int16).tobytes()`)
 *
 * The server is launched locally with `--model_dir` and `--port`; its client
 * reference decodes at 22 050 Hz (`prompt_sr, target_sr = 16000, 22050`), which
 * is why the sample rate is configuration rather than a guess baked into code.
 *
 * Everything CosyVoice-shaped stops here. The rest of the service — and the
 * whole kernel — sees only `SyntheticSpeechProvider`, so swapping in MeloTTS or
 * Piper means writing another adapter and changing no learning code.
 */
import {
  SynthesisError,
  syntheticProvenance,
  type SynthesisRequest,
  type SyntheticSpeechProvider,
  type SyntheticSpeechResult,
} from "@dyr/senses";
import { COSYVOICE_PCM, pcm16DurationMs, pcm16ToWav } from "../audio/wav.ts";

/** Bumping this invalidates every cached clip produced by an older adapter. */
export const COSYVOICE_ADAPTER_VERSION = "dyr-cosyvoice-adapter@1.0.0";

export interface CosyVoiceOptions {
  baseUrl: string;
  modelVersion: string;
  defaultVoice: string;
  sampleRate: number;
  maxTextLength: number;
  requestTimeoutMs: number;
  now?: () => number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Raw synthesis output, before caching/transcoding decisions are made. */
export interface RawSynthesis {
  wav: Uint8Array;
  durationMs: number;
  sampleRate: number;
}

export class CosyVoiceProvider implements SyntheticSpeechProvider {
  readonly providerId = "cosyvoice";
  readonly modelVersion: string;
  readonly providerVersion = COSYVOICE_ADAPTER_VERSION;
  private readonly opts: CosyVoiceOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(opts: CosyVoiceOptions) {
    this.opts = opts;
    this.modelVersion = opts.modelVersion;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
  }

  /** Cheap reachability probe so callers can degrade before a long request. */
  async available(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      // The FastAPI app exposes no health route, so any answered request — even
      // a 404/422 — proves the server is up and listening.
      const res = await this.fetchImpl(`${this.opts.baseUrl}/docs`, { signal: controller.signal });
      clearTimeout(timer);
      return res.status < 500 || res.status === 500;
    } catch {
      return false;
    }
  }

  /** Call CosyVoice and frame its headerless PCM into a playable WAV. */
  async synthesiseRaw(request: SynthesisRequest): Promise<RawSynthesis> {
    const text = request.text.trim();
    if (text.length === 0) throw new SynthesisError("invalid_request", "text is empty");
    if (text.length > this.opts.maxTextLength) {
      throw new SynthesisError("text_too_long", `text exceeds ${this.opts.maxTextLength} characters`);
    }
    if (request.language !== "zh-CN") {
      throw new SynthesisError("unsupported_language", `unsupported language: ${request.language}`);
    }

    const form = new FormData();
    form.set("tts_text", text);
    form.set("spk_id", request.voice ?? this.opts.defaultVoice);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.opts.baseUrl}/inference_sft`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
    } catch (cause) {
      throw new SynthesisError(
        "speech_service_unavailable",
        `cannot reach CosyVoice at ${this.opts.baseUrl}: ${(cause as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new SynthesisError("synthesis_failed", `CosyVoice returned HTTP ${response.status}`);
    }

    const pcm = new Uint8Array(await response.arrayBuffer());
    if (pcm.length === 0) throw new SynthesisError("synthesis_failed", "CosyVoice returned no audio");

    return {
      wav: pcm16ToWav(pcm, { ...COSYVOICE_PCM, sampleRate: this.opts.sampleRate }),
      durationMs: pcm16DurationMs(pcm, this.opts.sampleRate),
      sampleRate: this.opts.sampleRate,
    };
  }

  /**
   * Interface-level synthesis. Returns WAV bytes with synthetic provenance; the
   * service layer owns caching and optional OGG/Opus transcoding.
   */
  async synthesise(request: SynthesisRequest): Promise<SyntheticSpeechResult> {
    const raw = await this.synthesiseRaw(request);
    return {
      // The service replaces this with the cache's content address.
      audioId: "",
      mimeType: "audio/wav",
      durationMs: raw.durationMs,
      audio: raw.wav,
      cached: false,
      speedApplied: false,
      provenance: syntheticProvenance({
        provider: this.providerId,
        modelVersion: this.modelVersion,
        providerVersion: this.providerVersion,
        generatedAt: this.now(),
      }),
    };
  }
}
