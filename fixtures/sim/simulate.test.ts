import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate } from "./simulate.ts";
import { SKILLS } from "@dyr/domain";

test("365-day simulation stays within the bounded session budget every day (p.18)", () => {
  const r = simulate(365, 7);
  assert.ok(r.maxPredictedMinutes <= 7, `max ${r.maxPredictedMinutes} <= 7`);
  assert.equal(r.sessions, 365);
});

test("365-day simulation keeps a bounded, replayable event log (Stage 1 exit)", () => {
  const r = simulate(365, 7);
  assert.equal(r.replayHolds, true, "replay reconstructs final state after a year");
  assert.ok(r.eventCount > 0);
});

test("the year-end report is four independent skill counts, never one number", () => {
  const r = simulate(365, 7);
  for (const skill of SKILLS) {
    assert.ok(skill in r.finalProfile, `${skill} reported`);
    assert.ok(r.finalProfile[skill].retained >= 0);
  }
  // The profile object has exactly the four skill keys — no aggregate field.
  assert.deepEqual(Object.keys(r.finalProfile).sort(), [...SKILLS].sort());
});

test("the simulation is deterministic across runs", () => {
  const a = simulate(120, 7);
  const b = simulate(120, 7);
  assert.deepEqual(a, b);
});
