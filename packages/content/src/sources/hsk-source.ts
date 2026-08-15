/**
 * HSK level source ADAPTER — a contract, deliberately with no bundled data.
 *
 * The binding specification does not make HSK metadata a Stage 2 requirement:
 * PLAIN-SLICE DONE (p.28) asks for "60 licensed lexemes with clear human audio",
 * and the same page instructs "Keep HSK reporting separate". Spec p.9 is
 * blunter still — HSK "never decides readiness, schedules a review or turns a
 * four-dimensional profile into one level."
 *
 * So: `hskLevel = undefined` is a permanently valid state, Dyr teaches Mandarin
 * without it, and no approved source is bundled until one passes the licence
 * gate. This contract is the seam a licensed dataset plugs into later without
 * touching the content compiler.
 */
import type { HskLevel, PublishedBand } from "../import/hsk.ts";
import type { SourceManifest } from "./manifest.ts";

export interface HskLevelEntry {
  /** Surface form as published by the source. */
  simplified: string;
  traditional?: string;
  /** Pronunciation, when the source distinguishes homographs. */
  pinyinNumbered?: string;
  /** Exactly as the source published it — "7-9" stays "7-9". */
  publishedBand: PublishedBand;
}

export interface HskLevelSource {
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly licence: string;
  readonly provenance: SourceManifest;
  entries(): Iterable<HskLevelEntry>;
}

/** Resolved mapping the compiler consumes: Dyr lexeme id → level. */
export interface HskMapping {
  sourceId: string;
  sourceVersion: string;
  licence: string;
  byLexemeId: Map<string, { level: HskLevel; publishedBand: PublishedBand }>;
  /** Source entries that matched no lexeme in the pack. */
  unmatched: string[];
}

/**
 * Resolve a source's surface forms onto Dyr lexeme ids.
 *
 * Matching is by surface form because that is all an HSK list publishes; the
 * lexeme id remains Dyr's permanent identity, never the Chinese text.
 */
export function resolveHskMapping(
  source: HskLevelSource,
  lexemes: { id: string; simplified: string; traditional?: string }[],
): HskMapping {
  const bySurface = new Map<string, string>();
  for (const lexeme of lexemes) {
    bySurface.set(lexeme.simplified.normalize("NFC"), lexeme.id);
    if (lexeme.traditional) bySurface.set(lexeme.traditional.normalize("NFC"), lexeme.id);
  }

  const byLexemeId = new Map<string, { level: HskLevel; publishedBand: PublishedBand }>();
  const unmatched: string[] = [];
  for (const entry of source.entries()) {
    const id = bySurface.get(entry.simplified.normalize("NFC"))
      ?? (entry.traditional ? bySurface.get(entry.traditional.normalize("NFC")) : undefined);
    if (!id) { unmatched.push(entry.simplified); continue; }
    const level = (entry.publishedBand === "7-9" ? 7 : Number(entry.publishedBand)) as HskLevel;
    // First source wins for a lexeme; sources are not silently merged.
    if (!byLexemeId.has(id)) byLexemeId.set(id, { level, publishedBand: entry.publishedBand });
  }

  return {
    sourceId: source.sourceId,
    sourceVersion: source.sourceVersion,
    licence: source.licence,
    byLexemeId,
    unmatched: unmatched.sort(),
  };
}

/** No installed source: every lexeme's level is legitimately undefined. */
export function noHskMapping(): HskMapping {
  return {
    sourceId: "none",
    sourceVersion: "0",
    licence: "n/a",
    byLexemeId: new Map(),
    unmatched: [],
  };
}
