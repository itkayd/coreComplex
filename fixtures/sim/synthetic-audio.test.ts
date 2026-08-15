import { test } from "node:test";
import assert from "node:assert/strict";
import { LexemeId } from "@dyr/domain";
import {
  buildCore60Pack,
  packAssetProvider,
  packToGraph,
  isCanonical,
  runAudioQa,
  type AudioAsset,
} from "@dyr/content";
import { canSatisfyCanonicalAudio, syntheticProvenance } from "@dyr/senses";
import { makeCore60Harness } from "./core60.ts";

const BANK = "bank.n.01"; // 银行 — the spec's worked example

/**
 * Exactly what a CosyVoice clip looks like once stored: a real recording, of
 * good technical quality, that is nonetheless SYNTHETIC.
 */
function cosyVoiceClip(lexeme: string): AudioAsset {
  return {
    id: `audio:${lexeme}`,
    lexeme,
    transcript: "银行",
    state: "verified", // deliberately the strongest state a clip can hold
    sha256: "c".repeat(64),
    durationMs: 800,
    synthetic: true,
    speaker: "cosyvoice:中文女",
    region: "zh-CN",
  };
}

test("a CosyVoice clip is never canonical, even when marked verified", () => {
  const clip = cosyVoiceClip(BANK);
  assert.equal(clip.state, "verified", "the clip holds the strongest QA state");
  assert.equal(isCanonical(clip), false, "and is still not canonical, because it is synthetic");
});

test("the synthetic provenance contract itself refuses canonical status", () => {
  const provenance = syntheticProvenance({
    provider: "cosyvoice",
    modelVersion: "FunAudioLLM/Fun-CosyVoice3-0.5B-2512",
    providerVersion: "dyr-cosyvoice-adapter@1.0.0",
    generatedAt: 0,
  });
  assert.equal(provenance.sourceType, "synthetic");
  assert.equal(canSatisfyCanonicalAudio(provenance), false);
  assert.equal(canSatisfyCanonicalAudio({ sourceType: "human" }), true);
});

test("the audio QA gate rejects a CosyVoice clip on every path", () => {
  const clip = cosyVoiceClip(BANK);
  // Even claiming every human property AND passing objective screening.
  const result = runAudioQa({
    asset: clip,
    humanRecorded: true,
    transcriptMatches: true,
    segmentationVerified: true,
    clean: true,
    naturalPace: true,
    licenceAndConsentClear: true,
    screening: { passed: true, failures: [] },
  });
  assert.equal(result.state, "rejected");
  assert.ok(result.failures.includes("synthetic_cannot_be_canonical"));
});

test("a pack whose only audio is CosyVoice still reports NO canonical audio", () => {
  const pack = buildCore60Pack().pack;
  for (const lexeme of pack.lexemes) pack.audio.set(String(lexeme.id), cosyVoiceClip(String(lexeme.id)));

  const provider = packAssetProvider(pack);
  for (const lexeme of pack.lexemes) {
    assert.equal(provider.hasCanonicalAudio(lexeme.id), false, `${lexeme.id} must not count as canonical`);
    assert.equal(provider.hasTranscript(lexeme.id), false, "a synthetic transcript is not canonical evidence either");
  }
});

/**
 * THE GATE TEST the whole integration hangs on: with CosyVoice audio present for
 * every lexeme, the planner must STILL refuse audio-primary tasks and say why.
 */
test("KERNEL GATE: CosyVoice audio does not unblock listening — missing_canonical_audio persists", () => {
  const h = makeCore60Harness({ provisionAudio: false });
  // Fill the pack with synthetic clips, as if every word had been TTS-generated.
  for (const lexeme of h.pack.lexemes) h.pack.audio.set(String(lexeme.id), cosyVoiceClip(String(lexeme.id)));

  const plan = h.kernel.planSession({ budgetMinutes: 15, candidateIntroductions: h.lexemeIds });

  assert.equal(
    plan.tasks.some((t) => t.requiresHumanAudio),
    false,
    "no audio-primary task may be issued from synthetic audio",
  );
  assert.ok(
    plan.rejected.some((r) => r.reason === "missing_canonical_audio"),
    "the refusal is still explainable as missing_canonical_audio",
  );
  // Reading is unaffected: synthetic audio neither helps nor harms it.
  assert.ok(plan.tasks.some((t) => t.skill === "reading"), "reading still works");
});

test("progression cannot advance the listening channel on synthetic audio alone", () => {
  const h = makeCore60Harness({ provisionAudio: false });
  for (const lexeme of h.pack.lexemes) h.pack.audio.set(String(lexeme.id), cosyVoiceClip(String(lexeme.id)));

  // Drive several sessions; listening must never open.
  for (let day = 0; day < 10; day++) {
    const plan = h.kernel.planSession({ budgetMinutes: 15, candidateIntroductions: h.lexemeIds });
    for (const task of plan.tasks) {
      assert.notEqual(task.skill, "listening", "a listening task must never be issued");
      const prod = task.skill === "speaking" || task.skill === "writing";
      h.kernel.submitAttempt(task, {
        taskId: task.id,
        targetTrace: task.targetTrace,
        answer: plan.answers.get(task.id)!,
        latencyMs: task.estSeconds * 1000,
        hintsUsed: 0,
        answerRevealed: false,
        audioReplays: 1,
        selfGrade: prod ? "good" : undefined,
      });
    }
    h.clock.advanceDays(1);
  }
  assert.equal(h.kernel.frontier.profile().listening.retained, 0, "listening stays at zero without human audio");
});

test("graph pronunciation still points at the DECLARED canonical clip, not the synthetic one", () => {
  const pack = buildCore60Pack().pack;
  const graph = packToGraph(pack);
  // Pronunciation metadata references the canonical asset id the pack declares;
  // a synthetic clip is a playback convenience, never the pronunciation reference.
  assert.equal(graph.pronunciationOf(BANK)!.audioAssetId, `audio:${BANK}`);
  assert.equal(isCanonical(pack.audio.get(BANK)), false, "still unprovisioned");
});
