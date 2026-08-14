/**
 * Deterministic random number generator.
 *
 * Spec p.16 (FSRS Adapter Rules): "Use an injected clock and deterministic
 * randomness." Spec p.18 (Replay Test): the planner must return the same
 * tasks in the same order given the same seed. A global Math.random would
 * break replay, so all stochastic choices flow through this seeded PRNG.
 *
 * mulberry32 — tiny, fast, good enough for tie-breaking and jitter. It is a
 * scheduling aid, never a security primitive.
 */
export interface Rng {
  /** Next float in [0, 1). */
  next(): number;
  /** Integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (maxExclusive: number) => Math.floor(next() * maxExclusive),
  };
}
