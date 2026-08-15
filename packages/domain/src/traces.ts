/**
 * SkillTrace — the canonical memory unit (spec p.4, p.14).
 *
 * "One concept, four independent memory traces." Each trace owns its own due
 * date, stability, difficulty and evidence history (p.4). The trace store
 * (p.16) records "stability, difficulty, state, due time and event cursor for
 * one skill direction". A learner can know a word for reading and fail it for
 * speaking; the kernel stores that reality instead of a single mastered flag.
 *
 * ADR-0002: the domain stores memory STATE but does NOT compute a forgetting
 * curve. Retrievability comes solely from the FSRS adapter
 * (`FsrsAdapter.retrievability`). The extra neutral fields below (reps, lapses,
 * learningSteps, scheduledDays) let the adapter round-trip a ts-fsrs Card
 * without leaking library types into the domain (ADR-0001).
 */
import type { LexemeId, TraceId } from "./ids.ts";
import type { Skill } from "./skills.ts";
import type { Millis } from "./clock.ts";

/** FSRS-style memory state for one direction. Mirrors ts-fsrs `State`. */
export type TraceState = "new" | "learning" | "review" | "relearning";

/**
 * Domain-neutral memory state — the fields needed to reconstruct a scheduler
 * card. No scheduling-library types appear here (ADR-0001).
 */
export interface MemoryState {
  stability: number;
  difficulty: number;
  state: TraceState;
  /** Next-due time, epoch millis. Undefined only for a brand-new trace. */
  due?: Millis;
  lastReview?: Millis;
  /** Total reviews (ts-fsrs Card.reps). */
  reps: number;
  /** Total lapses (ts-fsrs Card.lapses). */
  lapses: number;
  /** Current learning/relearning step index (ts-fsrs Card.learning_steps). */
  learningSteps: number;
  /** Last scheduled interval in days (ts-fsrs Card.scheduled_days). */
  scheduledDays: number;
}

export interface SkillTrace extends MemoryState {
  id: TraceId;
  lexeme: LexemeId;
  skill: Skill;
  /** Count of accepted evidence attempts against this trace. */
  evidenceCount: number;
  /** localSequence of the last event that mutated this trace (event cursor). */
  eventCursor: number;
}

export function newTrace(id: TraceId, lexeme: LexemeId, skill: Skill): SkillTrace {
  return {
    id,
    lexeme,
    skill,
    stability: 0,
    difficulty: 0,
    state: "new",
    reps: 0,
    lapses: 0,
    learningSteps: 0,
    scheduledDays: 0,
    evidenceCount: 0,
    eventCursor: 0,
  };
}

/** Extract just the memory-state fields of a trace (for the adapter boundary). */
export function memoryStateOf(trace: SkillTrace): MemoryState {
  return {
    stability: trace.stability,
    difficulty: trace.difficulty,
    state: trace.state,
    due: trace.due,
    lastReview: trace.lastReview,
    reps: trace.reps,
    lapses: trace.lapses,
    learningSteps: trace.learningSteps,
    scheduledDays: trace.scheduledDays,
  };
}

/** True when the trace is at or past its due time. */
export function isDue(trace: SkillTrace, now: Millis): boolean {
  return trace.due !== undefined && now >= trace.due;
}

/** Lateness in days (0 if not yet due). Feeds planner priority (p.18). */
export function latenessDays(trace: SkillTrace, now: Millis): number {
  if (trace.due === undefined || now < trace.due) return 0;
  return (now - trace.due) / 86_400_000;
}
