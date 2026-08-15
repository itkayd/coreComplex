# ADR-0003: Short-term repair via ts-fsrs steps + explicit RepairDirective

## Context
v0.1 clamped all intervals to ≥1 day, so a failed retrieval could not be
repaired the same session (Correction 3).

## Decision
Two complementary mechanisms, kept distinct:
1. **Long-term scheduling**: ts-fsrs runs with `enable_short_term: true`,
   `learning_steps ['1m','10m']`, `relearning_steps ['10m']`. A lapse naturally
   yields a sub-day due — legitimate FSRS state, not a fake SRS.
2. **In-session repair**: on an accepted `Again`, the kernel emits an explicit,
   replayable `RepairDirective` targeting the SAME trace. The planner may issue
   one repair task later in the current/next bounded session. A repair attempt
   flows through the normal evidence→one-update path (a real grade); it never
   fakes success and never overwrites the FSRS due.

## Alternatives
- Invent a second scheduler for short intervals → rejected (spec forbids).
- Rely on ts-fsrs steps alone → rejected (not explainable as a kernel concept).

## Consequences
`RepairDirective` is an event and a planner input; it is visible in explanations
and reconstructed by replay. Repair never updates another trace.

## Spec impact
Satisfies Correction 3.
