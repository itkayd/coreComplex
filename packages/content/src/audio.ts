/**
 * Audio asset declaration, provisioning and QA (spec p.21 "Human voices are the
 * reference; automation reports confidence"; p.7 AUDIO RULE).
 *
 * Human-recorded Standard Mandarin is canonical and CANNOT be fabricated. A
 * released pack therefore DECLARES the audio each lexeme needs and records the
 * provisioning state of that recording. Only a `verified` clip — human-recorded,
 * transcript- and segmentation-checked, clean, natural pace, licence and consent
 * clear — may satisfy the canonical-audio gate.
 *
 * Until a clip is provisioned the asset gate blocks audio-primary tasks with
 * `missing_canonical_audio` (see @dyr/kernel checkTaskAssets). That is the
 * correct, honest behaviour: the kernel refuses to teach listening from audio
 * that does not exist rather than silently substituting something else.
 *
 * Synthetic speech may exist only as a clearly-labelled fallback and can never
 * satisfy this gate (spec p.21 SYNTHETIC FALLBACK).
 */
import type { SourceAsset } from "./index.ts";

export type AudioProvisionState =
  /** The pack knows it needs this clip; no recording is present yet. */
  | "declared"
  /** A recording is present but has not passed the canonical-audio QA gate. */
  | "unverified"
  /** Human-recorded and QA-passed — the only state that satisfies the gate. */
  | "verified"
  /** Present but rejected by QA (clipping, noise, wrong transcript, ...). */
  | "rejected";

/** Approved upstream families for human zh-CN audio (spec p.22, p.32). */
export type AudioUpstream = "common-voice-zh-CN" | "thchs-30" | "wikimedia-commons" | "tatoeba" | "original-recording";

/**
 * Where a recording actually came from.
 *
 * Recorded verbatim rather than collapsed to a default: a Common Voice clip that
 * emerges from the pipeline labelled `original-recording` is a provenance lie,
 * and provenance is the thing the licence gate depends on. `upstream` is the
 * coarse approved-family classification and may be absent when the source is
 * legitimate but outside the known families; `sourceName` is never absent.
 */
export interface AudioProvenance {
  /** Free-form origin exactly as the supplier declared it. */
  sourceName: string;
  /** Approved-family classification, when the source maps onto one. */
  upstream?: AudioUpstream;
  upstreamId?: string;
  upstreamUrl?: string;
  licenseSpdx: string;
  licenseUrl?: string;
  attributionText?: string;
  speaker?: string;
  region?: string;
  language?: string;
  /** sha256 of the bytes AS SUPPLIED, before any normalisation. */
  sourceSha256: string;
  /**
   * Marks a development/test recording. A flagged asset can never enter a
   * production pack — `buildCore60Pack` refuses it unless the caller explicitly
   * opts in, which only the fixture builder does.
   */
  fixture?: boolean;
}

/**
 * The immutable, content-addressed form the runtime actually plays.
 *
 * Content-addressed on purpose: the name carries no lexeme id, so a cached URL
 * cannot leak the answer to a listening task, and identical bytes deduplicate.
 */
export interface AudioRuntimeRef {
  /** Pack-relative path, e.g. `audio/<sha256>.wav`. Never a machine path. */
  path: string;
  /** sha256 of the runtime bytes — verified again before playback. */
  sha256: string;
  bytes: number;
  mediaType: string;
  /** Source hash this was derived from; equal to `sha256` when untransformed. */
  derivedFrom: string;
  /** What was done to the source bytes. */
  transform: "none" | "normalised" | "transcoded";
}

/** The human review that promoted a recording to canonical, bound to its bytes. */
export interface AudioReviewRef {
  /** The exact bytes reviewed. A different hash means this review does not apply. */
  audioSha256: string;
  reviewedBy: string;
  reviewedAt: string;
  notes?: string;
}

export interface AudioAsset {
  id: string;
  lexeme: string;
  /** Expected transcript — used by the QA transcript check. */
  transcript: string;
  state: AudioProvisionState;
  upstream?: AudioUpstream;
  upstreamId?: string;
  licenseSpdx?: string;
  speaker?: string;
  region?: string;
  /** sha256 of the audio bytes; present only once a clip exists. */
  sha256?: string;
  durationMs?: number;
  /** Set when the clip is synthetic — can never satisfy the canonical gate. */
  synthetic?: boolean;
  /** Full origin record, preserved from candidate through to release. */
  provenance?: AudioProvenance;
  /** How the runtime locates and verifies the bytes. */
  runtime?: AudioRuntimeRef;
  /** The hash-bound human review, present only on a verified asset. */
  review?: AudioReviewRef;
}

/** Declare the audio a lexeme needs, with no recording provisioned yet. */
export function declareAudio(lexeme: string, transcript: string): AudioAsset {
  return { id: `audio:${lexeme}`, lexeme, transcript, state: "declared" };
}

/**
 * Map a declared source name onto an approved upstream family.
 *
 * Returns `undefined` rather than guessing. An unrecognised source is not an
 * error — it is simply not classified, and `sourceName` still records the truth.
 */
export function classifyUpstream(sourceName: string): AudioUpstream | undefined {
  const s = sourceName.toLowerCase();
  if (s.includes("common voice") || s.includes("common-voice") || s.includes("commonvoice")) return "common-voice-zh-CN";
  if (s.includes("thchs")) return "thchs-30";
  if (s.includes("wikimedia") || s.includes("wikipedia") || s.includes("commons")) return "wikimedia-commons";
  if (s.includes("tatoeba")) return "tatoeba";
  if (s.includes("original recording") || s.includes("original-recording")) return "original-recording";
  return undefined;
}

export interface AudioQaInput {
  asset: AudioAsset;
  humanRecorded: boolean;
  transcriptMatches: boolean;
  segmentationVerified: boolean;
  /** No clipping / severe noise / music masking / codec damage. */
  clean: boolean;
  /** Natural pace (pitch-preserving 0.75–1.0x playback is a UI concern). */
  naturalPace: boolean;
  licenceAndConsentClear: boolean;
  /**
   * Objective signal screening from `screenAudio()`. When supplied it OVERRIDES
   * the declared `clean` / `naturalPace` claims: those two are measurable, so a
   * measurement outranks an assertion. Without it they remain declarations and
   * the result is marked `unverified` rather than `verified` — an unmeasured
   * clip never reaches canonical.
   */
  screening?: ScreeningSummary;
}

/** The subset of a ScreeningResult the gate needs (see audio-analysis.ts). */
export interface ScreeningSummary {
  passed: boolean;
  failures: string[];
}

export interface AudioQaResult {
  state: AudioProvisionState;
  failures: string[];
  /** True when objective screening ran; false means claims were unmeasured. */
  screened: boolean;
}

/**
 * The canonical-audio QA gate (spec p.21).
 *
 * Two classes of evidence, deliberately kept apart:
 *   - measured (clipping, noise, pace) — supplied via `screening`;
 *   - declared (human-recorded, transcript, segmentation, consent) — no
 *     measurement can establish these, so they stay explicit inputs.
 *
 * A synthetic clip fails outright regardless of technical quality, and a clip
 * that was never screened can only reach `unverified`.
 */
export function runAudioQa(input: AudioQaInput): AudioQaResult {
  const failures: string[] = [];
  if (input.asset.synthetic) failures.push("synthetic_cannot_be_canonical");
  if (!input.humanRecorded) failures.push("not_human_recorded");
  if (!input.transcriptMatches) failures.push("transcript_mismatch");
  if (!input.segmentationVerified) failures.push("segmentation_unverified");
  if (!input.licenceAndConsentClear) failures.push("licence_or_consent");
  if (!input.asset.sha256) failures.push("no_audio_bytes");

  if (input.screening) {
    // Measurement outranks assertion for the objective properties.
    for (const f of input.screening.failures) failures.push(`signal:${f}`);
  } else {
    if (!input.clean) failures.push("audio_quality");
    if (!input.naturalPace) failures.push("unnatural_pace");
  }

  if (failures.length > 0) return { state: "rejected", failures, screened: Boolean(input.screening) };
  // Passing declarations without measurement is not enough for canonical.
  if (!input.screening) return { state: "unverified", failures: ["not_screened"], screened: false };
  return { state: "verified", failures: [], screened: true };
}

/** Only a verified, non-synthetic clip counts as canonical (spec p.6 gate 5). */
export function isCanonical(asset: AudioAsset | undefined): boolean {
  return asset !== undefined && asset.state === "verified" && asset.synthetic !== true;
}

/**
 * How to provision the declared clips.
 *
 * Acquiring the recordings stays a human step: each source has its own terms to
 * accept and its own attribution obligations, and the spec forbids an asset
 * entering a released pack while provenance or licence is ambiguous (p.31
 * PROHIBITED). Everything after acquisition is executed by the commands below.
 */
export const AUDIO_PROVISIONING_GUIDE = `
Provisioning canonical Mandarin audio for a released pack
=========================================================
1. Choose an approved upstream (spec p.22) and accept its terms:
   - Common Voice zh-CN (CC0 + conditions)  https://commonvoice.mozilla.org
   - THCHS-30 (Apache-2.0)                  https://openslr.org/18
   - Wikimedia Commons (per-asset allowlist)
   - Original recordings with a signed consent record
2. For each lexeme, obtain a clip of that word in Standard Mandarin and convert
   it to PCM WAV:
     ffmpeg -i clip.ogg -ac 1 -ar 16000 -sample_fmt s16 files/<lexemeId>.wav
3. Describe the batch and every recording in sources/inbox/audio/
   (manifest.json + candidates.json). The AUDIO licence belongs to the recording
   and is never inherited from a sentence or from the batch manifest.
     npm run content:import:audio     licence, hash and signal screening
4. Review what the machine cannot judge — human-recorded, transcript matches,
   segmentation verified, licence and consent clear:
     npm run content:audio:review -- --emit-templates
   Fill the templates in and merge them into sources/review/audio/reviews.json.
   Each review is bound to the recording's sha256: re-record the clip and the
   review no longer applies.
5. Certify. Only a 'verified' result may ship:
     npm run content:audio:certify
6. Rebuild. The content hash and pack version change, because canonical audio is
   part of pack identity and a released pack is immutable (spec p.15).
     npm run build:web
Until a lexeme has a certified recording, the kernel correctly refuses
audio-primary tasks for it with missing_canonical_audio.
`.trim();
