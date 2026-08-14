/**
 * Injected clock.
 *
 * Spec p.16 (Adapter Rules): "Use an injected clock and deterministic
 * randomness." Spec p.5 (Replay Contract): identical state requires the *same
 * clock*. The kernel therefore never calls Date.now() directly; it reads time
 * only through a Clock, so a replay can feed the exact recorded timestamps
 * back in and reproduce state byte-for-byte.
 *
 * Time is milliseconds since the Unix epoch (UTC). Durations are milliseconds.
 */
export type Millis = number;

export interface Clock {
  now(): Millis;
}

/** A clock that only ever moves when told to — the substrate of replay. */
export class ManualClock implements Clock {
  private t: Millis;
  constructor(startIso: string | Millis) {
    this.t = typeof startIso === "number" ? startIso : Date.parse(startIso);
  }
  now(): Millis {
    return this.t;
  }
  set(iso: string | Millis): void {
    this.t = typeof iso === "number" ? iso : Date.parse(iso);
  }
  advance(ms: Millis): void {
    this.t += ms;
  }
  advanceMinutes(m: number): void {
    this.advance(m * 60_000);
  }
  advanceDays(d: number): void {
    this.advance(d * 86_400_000);
  }
}

/** Wraps the system clock. Used in production surfaces, never in tests. */
export class SystemClock implements Clock {
  now(): Millis {
    return Date.now();
  }
}

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
