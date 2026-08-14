import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG,
  type Skill,
  type SkillTrace,
  newTrace,
  traceId,
  LexemeId,
} from "@dyr/domain";
import { assessWorkload } from "./workload.ts";

function reviewTrace(i: number, skill: Skill, stability: number, state: SkillTrace["state"] = "review"): SkillTrace {
  const lex = LexemeId(`w${i}`);
  return {
    ...newTrace(traceId(lex, skill), lex, skill),
    stability,
    difficulty: 5,
    state,
    due: 0,
    lastReview: 0,
    evidenceCount: 1,
  };
}

test("zero traces yields a valid empty forecast and no freeze", () => {
  const r = assessWorkload([], 0, DEFAULT_CONFIG);
  assert.equal(r.freezeIntroductions, false);
  assert.ok(r.forecasts.length === 6, "7d & 30d x high/expected/low");
});

test("a heavy due backlog freezes introductions (forecast exceeds budget)", () => {
  // Many low-stability traces => frequent reviews => minutes blow the budget.
  const traces = Array.from({ length: 400 }, (_, i) => reviewTrace(i, "reading", 0.6));
  const r = assessWorkload(traces, 0, DEFAULT_CONFIG);
  assert.equal(r.freezeIntroductions, true);
  assert.ok(r.reasons.some((x) => x.includes("exceeds budget")));
});

test("lapse repair dominating freezes introductions", () => {
  const traces = [
    ...Array.from({ length: 4 }, (_, i) => reviewTrace(i, "reading", 20, "relearning")),
    ...Array.from({ length: 6 }, (_, i) => reviewTrace(100 + i, "reading", 20, "review")),
  ];
  const r = assessWorkload(traces, 0, DEFAULT_CONFIG);
  assert.ok(r.lapseRepairShare >= 0.3);
  assert.equal(r.freezeIntroductions, true);
  assert.ok(r.reasons.some((x) => x.includes("lapse repair")));
});

test("weak recent confidence freezes introductions", () => {
  const traces = [reviewTrace(1, "reading", 30)];
  const r = assessWorkload(traces, 0, DEFAULT_CONFIG, { weakConfidence: true });
  assert.equal(r.freezeIntroductions, true);
});

test("a light, healthy load does not freeze — new items are welcome", () => {
  const traces = Array.from({ length: 5 }, (_, i) => reviewTrace(i, "reading", 40));
  const r = assessWorkload(traces, 0, DEFAULT_CONFIG);
  assert.equal(r.freezeIntroductions, false);
});
