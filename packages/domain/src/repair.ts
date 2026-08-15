/**
 * RepairDirective — short-term instructional repair, kept distinct from
 * long-term FSRS scheduling (ADR-0003, spec Correction 3).
 *
 * When a direct retrieval fails, the kernel records a genuine `Again` on the
 * target trace (long-term scheduling handled by ts-fsrs) AND emits a
 * RepairDirective: an explicit, replayable opportunity to retry the SAME trace
 * later in the current or next suitable bounded session. A repair never:
 *   - targets another trace;
 *   - fakes successful retrieval;
 *   - overwrites the FSRS long-term due.
 */
import type { TraceId } from "./ids.ts";
import type { Millis } from "./clock.ts";

export interface RepairDirective {
  trace: TraceId;
  /** Earliest time the repair task may be issued. */
  eligibleAt: Millis;
  /** Repair is dropped if not taken by this time (bounded, no shame debt). */
  expiresAt: Millis;
  /** How many times this trace has been repaired in the current lapse cluster. */
  attempt: number;
  reason: string;
}

/** Default in-session repair window: eligible after a short gap, expires in a day. */
export const REPAIR_MIN_GAP_MS = 60_000; // 1 minute, matches short-term steps
export const REPAIR_WINDOW_MS = 86_400_000; // 1 day

export function makeRepairDirective(
  trace: TraceId,
  now: Millis,
  attempt: number,
): RepairDirective {
  return {
    trace,
    eligibleAt: now + REPAIR_MIN_GAP_MS,
    expiresAt: now + REPAIR_WINDOW_MS,
    attempt,
    reason: attempt > 1 ? "repeated_lapse" : "failed_direct_retrieval",
  };
}
