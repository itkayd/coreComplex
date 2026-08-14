import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type PackVersion,
  type Skill,
  type SkillTrace,
  LanguageGraph,
  LexemeId,
  PackVersion as mkPack,
  PlannerVersion,
  SKILLS,
  newTrace,
  traceId,
} from "@dyr/domain";
import { TraceStore } from "./traceStore.ts";
import { Frontier } from "./frontier.ts";

const PACK = mkPack("acceptance@1.0.0") as PackVersion;

/** Build a 60-lexeme graph and a store with exactly the given retained counts. */
function build(counts: Record<Skill, number>): { frontier: Frontier; store: TraceStore } {
  const graph = new LanguageGraph();
  const lexIds: LexemeId[] = [];
  for (let i = 0; i < 60; i++) {
    const id = LexemeId(`lex${String(i).padStart(2, "0")}`);
    lexIds.push(id);
    graph.addLexeme({
      id, simplified: `词${i}`, pinyin: "ci", senses: [`m${i}`], pos: "n",
      frequency: 5, packVersion: PACK, requiresHumanAudioFor: ["listening"],
    });
  }
  const store = new TraceStore();
  for (const skill of SKILLS) {
    for (let i = 0; i < counts[skill]; i++) {
      const id = traceId(lexIds[i], skill);
      const t: SkillTrace = {
        ...newTrace(id, lexIds[i], skill),
        stability: 12, difficulty: 5, state: "review",
        due: 0, lastReview: 0, evidenceCount: 3,
      };
      store.put(t);
    }
  }
  return { frontier: new Frontier(store, graph), store };
}

test("REQUIRED ACCEPTANCE FIXTURE: reports 48/41/23/18 as four separate counts", () => {
  const { frontier } = build({ listening: 48, reading: 41, speaking: 23, writing: 18 });
  const p = frontier.profile();
  assert.equal(p.listening.retained, 48);
  assert.equal(p.reading.retained, 41);
  assert.equal(p.speaking.retained, 23);
  assert.equal(p.writing.retained, 18);
  for (const skill of SKILLS) assert.equal(p[skill].total, 60);
});

test("the frontier never collapses the four dimensions into one 'mastered' number", () => {
  const { frontier } = build({ listening: 48, reading: 41, speaking: 23, writing: 18 });
  const p = frontier.profile();
  // There is deliberately no single scalar. Any attempt to sum is meaningless;
  // assert the four values are genuinely distinct, not one shared figure.
  const values = SKILLS.map((s) => p[s].retained);
  assert.equal(new Set(values).size, 4, "four distinct per-skill counts");
});

test("the weakest production channel is flagged for repair (writing = 18)", () => {
  const { frontier } = build({ listening: 48, reading: 41, speaking: 23, writing: 18 });
  assert.equal(frontier.weakestSkill(), "writing");
});

test("admission blocks an unlicensed candidate", () => {
  const { frontier } = build({ listening: 5, reading: 5, speaking: 2, writing: 1 });
  const cand = LexemeId("lex10");
  const res = frontier.admit(cand, {
    licensed: () => false,
    humanAudioAvailable: () => true,
    knownTokenRatio: () => 0.96,
    introductionsFrozen: false,
    knownTokenBand: { min: 0.95, max: 0.98 },
    plannerVersion: "dyr-planner@1.0.0" as PlannerVersion,
  });
  assert.equal(res.eligible, false);
  assert.ok(res.blockers.includes("license"));
});

test("admission blocks out-of-band comprehension context and explains why", () => {
  const { frontier } = build({ listening: 5, reading: 5, speaking: 2, writing: 1 });
  const res = frontier.admit(LexemeId("lex10"), {
    licensed: () => true,
    humanAudioAvailable: () => true,
    knownTokenRatio: () => 0.50, // too hard
    introductionsFrozen: false,
    knownTokenBand: { min: 0.95, max: 0.98 },
    plannerVersion: "dyr-planner@1.0.0" as PlannerVersion,
  });
  assert.equal(res.eligible, false);
  assert.ok(res.blockers.includes("context"));
  assert.ok(res.reasonCodes.some((r) => r.code === "context_out_of_band"));
});

test("admission blocks when the workload governor has frozen introductions", () => {
  const { frontier } = build({ listening: 5, reading: 5, speaking: 2, writing: 1 });
  const res = frontier.admit(LexemeId("lex10"), {
    licensed: () => true,
    humanAudioAvailable: () => true,
    knownTokenRatio: () => 0.96,
    introductionsFrozen: true,
    knownTokenBand: { min: 0.95, max: 0.98 },
    plannerVersion: "dyr-planner@1.0.0" as PlannerVersion,
  });
  assert.equal(res.eligible, false);
  assert.ok(res.blockers.includes("workload"));
});
