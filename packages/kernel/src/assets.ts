/**
 * Asset gate at task-planning time (spec Correction 7).
 *
 * A lexeme admitted through reading (no human audio) must never later yield an
 * audio task pointing at nonexistent canonical audio. Every issued TaskContract
 * is validated against the assets THAT task needs, with explainable reason codes.
 */
import {
  type AssetProvider,
  type AssetReasonCode,
  type LexemeId,
  type Skill,
  type TaskRubric,
} from "@dyr/domain";

// The provider contract itself lives in @dyr/domain so that @dyr/content can
// implement it without importing the kernel (spec §20). Re-exported here for
// callers that already depend on the kernel.
export type { AssetProvider, AssetReasonCode };

export interface AssetGateResult {
  ok: boolean;
  blockers: AssetReasonCode[];
}

/**
 * Validate the assets for one exact task (family + rubric + skill). Called by
 * the planner before a TaskContract may enter the plan.
 */
export function checkTaskAssets(
  provider: AssetProvider,
  lexeme: LexemeId,
  skill: Skill,
  rubric: TaskRubric,
  opts: { requireOffline: boolean; family: string },
): AssetGateResult {
  const blockers: AssetReasonCode[] = [];

  if (!provider.licensed(lexeme)) blockers.push("asset_not_licensed");
  if (!provider.hasRubric(rubric.rubricId, rubric.rubricVersion)) blockers.push("rubric_not_available");
  if (rubric.requiresCanonicalAudio && !provider.hasCanonicalAudio(lexeme)) {
    blockers.push("missing_canonical_audio");
  }
  // Dictation / audio-to-hanzi additionally need a verified transcript.
  if ((opts.family === "micro_dictation" || opts.family === "audio_to_hanzi") && !provider.hasTranscript(lexeme)) {
    blockers.push("missing_transcript");
  }
  if (rubric.writingContext === "handwriting" && !provider.hasStrokeData(lexeme)) {
    blockers.push("missing_stroke_data");
  }
  if (opts.requireOffline && !provider.offlineAvailable(lexeme)) {
    blockers.push("asset_not_available_offline");
  }

  return { ok: blockers.length === 0, blockers };
}
