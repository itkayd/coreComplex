/**
 * Event envelope and the kernel's event vocabulary.
 *
 * Spec p.24 (Event Envelope) lists the exact fields every event carries.
 * Spec p.5 (Event Replay Contract) fixes the causal chain:
 *   AttemptAccepted -> EvidenceValidated -> TraceUpdated
 *   -> ConsolidationRecorded -> LearningFactPublished
 * and the guarantee: same events + config + clock => identical state.
 *
 * Events are append-only and never overwritten in place (p.24 Offline +
 * Reconnect). learning.db holds events, traces, graph state and facts; layer
 * stores are strictly separate (Store Separation, p.24; Rule 3, headless).
 */
import type {
  AttemptId,
  DeviceId,
  EventId,
  LearnerId,
  PackVersion,
  PlannerVersion,
} from "./ids.ts";
import type { Millis } from "./clock.ts";
import type {
  AttemptEnvelope,
  LearningFact,
  RawAttempt,
  TaskContract,
} from "./contracts.ts";
import type { Rating } from "./skills.ts";

export const EVENT_TYPES = [
  "SessionPlanned",
  "TaskCued",
  "AttemptAccepted",
  "EvidenceValidated",
  "TraceUpdated",
  "ConsolidationRecorded",
  "LearningFactPublished",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Envelope fields from spec p.24, verbatim. */
export interface EventEnvelope<P = unknown> {
  eventId: EventId;
  learnerId: LearnerId;
  deviceId: DeviceId;
  /** Stable learner-local sequence — the replay ordering key (p.24). */
  localSequence: number;
  occurredAt: Millis;
  receivedAt: Millis;
  eventType: EventType;
  schemaVersion: number;
  /** Event that directly caused this one (per the p.5 chain). */
  causationId?: EventId;
  /** Groups all events belonging to one review/session. */
  correlationId?: EventId;
  /** Makes writes idempotent on reconnect (p.24). */
  idempotencyKey: string;
  plannerVersion: PlannerVersion;
  packVersion: PackVersion;
  configurationHash: string;
  payload: P;
  payloadHash: string;
}

// ---- Payloads for each event type ----

export interface SessionPlannedPayload {
  budgetMinutes: number;
  taskIds: string[];
  predictedMinutes: number;
  reasonCodes: { code: string; detail: string }[];
}

export interface TaskCuedPayload {
  task: TaskContract;
}

export interface AttemptAcceptedPayload {
  attempt: RawAttempt;
}

export interface EvidenceValidatedPayload {
  envelope: AttemptEnvelope;
  decision: "update" | "reject" | "ask_self_grade";
}

export interface TraceUpdatedPayload {
  traceId: string;
  ratingApplied: Rating;
  stabilityBefore: number;
  stabilityAfter: number;
  difficultyBefore: number;
  difficultyAfter: number;
  dueAfter: Millis;
}

export interface ConsolidationRecordedPayload {
  traceId: string;
  /** Support/interference/transfer edges touched, for explanation only. */
  transferNotes: string[];
}

export interface LearningFactPublishedPayload {
  fact: LearningFact;
}
