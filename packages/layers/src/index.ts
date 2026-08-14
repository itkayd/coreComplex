/**
 * @dyr/layers — optional game/profile/world projections (spec p.18, p.20).
 *
 *   "A living Mandarin city that reflects learning, never controls it."
 *
 * Rule 4 (One-way layers) + ONE-WAY FACTS (p.3): layers read immutable
 * LearningFacts. No point, streak or cosmetic can set memory state. This
 * package therefore imports only the read-only LearningFact contract from
 * @dyr/domain and NEVER the kernel, its stores or the FSRS adapter
 * (Dependency CI, p.23). It exposes no way to mutate a trace.
 *
 * REMOVAL TEST (p.20): "Delete game.db and disable every layer flag. The next
 * plain session, trace state and replay digest must remain identical." Because
 * a projection is a pure function of published facts, deleting it changes
 * nothing in the kernel — which the layers test asserts directly.
 */
import type { LearningFact, Skill } from "@dyr/domain";

/** Cosmetic districts of the living city, one per skill channel (spec p.20). */
export interface CityState {
  soundscape: number; // listening makes it audible
  signage: number; // reading makes it legible
  people: number; // speaking makes it responsive
  archive: number; // writing makes it persistent
  /** Points awarded ONLY for completed direct retrieval, never passive exposure. */
  points: number;
}

const DISTRICT: Record<Skill, keyof Omit<CityState, "points">> = {
  listening: "soundscape",
  reading: "signage",
  speaking: "people",
  writing: "archive",
};

export const EMPTY_CITY: CityState = {
  soundscape: 0,
  signage: 0,
  people: 0,
  archive: 0,
  points: 0,
};

/**
 * Fold published LearningFacts into a city read-model. Pure and idempotent:
 * the same facts always yield the same city, and it can be discarded and
 * rebuilt at any time (removable projection).
 *
 * ALLOWED PROJECTIONS (p.20): cosmetic restoration + points for completed
 * direct retrieval. A passing, high-retrievability fact restores its district
 * and earns a point; a lapse (again) restores nothing.
 */
export function projectCity(facts: readonly LearningFact[]): CityState {
  const city: CityState = { ...EMPTY_CITY };
  for (const fact of facts) {
    if (fact.ratingApplied === "again") continue; // no reward for a lapse
    const district = DISTRICT[fact.skill];
    city[district] += 1;
    city.points += fact.ratingApplied === "easy" ? 2 : 1;
  }
  return city;
}
