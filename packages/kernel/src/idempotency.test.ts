import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, correctAttempt, wrongAttempt, makeCommand } from "../../../fixtures/sim/harness.ts";

function firstTask(h: ReturnType<typeof makeHarness>) {
  const plan = h.kernel.planSession({ budgetMinutes: 7, candidateIntroductions: h.pack.lexemeIds });
  const task = plan.tasks[0];
  return { task, answer: plan.answers.get(task.id)! };
}

test("a duplicate command does not update the trace twice (Correction 8)", () => {
  const h = makeHarness();
  const { task, answer } = firstTask(h);
  const cmd = makeCommand(task, correctAttempt(task, answer), h.clock.now());

  const first = h.kernel.submitCommand(cmd, task);
  const eventsAfterFirst = h.kernel.log.length;
  const factsAfterFirst = h.kernel.publishedFacts().length;

  const second = h.kernel.submitCommand(cmd, task); // exact retry
  assert.equal(first.outcome.status, "applied");
  assert.equal(second.outcome.status, "duplicate");
  assert.equal(h.kernel.log.length, eventsAfterFirst, "no new events on retry");
  assert.equal(h.kernel.publishedFacts().length, factsAfterFirst, "no second fact");
  const t = h.kernel.traces.get(task.targetTrace)!;
  assert.equal(t.evidenceCount, 1, "trace updated exactly once");
});

test("a retry after unrelated events is still recognised as the same command", () => {
  const h = makeHarness();
  const { task, answer } = firstTask(h);
  const cmd = makeCommand(task, correctAttempt(task, answer), h.clock.now());
  h.kernel.submitCommand(cmd, task);

  // Unrelated activity: another task attempt in between.
  const plan2 = h.kernel.planSession({ budgetMinutes: 7, candidateIntroductions: h.pack.lexemeIds });
  const other = plan2.tasks.find((t) => t.id !== task.id);
  if (other) h.kernel.submitAttempt(other, correctAttempt(other, plan2.answers.get(other.id)!));

  const before = h.kernel.traces.get(task.targetTrace)!.evidenceCount;
  const retry = h.kernel.submitCommand(cmd, task);
  assert.equal(retry.outcome.status, "duplicate");
  assert.equal(h.kernel.traces.get(task.targetTrace)!.evidenceCount, before, "no extra update");
});

test("duplicate upload after reconnect resolves to the same logical result", () => {
  const h = makeHarness();
  const { task, answer } = firstTask(h);
  const cmd = makeCommand(task, correctAttempt(task, answer), h.clock.now());
  const a = h.kernel.submitCommand(cmd, task);
  const b = h.kernel.submitCommand(cmd, task);
  // Same fact identity returned both times.
  assert.equal(a.result?.fact?.id, b.result?.fact?.id);
});

test("a reused idempotency key with a different payload is a conflict (first write wins)", () => {
  const h = makeHarness();
  const { task, answer } = firstTask(h);
  const good = makeCommand(task, correctAttempt(task, answer), h.clock.now(), { idempotencyKey: "K1", attemptId: "A1" as never });
  h.kernel.submitCommand(good, task);
  const evidence = h.kernel.publishedFacts().length;

  // Same key, different payload (a wrong answer this time).
  const conflicting = makeCommand(task, wrongAttempt(task), h.clock.now(), { idempotencyKey: "K1", attemptId: "A2" as never });
  const res = h.kernel.submitCommand(conflicting, task);
  assert.equal(res.outcome.status, "idempotency_conflict");
  assert.equal(h.kernel.publishedFacts().length, evidence, "conflict wrote nothing");
});
