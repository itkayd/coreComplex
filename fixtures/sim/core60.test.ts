import { test } from "node:test";
import assert from "node:assert/strict";
import { SKILLS, type Skill } from "@dyr/domain";
import { verifyReplay } from "@dyr/kernel";
import { makeCore60Harness } from "./core60.ts";
import { correctAttempt, wrongAttempt } from "./harness.ts";

/** Drive N days on the real pack with per-skill success rates. */
function drive(h: ReturnType<typeof makeCore60Harness>, days: number, recall: Record<Skill, number>, budget = 7) {
  let step = 0;
  for (let d = 0; d < days; d++) {
    const plan = h.kernel.planSession({ budgetMinutes: budget, candidateIntroductions: h.lexemeIds });
    for (const task of plan.tasks) {
      const prod = task.skill === "speaking" || task.skill === "writing";
      // Deterministic pseudo-recall: no RNG, reproducible across runs.
      const ok = ((step++ * 37) % 100) / 100 < recall[task.skill];
      const ans = plan.answers.get(task.id)!;
      h.kernel.submitAttempt(task, ok
        ? correctAttempt(task, ans, "normal", prod ? "good" : undefined)
        : (prod ? { ...wrongAttempt(task), selfGrade: "again" as const } : wrongAttempt(task)));
    }
    h.clock.advanceDays(1);
  }
}

test("the kernel runs on the real licensed pack", () => {
  const h = makeCore60Harness();
  // The pack now carries the hand-authored CC0 Core 60 plus the CC BY-SA HSK 1
  // expansion, so this is a floor rather than an equality.
  assert.ok(h.lexemeIds.length >= 60, `expected at least the Core 60, got ${h.lexemeIds.length}`);
  const plan = h.kernel.planSession({ budgetMinutes: 7, candidateIntroductions: h.lexemeIds });
  assert.ok(plan.tasks.length > 0, "a session is plannable from real content");
  assert.ok(plan.predictedMinutes <= 7);
});

test("WITHOUT provisioned audio, listening is blocked and explained; reading still works", () => {
  const h = makeCore60Harness({ provisionAudio: false });
  const plan = h.kernel.planSession({ budgetMinutes: 15, candidateIntroductions: h.lexemeIds });

  assert.equal(plan.tasks.some((t) => t.requiresHumanAudio), false, "no task claims audio that does not exist");
  assert.ok(plan.rejected.some((r) => r.reason === "missing_canonical_audio"), "blocked audio is explainable");
  assert.ok(plan.tasks.some((t) => t.skill === "reading"), "reading is fully usable offline");
});

test("WITH provisioned canonical audio, the listening channel opens (same pack)", () => {
  const h = makeCore60Harness({ provisionAudio: true });
  const plan = h.kernel.planSession({ budgetMinutes: 15, candidateIntroductions: h.lexemeIds });
  assert.ok(plan.tasks.some((t) => t.skill === "listening"), "listening tasks issue once audio is canonical");
  assert.equal(plan.rejected.some((r) => r.reason === "missing_canonical_audio"), false);
});

test("bounded sessions hold on real content at 3, 7 and 15 minutes (spec p.14)", () => {
  for (const budget of [3, 7, 15]) {
    const h = makeCore60Harness({ provisionAudio: true });
    drive(h, 5, { listening: 0.9, reading: 0.9, speaking: 0.8, writing: 0.8 }, budget);
    const plan = h.kernel.planSession({ budgetMinutes: budget, candidateIntroductions: h.lexemeIds });
    assert.ok(plan.predictedMinutes <= budget, `${plan.predictedMinutes} <= ${budget}`);
  }
});

test("replay holds over a long run on the real pack", () => {
  const h = makeCore60Harness({ provisionAudio: true });
  drive(h, 60, { listening: 0.85, reading: 0.9, speaking: 0.7, writing: 0.65 });
  assert.equal(verifyReplay(h.kernel.traces, h.kernel.log.all()), true);
});

/**
 * THE REQUIRED ACCEPTANCE FIXTURE (spec p.6, p.28), now on REAL content:
 * sixty encountered lexemes must never become "sixty mastered words".
 */
test("ACCEPTANCE: encountered lexemes report four independent counts, never one scalar", () => {
  const h = makeCore60Harness({ provisionAudio: true });
  // A deliberately asymmetric learner: strong receptive, weaker production.
  drive(h, 200, { listening: 0.92, reading: 0.88, speaking: 0.62, writing: 0.5 });

  const profile = h.kernel.frontier.profile();

  // Every skill reports out of the SAME set of encountered lexemes. The count
  // itself is a property of the pack, so assert the AGREEMENT rather than a
  // number that changes whenever content is added.
  const encountered = profile[SKILLS[0]].total;
  assert.ok(encountered > 0, "the learner should have encountered something in 200 days");
  for (const skill of SKILLS) {
    assert.equal(profile[skill].total, encountered, `${skill} reported out of a different total`);
    assert.ok(profile[skill].retained <= encountered);
  }
  // ...and the four counts are genuinely independent, not one shared number.
  const counts = SKILLS.map((s) => profile[s].retained);
  assert.ok(new Set(counts).size > 1, `expected distinct per-skill counts, got ${counts.join("/")}`);

  // The profile object exposes exactly the four skills — there is no aggregate
  // "mastered" field anywhere to collapse them into.
  assert.deepEqual(Object.keys(profile).sort(), [...SKILLS].sort());

  // Receptive outpaces production for this learner, and the weakest channel is
  // flagged for repair rather than averaged away.
  assert.ok(profile.reading.retained >= profile.writing.retained, "reading ahead of writing");
  assert.ok(["speaking", "writing"].includes(h.kernel.frontier.weakestSkill()), "weak production channel flagged");
});

test("the pack's confusables are never paired inside one session (买/卖 etc.)", () => {
  const h = makeCore60Harness({ provisionAudio: true });
  drive(h, 30, { listening: 0.9, reading: 0.9, speaking: 0.8, writing: 0.8 });
  for (let d = 0; d < 20; d++) {
    const plan = h.kernel.planSession({ budgetMinutes: 15, candidateIntroductions: h.lexemeIds });
    const lex = new Set(plan.tasks.map((t) => String(t.lexeme)));
    assert.ok(!(lex.has("buy.v.01") && lex.has("sell.v.01")), "买/卖 not paired");
    assert.ok(!(lex.has("he.pron.01") && lex.has("she.pron.01")), "他/她 not paired");
    for (const task of plan.tasks) {
      const prod = task.skill === "speaking" || task.skill === "writing";
      h.kernel.submitAttempt(task, correctAttempt(task, plan.answers.get(task.id)!, "normal", prod ? "good" : undefined));
    }
    h.clock.advanceDays(1);
  }
});
