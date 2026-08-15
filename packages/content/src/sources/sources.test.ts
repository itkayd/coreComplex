import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateAudioCandidate, importAudioCandidates, importCedict, importTatoeba,
  inspectSource, resolveHskMapping, validateManifest, noHskMapping,
  type AudioCandidate, type HskLevelSource, type SourceManifest,
} from "./index.ts";
import { certifyCandidate } from "./importers.ts";

const scratch = () => mkdtempSync(join(tmpdir(), "dyr-inbox-"));

function writeManifest(dir: string, manifest: Partial<SourceManifest> & { sourceId: string }): void {
  mkdirSync(dir, { recursive: true });
  const full: SourceManifest = {
    sourceName: manifest.sourceId,
    sourceUrl: "https://example.invalid",
    sourceVersion: "1",
    retrievedAt: "2026-08-15T10:00:00Z",
    licenseSpdx: "CC-BY-SA-4.0",
    redistributionAllowed: true,
    derivativeAllowed: true,
    files: [],
    ...manifest,
  } as SourceManifest;
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(full, null, 2));
}

/** Build a valid PCM16 WAV of roughly the requested duration. */
function wavClip(ms: number, amplitude = 0.5, noise = 0.0005): Buffer {
  const RATE = 16000;
  const lead = 640, tail = 640;
  const body = Math.floor((ms * RATE) / 1000);
  const samples = new Float32Array(lead + body + tail);
  let seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; };
  for (let i = 0; i < samples.length; i++) samples[i] = rnd() * noise;
  for (let i = 0; i < body; i++) {
    samples[lead + i] += Math.sin((2 * Math.PI * 180 * i) / RATE) * amplitude * Math.sin((Math.PI * i) / body);
  }
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write("RIFF", 0); out.writeUInt32LE(36 + samples.length * 2, 4); out.write("WAVE", 8);
  out.write("fmt ", 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(RATE, 24); out.writeUInt32LE(RATE * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write("data", 36); out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Absence is a state, not a failure
// ---------------------------------------------------------------------------

test("a missing source reports an actionable message, never a crash", () => {
  const inbox = scratch();
  try {
    const report = importCedict(inbox);
    assert.equal(report.installed, false);
    assert.match(report.message, /CC-CEDICT source not installed/);
    assert.match(report.message, /npm run content:import:cedict/);
    assert.deepEqual(report.entries, []);
  } finally { rmSync(inbox, { recursive: true, force: true }); }
});

test("a malformed manifest is diagnosed rather than ignored", () => {
  const inbox = scratch();
  try {
    mkdirSync(join(inbox, "cc-cedict"), { recursive: true });
    writeFileSync(join(inbox, "cc-cedict", "manifest.json"), "{ not json");
    const status = inspectSource("cc-cedict", inbox);
    assert.equal(status.state, "invalid_manifest");
    assert.ok(status.issues[0].includes("not valid JSON"));
  } finally { rmSync(inbox, { recursive: true, force: true }); }
});

test("manifest validation requires explicit rights — they are never inferred", () => {
  const result = validateManifest({
    sourceId: "x", sourceName: "X", sourceUrl: "u", sourceVersion: "1",
    retrievedAt: "2026-08-15T10:00:00Z", licenseSpdx: "CC0-1.0",
    files: [{ path: "a.txt", role: "r" }],
  });
  assert.equal(result.valid, false);
  if (result.valid) return;
  const paths = result.issues.map((i) => i.path);
  assert.ok(paths.includes("redistributionAllowed"));
  assert.ok(paths.includes("derivativeAllowed"));
});

test("a manifest path may not escape its source directory", () => {
  const result = validateManifest({
    sourceId: "x", sourceName: "X", sourceUrl: "u", sourceVersion: "1",
    retrievedAt: "2026-08-15T10:00:00Z", licenseSpdx: "CC0-1.0",
    redistributionAllowed: true, derivativeAllowed: true,
    files: [{ path: "../../etc/passwd", role: "r" }],
  });
  assert.equal(result.valid, false);
});

// ---------------------------------------------------------------------------
// CC-CEDICT local ingestion
// ---------------------------------------------------------------------------

const CEDICT = [
  "# CC-CEDICT", "#! version=1",
  "銀行 银行 [yin2 hang2] /bank/",
  "你好 你好 [ni3 hao3] /hello/hi/",
  "garbage line",
].join("\n");

test("a locally supplied CC-CEDICT file is hashed and parsed (gzip supported)", () => {
  const inbox = scratch();
  try {
    const dir = join(inbox, "cc-cedict");
    writeManifest(dir, {
      sourceId: "cc-cedict", sourceName: "CC-CEDICT", licenseSpdx: "CC-BY-SA-4.0",
      files: [{ path: "cedict.txt.gz", role: "dictionary" }],
    });
    writeFileSync(join(dir, "cedict.txt.gz"), gzipSync(Buffer.from(CEDICT, "utf8")));

    const report = importCedict(inbox);
    assert.equal(report.installed, true);
    assert.equal(report.entries.length, 2);
    assert.equal(report.parsed?.rejected.length, 1, "the garbage line is rejected with a reason");
    assert.match(report.sha256 ?? "", /^[a-f0-9]{64}$/);
    const bank = report.entries.find((e) => e.simplified === "银行")!;
    assert.equal(bank.traditional, "銀行");
    assert.equal(bank.pinyinNumbered, "yin2 hang2");
    assert.equal(bank.pinyinMarked, "yín háng");
  } finally { rmSync(inbox, { recursive: true, force: true }); }
});

test("a declared hash that disagrees with the bytes blocks the source", () => {
  const inbox = scratch();
  try {
    const dir = join(inbox, "cc-cedict");
    writeManifest(dir, {
      sourceId: "cc-cedict", files: [{ path: "cedict.txt", role: "dictionary", sha256: "a".repeat(64) }],
    });
    writeFileSync(join(dir, "cedict.txt"), CEDICT);
    const status = inspectSource("cc-cedict", inbox);
    assert.equal(status.state, "files_missing");
    assert.ok(status.issues[0].includes("hash mismatch"));
  } finally { rmSync(inbox, { recursive: true, force: true }); }
});

test("a source whose licence fails the gate is refused even when well-formed", () => {
  const inbox = scratch();
  try {
    const dir = join(inbox, "cc-cedict");
    writeManifest(dir, {
      sourceId: "cc-cedict", licenseSpdx: "CC-BY-NC-4.0",
      files: [{ path: "cedict.txt", role: "dictionary" }],
    });
    writeFileSync(join(dir, "cedict.txt"), CEDICT);
    const status = inspectSource("cc-cedict", inbox);
    assert.equal(status.state, "licence_rejected");
  } finally { rmSync(inbox, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Human audio candidates
// ---------------------------------------------------------------------------

const baseCandidate = (over: Partial<AudioCandidate> = {}): AudioCandidate => ({
  file: "files/bank.n.01.wav",
  lexemeId: "bank.n.01",
  transcript: "银行",
  language: "cmn",
  source: "Common Voice zh-CN",
  licenseSpdx: "CC0-1.0",
  redistributionAllowed: true,
  derivativeAllowed: true,
  syllables: 2,
  ...over,
});

function audioInbox(candidates: AudioCandidate[], clip = wavClip(700)): string {
  const inbox = scratch();
  const dir = join(inbox, "audio");
  mkdirSync(join(dir, "files"), { recursive: true });
  writeManifest(dir, {
    sourceId: "audio", sourceName: "Human audio batch", licenseSpdx: "CC0-1.0",
    files: [{ path: "candidates.json", role: "candidates" }],
  });
  writeFileSync(join(dir, "candidates.json"), JSON.stringify(candidates, null, 2));
  writeFileSync(join(dir, "files", "bank.n.01.wav"), clip);
  return inbox;
}

test("a clean, openly licensed recording is accepted as HUMAN audio", () => {
  const inbox = audioInbox([baseCandidate()]);
  try {
    const report = importAudioCandidates(inbox);
    assert.equal(report.installed, true);
    assert.equal(report.accepted.length, 1);
    const asset = report.accepted[0].asset!;
    assert.equal(asset.synthetic, undefined, "human audio is never flagged synthetic");
    assert.equal(asset.state, "unverified", "screening alone does not make it canonical");
    assert.match(asset.sha256 ?? "", /^[a-f0-9]{64}$/);
  } finally { rmSync(inbox, { recursive: true, force: true }); }
});

test("AUDIO LICENCE IS SEPARATE: a missing audio licence is rejected", () => {
  const inbox = audioInbox([baseCandidate({ licenseSpdx: "" })]);
  try {
    const result = importAudioCandidates(inbox).results[0];
    assert.equal(result.accepted, false);
    assert.ok(result.rejections.includes("licence_missing"));
    assert.ok(result.detail.some((d) => /never inferred from the sentence licence/.test(d)));
  } finally { rmSync(inbox, { recursive: true, force: true }); }
});

test("NC and ND audio are rejected (ND because the pipeline transcodes)", () => {
  for (const [spdx, code] of [["CC-BY-NC-4.0", "licence_non_commercial"], ["CC-BY-ND-4.0", "licence_no_derivatives"]] as const) {
    const inbox = audioInbox([baseCandidate({ licenseSpdx: spdx })]);
    try {
      const result = importAudioCandidates(inbox).results[0];
      assert.equal(result.accepted, false, spdx);
      assert.ok(result.rejections.includes(code), `${spdx} → ${result.rejections.join(",")}`);
    } finally { rmSync(inbox, { recursive: true, force: true }); }
  }
});

test("audio without a redistribution grant is rejected", () => {
  const inbox = audioInbox([baseCandidate({ redistributionAllowed: false })]);
  try {
    assert.ok(importAudioCandidates(inbox).results[0].rejections.includes("licence_not_redistributable"));
  } finally { rmSync(inbox, { recursive: true, force: true }); }
});

test("the actual file hash is verified against the declared one", () => {
  const inbox = audioInbox([baseCandidate({ sha256: "b".repeat(64) })]);
  try {
    assert.ok(importAudioCandidates(inbox).results[0].rejections.includes("hash_mismatch"));
  } finally { rmSync(inbox, { recursive: true, force: true }); }
});

test("a clipped recording fails signal screening", () => {
  const inbox = audioInbox([baseCandidate()], wavClip(700, 3));
  try {
    const result = importAudioCandidates(inbox).results[0];
    assert.equal(result.accepted, false);
    assert.ok(result.rejections.includes("signal_screening_failed"));
    assert.ok(result.detail.some((d) => d.includes("clipping_detected")));
  } finally { rmSync(inbox, { recursive: true, force: true }); }
});

test("a missing or undecodable file is rejected", () => {
  const inbox = audioInbox([baseCandidate({ file: "files/nope.wav" })]);
  try {
    assert.ok(importAudioCandidates(inbox).results[0].rejections.includes("file_missing"));
  } finally { rmSync(inbox, { recursive: true, force: true }); }
});

test("certification to canonical still requires the human declarations", () => {
  const inbox = audioInbox([baseCandidate()]);
  try {
    const result = importAudioCandidates(inbox).accepted[0];
    // Without the human declarations, it cannot become canonical.
    const withoutHuman = certifyCandidate(result, {
      humanRecorded: false, transcriptMatches: true, segmentationVerified: true, licenceAndConsentClear: true,
    });
    assert.notEqual(withoutHuman.state, "verified");
    assert.ok(withoutHuman.failures.includes("not_human_recorded"));

    const certified = certifyCandidate(result, {
      humanRecorded: true, transcriptMatches: true, segmentationVerified: true, licenceAndConsentClear: true,
    });
    assert.equal(certified.state, "verified");
    assert.equal(certified.asset?.state, "verified");
    assert.equal(certified.asset?.synthetic, undefined, "a certified clip is human, never synthetic");
  } finally { rmSync(inbox, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Tatoeba
// ---------------------------------------------------------------------------

test("Tatoeba exports parse locally; audio without its OWN licence is rejected", () => {
  const inbox = scratch();
  try {
    const dir = join(inbox, "tatoeba");
    writeManifest(dir, {
      sourceId: "tatoeba", sourceName: "Tatoeba", licenseSpdx: "CC-BY-4.0",
      files: [
        { path: "sentences.csv", role: "sentences" },
        { path: "links.csv", role: "links" },
        { path: "sentences_with_audio.csv", role: "sentences_with_audio" },
      ],
    });
    writeFileSync(join(dir, "sentences.csv"), [
      "1\tcmn\t我去银行取钱。",
      "2\teng\tI go to the bank to withdraw money.",
      "3\tcmn\t你好。",
      "4\tfra\tBonjour.",
    ].join("\n"));
    writeFileSync(join(dir, "links.csv"), ["1\t2", "3\t4"].join("\n"));
    writeFileSync(join(dir, "sentences_with_audio.csv"), [
      "1\t900\tspeakerA\tCC0 1.0\thttps://example.invalid/a",
      "3\t901\tspeakerB\t\t", // no audio licence → must be rejected
    ].join("\n"));

    const report = importTatoeba(inbox);
    assert.equal(report.installed, true);
    assert.equal(report.mandarinSentences.length, 2, "only cmn sentences");
    assert.deepEqual(report.translations.get("1"), ["I go to the bank to withdraw money."]);
    assert.equal(report.translations.has("3"), false, "a French link is not an English translation");
    assert.equal(report.audioRows.length, 1, "only the licensed audio row survives");
    assert.equal(report.audioRejectedForLicence, 1);
  } finally { rmSync(inbox, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// HSK adapter — contract only, no bundled data
// ---------------------------------------------------------------------------

test("no installed HSK source means every level is legitimately undefined", () => {
  const mapping = noHskMapping();
  assert.equal(mapping.byLexemeId.size, 0);
  assert.equal(mapping.byLexemeId.get("bank.n.01"), undefined);
});

test("an HSK adapter resolves surface forms onto Dyr lexeme ids, preserving 7-9", () => {
  const source: HskLevelSource = {
    sourceId: "example-open-hsk",
    sourceVersion: "1.0",
    licence: "CC0-1.0",
    provenance: { sourceId: "example-open-hsk" } as never,
    *entries() {
      yield { simplified: "银行", publishedBand: "2" as const };
      yield { simplified: "你好", publishedBand: "1" as const };
      yield { simplified: "罕見", publishedBand: "7-9" as const };
      yield { simplified: "不在包里", publishedBand: "3" as const };
    },
  };
  const mapping = resolveHskMapping(source, [
    { id: "bank.n.01", simplified: "银行", traditional: "銀行" },
    { id: "hello.intj.01", simplified: "你好" },
  ]);
  assert.equal(mapping.byLexemeId.get("bank.n.01")?.level, 2);
  assert.equal(mapping.byLexemeId.get("hello.intj.01")?.level, 1);
  assert.equal(mapping.unmatched.length, 2, "entries with no lexeme are reported, not dropped silently");
  assert.equal(mapping.licence, "CC0-1.0");
});
