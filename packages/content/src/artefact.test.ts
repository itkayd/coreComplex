/**
 * The wire format: interned provenance, derived attribution, signed licences.
 *
 * The artefact was 73% duplicated licence prose. Compressing that is only safe
 * if the information survives exactly, so these tests pin the round-trip and the
 * refusals rather than the byte count.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildCore60Pack } from "./pipeline.ts";
import { exportPack, importPack, expandManifest, PackProvenanceError } from "./export.ts";
import { loadVerifiedPack, validatePackStructure, webCryptoSha256 } from "./validate.ts";
import { licenceGate } from "./index.ts";

const built = () => buildCore60Pack().pack;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

test("interning loses nothing: every asset round-trips to the same provenance", () => {
  const pack = built();
  const restored = importPack(clone(exportPack(pack)));

  assert.equal(restored.manifest.length, pack.manifest.length);
  // Field-for-field, not merely the same count.
  assert.deepEqual(clone(restored.manifest), clone(pack.manifest));
  // And every restored asset still passes the gate it passed at build time.
  for (const asset of restored.manifest) {
    assert.equal(licenceGate(asset).allowed, true, `${asset.id} lost its admissibility`);
  }
});

test("the pack really does hold two licences, and both survive the round-trip", () => {
  const restored = importPack(clone(exportPack(built())));
  const licences = new Set(restored.manifest.map((a) => a.licenseSpdx));
  assert.deepEqual([...licences].sort(), ["CC-BY-SA-4.0", "CC0-1.0"]);

  // The CC0 set must not have acquired a share-alike obligation, nor the
  // CC BY-SA set lost one — that is the whole point of per-asset licensing.
  const cc0 = restored.manifest.filter((a) => a.licenseSpdx === "CC0-1.0");
  assert.equal(cc0.length, 60, "the hand-authored Core 60 must stay CC0");
  assert.ok(cc0.every((a) => a.rightsGrant === undefined), "CC0 assets need no grant");
  assert.ok(
    restored.manifest.filter((a) => a.licenseSpdx === "CC-BY-SA-4.0").every((a) => a.rightsGrant?.holder === "Pleco Inc."),
    "every derived asset must carry its recorded grant",
  );
});

test("attribution is derived, not transmitted, and is byte-identical to the build's", () => {
  const pack = built();
  const wire = clone(exportPack(pack));
  assert.equal((wire as unknown as Record<string, unknown>).attributions, undefined, "attributions must not be shipped");
  assert.deepEqual(clone(importPack(wire).attributions), clone(pack.attributions));
});

test("declared audio is reconstructed, not shipped", () => {
  const pack = built();
  const wire = clone(exportPack(pack));
  assert.equal(wire.audio.length, 0, "an unprovisioned pack should ship no audio rows at all");

  const restored = importPack(wire);
  assert.equal(restored.audio.size, pack.lexemes.length, "every lexeme still declares the audio it needs");
  for (const lexeme of pack.lexemes) {
    const asset = restored.audio.get(String(lexeme.id));
    assert.equal(asset?.state, "declared");
    assert.equal(asset?.transcript, lexeme.simplified);
  }
});

test("a manifest row pointing at a source that does not exist is refused", () => {
  const wire = clone(exportPack(built()));
  wire.manifest[0].source = 999;
  // An asset whose provenance cannot be resolved effectively has no licence.
  assert.throws(() => expandManifest(wire), PackProvenanceError);
  const structure = validatePackStructure(wire);
  assert.equal(structure.valid, false);
  assert.match((structure as { issues: { message: string }[] }).issues[0].message, /does not exist/);
});

test("RE-LICENSING A PACK BREAKS ITS SIGNATURE", async () => {
  // The hash used to cover the words but not the terms they ship under, so a
  // pack could be relabelled CC0 and still verify. It cannot now.
  const wire = clone(exportPack(built()));
  await loadVerifiedPack(clone(wire), webCryptoSha256);

  const relicensed = clone(wire);
  const shareAlike = relicensed.sources.findIndex((s) => s.licenseSpdx === "CC-BY-SA-4.0");
  assert.ok(shareAlike >= 0, "expected a share-alike source to relabel");
  relicensed.sources[shareAlike].licenseSpdx = "CC0-1.0";

  await assert.rejects(() => loadVerifiedPack(relicensed, webCryptoSha256), /integrity/);
});

test("the content hash still ignores presentation-only changes", async () => {
  // Interning is a serialisation decision, not a content one: moving provenance
  // into a shared table must not mint a new pack version by itself.
  const pack = built();
  const wire = clone(exportPack(pack));
  assert.equal(wire.contentHash, pack.contentHash);
  await loadVerifiedPack(clone(wire), webCryptoSha256);
});
