/**
 * Stage 2 browser gate.
 *
 * Drives the real built PWA in a real browser and checks the acceptance
 * behaviours that only exist end-to-end: bounded sessions, offline reload,
 * IndexedDB restore, interrupted sessions, pack-integrity refusal, and WCAG
 * AA accessibility on every screen.
 *
 * Usage:
 *   npm run build:web
 *   npx vite preview --port 4173 --strictPort &
 *   node apps/web/e2e/stage2.mjs [--browser chromium|firefox|webkit]
 *
 * Requires `playwright` and `axe-core` to be resolvable. Both are dev-only and
 * neither ships in the app bundle.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium, firefox, webkit } = require("playwright");
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const BASE = process.env.DYR_E2E_URL ?? "http://localhost:4173";
const PACK = process.env.DYR_E2E_PACK ?? "apps/web/dist/packs/dyr-core60.json";
const browserArg = (process.argv.find((a) => a.startsWith("--browser=")) ?? "--browser=chromium").split("=")[1];
const EXECUTABLE = process.env.DYR_E2E_CHROMIUM; // optional pinned binary

const ENGINES = { chromium, firefox, webkit };
const answers = new Map(
  JSON.parse(readFileSync(PACK, "utf8")).lexemes.map((l) => [l.simplified, l.senses[0]]),
);

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok" : "NOT OK"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/** Wait for CSS animations to settle so audits sample the resting state. */
async function settle(page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 5000 })
    .catch(() => {});
}

async function audit(page, label) {
  await settle(page);
  await page.evaluate(AXE_SOURCE);
  const report = await page.evaluate(async () =>
    window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } }));
  const violations = report.violations.map((v) => `${v.id}(${v.impact})`);
  check(`a11y: ${label}`, violations.length === 0, violations.join(", "));
}

/**
 * Answer the current task.
 *
 * A task shows either a text cue or an audio cue. An audio task deliberately
 * reveals nothing about its target, so there is no correct answer to look up —
 * any answer still exercises the task→result cycle this gate is checking.
 */
async function answerCurrentTask(page) {
  await page.waitForSelector("#answer", { timeout: 15_000 });
  const cueEl = await page.$(".cue");
  const cue = cueEl ? (await cueEl.textContent())?.trim() ?? "" : "";
  await page.fill("#answer", answers.get(cue) ?? "x");
  await page.getByRole("button", { name: "Answer", exact: true }).click();
  await page.waitForSelector('button:has-text("Next")', { timeout: 15_000 });
}

async function run() {
  const engine = ENGINES[browserArg];
  if (!engine) throw new Error(`unknown browser: ${browserArg}`);
  const browser = await engine.launch(EXECUTABLE && browserArg === "chromium" ? { executablePath: EXECUTABLE } : {});
  // Mobile viewport + reduced motion: the configuration the spec cares about.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("button");
  await audit(page, "home");

  // --- bounded sessions: 3 / 7 / 15 minutes all plan and stay bounded ---
  for (const [label, name] of [["3", /^3 min$/], ["7", /Start 7 minutes/], ["15", /^15 min$/]]) {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.getByRole("button", { name }).click();
    const started = await page.$("#answer");
    check(`${label}-minute session plans a task`, Boolean(started));
    if (started) await audit(page, `task (${label} min)`);
  }

  // --- a full task → result cycle ---
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Start 7 minutes/ }).click();
  await answerCurrentTask(page);
  await audit(page, "result");

  // --- interrupted session: reload mid-session, state must survive ---
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Progress" }).click();
  await page.waitForSelector(".meter");
  const afterReload = await page.$$eval(".meter", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  check("IndexedDB restore after interruption", afterReload.some((m) => /[1-9]/.test(m.split("/")[0])),
    afterReload.join(" | "));
  await audit(page, "progress");

  await page.getByRole("button", { name: "Words" }).click();
  await page.waitForSelector(".hsk-bar", { timeout: 15_000 });
  await audit(page, "words");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.waitForSelector("h1");
  await audit(page, "settings");

  // --- offline: the shell and pack are cached, the session still starts ---
  await context.setOffline(true);
  await page.reload({ waitUntil: "load" }).catch(() => {});
  await page.waitForTimeout(600);
  const offlineUsable = await page.$('button:has-text("Start 7 minutes")');
  check("offline reload keeps the app usable", Boolean(offlineUsable));
  await context.setOffline(false);

  // --- pack integrity: a tampered pack must be REFUSED, not taught from ---
  // The service worker caches the pack (correct offline behaviour), so the
  // cache must be cleared first or the tampered response never reaches the app.
  await page.evaluate(async () => {
    for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
    for (const key of await caches.keys()) await caches.delete(key);
  });
  await context.route("**/packs/dyr-core60.json", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.lexemes[0].senses = ["tampered meaning"]; // hash no longer matches
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const bodyText = (await page.textContent("body")) ?? "";
  check("tampered pack is refused with an explanation",
    /rejected \(integrity\)|failed integrity check/i.test(bodyText),
    bodyText.replace(/\s+/g, " ").slice(0, 90));
  await context.unroute("**/packs/dyr-core60.json");

  check("no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${browserArg}: ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log("FAILED:");
    for (const f of failed) console.log(`  - ${f.name} ${f.detail}`);
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
