/**
 * Synthetic speech provider contract (spec p.21 SYNTHETIC FALLBACK).
 *
 *   "MeloTTS or another locally licensed model may read novel text when no human
 *    clip exists. Mark it as synthetic in the UI and manifest. It cannot satisfy
 *    the canonical-audio prerequisite for listening or pronunciation
 *    progression."
 *
 * This is an INTERFACE ONLY. A concrete engine (CosyVoice, MeloTTS, Piper, …)
 * lives behind it in the service layer so the kernel depends on the contract and
 * never on an implementation (Dependency CI, spec p.23).
 *
 * The single most important property here is a NEGATIVE one: nothing produced
 * through this interface can ever be canonical. `sourceType` is the literal
 * `"synthetic"` — not a boolean that a caller could flip, and not optional — so
 * a synthetic result cannot be constructed that claims to be a human recording.
 * The canonical gate (`passesCanonicalAudioGate`) requires `humanRecorded`, and
 * the content layer additionally refuses any asset flagged synthetic.
 */

export type SpeechSourceType = "human" | "synthetic";

/** Provenance stamped onto every generated asset. Synthetic is not negotiable. */
export interface SyntheticProvenance {
  readonly sourceType: "synthetic";
  /** Stable engine id, e.g. "cosyvoice". */
  readonly provider: string;
  /** Exact model identity, e.g. "FunAudioLLM/Fun-CosyVoice3-0.5B-2512". */
  readonly modelVersion: string;
  /** Adapter version, so a provider change invalidates cached output. */
  readonly providerVersion: string;
  /** When the clip was generated (epoch millis). */
  readonly generatedAt: number;
}

export interface SynthesisRequest {
  text: string;
  language: "zh-CN";
  /** Engine voice / speaker id. */
  voice?: string;
  /** Playback rate baked into the audio, 0.5–2.0. */
  speed?: number;
}

export interface SyntheticSpeechResult {
  /** Opaque content-addressed id. Never a filesystem path (privacy + safety). */
  audioId: string;
  mimeType: string;
  durationMs?: number;
  /** Bytes are optional: a service may return only an id the client can fetch. */
  audio?: Uint8Array;
  /** True when the clip came from cache rather than fresh synthesis. */
  cached: boolean;
  /** Whether the requested speed was baked into the audio (see service docs). */
  speedApplied: boolean;
  provenance: SyntheticProvenance;
}

export interface SyntheticSpeechProvider {
  readonly providerId: string;
  readonly modelVersion: string;
  readonly providerVersion: string;
  /** True when the engine is reachable right now (offline-aware callers). */
  available(): Promise<boolean>;
  synthesise(request: SynthesisRequest): Promise<SyntheticSpeechResult>;
}

/** Typed failure so callers can degrade gracefully instead of crashing a session. */
export type SynthesisErrorCode =
  | "speech_service_unavailable"
  | "synthesis_failed"
  | "text_too_long"
  | "unsupported_language"
  | "invalid_request";

export class SynthesisError extends Error {
  readonly code: SynthesisErrorCode;
  constructor(code: SynthesisErrorCode, message: string) {
    super(message);
    this.name = "SynthesisError";
    this.code = code;
  }
}

/** Build provenance for a generated clip. Always synthetic, by construction. */
export function syntheticProvenance(input: {
  provider: string;
  modelVersion: string;
  providerVersion: string;
  generatedAt: number;
}): SyntheticProvenance {
  return { sourceType: "synthetic", ...input };
}

/**
 * The guard the rest of the system relies on: synthetic audio can never satisfy
 * a canonical-audio requirement, no matter how good it sounds. Kept here beside
 * the contract so the rule travels with the interface it constrains.
 */
export function canSatisfyCanonicalAudio(provenance: { sourceType: SpeechSourceType }): boolean {
  return provenance.sourceType === "human";
}
