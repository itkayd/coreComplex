/**
 * The canonical-audio vertical slice, from supplied bytes to release pack.
 *
 * These tests are about REFUSAL as much as delivery. A pipeline that ships a
 * recording is easy; one that reliably declines a tampered, uncertified,
 * synthetic, mislicensed, mis-targeted or missing recording is the thing the
 * canonical-audio rule actually asks for.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { makeFixtureWav } from "../../../../fixtures/audio/make-fixture.ts";
import { buildCore60Pack, AudioRefused } from "../pipeline.ts";
import { writePack, AudioIntegrityError } from "../write.ts";
import { exportPack } from "../export.ts";
import { loadVerifiedPack, canonicalAudioDigestRows } from "../validate.ts";
import { resolveCanonicalAudio, audioUrl, packAudioUrls, lexemeFromAudioRef } from "../audio-runtime.ts";
import { isCanonical, classifyUpstream } from "../audio.ts";
import { packAssetProvider } from "../provider.ts";
import { evaluateAudioCandidate, type AudioCandidate } from "./importers.ts";
import { certifyAudioSet, normaliseTranscript, transcriptMatchesTarget, runtimeRefFor } from "./certify.ts";
import { core60Targets } from "./release.ts";
import { loadReviews, validateReview, type AudioReview, type ReviewStore } from "./review.ts";
import { resolveInside } from "./inbox.ts";
import { LexemeId } from "@dyr/domain";

const LEXEME = "bank.n.01";
const TRANSCRIPT = "银行";

// --- helpers ---------------------------------------------------------------

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "dyr-audio-"));
  mkdirSync(join(dir, "files"), { recursive: true });
  return dir;
}

function stageWav(dir: string, name = "fixture.wav", wav = makeFixtureWav({ syllables: 2 })): { path: string; sha256: string; bytes: number } {
  writeFileSync(join(dir, "files", name), wav);
  return { path: `files/${name}`, sha256: createHash("sha256").update(wav).digest("hex"), bytes: wav.length };
}

function candidate(over: Partial<AudioCandidate> = {}): AudioCandidate {
  return {
    file: "files/fixture.wav",
    lexemeId: LEXEME,
    transcript: TRANSCRIPT,
    language: "cmn",
    region: "zh-CN",
    speaker: "cv-zh-0001",
    source: "Mozilla Common Voice zh-CN",
    upstreamId: "common_voice_zh-CN_12345678",
    upstreamUrl: "https://commonvoice.mozilla.org/",
    licenseSpdx: "CC0-1.0",
    redistributionAllowed: true,
    derivativeAllowed: true,
    syllables: 2,
    ...over,
  };
}

function reviewStore(reviews: AudioReview[]): ReviewStore {
  return { present: true, path: "(test)", reviews, issues: [] };
}

function review(audioSha256: string, over: Partial<AudioReview> = {}): AudioReview {
  return {
    lexemeId: LEXEME,
    audioSha256,
    humanRecorded: true,
    transcriptMatches: true,
    segmentationVerified: true,
    licenceAndConsentClear: true,
    reviewedBy: "test-reviewer",
    reviewedAt: "2026-08-15T00:00:00.000Z",
    ...over,
  };
}

/** The whole path: staged bytes → certified set. */
function certifyOne(dir: string, over: Partial<AudioCandidate> = {}, reviews?: AudioReview[]) {
  const staged = stageWav(dir);
  const result = evaluateAudioCandidate(candidate({ ...over }), dir);
  return {
    staged,
    result,
    set: certifyAudioSet([result], {
      targets: core60Targets(),
      reviews: reviewStore(reviews ?? [review(staged.sha256)]),
    }),
  };
}

// --- 1. candidate path security -------------------------------------------

test("a candidate path escaping the source directory is refused before any read", () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, "outside.wav"), makeFixtureWav());
    for (const escape of ["../outside.wav", "../../outside.wav", "files/../../outside.wav"]) {
      const result = evaluateAudioCandidate(candidate({ file: escape }), join(dir, "inner"));
      assert.ok(result.rejections.includes("file_path_escape"), `${escape} was not refused`);
      assert.equal(result.sha256, undefined, `${escape} was read despite escaping`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an absolute candidate path is refused", () => {
  const dir = scratch();
  try {
    const staged = stageWav(dir);
    const result = evaluateAudioCandidate(candidate({ file: join(dir, staged.path) }), dir);
    assert.ok(result.rejections.includes("file_path_escape"));
    // Windows-style drive letters and UNC paths too, on any platform.
    for (const p of ["C:\\evil.wav", "\\\\host\\share\\evil.wav"]) {
      assert.equal(resolveInside(dir, p).ok, false, `${p} was accepted`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a symlink pointing outside the source directory is refused", () => {
  const dir = scratch();
  const outside = mkdtempSync(join(tmpdir(), "dyr-outside-"));
  try {
    writeFileSync(join(outside, "secret.wav"), makeFixtureWav());
    symlinkSync(join(outside, "secret.wav"), join(dir, "files", "link.wav"));
    const result = evaluateAudioCandidate(candidate({ file: "files/link.wav" }), dir);
    assert.ok(result.rejections.includes("file_path_escape"), result.rejections.join(","));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("an ordinary relative path inside the directory is accepted", () => {
  const dir = scratch();
  try {
    stageWav(dir);
    const result = evaluateAudioCandidate(candidate(), dir);
    assert.equal(result.accepted, true, result.detail.join("; "));
    assert.ok(result.absolutePath?.startsWith(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- 2. review binding -----------------------------------------------------

test("a review bound to the exact bytes certifies; a review of other bytes does not", () => {
  const dir = scratch();
  try {
    const matched = certifyOne(dir);
    assert.equal(matched.set.entries.length, 1, JSON.stringify(matched.set.outcomes));
    assert.equal(matched.set.entries[0].asset.state, "verified");

    // Same lexeme, same reviewer, different bytes: not evidence about this clip.
    const mismatched = certifyOne(dir, {}, [review("b".repeat(64))]);
    assert.equal(mismatched.set.entries.length, 0);
    assert.deepEqual(mismatched.set.outcomes[0].codes, ["not_reviewed"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("re-recording the clip invalidates the old review — certification is never by lexeme id", () => {
  const dir = scratch();
  try {
    const first = stageWav(dir, "fixture.wav", makeFixtureWav({ syllables: 2 }));
    const store = reviewStore([review(first.sha256)]);

    // The operator replaces the file with a different recording of the same word.
    const second = stageWav(dir, "fixture.wav", makeFixtureWav({ syllables: 2, baseHz: 240 }));
    assert.notEqual(second.sha256, first.sha256);

    const result = evaluateAudioCandidate(candidate(), dir);
    const set = certifyAudioSet([result], { targets: core60Targets(), reviews: store });
    assert.equal(set.entries.length, 0, "an old review certified new bytes");
    assert.deepEqual(set.outcomes[0].codes, ["not_reviewed"]);
    assert.equal(set.stale.length, 1, "the superseded review should be reported as stale");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a reviewer who declines any declaration blocks certification", () => {
  const dir = scratch();
  try {
    for (const key of ["humanRecorded", "transcriptMatches", "segmentationVerified", "licenceAndConsentClear"] as const) {
      const staged = stageWav(dir);
      const result = evaluateAudioCandidate(candidate(), dir);
      const set = certifyAudioSet([result], {
        targets: core60Targets(),
        reviews: reviewStore([review(staged.sha256, { [key]: false })]),
      });
      assert.equal(set.entries.length, 0, `${key}: false still certified`);
      assert.deepEqual(set.outcomes[0].codes, ["review_declined"]);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("passing signal QA alone never certifies — a human declaration is required", () => {
  const dir = scratch();
  try {
    const result = evaluateAudioCandidate(candidate(), dir === "" ? dir : (stageWav(dir), dir));
    assert.equal(result.accepted, true);
    assert.equal(result.screening?.passed, true, "the fixture should pass objective screening");
    const set = certifyAudioSet([result], { targets: core60Targets(), reviews: reviewStore([]) });
    assert.equal(set.entries.length, 0);
    assert.deepEqual(set.outcomes[0].codes, ["not_reviewed"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("review records require every declaration explicitly", () => {
  const partial = { lexemeId: LEXEME, audioSha256: "a".repeat(64), humanRecorded: true, reviewedBy: "x", reviewedAt: "2026-01-01T00:00:00Z" };
  const result = validateReview(partial, "[0]");
  assert.equal(result.valid, false);
  const paths = (result as { issues: { path: string }[] }).issues.map((i) => i.path);
  assert.ok(paths.includes("[0].transcriptMatches"));
  assert.ok(paths.includes("[0].licenceAndConsentClear"));
});

test("an absent reviews file is a state, not a crash", () => {
  const store = loadReviews(join(tmpdir(), "dyr-no-such-review-dir"));
  assert.equal(store.present, false);
  assert.deepEqual(store.reviews, []);
  assert.deepEqual(store.issues, []);
});

// --- 3. provenance preservation -------------------------------------------

test("a Common Voice recording does not emerge labelled 'original-recording'", () => {
  const dir = scratch();
  try {
    const { set } = certifyOne(dir);
    const asset = set.entries[0].asset;
    assert.equal(asset.provenance?.sourceName, "Mozilla Common Voice zh-CN");
    assert.equal(asset.provenance?.upstream, "common-voice-zh-CN");
    assert.notEqual(asset.upstream, "original-recording");
    assert.equal(asset.provenance?.upstreamId, "common_voice_zh-CN_12345678");
    assert.equal(asset.provenance?.upstreamUrl, "https://commonvoice.mozilla.org/");
    assert.equal(asset.provenance?.licenseSpdx, "CC0-1.0");
    assert.equal(asset.provenance?.speaker, "cv-zh-0001");
    assert.equal(asset.provenance?.region, "zh-CN");
    assert.equal(asset.provenance?.language, "cmn");
    assert.equal(asset.provenance?.sourceSha256, set.entries[0].asset.runtime?.derivedFrom);
    assert.equal(asset.review?.reviewedBy, "test-reviewer");
    assert.equal(asset.review?.audioSha256, asset.sha256);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an unrecognised source stays unclassified rather than being guessed", () => {
  const dir = scratch();
  try {
    const { set } = certifyOne(dir, { source: "A regional broadcaster archive" });
    assert.equal(set.entries[0].asset.provenance?.sourceName, "A regional broadcaster archive");
    assert.equal(set.entries[0].asset.provenance?.upstream, undefined);
    assert.equal(classifyUpstream("A regional broadcaster archive"), undefined);
    assert.equal(classifyUpstream("Wikimedia Commons"), "wikimedia-commons");
    assert.equal(classifyUpstream("Tatoeba audio"), "tatoeba");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the source→runtime relationship is preserved with explicit hashes", () => {
  const ref = runtimeRefFor("a".repeat(64), 1234, "files/x.wav");
  assert.equal(ref.path, `audio/${"a".repeat(64)}.wav`);
  assert.equal(ref.derivedFrom, ref.sha256, "untransformed bytes derive from themselves");
  assert.equal(ref.transform, "none");
  assert.equal(ref.mediaType, "audio/wav");
  assert.equal(runtimeRefFor("b".repeat(64), 1, "x.opus").mediaType, "audio/opus");
  // Content-addressed: the path leaks no lexeme id and so no listening answer.
  assert.ok(!ref.path.includes(LEXEME));
});

// --- 4. licence rules ------------------------------------------------------

test("a broad batch grant cannot upgrade a recording whose own terms are narrower", () => {
  const dir = scratch();
  try {
    stageWav(dir);
    const batch = { licenseSpdx: "CC0-1.0", redistributionAllowed: true, derivativeAllowed: true };
    const result = evaluateAudioCandidate(candidate({ redistributionAllowed: false }), dir, batch);
    assert.equal(result.accepted, false);
    assert.ok(result.rejections.includes("licence_not_redistributable"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a recording claiming more than its batch is escalated, not resolved", () => {
  const dir = scratch();
  try {
    stageWav(dir);
    const batch = { licenseSpdx: "CC-BY-SA-4.0", redistributionAllowed: false, derivativeAllowed: false };
    const result = evaluateAudioCandidate(candidate(), dir, batch);
    assert.equal(result.accepted, false);
    assert.ok(result.rejections.includes("licence_conflicts_with_batch"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("missing, NC and ND audio licences are all refused", () => {
  const dir = scratch();
  try {
    stageWav(dir);
    const cases: [Partial<AudioCandidate>, string][] = [
      [{ licenseSpdx: "" }, "licence_missing"],
      [{ licenseSpdx: "UNKNOWN" }, "licence_missing"],
      [{ licenseSpdx: "CC-BY-NC-4.0" }, "licence_non_commercial"],
      [{ licenseSpdx: "CC-BY-ND-4.0" }, "licence_no_derivatives"],
    ];
    for (const [over, code] of cases) {
      const result = evaluateAudioCandidate(candidate(over), dir);
      assert.ok(result.rejections.includes(code as never), `${JSON.stringify(over)} → ${result.rejections.join(",")}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- 5. targeting ----------------------------------------------------------

test("a recording for an unknown lexeme cannot count toward Core 60 coverage", () => {
  const dir = scratch();
  try {
    const { set } = certifyOne(dir, { lexemeId: "not-a-real-lexeme.n.01" });
    assert.equal(set.entries.length, 0);
    assert.deepEqual(set.outcomes[0].codes, ["unknown_target"]);
    assert.equal(set.missing.length, 60, "coverage must be unaffected by an off-target recording");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a sentence recording cannot stand in for lexeme-level canonical audio", () => {
  const dir = scratch();
  try {
    const staged = stageWav(dir);
    const result = evaluateAudioCandidate(candidate({ lexemeId: undefined, sentenceId: "tatoeba:12345" }), dir);
    assert.equal(result.accepted, true, "it is a valid asset — just not a lexeme's canonical audio");
    const set = certifyAudioSet([result], {
      targets: core60Targets(),
      reviews: reviewStore([review(staged.sha256, { lexemeId: "tatoeba:12345" })]),
    });
    assert.equal(set.entries.length, 0);
    assert.deepEqual(set.outcomes[0].codes, ["unknown_target"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a transcript that disagrees with the pack's surface form is refused", () => {
  const dir = scratch();
  try {
    const { set } = certifyOne(dir, { transcript: "医院" });
    assert.equal(set.entries.length, 0);
    assert.deepEqual(set.outcomes[0].codes, ["transcript_mismatch"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("transcript normalisation folds whitespace and punctuation but never simplified/traditional", () => {
  assert.equal(normaliseTranscript(" 银行。"), "银行");
  assert.equal(normaliseTranscript("银　行"), "银行");
  const target = { lexemeId: LEXEME, simplified: "银行", variants: ["銀行"] };
  assert.equal(transcriptMatchesTarget("银行", target), true);
  // Accepted only because the pack DECLARES it as a variant — never by conversion.
  assert.equal(transcriptMatchesTarget("銀行", target), true);
  assert.equal(transcriptMatchesTarget("銀行", { lexemeId: LEXEME, simplified: "银行" }), false);
});

test("two certified recordings for one lexeme are refused, not silently ordered", () => {
  const dir = scratch();
  try {
    const a = stageWav(dir, "a.wav", makeFixtureWav({ syllables: 2 }));
    const b = stageWav(dir, "b.wav", makeFixtureWav({ syllables: 2, baseHz: 240 }));
    const results = [
      evaluateAudioCandidate(candidate({ file: "files/a.wav" }), dir),
      evaluateAudioCandidate(candidate({ file: "files/b.wav" }), dir),
    ];
    const set = certifyAudioSet(results, {
      targets: core60Targets(),
      reviews: reviewStore([review(a.sha256), review(b.sha256)]),
    });
    assert.deepEqual(set.duplicates, [LEXEME]);
    assert.equal(set.entries.length, 0, "neither may be picked");
    assert.ok(set.outcomes.every((o) => !o.certified));

    // Removing one review is the reviewer's explicit selection.
    const chosen = certifyAudioSet(results, { targets: core60Targets(), reviews: reviewStore([review(a.sha256)]) });
    assert.equal(chosen.entries.length, 1);
    assert.equal(chosen.entries[0].asset.sha256, a.sha256);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- 6. pack merge and identity -------------------------------------------

test("a certified asset reaches the production RuntimePack as canonical audio", () => {
  const dir = scratch();
  try {
    const { set } = certifyOne(dir);
    const report = buildCore60Pack({ canonicalAudio: set.entries, allowFixtureAudio: true });
    const asset = report.pack.audio.get(LEXEME);
    assert.ok(asset, "the lexeme has no audio entry");
    assert.equal(asset.state, "verified");
    assert.equal(isCanonical(asset), true);
    assert.equal(asset.provenance?.sourceName, "Mozilla Common Voice zh-CN");
    assert.ok(asset.runtime?.path.startsWith("audio/"));
    assert.deepEqual(report.audioFiles.map((f) => f.path), [asset.runtime!.path]);
    // Every other lexeme stays honestly declared.
    assert.equal(report.audioPending.length, 59);
    assert.equal(report.pack.audio.get("water.n.01")?.state, "declared");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the asset provider reports canonical audio only for the certified lexeme", () => {
  const dir = scratch();
  try {
    const { set } = certifyOne(dir);
    const report = buildCore60Pack({ canonicalAudio: set.entries, allowFixtureAudio: true });
    const provider = packAssetProvider(report.pack);
    assert.equal(provider.hasCanonicalAudio(LexemeId(LEXEME)), true);
    assert.equal(provider.hasTranscript(LexemeId(LEXEME)), true);
    assert.equal(provider.hasCanonicalAudio(LexemeId("water.n.01")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("changing the canonical recording changes the pack's identity", () => {
  const dir = scratch();
  try {
    const first = certifyOne(dir).set;
    const plain = buildCore60Pack();
    const withA = buildCore60Pack({ canonicalAudio: first.entries, allowFixtureAudio: true });

    const second = stageWav(dir, "fixture.wav", makeFixtureWav({ syllables: 2, baseHz: 300 }));
    const resultB = evaluateAudioCandidate(candidate(), dir);
    const setB = certifyAudioSet([resultB], { targets: core60Targets(), reviews: reviewStore([review(second.sha256)]) });
    const withB = buildCore60Pack({ canonicalAudio: setB.entries, allowFixtureAudio: true });

    assert.notEqual(withA.pack.contentHash, plain.pack.contentHash, "adding audio must change identity");
    assert.notEqual(withA.pack.contentHash, withB.pack.contentHash, "swapping the recording must change identity");
    assert.notEqual(String(withA.pack.packVersion), String(withB.pack.packVersion));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the same inputs always produce the same pack — audio included", () => {
  const dir = scratch();
  try {
    const { set } = certifyOne(dir);
    const a = buildCore60Pack({ canonicalAudio: set.entries, allowFixtureAudio: true });
    const b = buildCore60Pack({ canonicalAudio: [...set.entries], allowFixtureAudio: true });
    assert.equal(a.pack.contentHash, b.pack.contentHash);
    assert.equal(JSON.stringify(exportPack(a.pack)), JSON.stringify(exportPack(b.pack)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the exported pack still verifies, and a swapped audio hash does not", async () => {
  const dir = scratch();
  try {
    const { set } = certifyOne(dir);
    const report = buildCore60Pack({ canonicalAudio: set.entries, allowFixtureAudio: true });
    const exported = JSON.parse(JSON.stringify(exportPack(report.pack)));
    await loadVerifiedPack(exported);

    const tampered = JSON.parse(JSON.stringify(exported));
    tampered.audio.find((a: { state: string }) => a.state === "verified").runtime.sha256 = "0".repeat(64);
    await assert.rejects(() => loadVerifiedPack(tampered), /integrity/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("only verified, non-synthetic assets with bytes contribute to pack identity", () => {
  const rows = canonicalAudioDigestRows([
    { lexeme: "a", state: "verified", runtime: { sha256: "1".repeat(64) } },
    { lexeme: "b", state: "declared" },
    { lexeme: "c", state: "verified", synthetic: true, runtime: { sha256: "2".repeat(64) } },
    { lexeme: "d", state: "unverified", runtime: { sha256: "3".repeat(64) } },
    { lexeme: "e", state: "verified" },
  ]);
  assert.deepEqual(rows.map((r) => r.lexeme), ["a"]);
});

// --- 7. refusals at build time --------------------------------------------

test("the production build refuses fixture audio; only the fixture builder opts in", () => {
  const dir = scratch();
  try {
    const { set } = certifyOne(dir, { fixture: true });
    assert.equal(set.entries[0].asset.provenance?.fixture, true);
    assert.throws(() => buildCore60Pack({ canonicalAudio: set.entries }), AudioRefused);
    assert.doesNotThrow(() => buildCore60Pack({ canonicalAudio: set.entries, allowFixtureAudio: true }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("synthetic audio can never enter the canonical set", () => {
  const dir = scratch();
  try {
    const { set } = certifyOne(dir);
    const synthetic = { ...set.entries[0], asset: { ...set.entries[0].asset, synthetic: true } };
    assert.throws(() => buildCore60Pack({ canonicalAudio: [synthetic], allowFixtureAudio: true }), /synthetic/);
    assert.equal(isCanonical(synthetic.asset), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an unverified or byte-less asset cannot be compiled into a release", () => {
  const dir = scratch();
  try {
    const { set } = certifyOne(dir);
    const base = set.entries[0];
    assert.throws(
      () => buildCore60Pack({ canonicalAudio: [{ ...base, asset: { ...base.asset, state: "unverified" } }], allowFixtureAudio: true }),
      /not verified/,
    );
    assert.throws(
      () => buildCore60Pack({ canonicalAudio: [{ ...base, asset: { ...base.asset, runtime: undefined } }], allowFixtureAudio: true }),
      /no runtime bytes/,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("audio that changed between certification and build fails the release", () => {
  const dir = scratch();
  const out = mkdtempSync(join(tmpdir(), "dyr-out-"));
  try {
    const { set } = certifyOne(dir);
    const report = buildCore60Pack({ canonicalAudio: set.entries, allowFixtureAudio: true });
    // Someone edits the recording after it was certified.
    stageWav(dir, "fixture.wav", makeFixtureWav({ syllables: 2, baseHz: 260 }));
    assert.throws(() => writePack(report, out), AudioIntegrityError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("writing a release emits the pack JSON and the content-addressed audio", () => {
  const dir = scratch();
  const out = mkdtempSync(join(tmpdir(), "dyr-out-"));
  try {
    const { set } = certifyOne(dir);
    const report = buildCore60Pack({ canonicalAudio: set.entries, allowFixtureAudio: true });
    const written = writePack(report, out);
    assert.equal(written.audioFiles.length, 1);
    assert.ok(written.audioFiles[0].endsWith(`${set.entries[0].asset.sha256}.wav`));
    assert.equal(written.bytesWritten, set.entries[0].asset.runtime!.bytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

// --- 8. runtime resolution -------------------------------------------------

test("a listening task resolves exactly the asset its contract names", () => {
  const dir = scratch();
  try {
    const { set } = certifyOne(dir);
    const report = buildCore60Pack({ canonicalAudio: set.entries, allowFixtureAudio: true });

    const resolved = resolveCanonicalAudio(report.pack, [`audio:${LEXEME}`]);
    assert.equal(resolved?.lexeme, LEXEME);
    // A lexeme with no certified recording resolves to nothing — the UI must not
    // be able to substitute a different word's audio.
    assert.equal(resolveCanonicalAudio(report.pack, ["audio:water.n.01"]), undefined);
    assert.equal(resolveCanonicalAudio(report.pack, []), undefined);
    assert.equal(lexemeFromAudioRef(`audio:${LEXEME}`), LEXEME);
    assert.equal(lexemeFromAudioRef(LEXEME), undefined);

    const url = audioUrl("/packs/", resolved!);
    assert.equal(url, `/packs/audio/${resolved!.sha256}.wav`);
    assert.ok(!url.includes(LEXEME), "the URL must not leak the answer");
    assert.deepEqual(packAudioUrls(report.pack, "/packs/"), [url]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
