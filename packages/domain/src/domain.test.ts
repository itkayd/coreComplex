import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ManualClock,
  canonicalJson,
  deriveSeed,
  hashValue,
  isDue,
  latenessDays,
  newTrace,
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

test("the domain no longer implements a forgetting curve (ADR-0002)", async () => {
  // Retrievability is the FSRS adapter's sole responsibility now. The domain
  // exposes memory STATE and due/lateness helpers only — importing a domain
  // `retrievability` must fail.
  const mod = await import("./index.ts");
  assert.equal((mod as Record<string, unknown>).retrievability, undefined);
});

test("due and lateness derive from stored state, not a curve", () => {
  const day = 86_400_000;
  const t = { ...newTrace(traceId(LexemeId("x"), "reading"), LexemeId("x"), "reading"),
    state: "review" as const, due: 10 * day, lastReview: 0, stability: 10 };
  assert.equal(isDue(t, 9 * day), false);
  assert.equal(isDue(t, 12 * day), true);
  assert.equal(latenessDays(t, 12 * day), 2);
  assert.equal(latenessDays(t, 5 * day), 0);
});

test("ManualClock only moves when told", () => {
  const c = new ManualClock("2026-01-01T00:00:00Z");
  const t0 = c.now();
  c.advanceDays(2);
  assert.equal(c.now() - t0, 2 * 86_400_000);
});
