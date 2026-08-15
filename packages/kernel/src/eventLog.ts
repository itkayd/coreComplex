/**
 * Append-only event log.
 *
 * Spec p.24: every event has a stable learner-local sequence; writes are
 * idempotent (idempotencyKey); accepted events are never overwritten in place.
 * Spec p.5: replay over this log rebuilds exact state.
 *
 * The log is the source of truth. Traces, facts and the frontier are all
 * derivable projections of it.
 */
import {
  type DeviceId,
  type EventEnvelope,
  type EventId,
  type EventType,
  type LearnerId,
  type PackVersion,
  type PlannerVersion,
  hashValue,
} from "@dyr/domain";

let counter = 0;

export interface AppendInput<P> {
  learnerId: LearnerId;
  deviceId: DeviceId;
  occurredAt: number;
  eventType: EventType;
  payload: P;
  causationId?: EventId;
  correlationId?: EventId;
  idempotencyKey: string;
  plannerVersion: PlannerVersion;
  packVersion: PackVersion;
  configurationHash: string;
  schemaVersion?: number;
}

export class EventLog {
  private readonly events: EventEnvelope[] = [];
  /** idempotencyKey -> envelope, for O(1) duplicate detection. */
  private readonly byKey = new Map<string, EventEnvelope>();
  private nextSequence = 1;

  /**
   * Deterministic, sequence-derived event id — no wall clock, no RNG, and no
   * process-global counter. (learnerId, localSequence) is already unique within
   * a log, so two kernels replaying the same events mint IDENTICAL event ids.
   * A global counter here would silently break the replay contract for anything
   * that compares causation edges rather than just the trace digest.
   */
  private mintId(learnerId: LearnerId, seq: number): EventId {
    return `evt_${hashValue([learnerId, seq])}` as EventId;
  }

  /**
   * Append one event. Idempotent: a repeat idempotencyKey returns the existing
   * envelope untouched (spec p.24 "Upload events idempotently on reconnect").
   */
  append<P>(input: AppendInput<P>): EventEnvelope<P> {
    const existing = this.byKey.get(input.idempotencyKey);
    if (existing) return existing as EventEnvelope<P>;

    const seq = this.nextSequence++;
    const envelope: EventEnvelope<P> = {
      eventId: this.mintId(input.learnerId, seq),
      learnerId: input.learnerId,
      deviceId: input.deviceId,
      localSequence: seq,
      occurredAt: input.occurredAt,
      receivedAt: input.occurredAt,
      eventType: input.eventType,
      schemaVersion: input.schemaVersion ?? 1,
      causationId: input.causationId,
      correlationId: input.correlationId,
      idempotencyKey: input.idempotencyKey,
      plannerVersion: input.plannerVersion,
      packVersion: input.packVersion,
      configurationHash: input.configurationHash,
      payload: input.payload,
      payloadHash: hashValue(input.payload),
    };
    this.events.push(envelope);
    this.byKey.set(input.idempotencyKey, envelope);
    return envelope;
  }

  /**
   * Adopt an already-minted event verbatim (restoring a persisted log).
   *
   * Unlike append(), this mints nothing and rewrites nothing: ids, sequences and
   * causation edges are preserved exactly, which is what makes a restored kernel
   * byte-identical to the one that wrote the log. The sequence counter advances
   * past the adopted event so newly appended events continue the series.
   */
  adopt(envelope: EventEnvelope): void {
    if (this.byKey.has(envelope.idempotencyKey)) return; // already present
    this.events.push(envelope);
    this.byKey.set(envelope.idempotencyKey, envelope);
    if (envelope.localSequence >= this.nextSequence) {
      this.nextSequence = envelope.localSequence + 1;
    }
  }

  all(): readonly EventEnvelope[] {
    return this.events;
  }

  ofType<P = unknown>(type: EventType): EventEnvelope<P>[] {
    return this.events.filter((e) => e.eventType === type) as EventEnvelope<P>[];
  }

  get length(): number {
    return this.events.length;
  }

  /** Deterministic digest of the whole log for replay comparison. */
  digest(): string {
    return hashValue(
      this.events.map((e) => [
        e.localSequence,
        e.eventType,
        e.payloadHash,
        e.configurationHash,
      ]),
    );
  }
}
