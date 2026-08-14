import { test } from "node:test";
import assert from "node:assert/strict";
import { passesCanonicalAudioGate, type CanonicalAudioCheck } from "./index.ts";

const good: CanonicalAudioCheck = {
  humanRecorded: true, transcriptVerified: true, segmentationVerified: true,
  clean: true, naturalPace: true, licenceAndConsentClear: true,
};

test("fully-verified human audio passes the canonical gate (p.21)", () => {
  assert.equal(passesCanonicalAudioGate(good), true);
});

test("synthetic (non-human) audio can never pass the canonical gate", () => {
  assert.equal(passesCanonicalAudioGate({ ...good, humanRecorded: false }), false);
});

test("unclean or unverified audio is rejected", () => {
  assert.equal(passesCanonicalAudioGate({ ...good, clean: false }), false);
  assert.equal(passesCanonicalAudioGate({ ...good, transcriptVerified: false }), false);
});
