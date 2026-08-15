# ADR-0011 — Canonical audio: hash-bound review, content addressing, pack identity

Status: accepted
Date: 2026-08-15

## Context

The specification makes human-recorded Mandarin canonical and forbids fabricating
it (p.21), and Stage 2 requires "60 licensed lexemes with clear human audio"
(p.28). Before this change the pieces existed but were not connected:

- `importAudioCandidates()` produced candidate assets and `certifyCandidate()`
  could return a verified one, but `buildCore60Pack()` ignored both and always
  emitted `declared` audio. Nothing a reviewer did could reach a release.
- The reviewer declarations existed only as function arguments, so a release
  depended on state no one could inspect, diff or reproduce.
- `AudioAsset` carried no runtime location, so metadata could say a recording was
  verified while the browser had no way to play it.
- The pack's `contentHash` covered only lexical JSON, so audio could be swapped
  without changing pack identity — the hash would still verify.
- Every imported recording was labelled `upstream: "original-recording"`,
  discarding the provenance the licence gate depends on.

## Decision

**1. Certification is an explicit build input.**
`buildCore60Pack({ canonicalAudio })` takes a certified set. The compiler never
searches the filesystem; exactly one place (`loadReleaseAudio()`) decides where
audio comes from. A different set produces a different content hash and therefore
a new pack version — released packs are never mutated in place (p.15).

**2. Reviews are persistent and bound to bytes, not to lexeme ids.**
`sources/review/audio/reviews.json` records the four declarations no measurement
can establish, each against the recording's `sha256`. Re-record a clip and the
old review stops applying: the candidate returns to `unverified`. Binding to a
lexeme id instead would let a pack silently acquire audio nobody reviewed, which
is precisely the failure the canonical rule exists to prevent.

**3. Objective screening and human judgement stay separate.**
Signal QA measures clipping, noise floor, silence and pace. Passing it means a
recording is technically usable — never that a human said it, said the right
word, segmented it correctly, or holds the rights. Certification requires both.

**4. Runtime audio is content-addressed.**
A certified recording ships at `audio/<sha256>.<ext>`, pack-relative. This is not
only deduplication: a path containing `bank.n.01` would hand the answer to a
listening task through the network panel, the HTTP cache, or a screen reader
announcing a filename. No build-machine path is ever exposed to the client.

**5. Canonical audio hashes are part of pack identity.**
`contentDigestInput()` includes `(lexeme, runtime.sha256)` for every verified,
non-synthetic recording. Only verified rows contribute, so a pack gains identity
change exactly once — when a real recording arrives. The browser verifier uses
the same definition, so build and client cannot drift.

**6. Provenance is preserved end to end.**
`AudioProvenance` records the supplier's `sourceName` verbatim plus an optional
approved-family classification, which is inferred from the source name only when
it matches a known family and is otherwise left absent. Rights are never inferred:
a recording's own licence governs, a broad batch manifest cannot widen it, and a
recording claiming more than its batch grants is escalated rather than resolved.

**7. Failure is refusal, never substitution.**
A missing, corrupted, mis-targeted, duplicated, uncertified or synthetic
recording produces no canonical audio. At plan time the kernel refuses
audio-primary tasks with `missing_canonical_audio`; at run time a failed hash
check makes the task unanswerable and writes no event. CosyVoice is never a
fallback for a listening cue (ADR-0010).

## Consequences

- Adding or changing a recording necessarily mints a new pack version. This is
  the intended cost of immutability, and it makes "which audio shipped in this
  version" answerable from the version string alone.
- A reviewer must re-review a re-recorded clip. Deliberate.
- The browser fetches and hashes a recording before playing it, costing one
  digest per clip. Worth it: without it, pack integrity would be a promise about
  bytes nobody checked at the point of use.
- Development can prove the whole path before licensed recordings exist, using a
  generated fixture flagged `provenance.fixture`. The production build refuses
  flagged assets (`AudioRefused`), so the fixture cannot inflate canonical
  coverage; `canonical-audio.test.ts` asserts that refusal in both directions.
