import { test } from "node:test";
import assert from "node:assert/strict";
import { traceId, LexemeId } from "@dyr/domain";
import { makeHarness, correctAttempt, wrongAttempt } from "../../../fixtures/sim/harness.ts";

const bank = LexemeId("bank.n.01");

function planAndFirst(h: ReturnType<typeof makeHarness>) {
  const plan = h.kernel.planSession({ budgetMinutes: 15, candidateIntroductions: h.pack.lexemeIds });
  const task = plan.tasks[0];
  return { plan, task, answer: plan.answers.get(task.id)! };
}

test("a failed retrieval schedules a repair for the SAME trace (ADR-0003)", () => {
  const h = makeHarness();
  const { task } = planAndFirst(h);
  const res = h.kernel.submitAttempt(task, wrongAttempt(task));
  assert.equal(res.decision, "update");
  assert.ok(res.repair, "repair scheduled");
  assert.equal(res.repair!.trace, task.targetTrace, "same trace");
});

test("a repair becomes eligible only after its short gap, then appears in a plan", () => {
  const h = makeHarness();
  const { task } = planAndFirst(h);
  h.kernel.submitAttempt(task, wrongAttempt(task));

  // Immediately: repair exists but is not yet eligible (min gap not elapsed).
  const repairsNow = h.kernel.activeRepairs();
  assert.equal(repairsNow.length, 1);
  assert.ok(repairsNow[0].eligibleAt > h.clock.now(), "not eligible instantly");

  // After the gap, the planner issues a repair task for that trace.
  h.clock.advanceMinutes(2);
  const plan = h.kernel.planSession({ budgetMinutes: 15 });
  const repairTask = plan.tasks.find((t) => t.isRepair && t.targetTrace === task.targetTrace);
  assert.ok(repairTask, "repair task issued for the failed trace");
});

test("a repair never fakes success and only ever updates its own trace", () => {
  const h = makeHarness();
  const { task } = planAndFirst(h);
  h.kernel.submitAttempt(task, wrongAttempt(task));
  h.clock.advanceMinutes(2);
  const plan = h.kernel.planSession({ budgetMinutes: 15 });
  const repairTask = plan.tasks.find((t) => t.isRepair && t.targetTrace === task.targetTrace)!;

  const before = h.kernel.traces.all().filter((t) => t.id !== repairTask.targetTrace).map((t) => t.stability + ":" + t.state);
  // A successful repair retrieval updates exactly the target trace.
  h.kernel.submitAttempt(repairTask, correctAttempt(repairTask, plan.answers.get(repairTask.id)!,
    "normal", repairTask.skill === "speaking" || repairTask.skill === "writing" ? "good" : undefined));
  const after = h.kernel.traces.all().filter((t) => t.id !== repairTask.targetTrace).map((t) => t.stability + ":" + t.state);
  assert.deepEqual(after, before, "no other trace changed");
});

test("a successful later retrieval clears the repair directive", () => {
  const h = makeHarness();
  const { task } = planAndFirst(h);
  h.kernel.submitAttempt(task, wrongAttempt(task));
  h.clock.advanceMinutes(2);
  const plan = h.kernel.planSession({ budgetMinutes: 15 });
  const repairTask = plan.tasks.find((t) => t.isRepair && t.targetTrace === task.targetTrace)!;
  h.kernel.submitAttempt(repairTask, correctAttempt(repairTask, plan.answers.get(repairTask.id)!,
    "normal", repairTask.skill === "speaking" || repairTask.skill === "writing" ? "good" : undefined));
  assert.ok(!h.kernel.activeRepairs().some((d) => d.trace === task.targetTrace), "repair cleared on success");
});

test("repeated lapses escalate the repair attempt counter", () => {
  const h = makeHarness();
  const { task } = planAndFirst(h);
  const r1 = h.kernel.submitAttempt(task, wrongAttempt(task));
  assert.equal(r1.repair!.attempt, 1);
  h.clock.advanceMinutes(2);
  const plan = h.kernel.planSession({ budgetMinutes: 15 });
  const repairTask = plan.tasks.find((t) => t.isRepair && t.targetTrace === task.targetTrace)!;
  const r2 = h.kernel.submitAttempt(repairTask, wrongAttempt(repairTask));
  assert.equal(r2.repair!.attempt, 2, "second lapse escalates");
  assert.equal(r2.repair!.reason, "repeated_lapse");
});
