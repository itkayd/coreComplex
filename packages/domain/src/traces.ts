/**
 * SkillTrace — the canonical memory unit (spec p.4, p.14).
 *
 * "One concept, four independent memory traces." Each trace owns its own due
 * date, stability, difficulty and evidence history (p.4). The trace store
 * (p.16) records "stability, difficulty, state, due time and event cursor for
 * one skill direction". A learner can know a word for reading and fail it for
 * speaking; the kernel stores that reality instead of a single mastered flag.
 */
import type { LexemeId, TraceId } from "./ids.ts";
import type { Skill } from "./skills.ts";
import type { Millis } from "./clock.ts";

/** FSRS-style memory state for one direction. */
export type TraceState = "new" | "learning" | "review" | "relearning";

export interface SkillTrace {
  id: TraceId;
  lexeme: LexemeId;
  skill: Skill;
  /** Stability (days): time for retrievability to fall to 90%. */
  stability: number;
  /** Difficulty in [1,10]. */
  difficulty: number;
  state: TraceState;
  /** When this trace next becomes due, in epoch millis. Undefined = new. */
  due?: Millis;
  /** Last time the trace was reviewed, in epoch millis. */
  lastReview?: Millis;
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
    difficulty: 5,
    state: "new",
    evidenceCount: 0,
    eventCursor: 0,
  };
}

/**
 * Retrievability: probability of successful direct retrieval now, from the
 * FSRS forgetting curve R = (1 + t/(9S))^-1 where t is elapsed days. A new
 * trace (no stability) has retrievability 0 — it has never been retrieved.
 */
export function retrievability(trace: SkillTrace, now: Millis): number {
  if (trace.state === "new" || trace.lastReview === undefined || trace.stability <= 0) {
    return 0;
  }
  const elapsedDays = (now - trace.lastReview) / 86_400_000;
  return Math.pow(1 + elapsedDays / (9 * trace.stability), -1);
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
