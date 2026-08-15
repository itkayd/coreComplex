/**
 * `npm run content:audio:certify` — apply the reviews and report the result.
 *
 * Deterministic and side-effect-light: it writes one snapshot of what is
 * certified, so the state a release depends on is reviewable in a diff rather
 * than recomputed silently inside the pack build. The pack build calls the same
 * function; this command exists so a human can see the same answer first.
 *
 *   node packages/content/bin/audio-certify.ts [--out sources/review/audio/certified.json]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_REVIEW_DIR, loadReleaseAudio } from "../src/sources/index.ts";

const outArg = process.argv.indexOf("--out");
const out = outArg >= 0 ? process.argv[outArg + 1] : `${DEFAULT_REVIEW_DIR}/certified.json`;

const release = loadReleaseAudio();

console.log("Canonical audio certification");
console.log("=============================\n");

if (!release.installed) {
  console.log(release.message);
  process.exit(0);
}

for (const outcome of release.outcomes) {
  if (outcome.certified) continue;
  console.log(`REJECTED ${(outcome.lexemeId || outcome.file).padEnd(22)} ${outcome.codes.join(", ")}`);
  for (const line of outcome.detail) console.log(`         ${line}`);
}

for (const entry of release.entries) {
  const p = entry.asset.provenance;
  console.log(`CERTIFIED ${entry.asset.lexeme.padEnd(21)} ${entry.asset.runtime!.path}`);
  console.log(`          ${p?.sourceName} · ${p?.licenseSpdx} · reviewed by ${entry.asset.review?.reviewedBy}`);
}

console.log("");
console.log(`certified:  ${release.entries.length}`);
console.log(`missing:    ${release.missing.length}`);
console.log(`duplicates: ${release.duplicates.length}${release.duplicates.length > 0 ? ` (${release.duplicates.join(", ")})` : ""}`);
console.log(`stale reviews: ${release.stale.length}`);

// The snapshot records WHAT was certified, not the bytes: the runtime hash is
// the identity, and the bytes stay in the inbox until the pack build copies them.
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(
  {
    certifiedAt: new Date(0).toISOString(), // fixed: this file must diff cleanly
    entries: release.entries.map((e) => e.asset).sort((a, b) => (a.lexeme < b.lexeme ? -1 : 1)),
    missing: release.missing,
    duplicates: release.duplicates,
  },
  null,
  2,
)}\n`, "utf8");
console.log(`\nwritten: ${out}`);

if (release.duplicates.length > 0 || release.reviewIssues.length > 0) process.exitCode = 1;
