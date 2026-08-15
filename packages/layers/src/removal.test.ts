import { test } from "node:test";
import assert from "node:assert/strict";
import { projectCity, EMPTY_CITY } from "./index.ts";
import { makeHarness, correctAttempt, wrongAttempt } from "../../../fixtures/sim/harness.ts";

/** Drive a kernel and return it plus a digest snapshot. */
function run() {
  const h = makeHarness();
  for (let d = 0; d < 4; d++) {
    const plan = h.kernel.planSession({ budgetMinutes: 7, candidateIntroductions: h.pack.lexemeIds });
    for (const [i, task] of plan.tasks.entries()) {
      const ans = plan.answers.get(task.id)!;
      const prod = task.skill === "speaking" || task.skill === "writing";
      if (i % 4 === 3) h.kernel.submitAttempt(task, prod ? { ...wrongAttempt(task), selfGrade: "again" } : wrongAttempt(task));
      else h.kernel.submitAttempt(task, correctAttempt(task, ans, "normal", prod ? "good" : undefined));
    }
    h.clock.advanceDays(1);
  }
  return h;
}

test("REMOVAL TEST (p.20): building the city projection never touches kernel state", () => {
  const h = run();
  const before = h.kernel.traces.digest();
  const logBefore = h.kernel.log.digest();

  const city = projectCity(h.kernel.publishedFacts());

  // The projection produced a city, yet the kernel is byte-for-byte unchanged.
  assert.notDeepEqual(city, EMPTY_CITY, "city reflects learning");
  assert.equal(h.kernel.traces.digest(), before, "trace state unchanged by layer");
  assert.equal(h.kernel.log.digest(), logBefore, "event log unchanged by layer");
});

test("the city is a pure function of facts — discard and rebuild is identical", () => {
  const h = run();
  const a = projectCity(h.kernel.publishedFacts());
  const b = projectCity(h.kernel.publishedFacts());
  assert.deepEqual(a, b, "removable + rebuildable");
});

test("a lapse earns no reward (points only for direct retrieval, p.20)", () => {
  const h = run();
  const facts = h.kernel.publishedFacts();
  const passes = facts.filter((f) => f.ratingApplied !== "again");
  const city = projectCity(facts);
  // Points never exceed 2x the passing facts and never count 'again'.
  assert.ok(city.points <= passes.length * 2);
  assert.ok(city.points >= passes.length); // at least one point each
});
