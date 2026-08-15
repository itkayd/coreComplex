/**
 * CC-CEDICT importer (CC BY-SA 4.0).
 *
 * Canonical line format of `cedict_ts.u8`:
 *
 *   銀行 银行 [yin2 hang2] /bank/CL:家[jia1],個|个[ge4]/
 *   traditional simplified [numbered pinyin] /sense/sense/
 *
 * Deterministic by construction: parsing is pure, output is sorted, and the
 * source hash + version travel with every record so the same dump always
 * compiles to the same pack.
 *
 * The dictionary is AUTHORITATIVE for pronunciation and meaning (spec: do not
 * let a generator overwrite source pronunciation, and do not have an LLM invent
 * definitions when CC-CEDICT has an entry). Both the original numbered form and
 * the derived tone-marked form are kept; nothing is discarded.
 */
import { normalisePinyin } from "./pinyin.ts";

export interface CedictEntry {
  traditional: string;
  simplified: string;
  /** Exactly as written in the dump, e.g. "yin2 hang2". Never rewritten. */
  pinyinNumbered: string;
  /** Derived, tone-marked: "yín háng". */
  pinyinMarked: string;
  /** Distinct senses, in source order. Never collapsed into one string. */
  definitions: string[];
  /** Cross-reference targets from CL:/see also entries, kept as metadata. */
  classifiers: string[];
  /** 1-based line number in the source dump, for traceability. */
  sourceLine: number;
}

export interface CedictParseReport {
  entries: CedictEntry[];
  /** Lines that were not valid entries, with the reason. */
  rejected: { line: number; text: string; reason: string }[];
  /** Comment/header lines describing the dump version. */
  headers: string[];
  /** Version string parsed from the header, when present. */
  sourceVersion?: string;
}

const ENTRY = /^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+\/(.*)\/\s*$/;

/**
 * Parse a CC-CEDICT dump. Malformed lines are rejected with a reason rather
 * than silently dropped — an importer that hides its losses cannot be audited.
 */
export function parseCedict(text: string): CedictParseReport {
  const entries: CedictEntry[] = [];
  const rejected: CedictParseReport["rejected"] = [];
  const headers: string[] = [];
  let sourceVersion: string | undefined;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const number = i + 1;
    if (line.trim().length === 0) continue;

    if (line.startsWith("#")) {
      headers.push(line);
      // The dump carries "#! version=1" / "#! date=..." metadata lines.
      const version = /#!\s*version=(\S+)/.exec(line);
      if (version) sourceVersion = version[1];
      continue;
    }

    const match = ENTRY.exec(line);
    if (!match) {
      rejected.push({ line: number, text: line, reason: "malformed_entry" });
      continue;
    }

    const [, traditional, simplified, pinyinNumbered, body] = match;
    const senses = body.split("/").map((s) => s.trim()).filter((s) => s.length > 0);
    if (senses.length === 0) {
      rejected.push({ line: number, text: line, reason: "no_definition" });
      continue;
    }

    // Classifier / cross-reference senses are metadata, not meanings.
    const definitions: string[] = [];
    const classifiers: string[] = [];
    for (const sense of senses) {
      if (sense.startsWith("CL:")) classifiers.push(sense.slice(3));
      else definitions.push(sense);
    }
    if (definitions.length === 0) {
      rejected.push({ line: number, text: line, reason: "only_metadata_senses" });
      continue;
    }

    let pinyinMarked: string;
    try {
      pinyinMarked = normalisePinyin(pinyinNumbered).marked;
    } catch {
      rejected.push({ line: number, text: line, reason: "unparseable_pinyin" });
      continue;
    }

    entries.push({
      traditional,
      simplified,
      pinyinNumbered, // original form preserved verbatim
      pinyinMarked,
      definitions,
      classifiers,
      sourceLine: number,
    });
  }

  return { entries, rejected, headers, sourceVersion };
}

/**
 * Index a parsed dump by simplified form. A headword can have several entries
 * (different pronunciations/senses); all are kept, since collapsing distinct
 * senses would destroy information the graph can represent.
 */
export function indexBySimplified(entries: CedictEntry[]): Map<string, CedictEntry[]> {
  const index = new Map<string, CedictEntry[]>();
  for (const entry of entries) {
    const list = index.get(entry.simplified) ?? [];
    list.push(entry);
    index.set(entry.simplified, list);
  }
  // Deterministic order within each headword.
  for (const list of index.values()) list.sort((a, b) => a.sourceLine - b.sourceLine);
  return index;
}

/**
 * Choose the entry that matches a known pronunciation, falling back to the
 * first. Used when enriching a Dyr lexeme that already knows how it is said —
 * the pack's own pronunciation stays authoritative for disambiguation.
 */
export function selectEntry(candidates: CedictEntry[], pinyinNumbered?: string): CedictEntry | undefined {
  if (candidates.length === 0) return undefined;
  if (!pinyinNumbered) return candidates[0];
  const target = pinyinNumbered.toLowerCase().replace(/\s+/g, " ").trim();
  return candidates.find((c) => c.pinyinNumbered.toLowerCase().trim() === target) ?? candidates[0];
}

/** Official download (blocked in some sandboxes; documented for reproducibility). */
export const CEDICT_SOURCE = {
  name: "CC-CEDICT",
  url: "https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz",
  homepage: "https://www.mdbg.net/chinese/dictionary?page=cc-cedict",
  licenseSpdx: "CC-BY-SA-4.0",
  licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  attributionText: "CC-CEDICT, by MDBG, licensed CC BY-SA 4.0",
} as const;
