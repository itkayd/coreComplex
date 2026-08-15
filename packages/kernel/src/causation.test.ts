import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventEnvelope } from "@dyr/domain";
import { makeHarness, correctAttempt, wrongAttempt } from "../../../fixtures/sim/harness.ts";

/** Return the single event of a type from a correlation group. */
function one(events: readonly EventEnvelope[], type: string): EventEnvelope {
  const matches = events.filter((e) => e.eventType === type);
  assert.equal(matches.length, 1, `expected exactly one ${type}, got ${matches.length}`);
  return matches[0];
}

test("the review cycle emits the exact causal chain (Correction 9 / ADR-0008)", () => {
  const h = makeHarness();
  const plan = h.kernel.planSession({ budgetMinutes: 7, candidateIntroductions: h.pack.lexemeIds });
  const task = plan.tasks[0];
  const ans = plan.answers.get(task.id)!;
  const start = h.kernel.log.length;
  h.kernel.submitAttempt(task, correctAttempt(task, ans));

  const cycle = h.kernel.log.all().slice(start);
  const accepted = one(cycle, "AttemptAccepted");
  const validated = one(cycle, "EvidenceValidated");
  const traceUpdated = one(cycle, "TraceUpdated");
  const consolidated = one(cycle, "ConsolidationRecorded");
  const fact = one(cycle, "LearningFactPublished");

  // causationId points to the DIRECT cause, not merely chronological order.
  assert.equal(validated.causationId, accepted.eventId, "accepted → validated");
  assert.equal(traceUpdated.causationId, validated.eventId, "validated → traceUpdated");
  assert.equal(consolidated.causationId, traceUpdated.eventId, "traceUpdated → consolidated");
  assert.equal(fact.causationId, consolidated.eventId, "consolidated → fact");

  // The whole review shares one correlationId (the SessionPlanned event).
  const corr = accepted.correlationId;
  for (const e of [validated, traceUpdated, consolidated, fact]) {
    assert.equal(e.correlationId, corr, `${e.eventType} shares the review correlation`);
  }
});

test("a self-grade-required attempt terminates at EvidenceValidated (no TraceUpdated/Fact)", () => {
  const h = makeHarness();
  const plan = h.kernel.planSession({ budgetMinutes: 7, candidateIntroductions: h.pack.lexemeIds });
  const task = plan.tasks[0];
  const ans = plan.answers.get(task.id)!;
  const start = h.kernel.log.length;

  // Reveal the answer → not direct retrieval → decision ask_self_grade.
  const res = h.kernel.submitAttempt(task, { ...correctAttempt(task, ans), answerRevealed: true });
  assert.equal(res.decision, "ask_self_grade");

  const cycle = h.kernel.log.all().slice(start).map((e) => e.eventType);
  assert.deepEqual(cycle, ["AttemptAccepted", "EvidenceValidated"], "terminal path only");
  assert.ok(!cycle.includes("TraceUpdated"), "no invented TraceUpdated");
  assert.ok(!cycle.includes("LearningFactPublished"), "no fact published");
});

test("a lapse emits TraceUpdated + RepairScheduled but the trace only updates once", () => {
  const h = makeHarness();
  const plan = h.kernel.planSession({ budgetMinutes: 7, candidateIntroductions: h.pack.lexemeIds });
  const task = plan.tasks[0];
  const start = h.kernel.log.length;
  h.kernel.submitAttempt(task, wrongAttempt(task));

  const cycle = h.kernel.log.all().slice(start);
  assert.equal(cycle.filter((e) => e.eventType === "TraceUpdated").length, 1, "one update");
  assert.equal(cycle.filter((e) => e.eventType === "RepairScheduled").length, 1, "one repair scheduled");
  const repair = one(cycle, "RepairScheduled");
  const traceUpdated = one(cycle, "TraceUpdated");
  assert.equal(repair.causationId, traceUpdated.eventId, "repair caused by the trace update");
});
