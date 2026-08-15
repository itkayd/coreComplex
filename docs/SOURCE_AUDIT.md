# Source audit

Every candidate content source is audited **per component** before anything is
imported. A repository is not one legal object: a single repo routinely mixes
CC BY-SA data with material that cannot be redistributed at all.

The decisions below are executable, not prose — `auditSource()` in
`packages/content/src/import/hsk.ts` reproduces them, and
`import.test.ts` asserts them.

---

## krmanik/HSK-3.0 — **HSK word lists REJECTED**

- Repository: <https://github.com/krmanik/HSK-3.0>
- Audited: 2026-08, against the repository's own `License.md`
- Verdict: **partially rejected — the HSK 3.0 word lists cannot be bundled**

The repository's `License.md` declares its components as:

| Component | Declared licence | Declared origin | Verdict |
| --- | --- | --- | --- |
| **HSK 3.0 word lists** | MIT | **Pleco** (plecoforums.com) | **REJECT** |
| HSK 3.0 official syllabus | *(none stated)* | moe.gov.cn / hsk.cn | **REJECT** |
| CC-CEDICT extract | CC BY-SA 4.0 | CC-CEDICT | admit |
| SUBTLEX-CH frequency | CC BY-SA 4.0 | openlexicon | admit |

### Why the word lists are rejected

1. **Pleco origin.** The spec denies Pleco-derived material outright — p.7
   DEFAULT PACK DENY lists "Any Pleco dictionary, audio, example or HSK data",
   and p.22 PLECO BOUNDARY says Pleco is "a UX benchmark or optional handoff
   only. Never scrape, import, transcribe or reconstruct its dictionaries,
   examples, HSK metadata, audio or add-ons."
2. **An MIT wrapper does not launder the origin.** A permissive licence applied
   to a redistribution cannot grant rights the redistributor never held.
3. **No per-file provenance.** The repository has a single root licence file
   covering ~11 000 files. There is no per-directory manifest that would let the
   CC BY-SA components be separated from the Pleco-derived lists with confidence.

Under the standing rule — *if uncertain, do not import* — the word lists go to
human review rather than into a pack.

### Why the official syllabus is also rejected

The HSK 3.0 standard itself is a Chinese Ministry of Education publication with
no stated redistribution licence. Spec p.22 OFFICIAL HSK: "Consult for external
reporting. Do not bundle lists until redistribution rights and exact provenance
are established." That condition is not met.

### Consequence

**HSK level metadata is not currently bundled.** The level *model* exists and is
tested (nine levels, three stages, published bands preserved), so a properly
licensed source can be imported without redesign. What is missing is a source,
not code.

### Routes to a usable HSK source

1. Obtain written permission for a specific list, recording it as a
   `SourceAsset` with the grant referenced.
2. Find a wordlist whose provenance traces to the published standard with clear
   redistribution terms.
3. Derive levels from an openly licensed frequency/graded corpus and label them
   as Dyr's own estimate — explicitly *not* "official HSK".

---

## CC-CEDICT — admitted, parser implemented, dump not bundled

- Source: <https://www.mdbg.net/chinese/dictionary?page=cc-cedict>
- Licence: **CC BY-SA 4.0** — on the allowlist
- Verdict: **admit**

A faithful parser for the canonical `cedict_ts.u8` format is implemented and
tested (traditional/simplified/numbered pinyin/senses, classifier metadata kept
separate, heteronyms preserved as distinct entries, malformed lines rejected with
reasons). The dump itself is **not** bundled in this repository yet.

> **Environment note.** `mdbg.net` is unreachable from this build sandbox (the
> network policy permits package registries and GitHub only), so the dump could
> not be downloaded and compiled here. On an unrestricted machine the download is
> one step; the parser is the durable part and is ready for it.

Attribution obligation if bundled: CC BY-SA 4.0 requires attribution **and**
share-alike on derived dictionary data — recorded automatically by the
attribution generator.

---

## Tatoeba — not yet imported

- Source: <https://tatoeba.org> (dumps at `downloads.tatoeba.org`)
- Sentence licence: predominantly CC BY 2.0 FR, some CC0 — **per sentence**
- Audio licence: **separate from the sentence licence, per recording**
- Verdict: **pending** — importer contracts and quality screening implemented
  (`screenSentence`), ingestion not run.

> **Environment note.** `downloads.tatoeba.org` is unreachable from this sandbox.

The rule that must survive implementation: **a reusable sentence never implies a
reusable recording.** Sentence and audio are separate assets with separate
licences, and audio with missing / UNKNOWN / NC / ND / unclear terms is rejected.

---

## Standing admission rules

Allowed: `CC0-1.0`, `CC-BY-4.0`, `CC-BY-SA-4.0`, `MIT`, `Apache-2.0`,
`Unicode-DFS-2016`.

Rejected outright: missing or `UNKNOWN` licence; any `-NC` or `-ND` variant;
Pleco-derived data; unestablished official-HSK material; scraped or reconstructed
commercial content; free-to-view-only sources.

Anything else: **human review**, never a guess.
