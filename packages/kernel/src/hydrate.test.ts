import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, correctAttempt, wrongAttempt } from "../../../fixtures/sim/harness.ts";

/** Drive a few days, then hand back the harness plus a serialisable event log. */
function driven() {
  const h = makeHarness();
  for (let d = 0; d < 5; d++) {
    const plan = h.kernel.planSession({ budgetMinutes: 7, candidateIntroductions: h.pack.lexemeIds });
    for (const [i, task] of plan.tasks.entries()) {
      const prod = task.skill === "speaking" || task.skill === "writing";
      const ans = plan.answers.get(task.id)!;
      h.kernel.submitAttempt(task, i % 3 === 2
        ? (prod ? { ...wrongAttempt(task), selfGrade: "again" as const } : wrongAttempt(task))
        : correctAttempt(task, ans, "normal", prod ? "good" : undefined));
    }
    h.clock.advanceDays(1);
  }
  return h;
}

test("a hydrated kernel is indistinguishable from the one that wrote the log", () => {
  const original = driven();
  // Persist → restore (the JSON round-trip a real store would perform).
  const persisted = JSON.parse(JSON.stringify(original.kernel.log.all()));

  const restored = makeHarness();
  restored.clock.set(original.clock.now());
  restored.kernel.hydrate(persisted);

  assert.equal(restored.kernel.traces.digest(), original.kernel.traces.digest(), "same memory state");
  assert.equal(restored.kernel.log.digest(), original.kernel.log.digest(), "same event log");
  assert.equal(restored.kernel.log.length, original.kernel.log.length);
  assert.equal(restored.kernel.publishedFacts().length, original.kernel.publishedFacts().length);
});

test("event identity and causation survive a persist/restore round trip", () => {
  const original = driven();
  const restored = makeHarness();
  restored.clock.set(original.clock.now());
  restored.kernel.hydrate(JSON.parse(JSON.stringify(original.kernel.log.all())));

  const shape = (evts: readonly { eventId: string; eventType: string; causationId?: string }[]) =>
    evts.map((e) => `${e.eventId}|${e.eventType}|${e.causationId ?? "-"}`).join("\n");
  assert.equal(shape(restored.kernel.log.all()), shape(original.kernel.log.all()));
});

test("a restored kernel continues the sequence instead of colliding with history", () => {
  const original = driven();
  const restored = makeHarness();
  restored.clock.set(original.clock.now());
  restored.kernel.hydrate(JSON.parse(JSON.stringify(original.kernel.log.all())));

  const before = restored.kernel.log.length;
  const plan = restored.kernel.planSession({ budgetMinutes: 7, candidateIntroductions: restored.pack.lexemeIds });
  assert.ok(restored.kernel.log.length > before, "new events appended after restore");
  const sequences = restored.kernel.log.all().map((e) => e.localSequence);
  assert.equal(new Set(sequences).size, sequences.length, "no duplicate localSequence");
  assert.deepEqual([...sequences].sort((a, b) => a - b), sequences, "sequence stays monotonic");
  assert.ok(plan.tasks.length >= 0);
});

test("pending repair directives survive a restart (resume without penalty, p.14)", () => {
  const h = makeHarness();
  const plan = h.kernel.planSession({ budgetMinutes: 7, candidateIntroductions: h.pack.lexemeIds });
  const task = plan.tasks[0];
  h.kernel.submitAttempt(task, wrongAttempt(task)); // schedules a repair
  assert.equal(h.kernel.activeRepairs().length, 1);

  const restored = makeHarness();
  restored.clock.set(h.clock.now());
  restored.kernel.hydrate(JSON.parse(JSON.stringify(h.kernel.log.all())));
  const repairs = restored.kernel.activeRepairs();
  assert.equal(repairs.length, 1, "the pending repair is restored");
  assert.equal(repairs[0].trace, task.targetTrace, "targeting the same trace");
});

test("hydrate refuses to run on a kernel that already has history", () => {
  const h = driven();
  const other = driven();
  assert.throws(() => h.kernel.hydrate(other.kernel.log.all()), /not empty/);
});
