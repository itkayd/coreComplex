/**
 * Build a pack containing ONE playable fixture recording, for the browser gate.
 *
 *   node scripts/build-fixture-pack.ts [outDir]
 *
 * Why this exists: the end-to-end listening path — bytes → bundle → fetch →
 * hash-verify → decode → play → evidence — can be proven before 60 licensed
 * human recordings have been supplied, and it should be, because those are two
 * different kinds of work. What it must never do is make the canonical gate look
 * satisfied. So the recording is generated, it is flagged `fixture: true`, and
 * `buildCore60Pack` refuses flagged audio unless `allowFixtureAudio` is set —
 * which only this file sets. A test asserts the production path refuses it.
 *
 * The pack is written to a SEPARATE directory from the release pack and is never
 * committed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { buildCore60Pack, writePack } from "../packages/content/src/index.ts";
import { evaluateAudioCandidate, certifyAudioSet, core60Targets } from "../packages/content/src/sources/index.ts";
import type { AudioCandidate } from "../packages/content/src/sources/index.ts";
import type { AudioReview } from "../packages/content/src/sources/index.ts";
import { makeFixtureWav } from "../fixtures/audio/make-fixture.ts";

const outDir = process.argv[2] ?? "apps/web/dist-fixture/packs";
const stagingDir = resolve(process.argv[3] ?? "/tmp/.dyr-fixture-audio");
const PROOF_LEXEME = "bank.n.01";
const reviewedAt = "1970-01-01T00:00:00.000Z";

// Cover all 60. One recording proves the path; sixty proves the same mechanism
// scales unchanged, and it gives the planner enough listening candidates that a
// bounded session reliably contains one — which is what the browser gate needs
// to test. Each clip differs (pitch varies by index) so the content-addressed
// paths are distinct and the pack exercises real per-lexeme resolution.
const targets = core60Targets();
mkdirSync(join(stagingDir, "files"), { recursive: true });

const candidates: AudioCandidate[] = [];
const reviews: AudioReview[] = [];

targets.forEach((target, index) => {
  const syllables = Math.max(1, [...target.simplified].length);
  const wav = makeFixtureWav({ syllables, baseHz: 150 + index * 3 });
  const file = `files/${index.toString().padStart(2, "0")}.wav`;
  writeFileSync(join(stagingDir, file), wav);
  const sha256 = createHash("sha256").update(wav).digest("hex");

  candidates.push({
    file,
    lexemeId: target.lexemeId,
    transcript: target.simplified,
    language: "cmn",
    region: "zh-CN",
    speaker: "dyr-fixture",
    source: "Dyr generated test fixture (NOT a human recording)",
    licenseSpdx: "CC0-1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    attributionText: "Dyr Mandarin Lab test fixture",
    redistributionAllowed: true,
    derivativeAllowed: true,
    sha256,
    syllables,
    fixture: true,
  });
  reviews.push({
    lexemeId: target.lexemeId,
    audioSha256: sha256,
    // Truthful for a fixture: these ARE the bytes generated for this target, and
    // they are CC0. What they are not is human — which is why every asset stays
    // flagged and the production build refuses the whole set.
    humanRecorded: true,
    transcriptMatches: true,
    segmentationVerified: true,
    licenceAndConsentClear: true,
    reviewedBy: "fixture-builder",
    reviewedAt,
    notes: "Generated fixture. Proves the byte path only; never canonical in production.",
  });
});

// Run the REAL ingestion and certification path — the point is to exercise it,
// not to hand-assemble assets that skip it.
const results = candidates.map((c) => evaluateAudioCandidate(c, stagingDir));
const failed = results.filter((r) => !r.accepted);
if (failed.length > 0) {
  throw new Error(`${failed.length} fixture(s) failed ingestion: ${failed[0].rejections.join(", ")} — ${failed[0].detail.join("; ")}`);
}

const set = certifyAudioSet(results, {
  targets,
  reviews: { present: true, path: "(in-memory fixture review)", reviews, issues: [] },
});
if (set.entries.length !== targets.length) {
  throw new Error(`fixture certification produced ${set.entries.length}/${targets.length}: `
    + JSON.stringify(set.outcomes.filter((o) => !o.certified).slice(0, 3)));
}

// Build with the fixture opt-in. Without `allowFixtureAudio` this throws.
const report = buildCore60Pack({ canonicalAudio: set.entries, allowFixtureAudio: true });
const written = writePack(report, outDir);
const proof = set.entries.find((e) => e.asset.lexeme === PROOF_LEXEME);

console.log(`fixture pack: ${report.pack.packVersion}`);
console.log(`contentHash:  ${report.pack.contentHash}`);
console.log(`canonical:    ${report.pack.lexemes.length - report.audioPending.length}/${report.pack.lexemes.length}`);
console.log(`proof lexeme: ${PROOF_LEXEME} → ${proof?.asset.runtime?.path}`);
console.log(`written:      ${written.packFile} + ${written.audioFiles.length} audio files (${(written.bytesWritten / 1024).toFixed(0)} KiB)`);
