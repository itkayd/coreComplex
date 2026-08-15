/**
 * Static sentence difficulty.
 *
 * The spec's distinction, kept strictly:
 *
 *   STATIC (here)   — properties of the sentence itself: highest HSK level of
 *                     its vocabulary, length, out-of-level tokens, target-word
 *                     density. Immutable, belongs in the content pack.
 *
 *   LEARNER-SPECIFIC — "how much of this sentence can THIS learner retrieve?"
 *                     That depends on live SkillTrace state, so it is computed
 *                     by the kernel/planner and must never be frozen into a
 *                     content object.
 *
 * `knownTokenRatio` therefore does NOT appear in this module.
 */
import type { HskLevel } from "./hsk.ts";
import type { SentenceToken } from "./tokenise.ts";

export interface StaticDifficulty {
  /** Highest HSK level among resolved tokens; undefined when none are levelled. */
  lexicalLevel?: HskLevel;
  /** Distinct known lexemes in the sentence. */
  lexemeCount: number;
  /** Han characters in the sentence. */
  characterCount: number;
  /** Tokens that resolved to no known lexeme. */
  unknownTokenCount: number;
  /** Fraction of vocabulary at or below the target level, 0..1. */
  atOrBelowTargetRatio: number;
  /** Tokens above the target level. */
  outOfLevelTokens: string[];
  /** Fraction of tokens that are the sentence's target vocabulary. */
  targetDensity: number;
  /** Composite 0..1 for ordering candidates. Never a pedagogical verdict. */
  score: number;
}

export interface DifficultyInput {
  tokens: SentenceToken[];
  /** lexemeId → HSK level, from the levelled pack. */
  levels: Map<string, HskLevel>;
  /** The lexemes this sentence is meant to practise. */
  targetLexemeIds: string[];
  /** The level the sentence is being judged against. */
  targetLevel?: HskLevel;
}

export function staticDifficulty(input: DifficultyInput): StaticDifficulty {
  const lexemeTokens = input.tokens.filter((t) => t.kind === "lexeme" && t.lexemeId);
  const unknownTokenCount = input.tokens.filter((t) => t.kind === "unknown").length;
  const characterCount = input.tokens
    .filter((t) => t.kind === "lexeme" || t.kind === "unknown")
    .reduce((sum, t) => sum + t.text.length, 0);

  const levelled: { text: string; level: HskLevel }[] = [];
  for (const token of lexemeTokens) {
    const level = input.levels.get(token.lexemeId!);
    if (level !== undefined) levelled.push({ text: token.text, level });
  }

  const lexicalLevel = levelled.length > 0
    ? (Math.max(...levelled.map((l) => l.level)) as HskLevel)
    : undefined;

  const target = input.targetLevel;
  const outOfLevelTokens = target === undefined ? [] : levelled.filter((l) => l.level > target).map((l) => l.text);
  const atOrBelowTargetRatio = target === undefined || levelled.length === 0
    ? 1
    : Number(((levelled.length - outOfLevelTokens.length) / levelled.length).toFixed(4));

  const targets = new Set(input.targetLexemeIds);
  const targetHits = lexemeTokens.filter((t) => targets.has(t.lexemeId!)).length;
  const targetDensity = lexemeTokens.length === 0
    ? 0
    : Number((targetHits / lexemeTokens.length).toFixed(4));

  // Composite: level and length dominate; unknown tokens are the strongest
  // single signal that a sentence is out of reach.
  const levelPart = ((lexicalLevel ?? 1) - 1) / 8; // 0..1 across HSK 1–9
  const lengthPart = Math.min(characterCount, 30) / 30;
  const unknownPart = Math.min(unknownTokenCount, 5) / 5;
  const score = Number(
    Math.min(1, 0.5 * levelPart + 0.2 * lengthPart + 0.3 * unknownPart).toFixed(4),
  );

  return {
    lexicalLevel,
    lexemeCount: new Set(lexemeTokens.map((t) => t.lexemeId)).size,
    characterCount,
    unknownTokenCount,
    atOrBelowTargetRatio,
    outOfLevelTokens,
    targetDensity,
    score,
  };
}

/**
 * Quality filters for imported sentences (Tatoeba and similar).
 *
 * Returns the reasons a candidate should be rejected; an empty array means the
 * sentence is admissible on quality grounds. LICENCE admission is a separate
 * decision and is never implied by passing these filters.
 */
export interface SentenceCandidate {
  text: string;
  translation: string;
  language: string;
  tokens: SentenceToken[];
  targetLexemeIds: string[];
}

export type SentenceRejection =
  | "not_mandarin"
  | "too_short"
  | "too_long"
  | "no_translation"
  | "no_chinese_characters"
  | "target_lexeme_absent"
  | "excessive_unknown_vocabulary";

export function screenSentence(
  candidate: SentenceCandidate,
  opts: { minChars?: number; maxChars?: number; maxUnknown?: number } = {},
): SentenceRejection[] {
  const reasons: SentenceRejection[] = [];
  const minChars = opts.minChars ?? 2;
  const maxChars = opts.maxChars ?? 40;
  const maxUnknown = opts.maxUnknown ?? 3;

  if (!candidate.language.toLowerCase().startsWith("cmn") && !candidate.language.toLowerCase().startsWith("zh")) {
    reasons.push("not_mandarin");
  }
  const han = [...candidate.text].filter((c) => /[㐀-䶿一-鿿]/.test(c)).length;
  if (han === 0) reasons.push("no_chinese_characters");
  if (candidate.text.length < minChars) reasons.push("too_short");
  if (candidate.text.length > maxChars) reasons.push("too_long");
  if (candidate.translation.trim().length === 0) reasons.push("no_translation");

  if (candidate.targetLexemeIds.length > 0) {
    const present = new Set(candidate.tokens.filter((t) => t.lexemeId).map((t) => t.lexemeId!));
    if (!candidate.targetLexemeIds.some((id) => present.has(id))) reasons.push("target_lexeme_absent");
  }
  if (candidate.tokens.filter((t) => t.kind === "unknown").length > maxUnknown) {
    reasons.push("excessive_unknown_vocabulary");
  }
  return reasons;
}
