# Dyr Mandarin Lab — adaptive Chinese memory kernel

A headless, deterministic, explainable Mandarin **learning brain**. Four
independent skill traces (listening, reading, speaking, writing), real FSRS
scheduling via `ts-fsrs`, evidence-based grading, an explainable planner, a
due-based workload governor, short-term repair, and a fully replayable event
log.

> **Brain first (spec p.2).** The kernel was built and proven before any screen.
> Games, profiles, points and worlds are removable projections of accepted
> `LearningFact`s and remain unbuilt — the plain body works without them.

Central abstraction:

```
language object → skill-specific memory trace → retrieval task → evidence
→ memory update → immutable LearningFact
```

## Status

- **Stage 1 (Kernel Proof): PASS** — headless brain, proven (see _Gate decision_).
- **Stage 2 (Plain Receptive): in progress** — real 60-lexeme licensed pack,
  content pipeline, and a working offline plain body (`apps/web`). Listening is
  gated until canonical human audio is provisioned; see _Known limitations_.

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
npm install       # workspace link + ts-fsrs / fast-check
npm run typecheck # tsc --noEmit (real type checking; the runtime only strips types)
npm test          # full suite (133 tests): unit + property + matrix + dependency
npm run sim       # single deterministic 365-day simulation
npm run matrix    # seeded 9-profile 365-day simulation matrix report

# Stage 2 — content pack and the plain body
npm run build:pack               # build the immutable, signed Core 60 artefact
npm run audio:qa -- <clipDir>    # screen candidate recordings against the audio gate
npm run attributions             # regenerate ATTRIBUTIONS.{json,md} from the pack
npm run e2e                      # Stage 2 browser gate: sessions, offline, a11y, pack integrity
npm run speech                   # local synthetic-speech service (see docs/SETUP-SPEECH.md)
npm run build:web                # build the pack + the offline PWA
npm run dev --workspace=@dyr/web # run the plain body locally
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

## Stage 2 — the plain receptive slice

**Content.** `Dyr Core 60`: 60 high-frequency Mandarin lexemes authored for this
project and released **CC0-1.0** — not scraped or reconstructed from any
dictionary product, no Pleco data, no official HSK list. Includes 银行 (the
spec's worked example) and real learner confusables (买/卖, 他/她, 日/月, 这/那),
plus 69 characters, 60 pronunciation nodes with tone and third-tone-sandhi
metadata, and grammar atoms. Built by the seven-stage pipeline (spec p.7) into an
**immutable, sha256-signed, versioned artefact** — the pack version embeds the
content hash, so a correction necessarily mints a new version.

**The plain body** (`apps/web`): an installable, offline-first React PWA —
Home / Task / Result / Progress / Settings. One primary Start button, 3/7/15
minute sessions, one cue and one action per task with no answer leakage, and a
Result screen that shows the kernel's *own* reason. Progress shows four
independent skill meters and no single score. Settings carries export and
deletion controls. No points, streaks, missions, city or narrative: the body is
fully useful with every optional layer absent.

**Persistence.** Only the learning event log (IndexedDB via Dexie) and the cached
pack are stored — no game or profile store. On startup the kernel is rebuilt by
replaying that log, so a reload resumes exactly where you were, with pending
repairs intact and no penalty.

**Pack integrity.** The PWA refuses a pack that does not validate structurally
*and* still hash to its declared `contentHash`. The digest definition is shared
by the Node build and the browser verifier, so they cannot drift. Tampering,
truncation and version mismatch are all rejected with a diagnosable reason — a
learner is never taught from content of unknown provenance.

**Browser gate** (`npm run e2e`): 14 checks in a real browser at a mobile
viewport with reduced motion — 3/7/15-minute sessions, a full task→result cycle,
IndexedDB restore after interruption, offline reload, tampered-pack refusal, and
**zero WCAG 2.1 AA violations (axe-core) on all five screens**.

## Open content pipeline

Importers for the open Mandarin sources, all build-time and none in the kernel:

- **CC-CEDICT parser** — canonical `cedict_ts.u8` format; preserves the original
  numbered pinyin verbatim and derives the tone-marked form; keeps distinct
  senses and heteronyms separate; rejects malformed lines *with reasons*.
- **Pinyin normaliser** — numbered ⇄ tone-marked, with initial/final split for
  later pronunciation evidence. Pure TypeScript; see the dependency register for
  why pypinyin is not a dependency.
- **Tokeniser** — longest-match over the LanguageGraph, so 银行 stays one lexeme
  rather than 银 + 行. Character offsets preserved for highlighting. A fallback
  segmenter (Jieba et al.) can refine **only unknown spans**, so a library
  upgrade can never re-cut vocabulary Dyr already owns.
- **Static difficulty** — highest HSK level, out-of-level tokens, target density.
  `knownTokenRatio` is deliberately absent: it depends on live SkillTrace state
  and belongs to the kernel, never to an immutable content object.
- **Source audit** — admission is decided per *component*, not per repository.

> **A source was rejected.** The suggested HSK 3.0 repository declares its word
> lists as Pleco-derived, which the spec denies (p.7, p.22). An MIT wrapper does
> not launder that origin, and the repo has no per-file provenance to separate it
> from its CC BY-SA parts — so **HSK levels are not bundled**. Full reasoning and
> routes to a usable source: `docs/SOURCE_AUDIT.md`.

## Synthetic speech (CosyVoice)

Self-hosted Mandarin TTS for text that has no human recording — example
sentences, explanations, learner-requested playback. Free to run, no API key, no
metered service; the service refuses to start against a known paid host.

```
apps/web → apps/service → SyntheticSpeechProvider → CosyVoice (its own FastAPI)
```

**It is never canonical.** `sourceType` is the literal `"synthetic"` in the
contract, `runAudioQa` rejects any synthetic asset outright, and a pack full of
CosyVoice clips still reports `missing_canonical_audio` and leaves the listening
channel closed — all proven in `fixtures/sim/synthetic-audio.test.ts`. Setup:
`docs/SETUP-SPEECH.md`; rationale: `docs/adr/0010-synthetic-speech-cosyvoice.md`.

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
apps/web              plain body: offline-first PWA (Home/Task/Result/Progress/Settings)
apps/service           local speech service: CosyVoice adapter, deterministic
                       version-aware cache, POST /speech/synthesise
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

### Known limitations

- **Canonical human audio is not bundled, so listening is gated.** Human-recorded
  Mandarin is canonical and cannot be fabricated (spec p.21). This environment's
  network policy also denies Wikimedia and OpenSLR, so the clips could not be
  fetched here. The pack *declares* the clip each lexeme needs and records its
  provisioning state; until a clip passes the gate the kernel refuses
  audio-primary tasks with `missing_canonical_audio` rather than substituting
  anything. Reading works fully offline today.

  The gate itself is built and measured, not a checkbox: `npm run audio:qa`
  decodes each candidate WAV and **measures** clipping, noise floor, silence and
  pace-against-syllable-count, and a measurement overrides a false "it's clean"
  claim. What no measurement can establish — that the clip really says the word,
  is Standard Mandarin, and is licence/consent clear — stays an explicit reviewer
  declaration, and an unscreened clip can only ever reach `unverified`.
  **Stage 2 is not complete until real recordings are provisioned and reviewed.**
- Stroke data is a separately-licensed asset (Hanzi Writer), so handwriting stays
  gated.
- `apps/service` remains a placeholder; the plain body is local-first and needs
  no server yet.
- Speech/handwriting providers are interfaces (`@dyr/senses`); concrete
  whisper.cpp / Silero VAD / MFA implementations are Stage 4.

## Next gate

**Finish Stage 2** by provisioning QA-verified human recordings for the Core 60
so the listening channel opens, then **Stage 3 — Four-skill core**: speaking,
typing, handwriting and composition through the same plain body and the same
independent-trace contracts.
```
