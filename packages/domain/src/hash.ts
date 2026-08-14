/**
 * Deterministic, dependency-free hashing.
 *
 * The kernel must satisfy the replay contract (spec p.5, p.18):
 *   "Same events + same configuration + same clock = identical state,
 *    identical plan and identical explanation frame."
 *
 * That forbids any non-deterministic hash (no Math.random, no Date, no
 * platform crypto with per-run salts). FNV-1a over a canonical JSON encoding
 * is stable across machines and runs, which is all the kernel needs for
 * configurationHash, payloadHash and seed derivation.
 */

/** FNV-1a 32-bit over a UTF-8 string, returned as 8 lowercase hex chars. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i) & 0xff;
    // Handle code units above 0xff by folding the high byte in too.
    const hi = input.charCodeAt(i) >> 8;
    if (hi) h ^= hi;
    h = Math.imul(h, 0x01000193);
  }
  // >>> 0 keeps it an unsigned 32-bit value.
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Canonical JSON: object keys sorted recursively so that logically-equal
 * values always serialise identically. Used for hashing configuration and
 * event payloads.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = sortValue(obj[key]);
  }
  return out;
}

/** Deterministic hash of any JSON-serialisable value. */
export function hashValue(value: unknown): string {
  return fnv1a(canonicalJson(value));
}

/**
 * Derive a stable 32-bit seed from any set of stable inputs (e.g.
 * learnerId + configurationHash + localSequence). Used to make the planner's
 * tie-breaking deterministic without a wall-clock or global RNG.
 */
export function deriveSeed(...parts: Array<string | number>): number {
  return parseInt(fnv1a(parts.join("|")), 16) >>> 0;
}
