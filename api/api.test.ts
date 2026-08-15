/**
 * The sync endpoint's contract.
 *
 * Neon is not reachable from CI or from a development sandbox, and depending on
 * a live database would make these tests flaky for reasons that have nothing to
 * do with the code. So the parts that decide anything — validation, limits,
 * identity — are pure functions, and they are what is tested here. The SQL
 * itself is exercised against the real database by hitting the deployed
 * endpoint (see docs/BACKUP.md).
 *
 * The last test is the important one architecturally: the API must stay a dumb
 * store. If learning logic ever leaks into it, there would be two things
 * deciding what a learner knows, and the kernel would stop being the authority
 * the whole design rests on (spec p.3).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MAX_BATCH, SCHEMA_SQL, validLearnerId, validateBatch } from "./sync.ts";

const here = dirname(fileURLToPath(import.meta.url));

const event = (over: Record<string, unknown> = {}) => ({
  localSequence: 0,
  deviceId: "web-1",
  eventType: "TraceUpdated",
  occurredAt: 1_755_000_000_000,
  payload: { some: "thing" },
  ...over,
});

test("a well-formed batch is accepted and normalised", () => {
  const result = validateBatch([event({ localSequence: 0 }), event({ localSequence: 1 })]);
  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows.map((r) => r.localSequence), [0, 1]);
  assert.equal(result.rows[0].eventType, "TraceUpdated");
  // The whole event is stored, not just the indexed columns: the log is the
  // thing being backed up, and a partial copy would not replay.
  assert.deepEqual(result.rows[0].payload, event({ localSequence: 0 }));
});

test("localSequence is the identity, so it must be a non-negative integer", () => {
  for (const bad of [undefined, null, "3", 1.5, -1, Number.NaN]) {
    const result = validateBatch([event({ localSequence: bad })]);
    assert.equal(result.ok, false, `${String(bad)} was accepted as a sequence`);
    assert.match(result.rejected[0].reason, /localSequence/);
  }
});

test("a batch is a sync unit, not a bulk import", () => {
  const huge = Array.from({ length: MAX_BATCH + 1 }, (_, i) => event({ localSequence: i }));
  const result = validateBatch(huge);
  assert.equal(result.ok, false);
  assert.match(result.rejected[0].reason, /exceeds/);
  // Exactly at the limit is fine.
  assert.equal(validateBatch(huge.slice(0, MAX_BATCH)).ok, true);
});

test("an oversized single event is rejected rather than truncated", () => {
  const result = validateBatch([event({ payload: { blob: "x".repeat(70_000) } })]);
  assert.equal(result.ok, false);
  assert.match(result.rejected[0].reason, /size limit/);
});

test("non-objects and unserialisable events are rejected", () => {
  assert.equal(validateBatch("nope").ok, false);
  assert.equal(validateBatch([42]).ok, false);
  const cyclic: Record<string, unknown> = { localSequence: 0 };
  cyclic.self = cyclic;
  assert.equal(validateBatch([cyclic]).ok, false);
});

test("free-text fields are bounded before they reach the database", () => {
  const result = validateBatch([event({ deviceId: "d".repeat(500), eventType: "t".repeat(500) })]);
  assert.equal(result.ok, true);
  assert.equal(result.rows[0].deviceId.length, 128);
  assert.equal(result.rows[0].eventType.length, 128);
});

test("learner ids are bounded and printable", () => {
  assert.equal(validLearnerId("local-learner"), true);
  assert.equal(validLearnerId("user@example.com"), true);
  for (const bad of ["", "a".repeat(129), "has space", "semi;colon", "quote'", 42, null, undefined]) {
    assert.equal(validLearnerId(bad), false, `${String(bad)} was accepted as a learner id`);
  }
});

test("the schema makes (learner, sequence) the primary key, which is what makes a re-send idempotent", () => {
  assert.match(SCHEMA_SQL, /primary key \(learner_id, local_sequence\)/);
  assert.match(SCHEMA_SQL, /create table if not exists/);
});

test("the API is a store, not a brain: no learning logic may live in it", () => {
  const source = readFileSync(join(here, "sync.ts"), "utf8");

  // No kernel, no scheduler, no domain policy — the device decides, always.
  for (const forbidden of ["@dyr/kernel", "@dyr/domain", "@dyr/fsrs-adapter", "@dyr/content", "ts-fsrs"]) {
    assert.ok(!source.includes(`from "${forbidden}"`), `the sync API must not import ${forbidden}`);
  }

  // And no scheduling vocabulary, which would mean it had started deciding.
  for (const term of ["stability", "difficulty", "retrievability", "scheduleReview", "ratingProposal"]) {
    assert.ok(!source.includes(term), `the sync API must not reason about ${term}`);
  }
});

test("no secret is committed alongside the code", () => {
  const source = readFileSync(join(here, "sync.ts"), "utf8");
  assert.ok(source.includes("process.env.DATABASE_URL"), "the connection string must come from the environment");
  assert.ok(!/postgres(ql)?:\/\/[^\s"']*:[^\s"']*@/.test(source), "a connection string with credentials is present in the source");
});
