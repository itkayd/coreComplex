import { test } from "node:test";
import assert from "node:assert/strict";
import { PROFILES, runProfile } from "./matrix.ts";
import { SKILLS } from "@dyr/domain";

// Reduced horizon keeps CI fast; the standalone `npm run matrix` runs the full
// 365-day version. Every invariant below is a RELEASE BLOCK per spec p.29.
const DAYS = 90;

for (const profile of PROFILES) {
  test(`matrix profile "${profile.name}" holds every invariant (${DAYS}d)`, () => {
    const r = runProfile(profile, DAYS);
    assert.equal(r.failure, undefined, r.failure ? `seed ${r.seed} day ${r.failure.day} @${r.failure.cursor}: ${r.failure.reason}` : "");
    assert.ok(r.maxPredictedMinutes <= r.maxBudget, `sessions within budget (${r.maxPredictedMinutes} <= ${r.maxBudget})`);
    assert.equal(r.replayHolds, true, "replay reconstructs authoritative state");
    assert.equal(r.layerStateNeverChangedLearning, true, "no layer op changed learning state");
    // Four independent counts, never a single scalar (acceptance-fixture spirit).
    for (const s of SKILLS) assert.ok(r.perSkillRetained[s] >= 0 && r.perSkillRetained[s] <= 8);
  });
}

test("the offline profile actually exercises duplicate-upload rejection", () => {
  const r = runProfile(PROFILES.find((p) => p.name === "offline-reconnect-duplicates")!, 40);
  assert.ok(r.duplicatesRejected > 0, "reconnect duplicates were deduped, not double-applied");
  assert.equal(r.replayHolds, true);
});

test("skill asymmetry is preserved, never collapsed (severe production lag)", () => {
  const r = runProfile(PROFILES.find((p) => p.name === "severe-production-lag")!, DAYS);
  // Receptive channels outpace production — the four dimensions stay distinct.
  assert.ok(r.perSkillRetained.reading >= r.perSkillRetained.speaking, "reading ahead of speaking");
  assert.ok(r.perSkillRetained.listening >= r.perSkillRetained.writing, "listening ahead of writing");
});

test("low recall drives workload freezes (governor engages under pressure)", () => {
  const r = runProfile(PROFILES.find((p) => p.name === "low-recall-consistent-7m")!, DAYS);
  assert.ok(r.workloadFreezes > 0, "governor froze introductions under low-recall overload");
});
