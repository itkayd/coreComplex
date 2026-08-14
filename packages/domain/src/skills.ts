/**
 * The four permanent skill channels and the FSRS rating vocabulary.
 *
 * Spec Rule 1 (p.2): "Listening, reading, speaking and writing never share one
 * mastery value." Spec p.21 assigns each channel a permanent colour, but the
 * kernel is headless — colour lives in the layers, never here.
 */

export const SKILLS = ["listening", "reading", "speaking", "writing"] as const;
export type Skill = (typeof SKILLS)[number];

/** Production skills carry a higher evidential bar than recognition skills. */
export const PRODUCTION_SKILLS: readonly Skill[] = ["speaking", "writing"];
export const RECEPTIVE_SKILLS: readonly Skill[] = ["listening", "reading"];

export function isProduction(skill: Skill): boolean {
  return PRODUCTION_SKILLS.includes(skill);
}

/**
 * FSRS rating semantics, verbatim from spec p.17:
 *   Again — failed direct retrieval.
 *   Hard  — correct with meaningful struggle or support.
 *   Good  — correct direct retrieval in expected time.
 *   Easy  — unusually fluent direct retrieval, used sparingly.
 */
export const RATINGS = ["again", "hard", "good", "easy"] as const;
export type Rating = (typeof RATINGS)[number];

export const RATING_VALUE: Record<Rating, 1 | 2 | 3 | 4> = {
  again: 1,
  hard: 2,
  good: 3,
  easy: 4,
};
