# Dyr Mandarin Lab — adaptive Chinese memory kernel

A headless, deterministic, explainable Mandarin **learning brain**. Four
independent skill traces (listening, reading, speaking, writing), real FSRS
scheduling via `ts-fsrs`, evidence-based grading, an explainable planner, a
due-based workload governor, short-term repair, and a fully replayable event
log.

> **Brain first (spec p.2).** Games, profiles, points and worlds are removable
> projections of accepted `LearningFact`s. This repository is the **kernel** —
> not the learner PWA, which is deliberately not built (see _Next gate_).

Central abstraction:

```
language object → skill-specific memory trace → retrieval task → evidence
→ memory update → immutable LearningFact
```

## Kernel v0.2 status

This is the **v0.2 correction pass** over the initial Stage 0–1 kernel. The
twelve corrections in the specification's behavioural-proof pages (p.27–32) are
implemented and tested. See `docs/KERNEL_V0.2_AUDIT.md` for the pre-correction
audit and `docs/adr/` for the nine Architecture Decision Records.

## Dependencies (verified & pinned at implementation time)

| Package | Version | Licence | Why |
|---------|---------|---------|-----|
| [`ts-fsrs`](https://github.com/open-spaced-repetition/ts-fsrs) | **5.4.1** | MIT | Owns memory-parameter updates (spec p.32 #14). Latest stable; beta 6.x intentionally not chosen. Only `@dyr/fsrs-adapter` imports it. |
| [`fast-check`](https://fast-check.dev) | **4.9.0** | MIT | Property testing (spec p.29, p.32 #16). Dev-only. |
| `typescript` | 5.9.2 | Apache-2.0 | `tsc --noEmit` typecheck (the runtime strips types, it does not check them). Dev-only. |
| `@types/node` | 22.10.5 | MIT | Node typings for the typecheck. Dev-only. |

Node ≥ 22.18 runs the TypeScript sources directly (native type-stripping + the
native test runner); there is no build step.

## The seven rules, enforced and tested

| Rule | Enforcement | Test |
|------|-------------|------|
| 1 Four traces | `traceId(lexeme, skill)`; independent `SkillTrace`s | `four-traces.test.ts`, `properties.test.ts` |
| 2 One update | kernel one-update guard | `four-traces.test.ts`, `properties.test.ts` (trace isolation) |
| 3 Headless | kernel imports no UI/layer/provider impl | `dependency.test.ts` |
| 4 One-way layers | `@dyr/layers` reads facts only | `layers/removal.test.ts`, `properties.test.ts` |
| 5 Open content | licence gate + attribution output | `content/licence.test.ts` |
| 6 Human audio | canonical-audio gate; synthetic labelled | `senses/audio.test.ts` |
| 7 Bounded use | 3/7/15-min budgets | `planner.test.ts`, `matrix.test.ts` |

## What the v0.2 corrections changed

1. **Real ts-fsrs** behind `FsrsAdapter`; hand-written FSRS maths deleted (ADR-0001).
2. **One retrievability authority** — `FsrsAdapter.retrievability`; the domain no
   longer implements a forgetting curve (ADR-0002).
3. **Short-term repair** — ts-fsrs learning/relearning steps (sub-day due) plus an
   explicit, replayable `RepairDirective` on the same trace (ADR-0003).
4. **Due-based workload governor** — forwards each trace through the adapter under
   versioned high/expected/low recall scenarios; out-of-window traces don't count (ADR-0006).
5. **Versioned task rubrics** — evidence instruments per family; separate speech
   components; ASR match is non-authoritative; rubric version stored on evidence (ADR-0004).
6. **Non-linear skill eligibility** — per-family evidence prerequisites; speaking/writing
   begin early in parallel (ADR-0005).
7. **Per-task asset gates** at plan time with reason codes (`missing_canonical_audio`, …).
8. **Idempotent command boundary** — `SubmitAttemptCommand` with a durable key;
   first-write-wins conflict policy (ADR-0007).
9. **Correct event causation** — `causationId` points to the direct cause;
   reject/self-grade terminate without a `TraceUpdated` (ADR-0008).
10. **Expanded language graph** — Pronunciation, GrammarAtom, task-family metadata (ADR-0009).

## Commands

```bash
npm install       # offline workspace link + ts-fsrs/fast-check (registry)
npm run typecheck # tsc --noEmit (real type checking)
npm test          # full suite (108 tests): unit + property + matrix + dependency
npm run sim       # single deterministic 365-day simulation
npm run matrix    # seeded 9-profile 365-day simulation matrix report
```

## Proof

- **Replay contract (spec p.5):** two independently-driven kernels produce
  byte-for-byte equal event-log and trace digests; the trace store rebuilds
  purely from the event log. `replay.test.ts`, `properties.test.ts`.
- **Acceptance fixture (spec p.28):** the frontier reports **48 / 41 / 23 / 18**
  as four independent counts and never a single "60 mastered" scalar;
  weakest production channel flagged for repair. `frontier.test.ts`.
- **Simulation matrix (spec p.29–30):** 9 seeded profiles (recall levels, skill
  asymmetry, missed weeks, variable budgets, offline-reconnect duplicate
  uploads) — every one holds replay, budget, layer isolation and idempotency.
  `fixtures/sim/matrix.ts`, `matrix.test.ts`.
- **Idempotency:** duplicate commands never double-update memory. `idempotency.test.ts`.
- **Dependency isolation:** only `@dyr/fsrs-adapter` imports `ts-fsrs`; the domain
  is free of library types; the kernel is headless. `dependency.test.ts`.

## Monorepo shape (spec p.25)

```
packages/domain        IDs, skills, clock, graph (+Pronunciation/GrammarAtom),
                       traces (memory state only), contracts, rubric,
                       task-family metadata, repair, command, events, config
packages/fsrs-adapter  ts-fsrs boundary (ONLY importer)
packages/kernel        evidence, trace store, planner, frontier, workload,
                       rubrics, asset gate, event log, replay, observatory
packages/content       manifests, licence gate, attribution output
packages/senses        speech/audio/handwriting provider interfaces
packages/layers        removable city/points projection (read-only facts)
apps/web, apps/service documented placeholders (later stages — not built)
fixtures               licensed mini pack + deterministic simulations
docs/adr               nine ADRs; docs/KERNEL_V0.2_AUDIT.md
```

## Gate decision

**Stage 1 (Kernel Proof) — PASS.** The brain-proof definition of done (spec
p.28) is met: versioned contracts, deterministic clock, ts-fsrs adapter,
evidence gate, independent SkillTraces, language graph, planner, workload
governor, progression admission, immutable events, read-only observatory,
property tests, 365-day simulations, an open-content fixture and reproducible
attribution output. `npm test` is green (108 tests) and `npm run typecheck` is
clean.

### Known limitations (belong to later stages)

- The bundled content is an **8-lexeme licensed fixture**. Spec Stage 2
  (PLAIN RECEPTIVE) requires a real **60-lexeme** licensed pack with clear human
  audio; sourcing/normalising it is Stage 2 content work. The 48/41/23/18
  acceptance fixture is proven against a synthetic 60-node graph.
- `apps/web` and `apps/service` are intentionally placeholders — the spec hard-
  gates the PWA and service behind a proven brain.
- Speech/handwriting providers are interfaces (`@dyr/senses`); concrete
  whisper.cpp / Silero VAD / MFA implementations are Stage 4.

## Next gate

**Stage 2 — Plain receptive body:** a real 60-lexeme licensed pack, the plain
learner surface (Today / Task / Result / Progress) consuming the kernel through
the versioned contracts, and offline 3/7/15-minute sessions. Not started —
this pass stops at the proven brain by design.
```
