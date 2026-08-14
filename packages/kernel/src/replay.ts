/**
 * Event replay (spec p.5, p.18, p.24).
 *
 *   "Same events + same configuration + same clock = identical state."
 *
 * The event log is the source of truth. learning.db holds events, traces,
 * graph state and facts (p.24); every other store is a removable projection.
 * Replaying the TraceUpdated stream in localSequence order reconstructs the
 * exact memory state, independently of any layer database (p.3 HEADLESS,
 * p.20 REMOVAL TEST).
 */
import {
  type EventEnvelope,
  type LexemeId,
  type Skill,
  type SkillTrace,
  type TaskCuedPayload,
  type TraceUpdatedPayload,
  newTrace,
} from "@dyr/domain";
import { TraceStore } from "./traceStore.ts";

/** Split a TraceId ("lexeme::skill") back into its parts. */
function parseTraceId(id: string): { lexeme: LexemeId; skill: Skill } {
  const idx = id.lastIndexOf("::");
  return {
    lexeme: id.slice(0, idx) as LexemeId,
    skill: id.slice(idx + 2) as Skill,
  };
}

/**
 * Rebuild a TraceStore purely from an ordered event log. Non-mutating event
 * types are ignored; only TraceUpdated carries authoritative post-state.
 */
export function replayTraces(events: readonly EventEnvelope[]): TraceStore {
  const store = new TraceStore();
  const ordered = [...events].sort((a, b) => a.localSequence - b.localSequence);

  for (const e of ordered) {
    // TaskCued materialises the (lexeme, skill) trace as `new`, exactly as the
    // kernel does when planning — so a replayed store contains the same set of
    // traces, not only the ones that were later updated.
    if (e.eventType === "TaskCued") {
      const { task } = e.payload as TaskCuedPayload;
      store.ensure(task.lexeme, task.skill);
      continue;
    }
    if (e.eventType !== "TraceUpdated") continue;
    const p = e.payload as TraceUpdatedPayload;
    const { lexeme, skill } = parseTraceId(p.traceId);
    const existing = store.get(p.traceId as SkillTrace["id"]) ??
      newTrace(p.traceId as SkillTrace["id"], lexeme, skill);
    store.put({
      ...existing,
      stability: p.stabilityAfter,
      difficulty: p.difficultyAfter,
      due: p.dueAfter,
      // A relearning state follows an "again"; otherwise the trace is in review.
      state: p.ratingApplied === "again" ? "relearning" : "review",
      lastReview: e.occurredAt,
      evidenceCount: existing.evidenceCount + 1,
      eventCursor: e.localSequence,
    });
  }
  return store;
}

/**
 * Assert the replay contract for a live store against its own event log.
 * Returns true when the reconstructed digest matches the live digest.
 */
export function verifyReplay(live: TraceStore, events: readonly EventEnvelope[]): boolean {
  return replayTraces(events).digest() === live.digest();
}
