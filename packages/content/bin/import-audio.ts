/** `npm run content:import:audio` — ingest locally supplied human recordings. */
import { importAudioCandidates } from "../src/sources/index.ts";

const report = importAudioCandidates(process.argv[2] ?? "sources/inbox");
if (!report.installed) {
  console.log(report.message);
  process.exit(0);
}
console.log(report.message);
for (const result of report.results) {
  const target = result.candidate.lexemeId ?? result.candidate.sentenceId ?? "(no target)";
  if (result.accepted) {
    console.log(`  accept  ${target.padEnd(22)} ${result.durationMs}ms  sha ${result.sha256?.slice(0, 12)}…`);
  } else {
    console.log(`  REJECT  ${target.padEnd(22)} ${result.rejections.join(",")}`);
    for (const d of result.detail) console.log(`            ${d}`);
  }
}
console.log("");
console.log("Accepted recordings are stored as HUMAN assets in state `unverified`.");
console.log("Promotion to canonical still needs the reviewer declarations the gate requires:");
console.log("  human_recorded, transcript match, segmentation verified, licence + consent clear.");
