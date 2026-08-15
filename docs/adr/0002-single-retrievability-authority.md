# ADR-0002: One retrievability authority

## Context
v0.1 had two forgetting-curve implementations (domain `traces.ts` and the
adapter). Spec Correction 2 forbids competing FSRS equations.

## Decision
`FsrsAdapter.retrievability(memoryState, now)` (backed by ts-fsrs
`get_retrievability`) is the sole source. `domain/traces.ts` no longer computes
a forgetting curve; it only stores memory state and derives due/lateness from
stored fields. Planner, workload and observatory obtain retrievability through
the adapter.

## Alternatives
- Keep a domain approximation for convenience → rejected (two sources of truth).

## Consequences
A regression test asserts planner-visible R == scheduler-visible R for the same
trace/timestamp.

## Spec impact
Satisfies Correction 2.
