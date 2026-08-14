import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ManualClock,
  canonicalJson,
  deriveSeed,
  hashValue,
  newTrace,
  retrievability,
  traceId,
  LexemeId,
} from "./index.ts";

test("hashValue is deterministic and order-independent for object keys", () => {
  const a = hashValue({ x: 1, y: [2, 3], z: { p: "q" } });
  const b = hashValue({ z: { p: "q" }, y: [2, 3], x: 1 });
  assert.equal(a, b);
  assert.notEqual(hashValue({ x: 1 }), hashValue({ x: 2 }));
});

test("canonicalJson sorts keys recursively", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":1}');
});

test("deriveSeed is stable for the same inputs", () => {
  assert.equal(deriveSeed("L1", "cfg", 3), deriveSeed("L1", "cfg", 3));
  assert.notEqual(deriveSeed("L1", "cfg", 3), deriveSeed("L1", "cfg", 4));
});

test("traceId binds lexeme and skill (four-traces identity)", () => {
  const lex = LexemeId("bank.n.01");
  assert.notEqual(traceId(lex, "listening"), traceId(lex, "reading"));
});

test("retrievability decays monotonically after review", () => {
  const t = { ...newTrace(traceId(LexemeId("x"), "reading"), LexemeId("x"), "reading"),
    stability: 10, state: "review" as const, lastReview: 0 };
  const day = 86_400_000;
  const r1 = retrievability(t, day * 1);
  const r5 = retrievability(t, day * 5);
  const r20 = retrievability(t, day * 20);
  assert.ok(r1 > r5 && r5 > r20, `expected decay, got ${r1} ${r5} ${r20}`);
  assert.ok(r1 <= 1 && r20 >= 0);
});

test("a brand-new trace has zero retrievability (never retrieved)", () => {
  const t = newTrace(traceId(LexemeId("x"), "reading"), LexemeId("x"), "reading");
  assert.equal(retrievability(t, 999), 0);
});

test("ManualClock only moves when told", () => {
  const c = new ManualClock("2026-01-01T00:00:00Z");
  const t0 = c.now();
  c.advanceDays(2);
  assert.equal(c.now() - t0, 2 * 86_400_000);
});
