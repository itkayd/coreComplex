# Source inbox — supplying content offline

Network access is **never** required to compile a release pack. Sources are
acquired externally, dropped in here, and compiled from an immutable local
snapshot. That is what makes a release reproducible: the pack depends on files
with known hashes, not on whatever an upstream API returned that day.

```
sources/inbox/<sourceId>/
    manifest.json      provenance + declared files (REQUIRED)
    <files…>           the actual downloaded data

sources/review/audio/
    reviews.json       human certification, bound to each recording's sha256
```

Declared paths must stay inside their source directory. Absolute paths, `..`
traversal and symlinks pointing outside are refused before any byte is read.

Nothing here is committed except the structure and the manifests — the source
bytes are git-ignored.

Check status at any time:

```bash
npm run content:sources
```

Absence is never a build failure. Each importer reports what is missing and how
to supply it.

---

## 1. CC-CEDICT — `sources/inbox/cc-cedict/`

*Optional for Stage 2* (enrichment: traditional forms, extra senses).

1. Download from <https://www.mdbg.net/chinese/dictionary?page=cc-cedict>
   (`cedict_1_0_ts_utf-8_mdbg.txt.gz` — the `.gz` may be left compressed).
2. Place it in `sources/inbox/cc-cedict/`.
3. Write `manifest.json`:

```json
{
  "sourceId": "cc-cedict",
  "sourceName": "CC-CEDICT",
  "sourceUrl": "https://www.mdbg.net/chinese/dictionary?page=cc-cedict",
  "sourceVersion": "2026-08-01",
  "retrievedAt": "2026-08-15T10:00:00Z",
  "licenseSpdx": "CC-BY-SA-4.0",
  "licenseUrl": "https://creativecommons.org/licenses/by-sa/4.0/",
  "author": "MDBG",
  "attributionText": "CC-CEDICT, by MDBG, licensed CC BY-SA 4.0",
  "redistributionAllowed": true,
  "derivativeAllowed": true,
  "files": [
    { "path": "cedict_1_0_ts_utf-8_mdbg.txt.gz", "role": "dictionary" }
  ]
}
```

`sha256` is optional per file; when present it is verified against the bytes.

```bash
npm run content:import:cedict
```

---

## 2. Human audio — `sources/inbox/audio/`

**This is the actual Stage 2 blocker** (spec p.28: "60 licensed lexemes with
clear human audio").

```
sources/inbox/audio/
    manifest.json      provenance for the batch
    candidates.json    per-recording metadata (array)
    files/…            the recordings
```

Recordings must be **PCM WAV** so the signal screening can decode them. Convert
first if needed:

```bash
ffmpeg -i clip.ogg -ac 1 -ar 16000 -sample_fmt s16 files/bank.n.01.wav
```

`manifest.json` follows the same shape as above (`"sourceId": "audio"`, with
`files` declaring at least `{ "path": "candidates.json", "role": "candidates" }`).

`candidates.json` is an array. **The audio licence belongs to the recording and
is never inherited — not from a sentence, and not from the batch manifest.** A
recording whose own terms are narrower than the batch keeps its own terms; one
claiming more than the batch grants is rejected for human review.

Set `upstreamFamily` if you know it (`common-voice-zh-CN`, `thchs-30`,
`wikimedia-commons`, `tatoeba`, `original-recording`); otherwise it is inferred
from `source`, and left unset if `source` matches no known family. It is never
defaulted to `original-recording`.

```json
[
  {
    "file": "files/bank.n.01.wav",
    "lexemeId": "bank.n.01",
    "transcript": "银行",
    "language": "cmn",
    "region": "zh-CN",
    "speaker": "cv-zh-0001",
    "source": "Common Voice zh-CN",
    "upstreamId": "common_voice_zh-CN_12345678",
    "upstreamUrl": "https://commonvoice.mozilla.org/",
    "licenseSpdx": "CC0-1.0",
    "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
    "attributionText": "Mozilla Common Voice zh-CN (CC0)",
    "redistributionAllowed": true,
    "derivativeAllowed": true,
    "sha256": "optional-64-hex",
    "syllables": 2
  }
]
```

Rejected automatically: missing/unknown licence, `-NC`, `-ND` (the pipeline
normalises and transcodes, which no-derivatives forbids), no redistribution
grant, a licence conflicting with the batch manifest, a path escaping the source
directory, missing file, hash mismatch, undecodable audio, and failed signal
screening (clipping, noise floor, silence, implausible duration).

Refused at certification: an unknown lexeme id, a sentence recording offered as
lexeme-level canonical audio, a transcript that disagrees with the pack's surface
form, two certified recordings for one lexeme, and any recording without a
hash-bound review.

```bash
npm run content:import:audio
```

Accepted recordings are stored as **human** assets in state `unverified`.
Promotion to canonical requires a human review — see below.

### 2a. Reviewing recordings — `sources/review/audio/reviews.json`

Signal QA measures whether a recording is technically usable. It cannot establish
that a human said it, that they said the right word, that it is segmented
correctly, or that the rights are clear. Those stay reviewer decisions, recorded
on disk so a release is reproducible and auditable.

```bash
npm run content:audio:review                  # worklist: what needs a decision
npm run content:audio:review -- --emit-templates   # blank records to fill in
```

That writes `sources/review/audio/reviews.template.json`. Fill in the
declarations and merge them into `sources/review/audio/reviews.json`:

```json
[
  {
    "lexemeId": "bank.n.01",
    "audioSha256": "3a84a228…64 hex chars…",
    "humanRecorded": true,
    "transcriptMatches": true,
    "segmentationVerified": true,
    "licenceAndConsentClear": true,
    "reviewedBy": "your-name-or-id",
    "reviewedAt": "2026-08-15T12:00:00Z",
    "notes": ""
  }
]
```

**The review is bound to `audioSha256`, never to the lexeme id.** Replace the WAV
and the old review stops applying: the candidate drops back to `unverified` and
must be reviewed again. Every one of the four booleans is required — none is
inferred, and any `false` blocks certification.

If two recordings for the same lexeme both carry reviews, certification refuses
both rather than picking one. Delete the review of the one you do not want; the
remaining review *is* your selection.

```bash
npm run content:audio:certify
```

This applies the reviews, reports every rejection with a reason, and writes
`sources/review/audio/certified.json`. `npm run build:pack` then compiles that
certified set into the release: each recording is copied to
`audio/<sha256>.wav` inside the pack, and its hash becomes part of the pack's
`contentHash` — so changing a recording necessarily mints a new pack version.

---

## 3. Tatoeba — `sources/inbox/tatoeba/`

*Optional for Stage 2.* Download the official exports from
<https://downloads.tatoeba.org/exports/> and declare them by role:

| Role | File |
| --- | --- |
| `sentences` | `sentences.csv` (id ⇥ lang ⇥ text) |
| `sentences_detailed` | `sentences_detailed.csv` (adds contributor + licence) |
| `links` | `links.csv` (sentenceId ⇥ translationId) |
| `sentences_with_audio` | `sentences_with_audio.csv` |

`.bz2`/`.tar.bz2` archives must be extracted first; `.gz` is handled directly.

```bash
npm run content:import:tatoeba
```

An audio row whose **own** licence field is empty or unknown is rejected. Rights
are never inferred from the sentence licence.

---

## 4. HSK — `sources/inbox/hsk/`

**Not a Stage 2 gate.** The binding spec (p.28) says "Keep HSK reporting
separate", and p.9 says HSK "never decides readiness". `hskLevel = undefined` is
a permanently valid state and Dyr teaches Mandarin without it.

No HSK vocabulary data is bundled, because no source with established
redistribution rights has been supplied — see `docs/SOURCE_AUDIT.md` (the
commonly-suggested repository's word lists are Pleco-derived and were rejected).

To plug one in later, implement the `HskLevelSource` adapter:

```ts
interface HskLevelSource {
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly licence: string;
  readonly provenance: SourceManifest;
  entries(): Iterable<HskLevelEntry>;   // { simplified, publishedBand: "1".."9" | "7-9" }
}
```

`resolveHskMapping(source, lexemes)` maps it onto Dyr lexeme ids. A combined
`"7-9"` band is preserved exactly as published.
