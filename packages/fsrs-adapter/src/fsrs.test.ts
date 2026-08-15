import { test } from "node:test";
import assert from "node:assert/strict";
import { createFsrsAdapter } from "./index.ts";
import type { MemoryState } from "@dyr/domain";

const DAY = 86_400_000;
const adapter = createFsrsAdapter();

test("adapter reports the real ts-fsrs library and a pinned config hash", () => {
  assert.equal(adapter.parameters.library, "ts-fsrs");
  assert.match(adapter.parameters.libraryVersion, /\d+\.\d+\.\d+/);
  assert.equal(adapter.parameters.enableFuzz, false);
  assert.ok(adapter.parameters.configHash.length > 0);
});

test("first review initialises stability and difficulty within bounds", () => {
  const r = adapter.scheduleReview(adapter.initialState(), "good", 0);
  assert.ok(r.state.stability > 0, "stability positive");
  assert.ok(r.state.difficulty >= 1 && r.state.difficulty <= 10, "difficulty in [1,10]");
  assert.ok(r.state.due! > 0);
});

test("a successful recall never decreases stability", () => {
  const first = adapter.scheduleReview(adapter.initialState(), "good", 0).state;
  // graduate through the learning steps until it reaches review state
  let s = first;
  let t = first.due!;
  for (let i = 0; i < 5 && s.state !== "review"; i++) {
    s = adapter.scheduleReview(s, "good", t).state;
    t = s.due!;
  }
  const before = s.stability;
  const next = adapter.scheduleReview(s, "good", s.due!).state;
  assert.ok(next.stability >= before, `${next.stability} >= ${before}`);
});

test("SHORT-TERM REPAIR (ADR-0003): a lapse reappears in under a day", () => {
  // Drive to review state, then fail.
  let s = adapter.scheduleReview(adapter.initialState(), "easy", 0).state;
  let t = s.due!;
  for (let i = 0; i < 6 && s.state !== "review"; i++) {
    s = adapter.scheduleReview(s, "good", t).state;
    t = s.due!;
  }
  const lapsed = adapter.scheduleReview(s, "again", s.due!).state;
  const gapDays = (lapsed.due! - s.due!) / DAY;
  assert.ok(gapDays < 1, `lapse should reappear within a day, got ${gapDays.toFixed(3)}d`);
  assert.equal(lapsed.state, "relearning");
  assert.ok(lapsed.lapses >= 1, "lapse counted");
});

test("retrievability is the single authority and decays over time", () => {
  const reviewed = adapter.scheduleReview(adapter.initialState(), "easy", 0).state;
  // advance far enough to be in review with real stability
  let s = reviewed, t = s.due!;
  for (let i = 0; i < 6 && s.state !== "review"; i++) { s = adapter.scheduleReview(s, "good", t).state; t = s.due!; }
  const rNow = adapter.retrievability(s, s.lastReview!);
  const rLater = adapter.retrievability(s, s.lastReview! + 30 * DAY);
  assert.ok(rNow > rLater, `R should decay: ${rNow} > ${rLater}`);
  assert.ok(rNow <= 1 && rLater >= 0);
});

test("a brand-new state has zero retrievability", () => {
  assert.equal(adapter.retrievability(adapter.initialState(), 999), 0);
});

test("scheduling is pure: identical inputs give identical output", () => {
  const s: MemoryState = adapter.scheduleReview(adapter.initialState(), "good", 0).state;
  const a = adapter.scheduleReview(s, "good", s.due! + DAY);
  const b = adapter.scheduleReview(s, "good", s.due! + DAY);
  assert.deepEqual(a, b);
});

test("valid ratings always produce in-bounds memory state (FSRS state bounds)", () => {
  let s = adapter.initialState();
  let t = 0;
  const ratings = ["good", "again", "hard", "easy", "again", "good"] as const;
  for (let i = 0; i < 40; i++) {
    const r = adapter.scheduleReview(s, ratings[i % ratings.length], t);
    assert.ok(r.state.difficulty >= 1 && r.state.difficulty <= 10, `D ${r.state.difficulty}`);
    assert.ok(r.state.stability > 0, `S ${r.state.stability}`);
    assert.ok(Number.isFinite(r.state.due!), "due finite");
    s = r.state;
    t = s.due!;
  }
});
