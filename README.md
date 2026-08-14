# Dyr Mandarin Lab

Adaptive Chinese memory kernel with four independent skill traces, a
deterministic explainable planner, and a fully replayable event log.

> **Primary architecture (spec p.2):** build the headless learning brain first.
> The plain body makes it usable. Games, profiles, points and worlds are
> *removable projections* of accepted `LearningFact`s.

This repository implements the **brain** — Stages 0–1 of the specification's
hard-gated build order (`Dyr Mandarin Lab — Unified Master Specification`,
Master Edition 2.0) — as a dependency-free TypeScript monorepo that runs and
proves itself on Node 22 with **no build step and no network install**.

## The seven rules that cannot be simplified away (spec p.2)

| # | Rule | Where it is enforced |
|---|------|----------------------|
| 1 | **Four traces** — listening, reading, speaking, writing never share one mastery value | `traceId(lexeme, skill)`, `TraceStore`; test: `four-traces.test.ts` |
| 2 | **One update** — an accepted attempt changes exactly one `SkillTrace` | `DyrKernel.applySingleUpdate` one-update guard; test: `four-traces.test.ts` |
| 3 | **Headless core** — the kernel runs and replays without UI or game packages | `@dyr/kernel` imports no UI/layers; `replay.ts`; test: `replay.test.ts` |
| 4 | **One-way layers** — `LearningFact`s flow outward; rewards never alter memory | `@dyr/layers` reads facts only; test: `layers/removal.test.ts` |
| 5 | **Open content** — every bundled asset has exact redistribution rights | `@dyr/content` `licenceGate`; test: `content/licence.test.ts` |
| 6 | **Human audio** — human recordings are canonical; synthetic is labelled fallback | `@dyr/senses` `passesCanonicalAudioGate`; test: `senses/audio.test.ts` |
| 7 | **Bounded use** — sessions are useful in 3, 7 or 15 minutes with no shame debt | `KernelConfig.sessionMinutes`; planner time budget; test: `planner.test.ts` |

## Monorepo shape (spec p.25)

```
packages/domain        pure IDs, events, contracts, policies (zero deps)
packages/kernel        evidence, traces, graph, planner, frontier, workload, replay
packages/fsrs-adapter  the ONLY package that owns FSRS maths (ts-fsrs boundary)
packages/content       manifests, normalisation, licence gate
packages/senses        speech/audio/handwriting provider interfaces
packages/layers        optional game/city/points projection (removable)
apps/web               plain learner body + observatory   (later stages)
apps/service           self-hosted API + speech/content jobs (later stages)
fixtures               tiny licensed test pack + deterministic simulations
```

**Dependency CI (spec p.23):** the kernel imports no UI, game, reward, profile,
narrative or provider *implementation*. It depends only on `@dyr/domain` (pure
vocabulary) and `@dyr/fsrs-adapter` (the pinned FSRS boundary). Layers import
only the read-only `LearningFact` contract and never a learning store.

## The eight observable phases (spec p.5)

```
DECAY → PLAN → CUE → RETRIEVE → EVIDENCE → UPDATE → CONSOLIDATE → FACT
```

emitted as the causal event chain

```
AttemptAccepted → EvidenceValidated → TraceUpdated
                → ConsolidationRecorded → LearningFactPublished
```

**Replay contract (spec p.5):** *same events + same configuration + same clock
= identical state, identical plan, identical explanation frame.* Proven in
`replay.test.ts` (two independently-driven kernels produce byte-for-byte equal
event-log and trace digests) and by rebuilding the trace store purely from the
event log.

## Build gates implemented (spec p.8)

- **Stage 0 — Kernel contract:** domain types, events, FSRS adapter,
  deterministic clock; replay identical state; no UI/game import. ✅
- **Stage 1 — Kernel proof:** evidence, graph, planner, frontier, workload,
  explanations; property tests + a 365-day simulation pass. ✅
- **Stage 2+ — Plain body, four-skill UI, personal beta, game layer,
  hardening:** deliberately gated behind Stages 0–1 (`apps/web`,
  `apps/service`). Not yet built — the spec forbids decorating the body before
  the brain is proven.

## Running

Requires **Node ≥ 22.18** (native TypeScript + native test runner). The only
setup is `npm install`, which links the workspace packages into
`node_modules/@dyr/*` — it needs no network because there are no external
runtime dependencies.

```bash
npm install         # offline: creates the @dyr/* workspace symlinks
npm test            # run the full suite (58 tests)
npm run sim         # print a deterministic 365-day simulation report
```

### What the acceptance fixtures prove

- **48 / 41 / 23 / 18 (spec p.6):** the frontier reports four *independent*
  per-skill counts and never a single "60 words mastered" number; the weakest
  production channel is flagged for repair. (`frontier.test.ts`)
- **Bounded sessions (spec p.14):** every planned session fits its 3/7/15-minute
  budget. (`planner.test.ts`, `simulate.test.ts`)
- **Workload governor (spec p.18):** introductions freeze when the 7-day
  forecast exceeds budget, when lapse repair dominates, or when confidence is
  weak; zero new items is a valid plan. (`workload.test.ts`)
- **Evidence, not a button press (spec p.17):** revealed answers never
  auto-pass; low-confidence speech asks for a self-grade instead of
  auto-failing; hints reduce evidence strength. (`evidence.test.ts`)
- **Removal test (spec p.20):** building the city projection leaves the kernel's
  trace state and event log byte-for-byte unchanged. (`layers/removal.test.ts`)

## Notes on the FSRS adapter

`@dyr/fsrs-adapter` implements the published FSRS-4.5 default algorithm directly
so the brain is provable offline. It is shaped as a provider (spec p.16): to use
the real `ts-fsrs`, pin it in the lockfile and replace the body of
`scheduleReview` while keeping the `FsrsAdapter` interface. The kernel depends
only on that interface, never on FSRS internals. Weights are documented
defaults, not invented (spec p.16 Calibration).
