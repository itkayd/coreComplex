# Source inbox — supplying content offline

Network access is **never** required to compile a release pack. Sources are
acquired externally, dropped in here, and compiled from an immutable local
snapshot. That is what makes a release reproducible: the pack depends on files
with known hashes, not on whatever an upstream API returned that day.

```
sources/inbox/<sourceId>/
    manifest.json      provenance + declared files (REQUIRED)
    <files…>           the actual downloaded data
```

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

`candidates.json` is an array. **The audio licence is a separate asset from any
sentence licence and is never inherited:**

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
grant, missing file, hash mismatch, undecodable audio, and failed signal
screening (clipping, noise floor, silence, implausible duration).

```bash
npm run content:import:audio
```

Accepted recordings are stored as **human** assets in state `unverified`.
Promotion to canonical still requires the reviewer declarations the gate demands:
human-recorded, transcript match, segmentation verified, licence and consent
clear. No importer can self-certify those.

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
