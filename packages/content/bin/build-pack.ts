/**
 * Build the Core 60 pack into an immutable, versioned artefact.
 *
 *   node packages/content/bin/build-pack.ts [outDir] [--no-audio]
 *
 * Canonical audio is loaded from the certified set and passed to the compiler
 * EXPLICITLY. The compiler itself never searches the filesystem, so what ships is
 * exactly what this file decided to hand it.
 *
 * `--no-audio` builds the plain fixture-free artefact: deterministic, with every
 * audio slot `declared`. Useful for verifying that the lexical content hash is
 * independent of the machine's inbox.
 */
import { buildCore60Pack, writePack } from "../src/index.ts";
import { loadReleaseAudio } from "../src/sources/index.ts";

const args = process.argv.slice(2);
const withAudio = !args.includes("--no-audio");
const outDir = args.find((a) => !a.startsWith("--")) ?? "packs";

const release = withAudio ? loadReleaseAudio() : undefined;
const report = buildCore60Pack({ canonicalAudio: release?.entries });
const written = writePack(report, outDir);

console.log(`pack:        ${report.pack.packId}`);
console.log(`version:     ${report.pack.packVersion}`);
console.log(`contentHash: ${report.pack.contentHash}`);
console.log(`lexemes:     ${report.pack.lexemes.length} (rejected ${report.rejected.length})`);
console.log(`audio:       ${report.pack.audio.size} declared, ${report.pack.audio.size - report.audioPending.length} canonical, ${report.audioPending.length} awaiting recordings`);
if (release) {
  console.log(`             ${release.message}`);
  if (release.duplicates.length > 0) console.log(`             duplicates refused: ${release.duplicates.join(", ")}`);
  if (release.reviewIssues.length > 0) console.log(`             review file issues: ${release.reviewIssues.length}`);
}
console.log(`written:     ${written.packFile}`);
if (written.audioFiles.length > 0) {
  console.log(`             + ${written.audioFiles.length} audio files (${(written.bytesWritten / 1024).toFixed(0)} KiB)`);
}
