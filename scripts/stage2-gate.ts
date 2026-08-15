/**
 * `npm run stage2:gate` — the single authoritative Stage 2 decision command.
 *
 * Content gates are taken from the BINDING specification's PLAIN-SLICE DONE
 * list (p.28), not from assumptions added later:
 *
 *   - 60 licensed lexemes with clear human audio
 *   - listening and reading work offline in 3/7/15-minute sessions
 *   - speaking and writing later use the same independent-trace contracts
 *   - replay, forecast and observatory explanations exist
 *   - every optional layer is disabled
 *   - deletion and export controls pass
 *
 * HSK is deliberately NOT a gate: the same page says "Keep HSK reporting
 * separate", and p.9 says HSK "never decides readiness". CC-CEDICT and Tatoeba
 * are likewise enrichment — the spec requires the lexemes to be LICENSED, which
 * the CC0 Core 60 already is.
 *
 * The browser gate is a real gate here, not a footnote: this command either runs
 * `npm run e2e` itself (`--with-e2e`) or verifies the machine-readable report
 * from the same CI run. A release decision that depends on someone remembering
 * an undocumented second command is not a gate.
 *
 *   npm run stage2:gate              # consume artifacts/e2e-report.json
 *   npm run stage2:gate -- --with-e2e   # run the browser gates now
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { buildCore60Pack } from "../packages/content/src/pipeline.ts";
import { isCanonical } from "../packages/content/src/audio.ts";
import { importAudioCandidates, loadReleaseAudio, loadReviews, core60Targets } from "../packages/content/src/sources/index.ts";

type Verdict = "pass" | "fail" | "manual";
const rows: { area: string; name: string; verdict: Verdict; detail: string }[] = [];
const add = (area: string, name: string, verdict: Verdict, detail = "") => rows.push({ area, name, verdict, detail });

const WITH_E2E = process.argv.includes("--with-e2e");
const E2E_REPORT = process.env.DYR_E2E_REPORT ?? "artifacts/e2e-report.json";
const E2E_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function run(command: string, args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 1_800_000 });
    return { ok: true, output };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

// ---------------------------------------------------------------------------
// Engineering gates
// ---------------------------------------------------------------------------

const typecheck = run("npx", ["tsc", "-p", "tsconfig.json"]);
add("Engineering", "typecheck", typecheck.ok ? "pass" : "fail", typecheck.ok ? "" : typecheck.output.split("\n")[0]);

const tests = run("npm", ["test", "--silent"]);
const testLine = /# pass (\d+)/.exec(tests.output);
const failLine = /# fail (\d+)/.exec(tests.output);
const failed = failLine ? Number(failLine[1]) : 1;
add("Engineering", "unit + property + simulation tests", failed === 0 ? "pass" : "fail",
  `${testLine?.[1] ?? "?"} passed, ${failed} failed`);

for (const [name, marker] of [
  ["kernel invariants (four traces, one update)", "four-traces"],
  ["deterministic replay", "replay"],
  ["runtime pack validation + hash verification", "validate"],
  ["canonical audio pipeline", "canonical-audio"],
  ["layer isolation", "removal"],
] as const) {
  add("Engineering", name, failed === 0 ? "pass" : "fail", `covered by ${marker}.test.ts`);
}

const p1 = run("node", ["packages/content/bin/build-pack.ts", "/tmp/.stage2-a"]);
const p2 = run("node", ["packages/content/bin/build-pack.ts", "/tmp/.stage2-b"]);
const deterministic = p1.ok && p2.ok
  && existsSync("/tmp/.stage2-a/dyr-core60.json")
  && run("diff", ["-q", "/tmp/.stage2-a/dyr-core60.json", "/tmp/.stage2-b/dyr-core60.json"]).ok;
add("Engineering", "deterministic content build", deterministic ? "pass" : "fail");

const webBuild = run("npm", ["run", "build:web", "--silent"]);
add("Engineering", "offline PWA builds", webBuild.ok ? "pass" : "fail");

// --- browser gate: run it, or verify the report from this CI run -----------
if (WITH_E2E) {
  const e2e = run("npm", ["run", "e2e", "--silent"]);
  add("Engineering", "browser gates (Playwright + WCAG + listening)", e2e.ok ? "pass" : "fail",
    /browser gates: (\d+\/\d+)/.exec(e2e.output)?.[1] ?? e2e.output.split("\n").slice(-3).join(" ").slice(0, 90));
} else if (existsSync(E2E_REPORT)) {
  const report = JSON.parse(readFileSync(E2E_REPORT, "utf8")) as {
    ok: boolean; ranAt: string; gates: { gate: string; ok: boolean; detail: string }[];
  };
  const ageMs = Date.now() - statSync(E2E_REPORT).mtimeMs;
  const fresh = ageMs < E2E_MAX_AGE_MS;
  add("Engineering", "browser gates (Playwright + WCAG + listening)",
    report.ok && fresh ? "pass" : "fail",
    `${report.gates.map((g) => `${g.gate} ${g.ok ? "pass" : "FAIL"} (${g.detail})`).join("; ")}`
    + (fresh ? "" : ` — report is ${(ageMs / 3_600_000).toFixed(0)}h old, re-run \`npm run e2e\``));
} else {
  add("Engineering", "browser gates (Playwright + WCAG + listening)", "fail",
    `no ${E2E_REPORT}; run \`npm run e2e\` or \`npm run stage2:gate -- --with-e2e\``);
}

// ---------------------------------------------------------------------------
// Canonical audio pipeline — real coverage, not "the directory exists"
// ---------------------------------------------------------------------------

const targets = core60Targets();
const targetIds = new Set(targets.map((t) => t.lexemeId));
const inbox = importAudioCandidates();
const release = loadReleaseAudio();
const reviews = loadReviews();
const { pack, rejected } = buildCore60Pack({ canonicalAudio: release.entries });

const licenceOk = inbox.results.filter((r) => !r.rejections.some((c) => c.startsWith("licence")));
const signalOk = inbox.results.filter((r) => r.accepted);
const uniqueTargets = new Set(
  inbox.results.map((r) => r.candidate.lexemeId).filter((id): id is string => Boolean(id) && targetIds.has(id!)),
);
const reviewedHashes = new Set(reviews.reviews.map((r) => r.audioSha256));
const reviewed = signalOk.filter((r) => r.sha256 && reviewedHashes.has(r.sha256));
const certified = release.entries.length;
const bundled = pack.lexemes.filter((l) => isCanonical(pack.audio.get(String(l.id)))).length;
const runtimeValid = release.entries.filter((e) => e.asset.runtime?.sha256 === e.asset.sha256).length;

const duplicateTargets = (() => {
  const seen = new Map<string, number>();
  for (const r of inbox.results) {
    const id = r.candidate.lexemeId;
    if (id) seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  return [...seen].filter(([, n]) => n > 1).map(([id, n]) => `${id}×${n}`);
})();

const matrix: [string, number, number][] = [
  ["Core lexemes", pack.lexemes.length, 60],
  ["Candidate recordings supplied", inbox.results.length, 60],
  ["Unique Core60 targets", uniqueTargets.size, 60],
  ["Licence accepted", licenceOk.length, 60],
  ["Signal QA passed", signalOk.length, 60],
  ["Human reviewed", reviewed.length, 60],
  ["Canonical verified", certified, 60],
  ["Bundled into release pack", bundled, 60],
  ["Runtime hash valid", runtimeValid, 60],
];

// ---------------------------------------------------------------------------
// Content gates — from PLAIN-SLICE DONE (spec p.28)
// ---------------------------------------------------------------------------

const total = pack.lexemes.length;
add("Content", "60 lexemes", total === 60 ? "pass" : "fail", `${total} lexemes, ${rejected.length} rejected`);
add("Content", "lexemes are licensed (licence manifests)", pack.manifest.length === total ? "pass" : "fail",
  `${pack.manifest.length}/${total} manifest entries`);
add("Content", "attribution output", pack.attributions.length === total ? "pass" : "fail",
  `${pack.attributions.length} attribution entries`);
add("Content", "60 unique Core60 lexemes targeted by recordings", uniqueTargets.size === 60 ? "pass" : "fail",
  `${uniqueTargets.size}/60`);
add("Content", "60 certified canonical recordings", certified === 60 ? "pass" : "fail", `${certified}/60`);
add("Content", "60 bundled runtime assets with valid hashes", bundled === 60 && runtimeValid === certified ? "pass" : "fail",
  `${bundled}/60 bundled, ${runtimeValid}/${certified} hashes valid`);
add("Content", "no duplicate canonical targets", release.duplicates.length === 0 ? "pass" : "fail",
  release.duplicates.length === 0 ? "" : release.duplicates.join(", "));
add("Content", "review file is well-formed", reviews.issues.length === 0 ? "pass" : "fail",
  reviews.issues.length === 0 ? "" : `${reviews.issues.length} problem(s)`);

// ---------------------------------------------------------------------------
// Not gates — recorded so their absence is never mistaken for a blocker
// ---------------------------------------------------------------------------

const notGates = [
  ["HSK metadata", "spec p.28 \"Keep HSK reporting separate\"; p.9 HSK never decides readiness"],
  ["CC-CEDICT enrichment", "spec p.28 requires LICENSED lexemes; the CC0 Core 60 already qualifies"],
  ["Tatoeba sentences", "not named in PLAIN-SLICE DONE"],
];

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const mark = (v: Verdict) => (v === "pass" ? "PASS" : v === "fail" ? "FAIL" : "MANUAL");
let area = "";
console.log("Stage 2 Gate");
console.log("============\n");
for (const row of rows) {
  if (row.area !== area) { area = row.area; console.log(`${area} gates`); }
  console.log(`  [${mark(row.verdict).padEnd(6)}] ${row.name}${row.detail ? ` — ${row.detail}` : ""}`);
}

console.log("\nCanonical Audio Pipeline");
console.log("------------------------");
for (const [label, got, want] of matrix) {
  console.log(`  ${label.padEnd(32)} ${String(got).padStart(3)}/${want}`);
}
if (release.missing.length > 0) {
  console.log(`\n  Missing lexeme IDs (${release.missing.length}):`);
  console.log(`    ${release.missing.slice(0, 12).join(", ")}${release.missing.length > 12 ? `, … +${release.missing.length - 12} more` : ""}`);
}
if (duplicateTargets.length > 0) console.log(`\n  Duplicate candidates: ${duplicateTargets.join(", ")}`);
if (release.stale.length > 0) {
  console.log(`\n  Stale reviews (bytes changed since review): ${release.stale.map((r) => r.lexemeId).join(", ")}`);
}
const rejectionCounts = new Map<string, number>();
for (const outcome of release.outcomes) {
  if (outcome.certified) continue;
  for (const code of outcome.codes) rejectionCounts.set(code, (rejectionCounts.get(code) ?? 0) + 1);
}
if (rejectionCounts.size > 0) {
  console.log("\n  Rejected candidates by reason:");
  for (const [code, n] of [...rejectionCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(3)}  ${code}`);
  }
}

console.log("\nNot Stage 2 gates (binding spec)");
for (const [name, why] of notGates) console.log(`  [ n/a   ] ${name} — ${why}`);

const failures = rows.filter((r) => r.verdict === "fail");
console.log("");
if (failures.length === 0) {
  console.log("Stage 2 status: PASS");
} else {
  console.log("Stage 2 status: NOT YET PASS");
  console.log("Blocked by:");
  for (const f of failures) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
  process.exitCode = 1;
}
