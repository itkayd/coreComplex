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
export type AudioUpstream = "common-voice-zh-CN" | "thchs-30" | "wikimedia-commons" | "original-recording";

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
}

/** Declare the audio a lexeme needs, with no recording provisioned yet. */
export function declareAudio(lexeme: string, transcript: string): AudioAsset {
  return { id: `audio:${lexeme}`, lexeme, transcript, state: "declared" };
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
 * How to provision the declared clips. Documented rather than executed: each
 * source has its own terms to accept and its own attribution obligations, and
 * the spec forbids an asset entering a released pack while provenance or licence
 * is ambiguous (spec p.31 PROHIBITED).
 */
export const AUDIO_PROVISIONING_GUIDE = `
Provisioning canonical Mandarin audio for a released pack
=========================================================
1. Choose an approved upstream (spec p.22):
   - Common Voice zh-CN (CC0 + conditions)  https://commonvoice.mozilla.org
   - THCHS-30 (Apache-2.0)                  https://openslr.org/18
   - Wikimedia Commons (per-asset allowlist)
   - Original recordings with a signed consent record
2. For each declared AudioAsset, locate a clip whose transcript equals the
   lexeme's transcript field, spoken in Standard Mandarin.
3. Record upstream id, licence SPDX, speaker and region into the AudioAsset.
4. Compute sha256 over the audio bytes and store it.
5. Run runAudioQa(). Only a 'verified' result may ship.
6. Rebuild the pack: the content hash and pack version change, because a
   released pack is immutable (spec p.15 VERSION RULE).
Until then the kernel correctly refuses audio-primary tasks for that lexeme.
`.trim();
