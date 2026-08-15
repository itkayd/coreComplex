/**
 * TraceStore — the memory of the brain.
 *
 * Holds one SkillTrace per (lexeme, skill) pair. This is where Rule 1 (Four
 * Traces) and Rule 2 (One Update) physically live: a lexeme has up to four
 * traces, and `applyUpdate` touches exactly one of them.
 */
import {
  type LexemeId,
  type Skill,
  type SkillTrace,
  type TraceId,
  newTrace,
  traceId,
} from "@dyr/domain";

export class TraceStore {
  private readonly traces = new Map<TraceId, SkillTrace>();

  /** Get an existing trace or lazily create a `new` one for the pairing. */
  ensure(lexeme: LexemeId, skill: Skill): SkillTrace {
    const id = traceId(lexeme, skill);
    let t = this.traces.get(id);
    if (!t) {
      t = newTrace(id, lexeme, skill);
      this.traces.set(id, t);
    }
    return t;
  }

  get(id: TraceId): SkillTrace | undefined {
    return this.traces.get(id);
  }

  has(lexeme: LexemeId, skill: Skill): boolean {
    return this.traces.has(traceId(lexeme, skill));
  }

  /** Replace a trace wholesale (traces are immutable snapshots to callers). */
  put(trace: SkillTrace): void {
    this.traces.set(trace.id, trace);
  }

  /** All traces, in deterministic id order (replay/observatory stability). */
  all(): SkillTrace[] {
    return [...this.traces.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
  }

  forSkill(skill: Skill): SkillTrace[] {
    return this.all().filter((t) => t.skill === skill);
  }

  /**
   * Deterministic digest of the entire memory state. Two kernels that
   * replayed the same events under the same config+clock must produce the
   * same digest — this is the observable form of the replay contract (p.5).
   */
  digest(): string {
    const rows = this.all().map((t) => [
      t.id,
      t.stability.toFixed(6),
      t.difficulty.toFixed(6),
      t.state,
      t.due ?? -1,
      t.lastReview ?? -1,
      t.reps,
      t.lapses,
      t.learningSteps,
      t.scheduledDays,
      t.evidenceCount,
      t.eventCursor,
    ]);
    return JSON.stringify(rows);
  }

  size(): number {
    return this.traces.size;
  }
}
