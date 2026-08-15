import { test } from "node:test";
import assert from "node:assert/strict";
import { licenceGate, type SourceAsset } from "./index.ts";
import { PackVersion } from "@dyr/domain";

function asset(o: Partial<SourceAsset>): SourceAsset {
  return {
    id: "a1", type: "lexeme", sourceName: "CC-CEDICT", retrievedAt: 0,
    immutableVersion: PackVersion("p@1"), licenseSpdx: "CC-BY-SA-4.0",
    redistributionAllowed: true, derivativeAllowed: true, sha256: "x",
    languageTag: "zh-CN", qualityState: "verified", ...o,
  };
}

test("CC BY-SA with redistribution is allowed (DEFAULT PACK ALLOW, p.7)", () => {
  assert.equal(licenceGate(asset({})).allowed, true);
});

test("CC BY-NC is denied", () => {
  assert.equal(licenceGate(asset({ licenseSpdx: "CC-BY-NC-4.0" })).allowed, false);
});

test("CC BY-ND is denied", () => {
  assert.equal(licenceGate(asset({ licenseSpdx: "CC-BY-ND-4.0" })).allowed, false);
});

test("missing/unknown licence is denied", () => {
  assert.equal(licenceGate(asset({ licenseSpdx: "UNKNOWN" })).allowed, false);
});

test("Pleco-sourced data is denied outright (p.7 PLECO BOUNDARY)", () => {
  assert.equal(licenceGate(asset({ sourceName: "Pleco", licenseSpdx: "CC0-1.0" })).allowed, false);
});

test("free-to-view without redistribution rights is denied", () => {
  assert.equal(licenceGate(asset({ redistributionAllowed: false })).allowed, false);
});

import { attributionReport } from "./index.ts";

test("attribution output is deterministic and excludes denied assets (p.28)", () => {
  const allowed = asset({ id: "b", sourceName: "CC-CEDICT", licenseSpdx: "CC-BY-SA-4.0", attributionText: "CC-CEDICT (CC BY-SA)", sha256: "h2" });
  const alsoAllowed = asset({ id: "a", sourceName: "Unihan", licenseSpdx: "CC0-1.0", sha256: "h1" });
  const denied = asset({ id: "c", sourceName: "Pleco", licenseSpdx: "CC0-1.0", sha256: "h3" });
  const r1 = attributionReport([allowed, alsoAllowed, denied]);
  const r2 = attributionReport([denied, allowed, alsoAllowed]);
  assert.deepEqual(r1, r2, "order-independent, reproducible");
  assert.deepEqual(r1.map((e) => e.id), ["a", "b"], "sorted, Pleco excluded");
});
