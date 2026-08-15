import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  PackRejected,
  buildCore60Pack,
  exportPack,
  loadVerifiedPack,
  validatePackStructure,
  verifyPackIntegrity,
  webCryptoSha256,
} from "./index.ts";

const exported = () => exportPack(buildCore60Pack().pack);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test("the Node build hash and the browser (Web Crypto) hash AGREE", async () => {
  // The whole integrity story depends on these two never drifting apart.
  const pack = exported();
  const result = await verifyPackIntegrity(pack, webCryptoSha256);
  assert.equal(result.ok, true, `expected ${result.expected}, computed ${result.actual}`);
  assert.equal(result.actual, pack.contentHash);
});

test("a genuine pack passes structure and integrity", async () => {
  const built = exported();
  const pack = await loadVerifiedPack(clone(built));
  assert.equal(pack.lexemes.length, built.lexemes.length);
  assert.ok(pack.lexemes.length >= 60, "the pack must at least carry the Core 60");
});

test("PACK HASH MISMATCH: edited content is refused", async () => {
  const tampered = clone(exported());
  // Change one gloss — the sort of edit that "looks harmless".
  tampered.lexemes[0].senses = ["totally different meaning"];
  await assert.rejects(
    () => loadVerifiedPack(tampered),
    (e: unknown) => e instanceof PackRejected && e.reason === "integrity",
  );
});

test("PACK HASH MISMATCH: a truncated pack is refused", async () => {
  const truncated = clone(exported());
  truncated.lexemes = truncated.lexemes.slice(0, 30);
  await assert.rejects(
    () => loadVerifiedPack(truncated),
    (e: unknown) => e instanceof PackRejected && e.reason === "integrity",
  );
});

test("PACK HASH MISMATCH: a swapped declared hash is refused", async () => {
  const swapped = clone(exported());
  swapped.contentHash = "b".repeat(64);
  await assert.rejects(
    () => loadVerifiedPack(swapped),
    (e: unknown) => e instanceof PackRejected && e.reason === "integrity",
  );
});

test("structural problems are reported with an exact path", () => {
  const broken = clone(exported()) as unknown as Record<string, unknown>;
  (broken.lexemes as Record<string, unknown>[])[3].pinyin = "";
  const result = validatePackStructure(broken);
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.issues[0].path, "lexemes[3].pinyin");
});

test("a pack whose lexemes belong to another version is internally inconsistent", () => {
  const mixed = clone(exported()) as unknown as Record<string, unknown>;
  (mixed.lexemes as Record<string, unknown>[])[0].packVersion = "some-other-pack@9";
  const result = validatePackStructure(mixed);
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.ok(result.issues.some((i) => i.path === "lexemes[0].packVersion"));
});

test("junk input is rejected as structure, never reaching the hash check", async () => {
  for (const junk of [null, 42, "a string", [], {}]) {
    await assert.rejects(
      () => loadVerifiedPack(junk),
      (e: unknown) => e instanceof PackRejected && e.reason === "structure",
      `junk: ${JSON.stringify(junk)}`,
    );
  }
});

test("an empty pack is refused rather than loaded as an empty course", () => {
  const empty = clone(exported()) as unknown as Record<string, unknown>;
  empty.lexemes = [];
  const result = validatePackStructure(empty);
  assert.equal(result.valid, false);
});

test("a malformed content hash is caught structurally", () => {
  const bad = clone(exported()) as unknown as Record<string, unknown>;
  bad.contentHash = "not-a-hash";
  const result = validatePackStructure(bad);
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.ok(result.issues.some((i) => i.path === "contentHash"));
});

test("verification is deterministic and injectable (node:crypto path)", async () => {
  const nodeSha256 = async (input: string) => createHash("sha256").update(input, "utf8").digest("hex");
  const pack = exported();
  const a = await verifyPackIntegrity(pack, nodeSha256);
  const b = await verifyPackIntegrity(pack, webCryptoSha256);
  assert.equal(a.actual, b.actual, "both digest implementations agree");
  assert.equal(a.ok, true);
});
