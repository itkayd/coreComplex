import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, correctAttempt } from "../../../fixtures/sim/harness.ts";
import type { Harness } from "../../../fixtures/sim/harness.ts";

/** Drive a kernel through a fixed script so plans have something to schedule. */
function scripted(h: Harness): void {
  const plan = h.kernel.planSession({
    budgetMinutes: 7,
    candidateIntroductions: h.pack.lexemeIds,
  });
  for (const task of plan.tasks) {
    const ans = plan.answers.get(task.id)!;
    h.kernel.submitAttempt(task, correctAttempt(task, ans, "normal",
      task.skill === "speaking" || task.skill === "writing" ? "good" : undefined));
  }
  h.clock.advanceDays(1);
}

test("planner is deterministic: same script + clock + config => identical plan", () => {
  const a = makeHarness();
  const b = makeHarness();
  scripted(a);
  scripted(b);
  const pa = a.kernel.planSession({ budgetMinutes: 7, candidateIntroductions: a.pack.lexemeIds });
  const pb = b.kernel.planSession({ budgetMinutes: 7, candidateIntroductions: b.pack.lexemeIds });

  assert.deepEqual(pa.tasks.map((t) => t.id), pb.tasks.map((t) => t.id), "same order/ids");
  assert.equal(pa.predictedMinutes, pb.predictedMinutes);
  assert.deepEqual(pa.reasonCodes, pb.reasonCodes, "same explanation");
});

test("the plan never exceeds its declared time budget", () => {
  for (const budget of [3, 7, 15]) {
    const h = makeHarness();
    const plan = h.kernel.planSession({ budgetMinutes: budget, candidateIntroductions: h.pack.lexemeIds });
    assert.ok(plan.predictedMinutes <= budget, `${plan.predictedMinutes} <= ${budget}`);
  }
});

test("a TaskContract never leaks its answer (cue !== answer)", () => {
  const h = makeHarness();
  const plan = h.kernel.planSession({ budgetMinutes: 15, candidateIntroductions: h.pack.lexemeIds });
  for (const task of plan.tasks) {
    const answer = plan.answers.get(task.id)!;
    assert.notEqual(task.cue, answer, `task ${task.id} leaks answer in cue`);
  }
});

test("the novelty ceiling caps introductions per session", () => {
  const h = makeHarness();
  const plan = h.kernel.planSession({ budgetMinutes: 15, candidateIntroductions: h.pack.lexemeIds });
  const novel = plan.tasks.filter((t) => t.isNovel).length;
  assert.ok(novel <= 5, `novel ${novel} <= noveltyCeiling 5 (DEFAULT_CONFIG)`);
});

test("confusable lexemes are never paired in one session", () => {
  const h = makeHarness();
  // Make both 是 (be.v.01) and 事 (matter.n.01) due reviews at the same time.
  const intro = h.kernel.planSession({ budgetMinutes: 15, candidateIntroductions: h.pack.lexemeIds });
  for (const task of intro.tasks) {
    const ans = intro.answers.get(task.id)!;
    h.kernel.submitAttempt(task, correctAttempt(task, ans, "normal",
      task.skill === "speaking" || task.skill === "writing" ? "good" : undefined));
  }
  h.clock.advanceDays(2);
  const plan = h.kernel.planSession({ budgetMinutes: 15 });
  const lexemes = new Set(plan.tasks.map((t) => String(t.lexeme)));
  const paired = lexemes.has("be.v.01") && lexemes.has("matter.n.01");
  assert.equal(paired, false, "confusable pair 是/事 must not co-occur");
});
