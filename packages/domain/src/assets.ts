/**
 * Asset provider contract (spec §20 dependency direction).
 *
 * This is a PROVIDER CONTRACT, not an implementation, so it lives in the domain
 * alongside the other contracts: the kernel queries it when gating tasks, and
 * @dyr/content implements it from a built pack — without either package
 * importing the other.
 */
import type { LexemeId } from "./ids.ts";

export interface AssetProvider {
  /** Source + pack pass the redistribution allowlist (Rule 5). */
  licensed(lexeme: LexemeId): boolean;
  /** A canonical HUMAN recording exists and passed QA (Rule 6, spec p.21). */
  hasCanonicalAudio(lexeme: LexemeId): boolean;
  /** A verified transcript exists for the lexeme's audio. */
  hasTranscript(lexeme: LexemeId): boolean;
  /** Stroke/handwriting data exists (handwriting tasks). */
  hasStrokeData(lexeme: LexemeId): boolean;
  /** The rubric this task needs is available at the required version. */
  hasRubric(rubricId: string, rubricVersion: string): boolean;
  /** Required assets are available offline when the session demands it. */
  offlineAvailable(lexeme: LexemeId): boolean;
  /** Fraction of surrounding tokens already known (frontier context gate, p.6). */
  knownTokenRatio(lexeme: LexemeId): number;
}

/** Explainable reasons a task may be refused at plan time (spec Correction 7). */
export type AssetReasonCode =
  | "missing_canonical_audio"
  | "asset_not_licensed"
  | "asset_not_available_offline"
  | "rubric_not_available"
  | "missing_transcript"
  | "missing_stroke_data";
