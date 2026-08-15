# Kernel v0.2 — Engineering Audit (pre-correction)

_Authoritative source: `Dyr Mandarin Lab — Unified Master Specification`, 32-page
edition (pages 27–32 added the behavioural-proof, acceptance-fixture and
source-register criteria that define this correction pass)._

## 1. Repository / branch state

- Implementation branch inspected: `claude/build-it-now-fmp79i` @ `1b8a726`.
- `main` is essentially empty (README only) — confirmed.
- Working tree was **clean** before starting.
- Working branch created for this pass: **`claude/kernel-v0.2-corrections`**
  (branched from `claude/build-it-now-fmp79i`). No force-push, no auto-merge.

## 2. Baseline results (verified, not trusted from README)

- `npm test` → **58 tests, 58 pass, 0 fail**.
- `node fixtures/sim/simulate.ts` (single 365-day run) → max session 2.55 min,
  never froze, 2855 events, replay holds, final profile 8/8/8/8 (mini pack).

## 3. Architecture map (as found)

```
packages/domain        IDs, skills, clock, graph(Lexeme/Sentence/Character),
                       traces (+ retrievability equation ⚠), contracts, events,
                       config, hash, rng
packages/fsrs-adapter  hand-written FSRS-4.5 maths ⚠ (+ its own retrievability ⚠)
packages/kernel        traceStore, eventLog (idempotency via log.length ⚠),
                       evidence + confidence, workload (stability/horizon approx ⚠),
                       frontier, planner (linear channel chain ⚠), replay, kernel,
                       observatory
packages/content       licence gate
packages/senses        provider interfaces
packages/layers        city projection (read-only)
fixtures               mini pack + single simulation
```

## 4. Specification violations identified

| # | Correction | Concrete defect found | Files |
|---|-----------|-----------------------|-------|
| 1 | Real ts-fsrs | `fsrs-adapter` reimplements FSRS-4.5 by hand; spec (p.32 #14) requires the `ts-fsrs` library to own memory maths | `fsrs-adapter/src/index.ts` |
| 2 | One retrievability authority | Two forgetting-curve implementations: `domain/traces.ts::retrievability` **and** `fsrs-adapter` | `domain/src/traces.ts`, `fsrs-adapter` |
| 3 | Short-term repair | Effective minimum interval is 1 day (`nextIntervalDays` clamps to ≥1); a lapse cannot reappear same session | `fsrs-adapter`, `kernel` |
| 4 | Workload governor | Forecast approximates reviews from `stability × horizon`, not real due state; a trace not due in-window can still count | `kernel/src/workload.ts` |
| 5 | Task rubric | `TaskContract` is cue+target+answer; no evidence rubric, no per-family validation, no rubric version | `domain/src/contracts.ts`, `kernel/src/evidence.ts` |
| 6 | Linear skill unlocking | Planner opens channels in a fixed per-word chain (`channelOrder`) | `kernel/src/planner.ts` |
| 7 | Asset gates at plan time | Assets checked only at frontier admission, not per issued task | `kernel/src/planner.ts`, `frontier.ts` |
| 8 | Command idempotency | Idempotency keys derive from `this.log.length`; a genuine retry double-updates | `kernel/src/kernel.ts`, `eventLog.ts` |
| 9 | Event causation | `causationId` mostly set but untested; reject/self-grade terminal path unverified | `kernel/src/kernel.ts` |
| 10 | Language graph | Only Lexeme/Sentence/Character; no Pronunciation, GrammarAtom, TaskFamily metadata | `domain/src/graph.ts` |
| 11 | Property tests | None; spec (p.29) mandates fast-check property tests | new |
| 12 | Simulation matrix | One profile only; spec (p.29–30) mandates a seeded matrix | `fixtures/sim` |

## 5. Dependency decisions (verified at implementation time)

- **ts-fsrs 5.4.1** — latest stable (`npm view ts-fsrs` → 5.4.1; beta 6.0.0-beta.2
  deliberately not chosen). Licence **MIT**. Source
  `github.com/open-spaced-repetition/ts-fsrs` (spec p.32 #14). API verified:
  `fsrs()`, `next(card, now, grade)`, `get_retrievability(card, now, false)`,
  `createEmptyCard()`, `Rating`/`State` enums, and `enable_short_term` +
  `learning_steps ['1m','10m']` / `relearning_steps ['10m']` giving sub-day
  intervals (probed: New+Good → +10m; Review+Again → +1m).
- **fast-check 4.9.0** — latest stable. Licence **MIT**. `fast-check.dev`
  (spec p.32 #16). Node 22 compatible.

Only `@dyr/fsrs-adapter` will depend on `ts-fsrs`. `fast-check` is a dev
dependency used only by test files.

## 6. Correction sequence (milestones)

- **A — Scheduler truth:** wrap ts-fsrs; expose `retrievability()`; delete
  hand-written maths and the domain forgetting curve; parity/determinism tests.
- **B — Event correctness:** `SubmitAttemptCommand` with durable ids; content-
  based idempotency; causal-chain assertions; reject/self-grade terminal path.
- **C — Evidence correctness:** versioned `TaskRubric`; per-family validators;
  speaking/writing component separation; store rubric version on evidence.
- **D — Planner correctness:** task-path eligibility (non-linear); per-task
  asset gates with reason codes; due-based workload forecast via ts-fsrs
  simulation; `RepairDirective` scheduling.
- **E — Language model:** Pronunciation, GrammarAtom, TaskFamily metadata;
  graph tests; immutable pack versioning.
- **F — Proof:** fast-check property suite; seeded simulation matrix;
  acceptance fixture; dependency/architecture tests; final audit + README.

## 7. Files likely to change

`fsrs-adapter/*`, `domain/traces.ts`, `domain/contracts.ts`, `domain/graph.ts`,
`domain/events.ts`, all of `kernel/src/*`, `fixtures/*`, plus new
`packages/*/**/*.property.test.ts`, `fixtures/sim/matrix.*`, `docs/adr/*`.

## 8. Risks / unresolved questions

- **Memory-state fidelity:** driving ts-fsrs across reviews (esp. short-term
  steps) needs the full Card round-tripped. Resolution: expand `SkillTrace`
  with domain-neutral fields (reps, lapses, learningSteps, scheduledDays, due)
  and map them ↔ Card inside the adapter — keeping ts-fsrs types out of domain.
- **Repair vs long-term due:** ts-fsrs short-term steps already yield sub-day
  due, which is legitimate FSRS state. We additionally emit an explicit,
  replayable `RepairDirective` so in-session repair is explainable without
  overwriting the FSRS due. See ADR-0003.
- **Determinism with ts-fsrs:** must disable fuzz (`enable_fuzz: false`) and
  inject the clock so scheduling is reproducible. Verified `next()` is pure
  given (card, now, grade).
```
