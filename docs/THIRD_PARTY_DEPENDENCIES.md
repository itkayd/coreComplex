# Third-party dependency register

Libraries, models and datasets are audited **independently**. An open-source
library does not imply open model weights, and open-source software does not
imply an open dataset.

Nothing here requires a paid API, an account, or an API key.

## Runtime dependencies (shipped)

| Name | Purpose | Source | Version | Licence | Redistributed | Reason chosen | Replacement |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ts-fsrs | FSRS memory-parameter updates | [open-spaced-repetition/ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) | 5.4.1 | MIT | yes (npm) | Spec p.32 #14 names it; the kernel must not own memory maths | `FsrsAdapter` boundary — any scheduler behind the same interface |
| react / react-dom | Plain body UI | [facebook/react](https://github.com/facebook/react) | 19.2.8 | MIT | yes | Spec p.25 names a React/TypeScript PWA | Any view layer; the kernel is headless |
| dexie | IndexedDB wrapper for the event log | [dexie/Dexie.js](https://github.com/dexie/Dexie.js) | 4.4.5 | Apache-2.0 | yes | Spec p.32 #26; append-only event storage | Raw IndexedDB — the event model is ours, not Dexie's |

## Build / dev dependencies (not shipped)

| Name | Purpose | Source | Version | Licence | Reason | Replacement |
| --- | --- | --- | --- | --- | --- | --- |
| vite / @vitejs/plugin-react | PWA bundling | [vitejs/vite](https://github.com/vitejs/vite) | 8.2.1 / 6.0.5 | MIT | Standard TS/React build | Any bundler |
| typescript | `tsc --noEmit` typecheck | [microsoft/TypeScript](https://github.com/microsoft/TypeScript) | 5.9.2 | Apache-2.0 | The runtime strips types, it does not check them | — |
| fast-check | Property tests | [fast-check.dev](https://github.com/dubzzz/fast-check) | 4.9.0 | MIT | Spec p.29/p.32 #16 mandates property testing | Any property-testing library |
| @types/node | Node typings | DefinitelyTyped | 22.10.5 | MIT | Typecheck support | — |
| playwright | Browser verification | [microsoft/playwright](https://github.com/microsoft/playwright) | 1.62.1 | Apache-2.0 | Drive the real PWA; browsers pre-installed | Any browser driver |

## External processes (user-run, not bundled)

| Name | Purpose | Source | Licence | Model licence | Notes |
| --- | --- | --- | --- | --- | --- |
| CosyVoice | Synthetic Mandarin TTS | [QwenAudio/CosyVoice](https://github.com/QwenAudio/CosyVoice) | Apache-2.0 (verify at install) | **separate — audit before redistributing weights** | Runs as its own FastAPI server. Weights are never committed (`models/`, `pretrained_models/` git-ignored). Synthetic output can never be canonical audio. |
| ffmpeg | Optional OGG/Opus encoding, speed baking | [FFmpeg](https://ffmpeg.org) | LGPL/GPL depending on build | n/a | **Optional.** Absent → service serves WAV and reports `speedApplied: false`. Build-time/service only, never the kernel. |

## Data sources

| Name | Purpose | Licence | Bundled | Status |
| --- | --- | --- | --- | --- |
| Dyr Core 60 | Stage 2 proof vocabulary | CC0-1.0 | **yes** | Authored for this project |
| CC-CEDICT | Dictionary: traditional, pinyin, senses | CC BY-SA 4.0 | no | Parser implemented; `mdbg.net` unreachable from this sandbox |
| Tatoeba | Example sentences + some audio | per sentence; **audio licensed separately** | no | Screening implemented; `downloads.tatoeba.org` unreachable |
| krmanik/HSK-3.0 | HSK 3.0 levels | mixed | **no — REJECTED** | HSK word lists are Pleco-derived. See `docs/SOURCE_AUDIT.md` |

## Considered and deliberately NOT added

Each entry answers: *what problem would it solve, and can existing code already
solve it?*

| Candidate | Why not (yet) |
| --- | --- |
| **pypinyin** | Its real value is *generating* pinyin from hanzi. We do not need that: CC-CEDICT supplies pronunciation and the spec makes source pronunciation authoritative. What we needed — numbered ⇄ tone-marked normalisation — is a closed, deterministic transformation, implemented in ~150 lines of TypeScript with no Python runtime in the content build. Revisit if Dyr must derive pinyin for text with no dictionary entry. |
| **Jieba** | Dyr's LanguageGraph is canonical lexical identity; a statistical segmenter must never decide it, or a library upgrade could silently re-cut a sentence and change which trace a task belongs to. The tokeniser exposes a `FallbackSegmenter` hook that is offered **only unknown spans**, so Jieba can be added there when the corpus outgrows the pack vocabulary. |
| **OpenCC** | Needed for phrase-level simplified⇄traditional conversion at corpus scale. The Core 60 carries both forms from source data, so nothing is converted today. Add when importing a corpus that ships only one orthography — as a build-time step that never destructively rewrites canonical forms. |
| **Zod** | Runtime pack validation is genuinely required before third-party packs are loaded. The pack is currently built and consumed in-repo from a hash-verified artefact. Add at the point an untrusted pack can be installed. |
| **MiniSearch** | Offline dictionary search. There is no search surface yet; 60 lexemes need none. |
| **Workbox** | The hand-written service worker is ~30 lines and cache-first over an immutable, content-addressed pack. Adopt when versioned pack upgrades and eviction get complex. |
| **Hanzi Writer** | Stage 3 (writing). Note: the library licence (MIT) and its **stroke data licence** must be audited separately. |
| **sherpa-onnx** | Stage 3 (speech recognition). Runtime licence and each **model's** licence must be audited separately before any weights are redistributed. |
| **Yjs / CRDTs** | Explicitly wrong for the memory brain: learning state is event-sourced and replayable. Possibly useful later for shared notes — never for traces. |
| **Any LLM / paid API** | Dyr must work as a learning system without one. An LLM may become an optional outer layer; it must never be the brain. |

## Kernel isolation

The kernel imports none of the above except `@dyr/domain` and
`@dyr/fsrs-adapter`. This is enforced by
`packages/kernel/src/dependency.test.ts`, which fails the build if a speech
engine, segmenter, converter, UI framework or service package appears in
`domain`, `kernel`, `content` or `layers`.
