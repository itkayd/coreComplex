import { test } from "node:test";
import assert from "node:assert/strict";
import { createFsrsAdapter, type MemoryState } from "./index.ts";

const DAY = 86_400_000;
const adapter = createFsrsAdapter();
const newState: MemoryState = { stability: 0, difficulty: 5, state: "new" };

test("first review initialises stability and difficulty within bounds", () => {
  const r = adapter.scheduleReview(newState, "good", 0);
  assert.ok(r.stability > 0, "stability positive");
  assert.ok(r.difficulty >= 1 && r.difficulty <= 10, "difficulty in [1,10]");
  assert.equal(r.state, "review");
  assert.ok(r.due > 0);
});

test("a successful recall never decreases stability", () => {
  const first = adapter.scheduleReview(newState, "good", 0);
  const later = first.due; // review exactly when due
  const state: MemoryState = { ...first, lastReview: 0 };
  const second = adapter.scheduleReview(state, "good", later);
  assert.ok(second.stability >= first.stability, `${second.stability} >= ${first.stability}`);
});

test("a lapse (again) never increases stability", () => {
  const first = adapter.scheduleReview(newState, "good", 0);
  const state: MemoryState = { ...first, lastReview: 0 };
  const lapsed = adapter.scheduleReview(state, "again", first.due + 10 * DAY);
  assert.ok(lapsed.stability <= first.stability, `${lapsed.stability} <= ${first.stability}`);
  assert.equal(lapsed.state, "relearning");
});

test("easy schedules a longer interval than hard", () => {
  const easy = adapter.scheduleReview(newState, "easy", 0);
  const hard = adapter.scheduleReview(newState, "hard", 0);
  assert.ok(easy.due > hard.due, "easy further out than hard");
});

test("scheduling is pure: identical inputs give identical output", () => {
  const a = adapter.scheduleReview({ stability: 4, difficulty: 6, state: "review", lastReview: 0 }, "good", 5 * DAY);
  const b = adapter.scheduleReview({ stability: 4, difficulty: 6, state: "review", lastReview: 0 }, "good", 5 * DAY);
  assert.deepEqual(a, b);
});

test("difficulty stays clamped in [1,10] across many reviews", () => {
  let s: MemoryState = { ...adapter.scheduleReview(newState, "again", 0), lastReview: 0 };
  for (let i = 0; i < 50; i++) {
    const r = adapter.scheduleReview(s, i % 2 ? "again" : "easy", (i + 1) * DAY);
    assert.ok(r.difficulty >= 1 && r.difficulty <= 10, `difficulty ${r.difficulty}`);
    s = { ...r, lastReview: (i + 1) * DAY };
  }
});
