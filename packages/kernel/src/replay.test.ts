import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyReplay, replayTraces } from "./replay.ts";
import { makeHarness, correctAttempt, wrongAttempt } from "../../../fixtures/sim/harness.ts";
import type { Harness } from "../../../fixtures/sim/harness.ts";

/** A fixed multi-day script. Same script + clock + config must be reproducible. */
function run(h: Harness): void {
  for (let day = 0; day < 6; day++) {
    const plan = h.kernel.planSession({
      budgetMinutes: 7,
      candidateIntroductions: h.pack.lexemeIds,
    });
    for (const [i, task] of plan.tasks.entries()) {
      const ans = plan.answers.get(task.id)!;
      const production = task.skill === "speaking" || task.skill === "writing";
      // Deterministic mix of right/wrong to exercise both branches.
      if (i % 3 === 2) {
        h.kernel.submitAttempt(task, production
          ? { ...wrongAttempt(task), selfGrade: "again" }
          : wrongAttempt(task));
      } else {
        h.kernel.submitAttempt(task, correctAttempt(task, ans, "normal", production ? "good" : undefined));
      }
    }
    h.clock.advanceDays(1);
  }
}

test("REPLAY CONTRACT: same events + config + clock => identical state (p.5)", () => {
  const a = makeHarness();
  const b = makeHarness();
  run(a);
  run(b);
  // Two independent kernels driven identically must be byte-for-byte equal.
  assert.equal(a.kernel.log.digest(), b.kernel.log.digest(), "event logs identical");
  assert.equal(a.kernel.traces.digest(), b.kernel.traces.digest(), "trace state identical");
});

test("replaying the event log reconstructs the exact trace store", () => {
  const h = makeHarness();
  run(h);
  assert.equal(verifyReplay(h.kernel.traces, h.kernel.log.all()), true);
});

test("HEADLESS: replay needs only the event log, no live kernel object (p.3)", () => {
  const h = makeHarness();
  run(h);
  const rebuilt = replayTraces(h.kernel.log.all());
  assert.equal(rebuilt.digest(), h.kernel.traces.digest());
  assert.ok(rebuilt.size() > 0);
});

test("event ordering is stable under localSequence shuffling", () => {
  const h = makeHarness();
  run(h);
  const shuffled = [...h.kernel.log.all()].reverse();
  assert.equal(replayTraces(shuffled).digest(), h.kernel.traces.digest());
});
