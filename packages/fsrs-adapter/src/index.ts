/**
 * @dyr/fsrs-adapter — the ONLY package that owns FSRS memory-parameter maths.
 *
 * Spec p.14: "Use FSRS as an adapter, not as the whole brain." ts-fsrs owns
 * memory-parameter updates; the Dyr kernel owns evidence validity, trace
 * identity, constraints, progression and explanations.
 *
 * Spec p.16 (Adapter Rules):
 *   - Pin a stable ts-fsrs release in the lockfile.
 *   - Keep library types out of domain contracts.
 *   - Use an injected clock and deterministic randomness.
 *   - Store adapter version and configuration hash on updates.
 *   - Never copy demo equations from the observatory HTML.
 *
 * This file implements the published FSRS-4.5 default algorithm directly so
 * the kernel is provable offline with no network install. It is deliberately
 * shaped as a provider: swapping in the real `ts-fsrs` package means replacing
 * the body of `scheduleReview` with a call into the pinned library while
 * keeping this exact interface. The kernel depends only on `FsrsAdapter`.
 */
import type { Rating } from "@dyr/domain";
import { RATING_VALUE } from "@dyr/domain";

export type Millis = number;
const DAY = 86_400_000;

/** Opaque-to-the-kernel memory state for one skill direction. */
export interface MemoryState {
  stability: number;
  difficulty: number;
  state: "new" | "learning" | "review" | "relearning";
  lastReview?: Millis;
}

export interface ScheduleResult {
  stability: number;
  difficulty: number;
  state: "new" | "learning" | "review" | "relearning";
  due: Millis;
  /** Retrievability observed at the moment of this review (for the LearningFact). */
  retrievabilityAtReview: number;
}

export interface FsrsAdapter {
  readonly version: string;
  /** Pure: same inputs -> same output. No clock, no RNG inside. */
  scheduleReview(state: MemoryState, rating: Rating, now: Millis): ScheduleResult;
  /** Retrievability of a state at time `now`. */
  retrievability(state: MemoryState, now: Millis): number;
}

/**
 * Published FSRS-4.5 default weights (17 parameters). These are documented
 * defaults, not invented weights (spec p.16 Calibration). A real deployment
 * would optimise these against clean personal evidence and pin the result.
 */
export const FSRS_45_DEFAULT_WEIGHTS: readonly number[] = [
  0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05,
  0.34, 1.26, 0.29, 2.61,
];

const DECAY = -0.5;
const FACTOR = 19 / 81; // 0.9^(1/DECAY) - 1

const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, x));

export interface FsrsConfig {
  weights?: readonly number[];
  requestRetention?: number;
  /** Maximum scheduled interval in days. */
  maximumIntervalDays?: number;
  version?: string;
}

export function createFsrsAdapter(config: FsrsConfig = {}): FsrsAdapter {
  const w = config.weights ?? FSRS_45_DEFAULT_WEIGHTS;
  const requestRetention = config.requestRetention ?? 0.9;
  const maxInterval = config.maximumIntervalDays ?? 36500;
  const version = config.version ?? "dyr-fsrs-adapter@1.0.0";

  const initDifficulty = (g: number): number => clamp(w[4] - w[5] * (g - 3), 1, 10);
  const initStability = (g: number): number => Math.max(w[g - 1], 0.1);

  const retrievabilityFrom = (stability: number, elapsedDays: number): number => {
    if (stability <= 0) return 0;
    return Math.pow(1 + (FACTOR * elapsedDays) / stability, DECAY);
  };

  const nextIntervalDays = (stability: number): number => {
    const days = (stability / FACTOR) * (Math.pow(requestRetention, 1 / DECAY) - 1);
    return clamp(Math.round(days), 1, maxInterval);
  };

  const nextDifficulty = (d: number, g: number): number => {
    const damped = d - w[6] * (g - 3);
    const reverted = w[7] * initDifficulty(4) + (1 - w[7]) * damped;
    return clamp(reverted, 1, 10);
  };

  const stabilityAfterRecall = (
    d: number,
    s: number,
    r: number,
    g: number,
  ): number => {
    const hardPenalty = g === 2 ? w[15] : 1;
    const easyBonus = g === 4 ? w[16] : 1;
    const inc =
      Math.exp(w[8]) *
      (11 - d) *
      Math.pow(s, -w[9]) *
      (Math.exp(w[10] * (1 - r)) - 1) *
      hardPenalty *
      easyBonus;
    return s * (1 + inc);
  };

  const stabilityAfterLapse = (d: number, s: number, r: number): number => {
    const sf =
      w[11] *
      Math.pow(d, -w[12]) *
      (Math.pow(s + 1, w[13]) - 1) *
      Math.exp(w[14] * (1 - r));
    // A lapse must never increase stability.
    return Math.min(sf, s);
  };

  return {
    version,

    retrievability(state, now) {
      if (state.state === "new" || state.lastReview === undefined) return 0;
      const elapsedDays = (now - state.lastReview) / DAY;
      return retrievabilityFrom(state.stability, Math.max(0, elapsedDays));
    },

    scheduleReview(state, rating, now) {
      const g = RATING_VALUE[rating];
      let stability: number;
      let difficulty: number;
      let retrievabilityAtReview: number;

      if (state.state === "new" || state.lastReview === undefined) {
        // First review of this trace.
        stability = initStability(g);
        difficulty = initDifficulty(g);
        retrievabilityAtReview = 0;
      } else {
        const elapsedDays = Math.max(0, (now - state.lastReview) / DAY);
        const r = retrievabilityFrom(state.stability, elapsedDays);
        retrievabilityAtReview = r;
        difficulty = nextDifficulty(state.difficulty, g);
        stability =
          g === 1
            ? stabilityAfterLapse(state.difficulty, state.stability, r)
            : stabilityAfterRecall(state.difficulty, state.stability, r, g);
      }

      stability = Math.max(stability, 0.1);
      const nextState: MemoryState["state"] = g === 1 ? "relearning" : "review";
      const due = now + nextIntervalDays(stability) * DAY;

      return {
        stability,
        difficulty,
        state: nextState,
        due,
        retrievabilityAtReview,
      };
    },
  };
}
