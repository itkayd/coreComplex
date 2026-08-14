/**
 * @dyr/senses — replaceable provider interfaces for speech, audio and
 * handwriting (spec p.21, p.23, p.25).
 *
 *   "Human voices are the reference; automation reports confidence."
 *
 * These are INTERFACES only. Concrete providers (Silero VAD, whisper.cpp, MFA
 * alignment, pitch extraction, MeloTTS fallback) live behind them so the kernel
 * depends on the contract, never an implementation (Dependency CI, p.23). A
 * synthetic-speech provider must always self-label as a fallback and can never
 * satisfy the canonical-audio prerequisite (CANONICAL AUDIO GATE, p.21).
 */

/** Result of scoring a spoken attempt. Low confidence must fall back to self-grade (p.21). */
export interface SpeechScore {
  transcript: string;
  /** Component scores kept separate (initials/finals, tone, rhythm) — p.21. */
  components: { initialsFinals: number; tone: number; rhythm: number };
  /** Overall automation confidence in [0,1]; below the kernel floor => self-grade. */
  confidence: number;
}

export interface SpeechProvider {
  readonly name: string;
  /** True only for human-recorded canonical audio, never synthetic (p.6, p.21). */
  readonly canonical: boolean;
  score(audio: ArrayBuffer, referenceTranscript: string): Promise<SpeechScore>;
}

/** Text-to-speech provider. Synthetic output is always labelled fallback. */
export interface TtsProvider {
  readonly name: string;
  readonly synthetic: boolean; // must be true for MeloTTS-style fallback
  speak(text: string): Promise<ArrayBuffer>;
}

/** Handwriting recognition provider (writing skill; kept separate from typing). */
export interface HandwritingProvider {
  readonly name: string;
  recognise(strokes: number[][]): Promise<{ hanzi: string; confidence: number }>;
}

/**
 * CANONICAL AUDIO GATE (p.21): an asset may back listening/pronunciation
 * progression only if it is human-recorded Standard Mandarin, transcript- and
 * segmentation-verified, clean, at natural pace, and licence/consent-clear.
 * Synthetic speech never passes this gate.
 */
export interface CanonicalAudioCheck {
  humanRecorded: boolean;
  transcriptVerified: boolean;
  segmentationVerified: boolean;
  clean: boolean; // no clipping / severe noise / music masking / codec damage
  naturalPace: boolean;
  licenceAndConsentClear: boolean;
}

export function passesCanonicalAudioGate(c: CanonicalAudioCheck): boolean {
  return (
    c.humanRecorded &&
    c.transcriptVerified &&
    c.segmentationVerified &&
    c.clean &&
    c.naturalPace &&
    c.licenceAndConsentClear
  );
}
