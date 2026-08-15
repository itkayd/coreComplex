import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { RATINGS, type Rating } from "@dyr/domain";
import { createFsrsAdapter } from "@dyr/fsrs-adapter";
import { projectCity } from "@dyr/layers";
import { verifyReplay } from "./replay.ts";
import { makeHarness, correctAttempt, wrongAttempt, makeCommand } from "../../../fixtures/sim/harness.ts";

const DAY = 86_400_000;
const ratingArb = fc.constantFrom<Rating>(...RATINGS);

/** Drive a harness through a generated script of (correct?) decisions. */
function driveScript(correctness: boolean[], days: number): ReturnType<typeof makeHarness> {
  const h = makeHarness();
  let idx = 0;
  for (let d = 0; d < days; d++) {
    const plan = h.kernel.planSession({ budgetMinutes: 7, candidateIntroductions: h.pack.lexemeIds });
    for (const task of plan.tasks) {
      const ok = correctness[idx++ % correctness.length];
      const prod = task.skill === "speaking" || task.skill === "writing";
      const ans = plan.answers.get(task.id)!;
      h.kernel.submitAttempt(task, ok
        ? correctAttempt(task, ans, "normal", prod ? "good" : undefined)
        : (prod ? { ...wrongAttempt(task), selfGrade: "again" } : wrongAttempt(task)));
    }
    h.clock.advanceDays(1);
  }
  return h;
}

test("PROPERTY trace isolation: each accepted update touches exactly one trace", () => {
  fc.assert(
    fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }), fc.integer({ min: 1, max: 4 }), (correctness, days) => {
      // The kernel throws if an update ever mutates >1 trace; total evidence
      // must equal the number of TraceUpdated events.
      const h = driveScript(correctness, days);
      const totalEvidence = h.kernel.traces.all().reduce((s, t) => s + t.evidenceCount, 0);
      const updates = h.kernel.log.all().filter((e) => e.eventType === "TraceUpdated").length;
      return totalEvidence === updates;
    }),
    { numRuns: 40 },
  );
});

test("PROPERTY replay: reconstructed state matches the live kernel", () => {
  fc.assert(
    fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }), fc.integer({ min: 1, max: 4 }), (correctness, days) => {
      const h = driveScript(correctness, days);
      return verifyReplay(h.kernel.traces, h.kernel.log.all());
    }),
    { numRuns: 40 },
  );
});

test("PROPERTY idempotency: a duplicated command yields exactly one update", () => {
  fc.assert(
    fc.property(fc.boolean(), fc.integer({ min: 1, max: 5 }), (correct, dupCount) => {
      const h = makeHarness();
      const plan = h.kernel.planSession({ budgetMinutes: 7, candidateIntroductions: h.pack.lexemeIds });
      const task = plan.tasks[0];
      const ans = plan.answers.get(task.id)!;
      const prod = task.skill === "speaking" || task.skill === "writing";
      const attempt = correct ? correctAttempt(task, ans, "normal", prod ? "good" : undefined) : wrongAttempt(task);
      const cmd = makeCommand(task, attempt, h.clock.now());
      for (let i = 0; i < dupCount; i++) h.kernel.submitCommand(cmd, task);
      return h.kernel.traces.get(task.targetTrace)!.evidenceCount === 1;
    }),
    { numRuns: 30 },
  );
});

test("PROPERTY planner budget: a plan never exceeds its declared minutes", () => {
  fc.assert(
    fc.property(fc.constantFrom(3, 7, 15), fc.array(fc.boolean(), { maxLength: 8 }), fc.integer({ min: 0, max: 3 }), (budget, correctness, warmDays) => {
      const h = warmDays > 0 ? driveScript(correctness.length ? correctness : [true], warmDays) : makeHarness();
      const plan = h.kernel.planSession({ budgetMinutes: budget, candidateIntroductions: h.pack.lexemeIds });
      return plan.predictedMinutes <= budget;
    }),
    { numRuns: 40 },
  );
});

test("PROPERTY layer isolation: projecting the city never changes learning state", () => {
  fc.assert(
    fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 10 }), (correctness) => {
      const h = driveScript(correctness, 2);
      const before = h.kernel.traces.digest();
      const logBefore = h.kernel.log.digest();
      projectCity(h.kernel.publishedFacts()); // any layer op
      return h.kernel.traces.digest() === before && h.kernel.log.digest() === logBefore;
    }),
    { numRuns: 30 },
  );
});

test("PROPERTY FSRS bounds: valid ratings never create invalid memory state", () => {
  const adapter = createFsrsAdapter();
  fc.assert(
    fc.property(fc.array(ratingArb, { minLength: 1, maxLength: 30 }), (ratings) => {
      let s = adapter.initialState();
      let t = 0;
      for (const r of ratings) {
        const res = adapter.scheduleReview(s, r, t);
        if (!(res.state.difficulty >= 1 && res.state.difficulty <= 10)) return false;
        if (!(res.state.stability > 0)) return false;
        if (!Number.isFinite(res.state.due!)) return false;
        s = res.state;
        t = s.due!;
      }
      return true;
    }),
    { numRuns: 50 },
  );
});

test("PROPERTY determinism: identical script + seed + config => identical state", () => {
  fc.assert(
    fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }), fc.integer({ min: 1, max: 4 }), (correctness, days) => {
      const a = driveScript(correctness, days);
      const b = driveScript(correctness, days);
      return a.kernel.traces.digest() === b.kernel.traces.digest()
        && a.kernel.log.digest() === b.kernel.log.digest();
    }),
    { numRuns: 30 },
  );
});
