/**
 * Asset gate at task-planning time (spec Correction 7).
 *
 * A lexeme admitted through reading (no human audio) must never later yield an
 * audio task pointing at nonexistent canonical audio. Every issued TaskContract
 * is validated against the assets THAT task needs, with explainable reason codes.
 */
import {
  type LexemeId,
  type Skill,
  type TaskRubric,
} from "@dyr/domain";

/** Provider contract the kernel queries; implementations live in content/senses. */
export interface AssetProvider {
  /** Source + pack pass the redistribution allowlist (Rule 5). */
  licensed(lexeme: LexemeId): boolean;
  /** A canonical human recording exists for this lexeme (Rule 6, spec p.21). */
  hasCanonicalAudio(lexeme: LexemeId): boolean;
  /** A verified transcript exists for the lexeme's audio. */
  hasTranscript(lexeme: LexemeId): boolean;
  /** Stroke/handwriting data exists (writing handwriting tasks). */
  hasStrokeData(lexeme: LexemeId): boolean;
  /** The rubric this task needs is available. */
  hasRubric(rubricId: string, rubricVersion: string): boolean;
  /** Required assets are available offline when the session demands it. */
  offlineAvailable(lexeme: LexemeId): boolean;
  /** Fraction of surrounding tokens already known (frontier context gate, p.6). */
  knownTokenRatio(lexeme: LexemeId): number;
}

export type AssetReasonCode =
  | "missing_canonical_audio"
  | "asset_not_licensed"
  | "asset_not_available_offline"
  | "rubric_not_available"
  | "missing_transcript"
  | "missing_stroke_data";

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
