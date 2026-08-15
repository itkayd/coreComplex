/**
 * `npm run content:audio:review` — what a reviewer needs in order to decide.
 *
 * Prints every candidate with its objective signal-QA result and whether a
 * hash-bound review already covers it, and emits ready-to-paste review templates
 * for the ones that still need a human. It decides nothing itself: signal quality
 * is measurable, "this is a human speaking the right word, cleanly segmented,
 * with clear rights" is not.
 *
 *   node packages/content/bin/audio-review.ts [--emit-templates]
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_INBOX, DEFAULT_REVIEW_DIR, core60Targets, importAudioCandidates,
  loadReviews, reviewFor, reviewTemplate, transcriptMatchesTarget,
} from "../src/sources/index.ts";

const emit = process.argv.includes("--emit-templates");
const imported = importAudioCandidates(DEFAULT_INBOX);
const reviews = loadReviews(DEFAULT_REVIEW_DIR);
const targets = new Map(core60Targets().map((t) => [t.lexemeId, t]));

console.log("Audio review worklist");
console.log("=====================\n");

if (!imported.installed) {
  console.log(imported.message);
  process.exit(0);
}

if (reviews.issues.length > 0) {
  console.log(`reviews file has ${reviews.issues.length} problem(s):`);
  for (const issue of reviews.issues) console.log(`  ${issue.path}: ${issue.message}`);
  console.log("");
}

const needed: ReturnType<typeof reviewTemplate>[] = [];
for (const result of imported.results) {
  const id = result.candidate.lexemeId ?? result.candidate.sentenceId ?? "(no target)";
  const hash = result.sha256;
  const target = result.candidate.lexemeId ? targets.get(result.candidate.lexemeId) : undefined;

  let status: string;
  if (!result.accepted) {
    status = `INGEST FAILED  ${result.rejections.join(", ")}`;
  } else if (!target) {
    status = "UNKNOWN TARGET not a Core 60 lexeme";
  } else if (!transcriptMatchesTarget(result.candidate.transcript, target)) {
    status = `TRANSCRIPT     says "${result.candidate.transcript}", pack expects "${target.simplified}"`;
  } else if (hash && reviewFor(reviews, target.lexemeId, hash)) {
    status = "REVIEWED       hash-bound review on file";
  } else {
    status = "NEEDS REVIEW   signal QA passed; awaiting human declarations";
    if (hash) needed.push(reviewTemplate(target.lexemeId, hash));
  }

  console.log(`${id.padEnd(22)} ${status}`);
  console.log(`  file    ${result.candidate.file}`);
  console.log(`  source  ${result.candidate.source} · ${result.candidate.licenseSpdx}`);
  console.log(`  sha256  ${hash ?? "—"}`);
  if (result.screening) {
    console.log(`  signal  ${result.screening.passed ? "pass" : `fail (${result.screening.failures.join(", ")})`}`
      + ` · ${Math.round(result.screening.metrics.durationMs)} ms`);
  }
  for (const line of result.detail) console.log(`  note    ${line}`);
  console.log("");
}

const stale = reviews.reviews.filter((r) => !imported.results.some((x) => x.sha256 === r.audioSha256));
if (stale.length > 0) {
  console.log(`${stale.length} review(s) no longer match any candidate's bytes (the recording changed):`);
  for (const r of stale) console.log(`  ${r.lexemeId} ${r.audioSha256.slice(0, 12)}… reviewed by ${r.reviewedBy}`);
  console.log("These certify nothing. Re-review the new recording.\n");
}

console.log(`${needed.length} recording(s) awaiting review.`);
if (needed.length > 0 && emit) {
  const path = join(DEFAULT_REVIEW_DIR, "reviews.template.json");
  writeFileSync(path, `${JSON.stringify(needed, null, 2)}\n`, "utf8");
  console.log(`Templates written to ${path} — fill in the declarations and merge into reviews.json.`);
} else if (needed.length > 0) {
  console.log("Re-run with --emit-templates to write blank review records.");
}
