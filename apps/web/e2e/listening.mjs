/**
 * The canonical-listening browser gate.
 *
 * Proves the half of the vertical slice that only exists in a browser: that real
 * audio bytes travel from the built pack through the service worker into an
 * <audio> element, that the task screen never shows the answer before it is
 * given, that answering moves ONLY the Listening trace, that the recording still
 * plays after an offline reload, and that a missing or corrupted recording
 * produces no retrieval evidence at all.
 *
 * It runs against the FIXTURE pack (generated recordings), because the whole
 * point is to test the machinery before 60 licensed human recordings exist. The
 * fixture can never reach a production pack — `buildCore60Pack` refuses flagged
 * audio, and a unit test asserts that refusal.
 *
 * Usage:
 *   node scripts/build-fixture-pack.ts apps/web/dist/packs   # overwrite the pack
 *   npx vite preview --port 4173 --strictPort &
 *   node apps/web/e2e/listening.mjs
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = process.env.DYR_E2E_URL ?? "http://localhost:4173";
const PACK = process.env.DYR_E2E_PACK ?? "apps/web/dist/packs/dyr-core60.json";
const EXECUTABLE = process.env.DYR_E2E_CHROMIUM;

const pack = JSON.parse(readFileSync(PACK, "utf8"));
const canonical = pack.audio.filter((a) => a.state === "verified" && a.runtime);
const answers = new Map(pack.lexemes.map((l) => [l.id, l.senses[0]]));
const surfaces = new Map(pack.lexemes.map((l) => [l.id, l.simplified]));
/**
 * Which lexeme a content-addressed URL belongs to.
 *
 * The task screen deliberately reveals nothing about the target word, so the
 * harness identifies the task the same way the app does — through the pack, from
 * the recording that was requested. Needing this indirection is itself evidence
 * that the no-leakage rule holds.
 */
const lexemeByAudioPath = new Map(canonical.map((a) => [a.runtime.path.split("/").pop(), a.lexeme]));
const lexemeForUrl = (url) => lexemeByAudioPath.get(url.split("/").pop());

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok" : "NOT OK"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/** Advance through the plan until a listening task is on screen. */
async function findListeningTask(page, maxTasks = 12) {
  for (let i = 0; i < maxTasks; i++) {
    await page.waitForSelector("#answer, .cue-audio", { timeout: 5_000 }).catch(() => {});
    if (await page.$(".cue-audio")) return true;
    if (!(await page.$("#answer"))) return false; // plan exhausted, back on Home
    // Answer whatever this is (wrongly is fine) to advance the plan.
    await page.fill("#answer", "x");
    await page.getByRole("button", { name: "Answer", exact: true }).click();
    await page.waitForSelector('button:has-text("Next"), button:has-text("Finish session")', { timeout: 10_000 });
    await page.click('button:has-text("Next"), button:has-text("Finish session")');
  }
  return false;
}

/**
 * Read the four skill meters.
 *
 * The bottom nav is deliberately hidden during a task and its result (spec p.27:
 * one cue, one action), so leave that flow first — clicking "Next" on a result,
 * then answering out of any remaining task — before navigating to Progress.
 */
async function profile(page) {
  for (let i = 0; i < 15 && !(await page.$('nav.nav')); i++) {
    // The last task's advance button reads "Finish session", not "Next".
    const advance = await page.$('button:has-text("Next"), button:has-text("Finish session")');
    if (advance) { await advance.click(); continue; }
    if (await page.$("#answer")) {
      const disabled = await page.$eval("#answer", (el) => el.disabled);
      if (disabled) await page.getByRole("button", { name: /^Skip$/ }).click();
      else {
        await page.fill("#answer", "x");
        await page.getByRole("button", { name: "Answer", exact: true }).click();
      }
      continue;
    }
    await page.waitForTimeout(200);
  }
  await page.getByRole("button", { name: "Progress" }).click({ timeout: 10_000 });
  await page.waitForSelector(".meter");
  return page.$$eval(".meter", (els) => Object.fromEntries(els.map((e) => {
    const text = e.textContent.replace(/\s+/g, " ").trim();
    const [, skill, retained] = /^([A-Za-z]+)\s*(\d+)\s*\//.exec(text) ?? [, text, "?"];
    return [skill.toLowerCase(), retained];
  })));
}

async function run() {
  if (canonical.length === 0) {
    console.log("No canonical audio in the pack under test — build the fixture pack first:");
    console.log("  node scripts/build-fixture-pack.ts apps/web/dist/packs");
    process.exitCode = 1;
    return;
  }
  // 银行 / bank.n.01 is the worked example throughout the project; its asset is
  // inspected statically. Which lexeme the planner happens to schedule is its
  // decision, and is discovered at runtime below.
  const sample = canonical.find((a) => a.lexeme === "bank.n.01") ?? canonical[0];
  console.log(`pack has ${canonical.length} canonical recording(s); inspecting ${sample.lexeme} (${sample.runtime.path})\n`);

  const browser = await chromium.launch(EXECUTABLE ? { executablePath: EXECUTABLE } : {});
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
    // Chromium blocks autoplay by default; the app must work either way, and the
    // no-gesture path is what a returning learner actually experiences.
    permissions: [],
  });
  const page = await context.newPage();
  const pageErrors = [];
  const audioRequests = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("requestfinished", (r) => { if (/\/packs\/audio\//.test(r.url())) audioRequests.push(r.url()); });

  // ---- 1. the pack references content-addressed audio ----
  check("pack declares content-addressed runtime audio",
    canonical.every((a) => a.runtime.path === `audio/${a.runtime.sha256}.wav`),
    sample.runtime.path);
  check("runtime audio paths leak no lexeme id",
    canonical.every((a) => !a.runtime.path.includes(a.lexeme)));
  check("canonical audio carries full provenance",
    canonical.every((a) => a.provenance?.sourceName && a.provenance?.licenseSpdx && a.review?.reviewedBy),
    `${sample.provenance?.sourceName} / ${sample.provenance?.licenseSpdx}`);

  // ---- 2. a listening task appears and plays real audio ----
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Start 7 minutes/ }).click();
  const found = await findListeningTask(page);
  check("a listening task with an audio cue is planned", found);
  if (!found) { await browser.close(); return finish(); }

  // Identify the scheduled lexeme from the recording the app requested.
  await page.waitForTimeout(500);
  const target = canonical.find((a) => a.lexeme === lexemeForUrl(audioRequests.at(-1) ?? "")) ?? sample;
  console.log(`  ·  planner scheduled a listening task for ${target.lexeme}`);

  check("audio control is present and labelled generically",
    Boolean(await page.getByRole("button", { name: /^Play listening prompt/ }).first().elementHandle()),
    await page.getByRole("button", { name: /^Play listening prompt/ }).first().getAttribute("aria-label"));

  // ---- 3. no answer leakage ----
  const taskText = (await page.textContent("main")) ?? "";
  const taskHtml = (await page.innerHTML("main")) ?? "";
  const gloss = answers.get(target.lexeme) ?? "";
  const surface = surfaces.get(target.lexeme) ?? "";
  check("transcript / hanzi not in the task DOM", !taskText.includes(surface) && !taskHtml.includes(surface), surface);
  // Whole-word match: a one-letter gloss such as "I" would otherwise "leak"
  // through every ordinary sentence on the screen.
  const glossLeaked = new RegExp(`\\b${gloss.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(taskText);
  check("English gloss not in the task DOM", gloss.length > 0 && !glossLeaked, gloss);
  check("lexeme id not in the task DOM", !taskHtml.includes(target.lexeme));
  check("transcript not in any accessible label",
    !(await page.$$eval("[aria-label]", (els) => els.map((e) => e.getAttribute("aria-label")).join(" ")))
      .includes(surface));

  // ---- 4. playback actually succeeds ----
  await page.getByRole("button", { name: /^Play listening prompt/ }).first().click();
  await page.waitForTimeout(400);
  const played = await page.$eval(".cue-audio", (el) => Number(el.getAttribute("data-plays")));
  check("clicking play plays the recording", played >= 1, `data-plays=${played}`);
  check("the recording was fetched from the pack", audioRequests.length > 0, audioRequests[0] ?? "");
  check("cue reports ready (bytes passed their hash check)",
    (await page.$eval(".cue-audio", (el) => el.getAttribute("data-cue-state"))) === "ready");

  // Replay once more, so the recorded count is a real one and not a constant.
  await page.getByRole("button", { name: /^Play listening prompt/ }).first().click();
  await page.waitForTimeout(300);
  const replayed = await page.$eval(".cue-audio", (el) => Number(el.getAttribute("data-plays")));
  check("replays are counted from real playback", replayed === played + 1, `${played} → ${replayed}`);

  // ---- 5. answering moves ONLY listening ----
  await page.fill("#answer", answers.get(target.lexeme) ?? "x");
  await page.getByRole("button", { name: "Answer", exact: true }).click();
  await page.waitForSelector('button:has-text("Next")');
  const resultText = (await page.textContent("main")) ?? "";
  check("the result names Listening as the skill trained", /Listening/.test(resultText));

  const after = await profile(page);
  check("Listening retained is non-zero after a correct listening answer",
    Number(after.listening) >= 1, JSON.stringify(after));
  check("speaking and writing are untouched by a listening answer",
    after.speaking === "0" && after.writing === "0", JSON.stringify(after));

  // ---- 6. offline: the recording is cached and still plays ----
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200); // let the worker install the pack cache
  await context.setOffline(true);
  await page.reload({ waitUntil: "load" }).catch(() => {});
  await page.waitForTimeout(800);
  const offlineUsable = await page.$('button:has-text("Start 7 minutes")');
  check("offline reload keeps the app usable", Boolean(offlineUsable));
  if (offlineUsable) {
    await page.getByRole("button", { name: /Start 7 minutes/ }).click();
    const offlineFound = await findListeningTask(page);
    check("listening task is available offline", offlineFound);
    if (offlineFound) {
      await page.getByRole("button", { name: /^Play listening prompt/ }).first().click();
      await page.waitForTimeout(500);
      const offlineState = await page.$eval(".cue-audio", (el) => el.getAttribute("data-cue-state"));
      const offlinePlays = await page.$eval(".cue-audio", (el) => Number(el.getAttribute("data-plays")));
      check("the cached recording plays offline", offlineState === "ready" && offlinePlays >= 1,
        `state=${offlineState} plays=${offlinePlays}`);
    }
  }
  await context.setOffline(false);

  // ---- 7. corrupted runtime bytes produce NO evidence ----
  // A fresh context with no service worker: the route is then unambiguously the
  // only source of the audio bytes, so this tests the app's verification rather
  // than a cache race.
  // `serviceWorkers: "block"` matters: a registered worker serves fetches from
  // inside the browser, below Playwright's network layer, so a route would never
  // see the request. With no worker, the route is the only source of the bytes.
  const bare = await browser.newContext({
    viewport: { width: 390, height: 844 }, reducedMotion: "reduce", serviceWorkers: "block",
  });
  const bp = await bare.newPage();
  let corruptedServed = 0;
  // A URL predicate rather than a glob: unambiguous about what is intercepted.
  await bare.route((url) => url.pathname.includes("/packs/audio/"), (route) => {
    corruptedServed++;
    return route.fulfill({
      status: 200,
      contentType: "audio/wav",
      headers: { "cache-control": "no-store" },
      body: Buffer.from("RIFF....WAVEtampered-not-the-certified-bytes"),
    });
  });
  await bp.goto(BASE, { waitUntil: "networkidle" });
  await bp.getByRole("button", { name: /Start 7 minutes/ }).click();
  const corruptFound = await findListeningTask(bp);
  if (corruptFound) {
    await bp.waitForTimeout(800);
    const state = await bp.$eval(".cue-audio", (el) => el.getAttribute("data-cue-state"));
    check("corrupted audio is refused, not played", state === "failed",
      `state=${state}, intercepted=${corruptedServed}`);
    const answerDisabled = await bp.$eval("#answer", (el) => el.disabled);
    check("a task with corrupted audio cannot be answered", answerDisabled === true);
    const bodyText = (await bp.textContent("main")) ?? "";
    check("the refusal is explained to the learner",
      /does not match the content pack|could not be loaded/.test(bodyText), bodyText.replace(/\s+/g, " ").slice(0, 80));

    const before = await bp.evaluate(() => new Promise((resolve) => {
      const req = indexedDB.open("dyr-learning");
      req.onsuccess = () => {
        const db = req.result;
        const count = db.transaction("events").objectStore("events").count();
        count.onsuccess = () => resolve(count.result);
      };
      req.onerror = () => resolve(-1);
    }));
    await bp.getByRole("button", { name: /^Skip$/ }).click({ timeout: 10_000 });
    await bp.waitForTimeout(500);
    const after = await bp.evaluate(() => new Promise((resolve) => {
      const req = indexedDB.open("dyr-learning");
      req.onsuccess = () => {
        const db = req.result;
        const count = db.transaction("events").objectStore("events").count();
        count.onsuccess = () => resolve(count.result);
      };
      req.onerror = () => resolve(-1);
    }));
    check("skipping unheard audio writes no learning event", after === before, `${before} → ${after}`);
  } else {
    check("corrupted audio path reached", false, "no listening task appeared");
  }
  await bare.close();

  check("no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
  await browser.close();
  finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\nlistening gate: ${results.length - failed.length}/${results.length} checks passed`);
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
