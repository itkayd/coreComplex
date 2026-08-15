/**
 * Versioned contracts that cross the kernel boundary (spec p.3):
 *   "TaskContracts in; AttemptEnvelopes back; LearningFacts out."
 *
 * The evidence pipeline (p.17) is:
 *   TaskContract -> RawAttempt -> Validators -> AttemptEnvelope
 *   -> policy accepts/rejects/asks -> one SkillTrace update + LearningFact.
 */
import type {
  AttemptId,
  FactId,
  LexemeId,
  PackVersion,
  PlannerVersion,
  TaskId,
  TraceId,
} from "./ids.ts";
import type { Rating, Skill } from "./skills.ts";
import type { Millis } from "./clock.ts";

/** Retrieval task families per skill (spec p.22). */
export const TASK_FAMILIES = {
  listening: ["tone_contrast", "audio_to_meaning", "micro_dictation", "clip_comprehension", "listen_then_act"],
  reading: ["hanzi_to_meaning", "hanzi_to_sound", "sentence_cloze", "segmentation_reorder", "graded_passage"],
  speaking: ["echo_shadow", "substitution", "meaning_to_speech", "timed_reply", "roleplay_picture"],
  writing: ["audio_to_hanzi", "meaning_to_typed_word", "stroke_handwriting", "sentence_construction", "composition_revision"],
} as const satisfies Record<Skill, readonly string[]>;

export type TaskFamily =
  | (typeof TASK_FAMILIES)["listening"][number]
  | (typeof TASK_FAMILIES)["reading"][number]
  | (typeof TASK_FAMILIES)["speaking"][number]
  | (typeof TASK_FAMILIES)["writing"][number];

/**
 * A TaskContract issued by the planner (p.5 CUE: "Issue one versioned
 * TaskContract without leaking the answer"). It names the target trace and
 * the rubric, but never carries the answer the learner must produce.
 */
export interface TaskContract {
  id: TaskId;
  targetTrace: TraceId;
  lexeme: LexemeId;
  skill: Skill;
  family: TaskFamily;
  /** The cue shown to the learner (e.g. an audio clip id or a hanzi prompt). */
  cue: string;
  /** Reference to the versioned rubric this task is graded by (ADR-0004). */
  rubricId: string;
  rubricVersion: string;
  /** Asset ids this exact task needs (validated at plan time, ADR/Correction 7). */
  assetRefs: string[];
  /** Whether a canonical human recording backs this task (p.7 AUDIO RULE). */
  requiresHumanAudio: boolean;
  /** Estimated time to attempt, in seconds — used by the workload governor. */
  estSeconds: number;
  /** True for a task introducing a not-yet-seen atom (novelty ceiling, p.18). */
  isNovel: boolean;
  /** True when this task fulfils a RepairDirective for its target (ADR-0003). */
  isRepair: boolean;
  plannerVersion: PlannerVersion;
  packVersion: PackVersion;
}

/** The learner's raw attempt (p.17): answer, latency, hints, replay, device. */
export interface RawAttempt {
  taskId: TaskId;
  targetTrace: TraceId;
  /** Machine-comparable answer token or transcript. */
  answer: string;
  latencyMs: number;
  /** Number of hints consumed — reduces evidence strength (p.15, p.17). */
  hintsUsed: number;
  /** Whether the answer/transcript was revealed before responding. */
  answerRevealed: boolean;
  /** Whether audio was replayed before answering (listening tasks). */
  audioReplays: number;
  /** For self-graded production tasks, the learner's own rating. */
  selfGrade?: Rating;
}

export type Confidence = "high" | "medium" | "low";

export interface ReasonCode {
  code: string;
  detail: string;
}

/**
 * AttemptEnvelope (p.17 step 04): "rating proposal + confidence + reason
 * codes". Validators (exact match, ASR, alignment, pitch, stroke or
 * self-grade) produce this; the accept policy consumes it.
 */
export interface AttemptEnvelope {
  attemptId: AttemptId;
  taskId: TaskId;
  targetTrace: TraceId;
  ratingProposal: Rating;
  confidence: Confidence;
  reasonCodes: ReasonCode[];
  /** 0..1 quality of this evidence after penalties (hints, replays, reveal). */
  evidenceStrength: number;
  /** True when direct retrieval occurred (no reveal). Passive != mastery. */
  directRetrieval: boolean;
}

/** The accept policy's decision (p.17 step 05). */
export type AcceptDecision = "update" | "reject" | "ask_self_grade";

/**
 * LearningFact (p.5 FACT, p.3 ONE-WAY FACTS): the immutable value published
 * outward for projections and layers. Layers read facts; a fact never lets a
 * layer write memory back (Rule 4, one-way).
 */
export interface LearningFact {
  id: FactId;
  trace: TraceId;
  lexeme: LexemeId;
  skill: Skill;
  ratingApplied: Rating;
  stabilityAfter: number;
  difficultyAfter: number;
  retrievabilityAtReview: number;
  dueAfter: Millis;
  occurredAt: Millis;
  /** localSequence of the TraceUpdated event this fact summarises. */
  sourceSequence: number;
}
