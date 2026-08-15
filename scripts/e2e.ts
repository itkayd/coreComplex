/**
 * `npm run e2e` — build, serve, and run the browser gates.
 *
 * One command, because a release decision that depends on someone remembering an
 * undocumented second step is not a gate. It writes a machine-readable report so
 * `npm run stage2:gate` can consume the result of the same run rather than
 * claiming the browser gate passed on trust.
 *
 * The fixture pack is used for the listening gate: it carries one generated
 * recording, which proves the byte path without pretending the canonical
 * human-audio requirement is met. Coverage of the real 60 is reported separately
 * by the Stage 2 gate, from the release pack.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const REPORT = process.env.DYR_E2E_REPORT ?? "artifacts/e2e-report.json";
const PORT = Number(process.env.DYR_E2E_PORT ?? 4173);
const BASE = `http://localhost:${PORT}`;

const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  try {
    const out = execFileSync(cmd, args, {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 900_000,
      env: { ...process.env, ...env },
    });
    process.stdout.write(out);
    return { ok: true, output: out };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    process.stdout.write(out);
    return { ok: false, output: out };
  }
};

// 1. Build the web app (which also builds the release pack into public/packs).
const build = run("npm", ["run", "build:web", "--silent"]);
if (!build.ok) {
  writeReport([{ gate: "build:web", ok: false, detail: build.output.split("\n").slice(-5).join(" ") }]);
  process.exit(1);
}

// 2. Serve and drive.
//
// Each gate runs against the pack it is actually about. The Stage 2 gate uses
// the REAL release pack — the one that ships, whose audio slots are honestly
// `declared` until recordings are supplied — so it exercises the shipping
// configuration. The listening gate then runs against a fixture pack overlaid
// into dist, because a playable recording is exactly what it needs to test and
// no licensed human recording exists yet. Running both against one pack would
// mean either testing the release in a configuration it is not in, or not
// testing playback at all.
const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
  cwd: "apps/web", stdio: "ignore", detached: true,
});
const results: { gate: string; ok: boolean; detail: string }[] = [];
const PACK = "apps/web/dist/packs/dyr-core60.json";
try {
  await waitForServer(BASE);

  const stage2 = run("node", ["apps/web/e2e/stage2.mjs"], { DYR_E2E_URL: BASE, DYR_E2E_PACK: PACK });
  results.push({ gate: "stage2", ok: stage2.ok, detail: summarise(stage2.output) });

  // Overlay the fixture pack. Writes into dist only — the committed release pack
  // under apps/web/public is untouched.
  const fixture = run("node", ["scripts/build-fixture-pack.ts", "apps/web/dist/packs"]);
  if (!fixture.ok) {
    results.push({ gate: "fixture-pack", ok: false, detail: fixture.output.split("\n").slice(-3).join(" ") });
  } else {
    const listening = run("node", ["apps/web/e2e/listening.mjs"], { DYR_E2E_URL: BASE, DYR_E2E_PACK: PACK });
    results.push({ gate: "listening", ok: listening.ok, detail: summarise(listening.output) });
  }
} finally {
  if (server.pid) try { process.kill(-server.pid); } catch { /* already gone */ }
  // Restore the release pack in dist so a later manual `vite preview` serves
  // what actually ships rather than the fixture.
  run("node", ["packages/content/bin/build-pack.ts", "apps/web/dist/packs"]);
}

function summarise(output: string): string {
  return /(\d+)\/(\d+) checks passed/.exec(output)?.[0] ?? output.split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 100);
}

writeReport(results);
const failed = results.filter((r) => !r.ok);
console.log(`\nbrowser gates: ${results.length - failed.length}/${results.length} passed`);
for (const r of results) console.log(`  [${r.ok ? "PASS" : "FAIL"}] ${r.gate} — ${r.detail}`);
console.log(`report: ${REPORT}`);
if (failed.length > 0) process.exitCode = 1;

function writeReport(rows: { gate: string; ok: boolean; detail: string }[]) {
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, `${JSON.stringify({
    ranAt: new Date().toISOString(),
    ok: rows.every((r) => r.ok),
    gates: rows,
  }, null, 2)}\n`, "utf8");
}

async function waitForServer(url: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`preview server did not start at ${url}`);
}
