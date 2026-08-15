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
import { createFsrsAdapter } from "@dyr/fsrs-adapter";
import { assessWorkload } from "./workload.ts";

const DAY = 86_400_000;
const fsrs = createFsrsAdapter();

/** A review-state trace due at `dueOffsetDays` from `now`, with real S/D. */
function reviewTrace(i: number, skill: Skill, dueOffsetDays: number, opts: { state?: SkillTrace["state"]; stability?: number } = {}): SkillTrace {
  const lex = LexemeId(`w${i}`);
  const now = 0;
  return {
    ...newTrace(traceId(lex, skill), lex, skill),
    stability: opts.stability ?? 10,
    difficulty: 5,
    state: opts.state ?? "review",
    due: now + dueOffsetDays * DAY,
    lastReview: now - 1 * DAY,
    reps: 3,
    lapses: 0,
    scheduledDays: opts.stability ?? 10,
    evidenceCount: 3,
  };
}

test("zero traces yields a valid empty forecast and no freeze", () => {
  const r = assessWorkload([], 0, DEFAULT_CONFIG, fsrs);
  assert.equal(r.freezeIntroductions, false);
  assert.equal(r.forecasts.length, 6, "7d & 30d x high/expected/low");
  assert.equal(r.scenariosVersion.length > 0, true);
});

test("a trace due in 40 days does NOT appear in the 7-day forecast (Correction 4)", () => {
  const traces = [reviewTrace(1, "reading", 40, { stability: 60 })];
  const r = assessWorkload(traces, 0, DEFAULT_CONFIG, fsrs);
  const f7 = r.forecasts.filter((f) => f.horizonDays === 7);
  for (const f of f7) assert.equal(f.reviews, 0, `${f.scenario} 7d should see 0 reviews`);
  const f30 = r.forecasts.find((f) => f.horizonDays === 30 && f.scenario === "expected")!;
  assert.equal(f30.reviews, 0, "still not due within 30d either");
});

test("many genuinely-due traces create overload and freeze introductions", () => {
  const traces = Array.from({ length: 400 }, (_, i) => reviewTrace(i, "reading", 0, { stability: 1 }));
  const r = assessWorkload(traces, 0, DEFAULT_CONFIG, fsrs);
  assert.equal(r.freezeIntroductions, true);
  assert.ok(r.reasons.some((x) => x.includes("exceeds budget")));
});

test("low-recall scenario produces at least as much load as high recall", () => {
  const traces = Array.from({ length: 30 }, (_, i) => reviewTrace(i, "reading", 0, { stability: 3 }));
  const r = assessWorkload(traces, 0, DEFAULT_CONFIG, fsrs);
  const high30 = r.forecasts.find((f) => f.horizonDays === 30 && f.scenario === "high")!;
  const low30 = r.forecasts.find((f) => f.horizonDays === 30 && f.scenario === "low")!;
  assert.ok(low30.reviews >= high30.reviews, `low ${low30.reviews} >= high ${high30.reviews}`);
  assert.ok(low30.dueMinutes >= high30.dueMinutes);
});

test("lapse repair dominating freezes introductions", () => {
  const traces = [
    ...Array.from({ length: 4 }, (_, i) => reviewTrace(i, "reading", 5, { state: "relearning" })),
    ...Array.from({ length: 6 }, (_, i) => reviewTrace(100 + i, "reading", 5)),
  ];
  const r = assessWorkload(traces, 0, DEFAULT_CONFIG, fsrs);
  assert.ok(r.lapseRepairShare >= 0.3);
  assert.equal(r.freezeIntroductions, true);
  assert.ok(r.reasons.some((x) => x.includes("lapse repair")));
});

test("weak recent confidence freezes introductions", () => {
  const traces = [reviewTrace(1, "reading", 20, { stability: 30 })];
  const r = assessWorkload(traces, 0, DEFAULT_CONFIG, fsrs, { weakConfidence: true });
  assert.equal(r.freezeIntroductions, true);
});

test("a light, healthy load does not freeze — new items are welcome", () => {
  const traces = Array.from({ length: 5 }, (_, i) => reviewTrace(i, "reading", 20, { stability: 40 }));
  const r = assessWorkload(traces, 0, DEFAULT_CONFIG, fsrs);
  assert.equal(r.freezeIntroductions, false);
});

test("forecasts are deterministic across runs", () => {
  const traces = Array.from({ length: 20 }, (_, i) => reviewTrace(i, "speaking", 1, { stability: 2 }));
  const a = assessWorkload(traces, 0, DEFAULT_CONFIG, fsrs);
  const b = assessWorkload(traces, 0, DEFAULT_CONFIG, fsrs);
  assert.deepEqual(a, b);
});
