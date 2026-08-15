/**
 * Synthetic speech client.
 *
 *   apps/web → apps/service → SyntheticSpeechProvider → CosyVoice
 *
 * The PWA talks ONLY to the local service. It never contacts CosyVoice, never
 * sees a filesystem path, and never treats generated audio as a pronunciation
 * reference — playback here is a convenience for words that have no canonical
 * human recording (spec p.21 SYNTHETIC FALLBACK).
 *
 * Offline: audio is content-addressed, so once a clip has been played it is
 * stored in the Cache API under its audioId and replays with no network at all.
 * An uncached request while the service is down fails calmly and never blocks a
 * session — the learning task itself does not depend on synthetic audio.
 */

const SPEECH_CACHE = "dyr-speech-v1";

/**
 * Base URL of the local service. Configurable, never a hardcoded cloud host.
 *
 * The default only applies when the app is itself served locally. A build
 * deployed to a real origin has no business reaching for 127.0.0.1: that is the
 * VIEWER's machine, not the developer's, the request is mixed content over
 * HTTPS and would be blocked anyway, and the result would be a button that can
 * only ever fail. Where no service is configured, `SPEECH_AVAILABLE` is false
 * and the control is not rendered at all — better than offering an action the
 * app knows cannot work.
 */
const CONFIGURED_SPEECH_URL = import.meta.env.VITE_DYR_SPEECH_URL as string | undefined;
const servedLocally = typeof location !== "undefined"
  && (location.hostname === "localhost" || location.hostname === "127.0.0.1");

export const SPEECH_SERVICE_URL: string =
  CONFIGURED_SPEECH_URL ?? (servedLocally ? "http://127.0.0.1:8730" : "");

/** Whether a synthetic-speech service is configured for this build at all. */
export const SPEECH_AVAILABLE: boolean = SPEECH_SERVICE_URL.length > 0;

export interface SyntheticClip {
  audioId: string;
  objectUrl: string;
  mimeType: string;
  durationMs?: number;
  fromCache: boolean;
  provenance: {
    sourceType: "synthetic";
    provider: string;
    modelVersion: string;
  };
}

export type SpeechFailure =
  | "service_unavailable"
  | "not_cached_offline"
  | "synthesis_failed"
  | "unsupported";

export class SpeechUnavailable extends Error {
  readonly reason: SpeechFailure;
  constructor(reason: SpeechFailure, message: string) {
    super(message);
    this.name = "SpeechUnavailable";
    this.reason = reason;
  }
}

async function cacheStore(): Promise<Cache | undefined> {
  if (typeof caches === "undefined") return undefined;
  try {
    return await caches.open(SPEECH_CACHE);
  } catch {
    return undefined;
  }
}

/** Stable cache URL for a clip — the audioId is already a content address. */
const clipUrl = (audioId: string): string => `${SPEECH_SERVICE_URL}/speech/audio/${audioId}`;

/**
 * Fetch (or replay) synthetic speech for some Mandarin text.
 *
 * Two round trips by design: the service decides the content address, then the
 * bytes are fetched (or read from the local cache). That keeps the cache keyed
 * by the service's version-aware identity rather than by raw text, so a model or
 * voice change can never replay stale audio.
 */
export async function speak(
  text: string,
  opts: { voice?: string; speed?: number; signal?: AbortSignal } = {},
): Promise<SyntheticClip> {
  let descriptor: {
    audioId: string; url: string; mimeType: string; durationMs?: number;
    provenance: SyntheticClip["provenance"];
  };

  try {
    const res = await fetch(`${SPEECH_SERVICE_URL}/speech/synthesise`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, language: "zh-CN", voice: opts.voice, speed: opts.speed ?? 1 }),
      signal: opts.signal,
    });
    if (res.status === 503) {
      throw new SpeechUnavailable("service_unavailable", "the local speech service is not running");
    }
    if (!res.ok) {
      throw new SpeechUnavailable("synthesis_failed", `speech service returned ${res.status}`);
    }
    descriptor = await res.json();
  } catch (error) {
    if (error instanceof SpeechUnavailable) throw error;
    // Network-level failure: offline, or the service is not started.
    throw new SpeechUnavailable("service_unavailable", "cannot reach the local speech service");
  }

  const store = await cacheStore();
  const url = clipUrl(descriptor.audioId);

  // Content-addressed, so a cache hit is always the right bytes.
  const cached = await store?.match(url);
  if (cached) {
    return {
      audioId: descriptor.audioId,
      objectUrl: URL.createObjectURL(await cached.blob()),
      mimeType: descriptor.mimeType,
      durationMs: descriptor.durationMs,
      fromCache: true,
      provenance: descriptor.provenance,
    };
  }

  const audioRes = await fetch(url, { signal: opts.signal }).catch(() => undefined);
  if (!audioRes?.ok) {
    throw new SpeechUnavailable("not_cached_offline", "this clip has not been generated on this device yet");
  }
  await store?.put(url, audioRes.clone()).catch(() => undefined);

  return {
    audioId: descriptor.audioId,
    objectUrl: URL.createObjectURL(await audioRes.blob()),
    mimeType: descriptor.mimeType,
    durationMs: descriptor.durationMs,
    fromCache: false,
    provenance: descriptor.provenance,
  };
}

/** Whether the local speech service is reachable right now. */
export async function speechServiceReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${SPEECH_SERVICE_URL}/speech/health`, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}
