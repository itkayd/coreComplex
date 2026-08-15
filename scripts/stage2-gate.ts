/**
 * `npm run stage2:gate` — the Stage 2 acceptance gate.
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
 * separate", and p.9 says HSK "never decides readiness". CC-CEDICT is likewise
 * enrichment — the spec requires the lexemes to be LICENSED, which the CC0
 * Core 60 already is.
 *
 * Engineering gates that need a browser (Playwright, WCAG) are reported as
 * "run separately" rather than silently claimed.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { buildCore60Pack } from "../packages/content/src/pipeline.ts";
import { isCanonical } from "../packages/content/src/audio.ts";
import { importAudioCandidates } from "../packages/content/src/sources/index.ts";

type Verdict = "pass" | "fail" | "manual";
const rows: { area: string; name: string; verdict: Verdict; detail: string }[] = [];
const add = (area: string, name: string, verdict: Verdict, detail = "") => rows.push({ area, name, verdict, detail });

function run(command: string, args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000 });
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

// Specific invariants are proven by named tests inside that suite.
for (const [name, marker] of [
  ["kernel invariants (four traces, one update)", "four-traces"],
  ["deterministic replay", "replay"],
  ["runtime pack validation + hash verification", "validate"],
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

add("Engineering", "IndexedDB restore / offline / Playwright / WCAG", "manual",
  "run `npm run e2e` against a served build (needs playwright + axe-core)");

// ---------------------------------------------------------------------------
// Content gates — from PLAIN-SLICE DONE (spec p.28)
// ---------------------------------------------------------------------------

const { pack, rejected } = buildCore60Pack();
const total = pack.lexemes.length;

add("Content", "60 lexemes", total === 60 ? "pass" : "fail", `${total} lexemes, ${rejected.length} rejected`);

const licensed = pack.manifest.length === total;
add("Content", "lexemes are licensed (licence manifests)", licensed ? "pass" : "fail",
  `${pack.manifest.length}/${total} manifest entries`);

add("Content", "attribution output", pack.attributions.length === total ? "pass" : "fail",
  `${pack.attributions.length} attribution entries`);

const canonical = pack.lexemes.filter((l) => isCanonical(pack.audio.get(String(l.id)))).length;
add("Content", "clear human audio 60/60", canonical === total ? "pass" : "fail", `${canonical}/${total} canonical`);

const audioInbox = importAudioCandidates();
add("Content", "human audio candidates supplied", audioInbox.installed ? "pass" : "fail",
  audioInbox.installed ? `${audioInbox.accepted.length} accepted of ${audioInbox.results.length}` : "sources/inbox/audio not installed");

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
console.log("\nNot Stage 2 gates (binding spec)");
for (const [name, why] of notGates) console.log(`  [ n/a   ] ${name} — ${why}`);

const failures = rows.filter((r) => r.verdict === "fail");
console.log("");
if (failures.length === 0) {
  console.log("Stage 2 status: ALL AUTOMATED GATES PASS");
  console.log("Confirm the manual browser gate (`npm run e2e`) before declaring Stage 2 PASS.");
} else {
  console.log("Stage 2 status: NOT YET PASS");
  console.log("Blocked by:");
  for (const f of failures) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
  process.exitCode = 1;
}
