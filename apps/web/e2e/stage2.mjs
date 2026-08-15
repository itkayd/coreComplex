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

/**
 * The "Hear it" path, which cannot be tested any other way.
 *
 * Headless Chromium ships no speech voices at all, so the real browser exercises
 * only the DEGRADED path — which is worth checking, but proves nothing about the
 * behaviour a learner on a phone gets. So `speechSynthesis` is stubbed with a
 * known voice list and every `speak()` call is recorded, which lets this gate
 * assert the three things that actually matter:
 *
 *   1. with a Mandarin voice, the word list offers playback and speaking a word
 *      passes the right TEXT at the right LANG (a zh-CN utterance, not the page's
 *      English default, which is what silently reads hanzi as gibberish);
 *   2. with only a Cantonese voice, nothing is offered — a Cantonese reading of a
 *      Mandarin word is a wrong answer delivered confidently;
 *   3. with no voice, the UI says so instead of showing a button that can only
 *      ever fail.
 */
async function audioGate(browser) {
  const scenario = async (label, voices, assert) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript((list) => {
      const spoken = [];
      window.__spoken = spoken;
      class FakeUtterance {
        constructor(text) { this.text = text; this.lang = ""; this.rate = 1; this.voice = null; }
      }
      window.SpeechSynthesisUtterance = FakeUtterance;
      // `speechSynthesis` is a read-only accessor on window, so a plain
      // assignment is silently dropped and the stub never takes effect.
      Object.defineProperty(window, "speechSynthesis", {
        configurable: true,
        value: {
          getVoices: () => list,
          speak(u) {
            spoken.push({ text: u.text, lang: u.lang, rate: u.rate, voice: u.voice?.name ?? null });
            setTimeout(() => u.onend?.(), 5);
          },
          cancel() {},
          addEventListener() {},
          removeEventListener() {},
        },
      });
    }, voices);
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForSelector("button");
    try {
      await assert(page, label);
    } finally {
      await context.close();
    }
  };

  const mandarin = [{ name: "Ting-Ting", lang: "zh-CN", localService: true, default: false }];
  const cantonese = [{ name: "Sin-ji", lang: "zh-HK", localService: true, default: false }];

  await scenario("mandarin", mandarin, async (page) => {
    await page.getByRole("button", { name: "Words" }).click();
    await page.waitForSelector(".hsk-bar", { timeout: 15_000 });
    const show = await page.$('button:has-text("Show ")');
    if (show) await show.click();
    const button = await page.waitForSelector(".pronounce-compact", { timeout: 10_000 }).catch(() => null);
    check("audio: a Mandarin device voice offers playback in the word list", Boolean(button));
    if (!button) return;

    // The word beside the button is the text that must be spoken.
    const expected = await button.evaluate((el) => el.closest(".word")?.querySelector(".hanzi")?.textContent ?? "");
    await button.click();
    await page.waitForFunction(() => (window.__spoken ?? []).length > 0, null, { timeout: 5000 }).catch(() => {});
    const spoken = await page.evaluate(() => window.__spoken ?? []);
    check("audio: playing a word speaks that word", spoken[0]?.text === expected,
      `spoke ${JSON.stringify(spoken[0]?.text)}, expected ${JSON.stringify(expected)}`);
    check("audio: the utterance is tagged Mandarin, not the page language",
      spoken[0]?.lang === "zh-CN" && spoken[0]?.voice === "Ting-Ting",
      `lang=${spoken[0]?.lang} voice=${spoken[0]?.voice}`);

    // And the result screen offers the slower replay, at a real slower rate.
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /Start 7 minutes/ }).click();
    await answerCurrentTask(page);
    await page.evaluate(() => { window.__spoken.length = 0; });
    const slower = await page.$('button:has-text("Slower")');
    check("audio: the result screen offers a slower replay", Boolean(slower));
    if (slower) {
      await slower.click();
      await page.waitForFunction(() => (window.__spoken ?? []).length > 0, null, { timeout: 5000 }).catch(() => {});
      const rate = (await page.evaluate(() => window.__spoken ?? []))[0]?.rate;
      check("audio: slower actually lowers the rate", typeof rate === "number" && rate < 1, `rate=${rate}`);
    }
  });

  await scenario("cantonese", cantonese, async (page) => {
    await page.getByRole("button", { name: "Words" }).click();
    await page.waitForSelector(".hsk-bar", { timeout: 15_000 });
    const show = await page.$('button:has-text("Show ")');
    if (show) await show.click();
    await page.waitForTimeout(500);
    const offered = await page.$(".pronounce-compact");
    check("audio: a Cantonese-only device is offered NOTHING", offered === null);
  });

  await scenario("none", [], async (page) => {
    await page.getByRole("button", { name: "Settings" }).click();
    await page.waitForSelector("h1");
    // An empty voice list is the one case that waits out `loadVoices`' timeout:
    // the platform may still deliver voices on `voiceschanged`, so "none" is only
    // concluded after that window closes.
    await page.waitForFunction(
      () => !/checking…/.test(document.body.textContent ?? ""),
      null,
      { timeout: 8000 },
    ).catch(() => {});
    const text = ((await page.textContent("body")) ?? "").replace(/\s+/g, " ");
    check("audio: a device with no Mandarin voice is told so",
      /no Mandarin voice installed/i.test(text), text.slice(0, 80));
    check("audio: and is not shown a control that could only fail",
      (await page.$(".pronounce-compact")) === null);
  });
}

/**
 * The single account, as the learner meets it.
 *
 * The property that matters is the one it would be easiest to get wrong: SIGNING
 * IN MUST NEVER BE REQUIRED TO STUDY. This app is local-first, the pack is
 * public, and a learner with an expired session on a train must still be able to
 * work. So the gate is checked for having a way past it, and for the way past it
 * actually leading to a usable session.
 *
 * The preview server has no functions, so `/api/auth` is stubbed — which is also
 * how the "no account configured" path gets exercised, since that is what an
 * unconfigured deployment really returns.
 */
async function accountGate(browser) {
  const withAuth = async (label, handler, assertions) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route("**/api/auth", handler);
    // The backup endpoint is stubbed as unconfigured so nothing else interferes.
    await context.route("**/api/sync**", (route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, configured: false }) }));
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForSelector("button", { timeout: 15_000 });
    try {
      await assertions(page, label);
    } finally {
      await context.close();
    }
  };

  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  // --- configured, signed out: the gate appears and can be walked past ---
  await withAuth("gate", (route) => json(route, { ok: true, configured: true, authenticated: false }), async (page) => {
    const heading = await page.waitForSelector("text=Sign in to sync", { timeout: 10_000 }).catch(() => null);
    check("account: a configured deployment asks the owner to sign in", Boolean(heading));

    const skip = await page.$('button:has-text("Skip")');
    check("account: SIGNING IN IS NEVER REQUIRED TO STUDY", Boolean(skip));
    if (!skip) return;
    await skip.click();
    const start = await page.waitForSelector('button:has-text("Start 7 minutes")', { timeout: 10_000 }).catch(() => null);
    check("account: skipping leads to a usable session", Boolean(start));
    if (start) {
      await start.click();
      check("account: a skipped learner can still be issued a task", Boolean(await page.$("#answer")));
    }
  });

  // --- a wrong passphrase is reported, and does not let anyone in ---
  await withAuth("wrong", async (route) => {
    if (route.request().method() === "POST") return json(route, { ok: false, error: "nope" }, 401);
    return json(route, { ok: true, configured: true, authenticated: false });
  }, async (page) => {
    await page.waitForSelector("#passphrase", { timeout: 10_000 });
    await page.fill("#passphrase", "not-the-passphrase");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const alert = await page.waitForSelector('[role="alert"]', { timeout: 10_000 }).catch(() => null);
    check("account: a wrong passphrase is reported", Boolean(alert));
    check("account: and does not let anyone through",
      Boolean(await page.$("#passphrase")), "the gate should still be showing");
  });

  // --- the right passphrase gets in ---
  await withAuth("right", async (route) => {
    if (route.request().method() === "POST") return json(route, { ok: true, authenticated: true });
    return json(route, { ok: true, configured: true, authenticated: false });
  }, async (page) => {
    await page.waitForSelector("#passphrase", { timeout: 10_000 });
    await page.fill("#passphrase", "the-correct-passphrase");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const start = await page.waitForSelector('button:has-text("Start 7 minutes")', { timeout: 10_000 }).catch(() => null);
    check("account: the right passphrase signs in", Boolean(start));
  });

  // --- unconfigured: no gate at all, because there is nothing to sign in to ---
  await withAuth("unconfigured", (route) => json(route, { ok: true, configured: false, authenticated: false }), async (page) => {
    await page.waitForTimeout(400);
    check("account: an unconfigured deployment never shows a lock screen",
      (await page.$("#passphrase")) === null && Boolean(await page.$('button:has-text("Start 7 minutes")')));
  });

  // --- the gate must be accessible too ---
  await withAuth("a11y", (route) => json(route, { ok: true, configured: true, authenticated: false }), async (page) => {
    await page.waitForSelector("#passphrase", { timeout: 10_000 });
    await audit(page, "sign in");
  });
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

  await audioGate(browser);
  await accountGate(browser);

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
