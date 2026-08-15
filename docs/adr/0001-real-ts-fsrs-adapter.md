# ADR-0001: Real ts-fsrs behind the FsrsAdapter boundary

## Context
The v0.1 kernel hand-implemented FSRS-4.5. Spec p.14/p.32(#14) requires the
`ts-fsrs` library to own memory-parameter updates.

## Decision
`@dyr/fsrs-adapter` depends on **ts-fsrs 5.4.1** (MIT) and is the ONLY package
that imports it. It exposes a domain-neutral `FsrsAdapter` interface
(`scheduleReview`, `retrievability`, `initialState`). The kernel depends only on
that interface. Fuzz is disabled and the clock is injected for determinism.

## Alternatives
- Keep hand-written maths → rejected (drifts from FSRS, spec violation).
- Import ts-fsrs in the kernel → rejected (breaks dependency direction).

## Consequences
Domain gains neutral memory fields (reps, lapses, learningSteps, scheduledDays)
so a ts-fsrs Card round-trips without leaking library types. Scheduling is now
authoritative and version-pinned.

## Spec impact
Satisfies Correction 1; supports the "Brain-proof definition of done" (p.28).
