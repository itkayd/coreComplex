/**
 * SCENARIO J — a Cloudflare MeloTTS clip meets the canonical-audio gate.
 *
 * This is the test the whole pronunciation feature is allowed to exist because
 * of. Three synthetic providers now feed "Hear it", and the temptation each one
 * creates is identical: there are 2,006 lexemes and zero human recordings, and a
 * TTS provider that sounds good could make the Stage 2 gate turn green in an
 * afternoon. It must not, and the refusal must be structural rather than a
 * convention someone remembers.
 *
 * So this asserts the refusal on EVERY path a MeloTTS clip could travel:
 * the provenance contract, the asset gate, the QA screen, the content provider,
 * the pack's own accounting, and the planner. A single one of these passing
 * would be enough to teach a learner that a synthesised voice is how a Mandarin
 * word is pronounced by a person.
 *
 * The sibling file `synthetic-audio.test.ts` does the same for CosyVoice. Both
 * exist because the rule is about the CATEGORY, not about one vendor — and a new
 * provider should arrive with a new copy of this file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { canSatisfyCanonicalAudio, syntheticProvenance } from "@dyr/senses";
import { buildCore60Pack, isCanonical, packAssetProvider, runAudioQa, type AudioAsset } from "@dyr/content";

const MODEL = "@cf/myshell-ai/melotts";
const BANK = "bank.n.01";

/**
 * Exactly what a MeloTTS clip would look like if someone tried hardest to make
 * it pass: verified state, clean signal, a real hash, plausible speaker, an open
 * licence — and the one honest field, `synthetic: true`.
 */
function melottsClip(lexeme: string, over: Partial<AudioAsset> = {}): AudioAsset {
  return {
    id: `audio:${lexeme}`,
    lexeme,
    transcript: "银行",
    state: "verified",
    sha256: "b".repeat(64),
    durationMs: 900,
    synthetic: true,
    speaker: `cloudflare-workers-ai:${MODEL}`,
    licenseSpdx: "CC0-1.0",
    runtime: {
      path: `audio/${"b".repeat(64)}.mp3`,
      sha256: "b".repeat(64),
      bytes: 4096,
      mediaType: "audio/mpeg",
      derivedFrom: "generated",
      transform: "none",
    },
    ...over,
  };
}

test("SCENARIO J — a MeloTTS clip is NEVER canonical, however it is dressed up", () => {
  const clip = melottsClip(BANK);
  assert.equal(clip.state, "verified", "the state field is not what stops it");
  assert.equal(isCanonical(clip), false, "and yet it is not canonical, because it is synthetic");

  // Not even with a human-sounding speaker, a licence and a review attached.
  assert.equal(isCanonical(melottsClip(BANK, {
    speaker: "native speaker, Beijing",
    review: { audioSha256: "b".repeat(64), reviewedBy: "someone", reviewedAt: "2026-08-15T00:00:00Z" },
  })), false);
});

test("the provenance contract itself refuses to describe MeloTTS as human", () => {
  const provenance = syntheticProvenance({
    provider: "cloudflare-workers-ai",
    modelVersion: MODEL,
    providerVersion: "dyr-melotts-adapter@1.0.0",
    generatedAt: Date.UTC(2026, 7, 15),
  });
  // `sourceType` is the literal "synthetic" — not a boolean a caller could flip
  // and not optional, so a human-claiming result cannot be constructed at all.
  assert.equal(provenance.sourceType, "synthetic");
  assert.equal(canSatisfyCanonicalAudio(provenance), false);
  assert.equal(canSatisfyCanonicalAudio({ sourceType: "human" }), true, "the gate is not simply always false");
});

test("the QA gate refuses it EVEN IF EVERY DECLARATION CLAIMS IT IS HUMAN", () => {
  // The strongest possible attempt: an operator asserts the clip is human
  // recorded, transcript-matched, segmented, licensed and clean, and supplies
  // real measurements to back the objective claims. The one field that is a
  // structural fact rather than a claim — `synthetic` — is what refuses it.
  const result = runAudioQa({
    asset: melottsClip(BANK),
    humanRecorded: true,
    transcriptMatches: true,
    segmentationVerified: true,
    clean: true,
    naturalPace: true,
    licenceAndConsentClear: true,
    screening: { passed: true, failures: [] },
  });

  assert.equal(result.state, "rejected");
  assert.deepEqual(result.failures, ["synthetic_cannot_be_canonical"],
    "synthesis must be the sole and sufficient reason for refusal");
});

test("a pack full of MeloTTS still reports ZERO canonical audio", () => {
  const { pack } = buildCore60Pack();
  for (const lexeme of pack.lexemes) {
    pack.audio.set(String(lexeme.id), melottsClip(String(lexeme.id)));
  }

  const provider = packAssetProvider(pack);
  for (const lexeme of pack.lexemes) {
    assert.equal(provider.hasCanonicalAudio(lexeme.id), false, `${String(lexeme.id)} counted as canonical`);
    // A synthetic transcript is not canonical evidence either — otherwise a
    // listening task could be built from a generated reading of the word.
    assert.equal(provider.hasTranscript(lexeme.id), false);
  }

  const canonical = [...pack.audio.values()].filter(isCanonical);
  assert.equal(canonical.length, 0, "not one generated clip may count toward the 60");
});

test("MELOTTS CANNOT UNBLOCK STAGE 2", () => {
  // The gate the whole feature must not be able to satisfy. If this ever passes,
  // the Stage 2 canonical-audio requirement has been quietly deleted.
  const { pack } = buildCore60Pack();
  for (const lexeme of pack.lexemes) {
    pack.audio.set(String(lexeme.id), melottsClip(String(lexeme.id)));
  }
  const stillPending = pack.lexemes.filter((l) => !isCanonical(pack.audio.get(String(l.id))));
  assert.equal(stillPending.length, pack.lexemes.length,
    "filling the pack with generated audio must leave every recording still outstanding");
});
