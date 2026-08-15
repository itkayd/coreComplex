import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TASK_FAMILIES, traceId, LexemeId } from "@dyr/domain";
import { makeHarness, correctAttempt } from "../../../fixtures/sim/harness.ts";

/**
 * Correction 6: skill unlocking is non-linear. Speaking can begin (echo/shadow)
 * once listening is merely EXPOSED — it does NOT wait for reading to be retained.
 */
test("speaking can be eligible before reading is retained (non-linear, ADR-0005)", () => {
  const h = makeHarness();
  const hello = LexemeId("hello.n.01"); // no prerequisites, has canonical audio

  // Open + expose listening for 你好 only (one correct listening attempt).
  let plan = h.kernel.planSession({ budgetMinutes: 15, candidateIntroductions: [hello] });
  const listen = plan.tasks.find((t) => t.skill === "listening" && t.lexeme === hello)!;
  h.kernel.submitAttempt(listen, correctAttempt(listen, plan.answers.get(listen.id)!));

  // Reading for 你好 is still 'new' / not retained.
  const reading = h.kernel.traces.get(traceId(hello, "reading"));
  assert.ok(!reading || reading.state === "new", "reading not yet retained");

  // echo_shadow (speaking) requires only listening EXPOSED — so a speaking task
  // for 你好 should now be plannable even though reading is not retained.
  h.clock.advanceMinutes(11);
  plan = h.kernel.planSession({ budgetMinutes: 15, candidateIntroductions: [hello] });
  const speaking = plan.tasks.find((t) => t.skill === "speaking" && t.lexeme === hello);
  assert.ok(speaking, "speaking eligible from listening exposure alone");
  assert.equal(speaking!.family, "echo_shadow");
});

test("high-level production still requires stronger (retained) prerequisites", () => {
  // composition_revision needs writing RETAINED; meaning_to_speech needs
  // listening RETAINED. The registry encodes this — assert it, so the planner's
  // data-driven gate cannot silently regress to linear unlocking.
  assert.deepEqual(DEFAULT_TASK_FAMILIES.echo_shadow.prerequisites, [{ skill: "listening", level: "exposed" }]);
  assert.deepEqual(DEFAULT_TASK_FAMILIES.meaning_to_speech.prerequisites, [{ skill: "listening", level: "retained" }]);
  assert.deepEqual(DEFAULT_TASK_FAMILIES.composition_revision.prerequisites, [{ skill: "writing", level: "retained" }]);
  assert.deepEqual(DEFAULT_TASK_FAMILIES.timed_reply.prerequisites, [{ skill: "speaking", level: "retained" }]);
});

test("writing begins early via typed retrieval, gated only by reading exposure", () => {
  assert.deepEqual(DEFAULT_TASK_FAMILIES.meaning_to_typed_word.prerequisites, [{ skill: "reading", level: "exposed" }]);
  // handwriting is deliberately later — reading retained.
  assert.deepEqual(DEFAULT_TASK_FAMILIES.stroke_handwriting.prerequisites, [{ skill: "reading", level: "retained" }]);
});

test("no cross-skill mastery propagation: opening one channel never opens another", () => {
  const h = makeHarness();
  const hello = LexemeId("hello.n.01"); // no prerequisites, has canonical audio
  const plan = h.kernel.planSession({ budgetMinutes: 15, candidateIntroductions: [hello] });
  const listen = plan.tasks.find((t) => t.skill === "listening" && t.lexeme === hello)!;
  h.kernel.submitAttempt(listen, correctAttempt(listen, plan.answers.get(listen.id)!));
  // Reading/writing traces for 你好 must remain untouched by a listening success.
  for (const skill of ["reading", "writing"] as const) {
    const t = h.kernel.traces.get(traceId(hello, skill));
    assert.ok(!t || t.evidenceCount === 0, `${skill} not propagated`);
  }
});

/** Correction 7: a task whose asset is missing is rejected at plan time. */
test("an audio task for a lexeme lacking canonical audio is rejected with a reason code", () => {
  const h = makeHarness();
  const matter = LexemeId("matter.n.01"); // deliberately has NO human audio
  const plan = h.kernel.planSession({ budgetMinutes: 15, candidateIntroductions: [matter] });

  // No listening/audio task for 事 may be issued...
  const audioTask = plan.tasks.find((t) => t.lexeme === matter && t.requiresHumanAudio);
  assert.equal(audioTask, undefined, "no audio task issued without canonical audio");
  // ...and the rejection is explainable.
  assert.ok(
    plan.rejected.some((r) => r.reason === "missing_canonical_audio"),
    "missing_canonical_audio reason present",
  );
  // Reading (no audio required) for 事 is still fine.
  assert.ok(plan.tasks.some((t) => t.lexeme === matter && t.skill === "reading"), "reading still offered");
});
