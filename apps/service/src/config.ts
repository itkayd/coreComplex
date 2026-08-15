/**
 * Self-hosted service configuration.
 *
 * Everything is local and free by construction: the only external process is a
 * CosyVoice server the user runs on their own hardware. There is no API key,
 * no account and no metered endpoint anywhere in this file — see
 * `assertNoPaidDependencies()` for the check that keeps it that way.
 */
import { resolve } from "node:path";

export interface ServiceConfig {
  /** Port this service listens on. */
  port: number;
  /** Base URL of the locally-run CosyVoice FastAPI server (never a cloud host). */
  cosyvoiceUrl: string;
  /**
   * Model identity, recorded in provenance and mixed into every cache key so a
   * model change can never silently reuse old audio.
   */
  modelVersion: string;
  /** Local directory holding model weights — never committed to git. */
  modelDir: string;
  /** Where generated audio is cached on disk. */
  cacheDir: string;
  /** Default Mandarin speaker id passed to CosyVoice's /inference_sft. */
  defaultVoice: string;
  /** Preferred delivery format; falls back to WAV when ffmpeg is unavailable. */
  outputFormat: "ogg" | "wav";
  /** Sample rate CosyVoice emits (raw PCM has no header to tell us). */
  sampleRate: number;
  /** Longest text accepted, to bound synthesis cost and stored private text. */
  maxTextLength: number;
  /** Optional ffmpeg binary for OGG/Opus encoding and speed baking. */
  ffmpegPath?: string;
  /** Milliseconds before a synthesis request is abandoned. */
  requestTimeoutMs: number;
  /** Origins allowed to call this service (the local PWA, dev and preview). */
  allowedOrigins: string[];
}

const env = (key: string, fallback: string): string => process.env[key] ?? fallback;

export function loadConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  const config: ServiceConfig = {
    port: Number(env("DYR_SERVICE_PORT", "8730")),
    // Localhost by default. A cloud endpoint is never hardcoded anywhere.
    cosyvoiceUrl: env("DYR_COSYVOICE_URL", "http://127.0.0.1:50000"),
    modelVersion: env("DYR_COSYVOICE_MODEL", "FunAudioLLM/Fun-CosyVoice3-0.5B-2512"),
    modelDir: resolve(env("DYR_COSYVOICE_MODEL_DIR", "./models/cosyvoice")),
    cacheDir: resolve(env("DYR_SPEECH_CACHE_DIR", "./.cache/speech")),
    defaultVoice: env("DYR_COSYVOICE_VOICE", "中文女"),
    outputFormat: (env("DYR_SPEECH_FORMAT", "ogg") === "wav" ? "wav" : "ogg"),
    sampleRate: Number(env("DYR_COSYVOICE_SAMPLE_RATE", "22050")),
    maxTextLength: Number(env("DYR_SPEECH_MAX_TEXT", "500")),
    ffmpegPath: process.env.DYR_FFMPEG_PATH,
    requestTimeoutMs: Number(env("DYR_SPEECH_TIMEOUT_MS", "120000")),
    allowedOrigins: env("DYR_ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173")
      .split(",").map((o) => o.trim()).filter(Boolean),
    ...overrides,
  };
  assertNoPaidDependencies(config);
  return config;
}

/** Hostnames that would imply a metered, account-based speech service. */
const PAID_SPEECH_HOSTS = [
  "googleapis.com",
  "cognitiveservices.azure.com",
  "api.openai.com",
  "api.elevenlabs.io",
  "polly.amazonaws.com",
  "speech.platform.bing.com",
  "api.play.ht",
  "api.deepgram.com",
  "api.assemblyai.com",
];

/**
 * Fail loudly if the speech endpoint has been pointed at a paid SaaS. The whole
 * point of this integration is that it runs free on the user's own hardware, so
 * a misconfiguration should stop the service rather than start billing someone.
 */
export function assertNoPaidDependencies(config: Pick<ServiceConfig, "cosyvoiceUrl">): void {
  let host: string;
  try {
    host = new URL(config.cosyvoiceUrl).hostname.toLowerCase();
  } catch {
    throw new Error(`invalid DYR_COSYVOICE_URL: ${config.cosyvoiceUrl}`);
  }
  for (const paid of PAID_SPEECH_HOSTS) {
    if (host === paid || host.endsWith(`.${paid}`)) {
      throw new Error(
        `refusing to start: ${host} is a paid speech service. Dyr's speech stack is self-hosted and free; point DYR_COSYVOICE_URL at a local CosyVoice server.`,
      );
    }
  }
}

export const PAID_HOSTS_FOR_TEST = PAID_SPEECH_HOSTS;
