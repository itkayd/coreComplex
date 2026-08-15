# ADR-0007: SubmitAttemptCommand with durable idempotency

## Context
v0.1 derived idempotency from `event-log length`, so an offline retry double-
updated. Spec Correction 8 requires client-generated durable ids.

## Decision
Introduce `SubmitAttemptCommand { commandId, idempotencyKey, learnerId,
deviceId, deviceSequence, taskId, targetTrace, occurredAt, attempt }`. The
kernel dedupes on `idempotencyKey`: a repeat returns the same logical result and
does not create a second AttemptAccepted, TraceUpdated or LearningFact.
Conflict policy: same key + different payload hash → rejected as
`idempotency_conflict` (first write wins), never a silent overwrite.

## Alternatives
- Server-assigned ids → rejected (offline clients need pre-generated ids).

## Consequences
`EventLog.append` remains idempotent on `idempotencyKey`; the command layer adds
a durable, content-checked key independent of log position.

## Spec impact
Satisfies Correction 8.
