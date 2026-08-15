import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCore60Pack,
  packToGraph,
  packAssetProvider,
  licenceGate,
  runAudioQa,
  isCanonical,
  declareAudio,
} from "./index.ts";

test("the pack ingests exactly 60 lexemes and rejects none (Stage 2 plain slice)", () => {
  const r = buildCore60Pack();
  assert.equal(r.ingested, 60);
  assert.equal(r.pack.lexemes.length, 60);
  assert.deepEqual(r.rejected, [], "no entry fails QA or the licence gate");
});

test("the build is deterministic — same content, same hash, same pack version", () => {
  const a = buildCore60Pack();
  const b = buildCore60Pack();
  assert.equal(a.pack.contentHash, b.pack.contentHash);
  assert.equal(a.pack.packVersion, b.pack.packVersion);
});

test("the pack version is derived from content, so a released pack is immutable (p.15)", () => {
  const r = buildCore60Pack();
  // The version embeds the content hash: any content change necessarily mints a
  // new version rather than mutating the released one.
  assert.ok(String(r.pack.packVersion).includes(r.pack.contentHash.slice(0, 12)));
});

test("every bundled asset carries verifiable provenance and passes the licence gate (p.7)", () => {
  const r = buildCore60Pack();
  assert.equal(r.pack.manifest.length, 60);
  for (const asset of r.pack.manifest) {
    assert.equal(licenceGate(asset).allowed, true, `${asset.id} allowed`);
    assert.equal(asset.redistributionAllowed, true);
    assert.ok(asset.sha256.length === 64, "sha256 present");
    assert.ok(asset.author && asset.attributionText, "attribution present");
    assert.equal(asset.languageTag, "zh-CN");
  }
});

test("no bundled asset derives from Pleco or an unlicensed HSK list (p.22)", () => {
  const r = buildCore60Pack();
  for (const asset of r.pack.manifest) {
    assert.ok(!/pleco/i.test(asset.sourceName), "no Pleco provenance");
    assert.ok(!/hsk/i.test(asset.sourceName), "no HSK list provenance");
  }
});

test("attribution output is complete and reproducible (p.28)", () => {
  const a = buildCore60Pack();
  const b = buildCore60Pack();
  assert.equal(a.pack.attributions.length, 60);
  assert.deepEqual(a.pack.attributions, b.pack.attributions);
});

test("the graph carries pronunciation with tone and sandhi metadata (ADR-0009)", () => {
  const g = packToGraph(buildCore60Pack().pack);
  const bank = g.pronunciationOf("bank.n.01")!; // 银行 — the spec's worked example
  assert.equal(bank.tone, 2);
  assert.equal(bank.region, "zh-CN");
  // 你好 is nǐ hǎo — the canonical 3+3 third-tone sandhi case.
  assert.match(g.pronunciationOf("hello.intj.01")!.sandhi!, /third-tone sandhi/);
});

test("HUMAN AUDIO IS CANONICAL: unprovisioned audio never satisfies the gate (p.21)", () => {
  const r = buildCore60Pack();
  assert.equal(r.audioPending.length, 60, "no clip is provisioned yet — stated honestly");
  const provider = packAssetProvider(r.pack);
  for (const lex of r.pack.lexemes) {
    assert.equal(provider.hasCanonicalAudio(lex.id), false, `${lex.id} has no canonical audio`);
  }
});

test("QA gate: a synthetic clip can NEVER become canonical, however clean (p.21)", () => {
  const synthetic = { ...declareAudio("bank.n.01", "银行"), sha256: "x".repeat(64), synthetic: true };
  const result = runAudioQa({
    asset: synthetic,
    humanRecorded: false,
    transcriptMatches: true,
    segmentationVerified: true,
    clean: true,
    naturalPace: true,
    licenceAndConsentClear: true,
    screening: { passed: true, failures: [] },
  });
  assert.equal(result.state, "rejected");
  assert.ok(result.failures.includes("synthetic_cannot_be_canonical"));
  assert.equal(isCanonical(synthetic), false);
});

test("QA gate: a verified human clip becomes canonical and unblocks the lexeme", () => {
  const r = buildCore60Pack();
  const asset = { ...r.pack.audio.get("bank.n.01")!, sha256: "a".repeat(64), upstream: "common-voice-zh-CN" as const, licenseSpdx: "CC0-1.0" };
  const qa = runAudioQa({
    asset,
    humanRecorded: true,
    transcriptMatches: true,
    segmentationVerified: true,
    clean: true,
    naturalPace: true,
    licenceAndConsentClear: true,
    // Objective screening is mandatory for canonical: declarations alone only
    // reach `unverified` (see audio-analysis.test.ts for the measured cases).
    screening: { passed: true, failures: [] },
  });
  assert.equal(qa.state, "verified");
  assert.deepEqual(qa.failures, []);

  // Provision it into the pack and the provider flips for that lexeme only.
  r.pack.audio.set("bank.n.01", { ...asset, state: qa.state });
  const provider = packAssetProvider(r.pack);
  assert.equal(provider.hasCanonicalAudio("bank.n.01" as never), true);
  assert.equal(provider.hasCanonicalAudio("money.n.01" as never), false, "others still blocked");
});

test("stroke data is not bundled, so handwriting stays gated (separate licence)", () => {
  const provider = packAssetProvider(buildCore60Pack().pack);
  assert.equal(provider.hasStrokeData("bank.n.01" as never), false);
});
