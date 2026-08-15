/**
 * TaskRubric — exercises are evidence instruments, not cue+answer pairs
 * (ADR-0004, spec Correction 5, p.22 "Exercises are evidence instruments").
 *
 * A rubric is versioned; the version used is stored on accepted evidence. The
 * learner-facing TaskContract references a rubric by id+version; private answers
 * never travel in the contract (no answer leakage, spec p.5/p.18).
 */
import type { Skill } from "./skills.ts";

export type MatchPolicy = "exact" | "normalised" | "semantic_variants";

/** How much hints / reveals / replays erode evidence strength. */
export interface LeakagePolicy {
  /** Multiplier applied per hint (e.g. 0.7). */
  hintPenalty: number;
  /** Revealing the answer/transcript forbids a passing grade. */
  revealForbidsPass: boolean;
  /** Free audio replays before strength erodes (listening). */
  freeAudioReplays: number;
  audioReplayPenalty: number;
}

/** Components a production task keeps separate — never one opaque number. */
export type SpeechComponent =
  | "transcript"
  | "initials_finals"
  | "tone"
  | "rhythm"
  | "fluency";

export type RubricKind =
  | "receptive_exact" // hanzi_to_meaning, meaning_to_typed_word
  | "receptive_audio" // audio_to_meaning, micro_dictation
  | "production_speech" // meaning_to_speech, echo_shadow
  | "production_writing"; // handwriting, composition

export interface TaskRubric {
  rubricId: string;
  rubricVersion: string;
  kind: RubricKind;
  skill: Skill;
  matchPolicy: MatchPolicy;
  /** Expected response time band in ms; outside the upper bound reads as struggle. */
  latencyBandMs: { fast: number; expected: number };
  leakage: LeakagePolicy;
  /** Production only: which components must be reported separately. */
  speechComponents?: SpeechComponent[];
  /** Production only: below this automation confidence, defer to self-grade. */
  automationConfidenceFloor?: number;
  /** Writing only: distinguishes typed retrieval from handwriting; copy != recall. */
  writingContext?: "typed" | "handwriting";
  /** True when a canonical human recording is mandatory for this rubric. */
  requiresCanonicalAudio: boolean;
}

export const DEFAULT_LEAKAGE: LeakagePolicy = {
  hintPenalty: 0.7,
  revealForbidsPass: true,
  freeAudioReplays: 1,
  audioReplayPenalty: 0.85,
};
