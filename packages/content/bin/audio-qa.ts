/**
 * Audio provisioning CLI (spec p.21 canonical-audio gate).
 *
 * Usage:
 *   node packages/content/bin/audio-qa.ts <clipDir> [--out audio-manifest.json]
 *
 * `clipDir` holds one PCM WAV per lexeme, named `<lexemeId>.wav`
 * (e.g. `bank.n.01.wav`). Compressed sources are transcoded first:
 *   ffmpeg -i clip.ogg -ac 1 -ar 16000 -sample_fmt s16 bank.n.01.wav
 *
 * For each clip this measures the objective properties the spec's gate names —
 * clipping, noise floor, silence, and pace against the transcript's syllable
 * count — and reports what a human must still verify (that the clip really says
 * the word, is Standard Mandarin, and is licence/consent clear). Those are not
 * inferred: the tool refuses to promote a clip to canonical on measurement
 * alone, because no measurement establishes them.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";
import { buildCore60Pack } from "../src/pipeline.ts";
import { decodeWav, screenAudio } from "../src/audio-analysis.ts";
import { runAudioQa, type AudioAsset } from "../src/audio.ts";
import { CORE60 } from "../src/packs/core60.data.ts";

const clipDir = process.argv[2];
if (!clipDir) {
  console.error("usage: audio-qa.ts <clipDir> [--out <file>]");
  process.exit(2);
}
const outIndex = process.argv.indexOf("--out");
const outFile = outIndex > 0 ? process.argv[outIndex + 1] : undefined;

const syllablesOf = new Map(CORE60.map((e) => [e.id, e.tones.length]));
const pack = buildCore60Pack().pack;

const results: { lexeme: string; state: string; failures: string[]; metrics?: unknown }[] = [];
const provisioned: AudioAsset[] = [];

const files = readdirSync(clipDir).filter((f) => f.toLowerCase().endsWith(".wav"));
if (files.length === 0) {
  console.error(`no .wav clips found in ${clipDir}`);
  console.error("transcode compressed sources first, e.g.:");
  console.error("  ffmpeg -i clip.ogg -ac 1 -ar 16000 -sample_fmt s16 bank.n.01.wav");
  process.exit(1);
}

for (const file of files.sort()) {
  const lexeme = basename(file, ".wav");
  const declared = pack.audio.get(lexeme);
  if (!declared) {
    results.push({ lexeme, state: "rejected", failures: ["unknown_lexeme_for_this_pack"] });
    continue;
  }
  const bytes = new Uint8Array(readFileSync(join(clipDir, file)));
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  let screening;
  try {
    screening = screenAudio(decodeWav(bytes), { syllables: syllablesOf.get(lexeme) ?? 1 });
  } catch (e) {
    results.push({ lexeme, state: "rejected", failures: [`undecodable: ${(e as Error).message}`] });
    continue;
  }

  const asset: AudioAsset = { ...declared, sha256, durationMs: Math.round(screening.metrics.durationMs) };

  // Human-verified claims are NOT assumed. They arrive from a reviewer record;
  // absent one, the clip screens but cannot be promoted to canonical.
  const qa = runAudioQa({
    asset,
    humanRecorded: false,
    transcriptMatches: false,
    segmentationVerified: false,
    clean: true,
    naturalPace: true,
    licenceAndConsentClear: false,
    screening,
  });

  results.push({ lexeme, state: qa.state, failures: qa.failures, metrics: screening.metrics });
  provisioned.push({ ...asset, state: screening.passed ? "unverified" : "rejected" });
}

const screenedOk = results.filter((r) => !r.failures.some((f) => f.startsWith("signal:") || f.startsWith("undecodable")));
console.log(`clips analysed:        ${results.length}`);
console.log(`passed signal screening: ${screenedOk.length}`);
console.log(`failed signal screening: ${results.length - screenedOk.length}`);
for (const r of results) {
  const signal = r.failures.filter((f) => f.startsWith("signal:") || f.startsWith("undecodable"));
  console.log(`  ${r.lexeme.padEnd(20)} ${signal.length === 0 ? "signal OK" : signal.join(",")}`);
}
console.log("");
console.log("Still required before any clip can become CANONICAL (spec p.21):");
console.log("  - human_recorded confirmation (a person, not a synthesiser)");
console.log("  - transcript match: the clip really says the lexeme");
console.log("  - segmentation verified");
console.log("  - licence and speaker consent recorded");
console.log("These are declarations a reviewer supplies; measurement cannot establish them.");

if (outFile) {
  writeFileSync(outFile, JSON.stringify(provisioned, null, 2), "utf8");
  console.log(`\nwritten: ${outFile}`);
}
