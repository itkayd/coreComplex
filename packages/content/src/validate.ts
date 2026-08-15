/**
 * Pack validation: structure + cryptographic integrity.
 *
 *   "Never trust a content pack merely because TypeScript compiled."
 *
 * A pack arrives over the network as JSON. TypeScript types are erased at
 * runtime, so nothing about a fetched pack is guaranteed until it is checked.
 * Two independent checks, in order:
 *
 *   1. STRUCTURE — is this shaped like a pack at all? Reports the exact path of
 *      the first problem, so a bad pack is diagnosable rather than a stack trace.
 *   2. INTEGRITY — does the content still hash to the value the pack claims?
 *      This is the real guarantee: it detects truncation, tampering and
 *      accidental edits, and it is why a pack version can be trusted to mean one
 *      exact set of bytes.
 *
 * The digest INPUT is defined here and shared by the Node build pipeline and the
 * browser, so the two can never drift apart and disagree about the same pack.
 */
import type { ExportedPack } from "./export.ts";

export interface ValidationIssue {
  /** JSON-ish path to the offending value, e.g. `lexemes[3].pinyin`. */
  path: string;
  message: string;
}

export type ValidationResult =
  | { valid: true; pack: ExportedPack }
  | { valid: false; issues: ValidationIssue[] };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function requireString(value: unknown, path: string, issues: ValidationIssue[]): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    issues.push({ path, message: "expected a non-empty string" });
    return undefined;
  }
  return value;
}

function requireArray(value: unknown, path: string, issues: ValidationIssue[]): unknown[] | undefined {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "expected an array" });
    return undefined;
  }
  return value;
}

/**
 * Structural validation of a fetched pack.
 *
 * Deliberately hand-written rather than schema-library-generated: the shape is
 * small and stable, the error paths are better than a generic issue list, and it
 * adds no runtime dependency to a package the browser loads. If Dyr ever accepts
 * third-party packs with evolving schemas, a schema library becomes the right
 * call — see docs/THIRD_PARTY_DEPENDENCIES.md.
 */
export function validatePackStructure(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) {
    return { valid: false, issues: [{ path: "$", message: "pack must be an object" }] };
  }

  requireString(input.packId, "packId", issues);
  requireString(input.packVersion, "packVersion", issues);
  const contentHash = requireString(input.contentHash, "contentHash", issues);
  if (contentHash !== undefined && !/^[a-f0-9]{64}$/.test(contentHash)) {
    issues.push({ path: "contentHash", message: "expected a 64-character sha256 hex digest" });
  }

  const lexemes = requireArray(input.lexemes, "lexemes", issues);
  if (lexemes) {
    if (lexemes.length === 0) issues.push({ path: "lexemes", message: "pack contains no lexemes" });
    lexemes.forEach((entry, index) => {
      const at = `lexemes[${index}]`;
      if (!isRecord(entry)) { issues.push({ path: at, message: "expected an object" }); return; }
      requireString(entry.id, `${at}.id`, issues);
      requireString(entry.simplified, `${at}.simplified`, issues);
      requireString(entry.pinyin, `${at}.pinyin`, issues);
      requireString(entry.packVersion, `${at}.packVersion`, issues);
      const senses = requireArray(entry.senses, `${at}.senses`, issues);
      if (senses && senses.length === 0) issues.push({ path: `${at}.senses`, message: "lexeme has no sense" });
      if (typeof entry.frequency !== "number" || !Number.isFinite(entry.frequency)) {
        issues.push({ path: `${at}.frequency`, message: "expected a finite number" });
      }
    });
  }

  for (const key of ["characters", "pronunciations", "grammarAtoms", "edges", "audio", "manifest", "attributions"]) {
    requireArray((input as Record<string, unknown>)[key], key, issues);
  }

  // Every lexeme must belong to the pack version the manifest declares, or the
  // pack is internally inconsistent and its version means nothing.
  if (lexemes && typeof input.packVersion === "string") {
    lexemes.forEach((entry, index) => {
      if (isRecord(entry) && typeof entry.packVersion === "string" && entry.packVersion !== input.packVersion) {
        issues.push({
          path: `lexemes[${index}].packVersion`,
          message: `belongs to ${entry.packVersion}, pack declares ${String(input.packVersion)}`,
        });
      }
    });
  }

  return issues.length === 0
    ? { valid: true, pack: input as unknown as ExportedPack }
    : { valid: false, issues };
}

/**
 * The exact byte-string the content hash is taken over.
 *
 * Shared by the Node build and the browser verifier. Changing this changes every
 * pack version, which is correct: it IS the definition of pack identity.
 *
 * Canonical audio is part of that identity. Hashing the lexical JSON alone would
 * let a pack keep its version while its recordings were swapped — the JSON hash
 * would verify and the learner would hear different audio. Including each
 * canonical recording's runtime hash means replacing a recording necessarily
 * mints a new pack version, which is what immutability is supposed to mean.
 *
 * Only VERIFIED recordings contribute. A declared-but-unprovisioned slot has no
 * bytes to hash, so a pack that gains its first real recording changes identity
 * exactly once, when the recording arrives.
 */
export function contentDigestInput(
  lexemes: { id: string; simplified: string; traditional?: string; pinyin: string; senses: string[]; pos: string; frequency: number }[],
  tones: Map<string, number[]>,
  canonicalAudio: { lexeme: string; sha256: string }[] = [],
): string {
  return JSON.stringify([
    lexemes.map((l) => [
      l.id, l.simplified, l.traditional ?? "", l.pinyin,
      tones.get(l.id) ?? [], l.senses, l.pos, l.frequency,
    ]),
    [...canonicalAudio]
      .map((a) => [a.lexeme, a.sha256.toLowerCase()] as const)
      .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)),
  ]);
}

/**
 * The audio rows that participate in pack identity: verified, non-synthetic,
 * with runtime bytes. Defined once so build and browser agree exactly.
 */
export function canonicalAudioDigestRows(
  audio: { lexeme: string; state?: string; synthetic?: boolean; runtime?: { sha256: string } }[],
): { lexeme: string; sha256: string }[] {
  return audio
    .filter((a) => a.state === "verified" && a.synthetic !== true && a.runtime?.sha256)
    .map((a) => ({ lexeme: a.lexeme, sha256: a.runtime!.sha256 }));
}

export type Sha256 = (input: string) => Promise<string>;

/** Web Crypto digest — available in browsers and in Node ≥ 18. */
export const webCryptoSha256: Sha256 = async (input: string): Promise<string> => {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * Web Crypto digest over raw bytes — how runtime audio is verified before it is
 * played. The text digest above cannot be reused: audio is not UTF-8.
 */
export async function webCryptoSha256Bytes(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface IntegrityResult {
  ok: boolean;
  expected: string;
  actual: string;
}

/**
 * Verify a pack's declared content hash against its actual content.
 *
 * A mismatch means the pack was truncated, edited or swapped — the loader must
 * refuse it rather than teach from content of unknown provenance.
 */
export async function verifyPackIntegrity(pack: ExportedPack, sha256: Sha256 = webCryptoSha256): Promise<IntegrityResult> {
  // Tones are part of pack identity; recover the full per-syllable sequence
  // from the pronunciation nodes (a single `tone` cannot describe 银行).
  const tones = new Map<string, number[]>();
  for (const pronunciation of pack.pronunciations) {
    tones.set(String(pronunciation.lexeme), pronunciation.tones ?? [pronunciation.tone]);
  }
  const actual = await sha256(contentDigestInput(
    pack.lexemes as never,
    tones,
    canonicalAudioDigestRows(pack.audio ?? []),
  ));
  return { ok: actual === pack.contentHash, expected: pack.contentHash, actual };
}

export class PackRejected extends Error {
  readonly reason: "structure" | "integrity";
  readonly issues: ValidationIssue[];
  constructor(reason: "structure" | "integrity", message: string, issues: ValidationIssue[] = []) {
    super(message);
    this.name = "PackRejected";
    this.reason = reason;
    this.issues = issues;
  }
}

/** Validate then verify. Throws `PackRejected` with a diagnosable reason. */
export async function loadVerifiedPack(input: unknown, sha256: Sha256 = webCryptoSha256): Promise<ExportedPack> {
  const structure = validatePackStructure(input);
  if (!structure.valid) {
    const first = structure.issues[0];
    throw new PackRejected("structure", `invalid content pack at ${first.path}: ${first.message}`, structure.issues);
  }
  const integrity = await verifyPackIntegrity(structure.pack, sha256);
  if (!integrity.ok) {
    throw new PackRejected(
      "integrity",
      `content pack failed integrity check: expected ${integrity.expected.slice(0, 12)}…, got ${integrity.actual.slice(0, 12)}…`,
    );
  }
  return structure.pack;
}
