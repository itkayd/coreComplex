/**
 * Command boundary (ADR-0007, spec Correction 8).
 *
 * Idempotency must NOT depend on event-log position. Offline clients generate
 * durable identifiers before submitting, so a retry after a dropped connection
 * is recognised as the same command. The kernel dedupes on `idempotencyKey`.
 */
import type {
  AttemptId,
  DeviceId,
  LearnerId,
  TaskId,
  TraceId,
} from "./ids.ts";
import type { Millis } from "./clock.ts";
import type { RawAttempt } from "./contracts.ts";
import { hashValue } from "./hash.ts";

export interface SubmitAttemptCommand {
  /** Durable, client-generated command id. */
  commandId: string;
  /** The dedupe key. Same key => same logical result. */
  idempotencyKey: string;
  learnerId: LearnerId;
  deviceId: DeviceId;
  /** Monotonic per-device sequence for ordering on reconnect (spec p.24). */
  deviceSequence: number;
  attemptId: AttemptId;
  taskId: TaskId;
  targetTrace: TraceId;
  occurredAt: Millis;
  attempt: RawAttempt;
}

/** Content hash of the semantically meaningful payload — for conflict detection. */
export function commandPayloadHash(cmd: SubmitAttemptCommand): string {
  return hashValue({
    learnerId: cmd.learnerId,
    deviceId: cmd.deviceId,
    attemptId: cmd.attemptId,
    taskId: cmd.taskId,
    targetTrace: cmd.targetTrace,
    occurredAt: cmd.occurredAt,
    attempt: cmd.attempt,
  });
}

/** Conflict policy (ADR-0007): first write wins; a reused key with a different
 * payload is rejected, never silently overwritten. */
export type CommandOutcome =
  | { status: "applied"; idempotencyKey: string }
  | { status: "duplicate"; idempotencyKey: string }
  | { status: "idempotency_conflict"; idempotencyKey: string };
