/**
 * Content pack pipeline (spec p.7):
 *
 *   01 INGEST → 02 MANIFEST → 03 LICENSE GATE → 04 NORMALISE
 *   → 05 ASSET QA → 06 SIGN + VERSION → 07 RUNTIME
 *
 * Produces an immutable, sha256-signed, versioned RuntimePack. Released packs
 * never change in place: a correction mints a new pack version (spec p.15
 * VERSION RULE), because the content hash is derived from the normalised
 * content itself.
 */
import { createHash } from "node:crypto";
import {
  type Character,
  type Edge,
  type EdgeType,
  type GrammarAtom,
  type Lexeme,
  type LexemeId,
  type PackVersion,
  type Pronunciation,
  LexemeId as mkLexemeId,
  PackVersion as mkPackVersion,
} from "@dyr/domain";
import { licenceGate, type SourceAsset } from "./index.ts";
import { attributionReport } from "./index.ts";
import { type RuntimePack } from "./runtime.ts";
import { contentDigestInput } from "./validate.ts";
import { declareAudio, isCanonical, type AudioAsset } from "./audio.ts";
import { CORE60, CORE60_EDGES, type Core60Entry } from "./packs/core60.data.ts";

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export interface BuildReport {
  pack: RuntimePack;
  ingested: number;
  rejected: { id: string; stage: string; reason: string }[];
  /** Lexemes whose canonical audio is not yet provisioned. */
  audioPending: string[];
}

const PACK_ID = "dyr-core60";
const LICENCE = "CC0-1.0";
const AUTHOR = "Dyr Mandarin Lab";

/** 02 MANIFEST — one SourceAsset per ingested lexeme, with real provenance. */
function toManifestAsset(e: Core60Entry, retrievedAt: number, version: PackVersion): SourceAsset {
  const body = JSON.stringify([e.id, e.simplified, e.traditional, e.pinyin, e.senses, e.pos]);
  return {
    id: e.id,
    type: "lexeme",
    sourceName: "Dyr Core 60 (authored)",
    retrievedAt,
    immutableVersion: version,
    licenseSpdx: LICENCE,
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    author: AUTHOR,
    attributionText: `${AUTHOR} — Dyr Core 60 (CC0-1.0)`,
    redistributionAllowed: true,
    derivativeAllowed: true,
    sha256: sha256(body),
    languageTag: "zh-CN",
    region: "CN",
    qualityState: "verified",
  };
}

/** 04 NORMALISE — canonical NFC forms, trimmed glosses, stable ordering. */
function normalise(e: Core60Entry): Core60Entry {
  return {
    ...e,
    simplified: e.simplified.normalize("NFC"),
    traditional: e.traditional.normalize("NFC"),
    pinyin: e.pinyin.normalize("NFC").trim().replace(/\s+/g, " "),
    senses: e.senses.map((s) => s.trim()).filter((s) => s.length > 0),
  };
}

/** 05 ASSET QA — structural checks that must pass before signing. */
function assetQa(e: Core60Entry): string[] {
  const problems: string[] = [];
  if (!/^[a-z0-9]+\.[a-z]+\.\d{2}$/.test(e.id)) problems.push("malformed_id");
  if (e.simplified.length === 0) problems.push("empty_simplified");
  if (e.senses.length === 0) problems.push("no_sense");
  if (e.pinyin.length === 0) problems.push("no_pinyin");
  if (e.tones.length !== e.pinyin.split(" ").length) problems.push("tone_syllable_mismatch");
  if (e.frequency <= 0) problems.push("bad_frequency");
  return problems;
}

/**
 * Build the pack. Deterministic: the same input always yields the same content
 * hash and therefore the same pack version.
 */
export function buildCore60Pack(opts: { retrievedAt?: number } = {}): BuildReport {
  const retrievedAt = opts.retrievedAt ?? 0;
  const rejected: BuildReport["rejected"] = [];

  // 01 INGEST — deterministic order by id.
  const ingestedEntries = [...CORE60].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // 04 NORMALISE + 05 ASSET QA
  const normalised: Core60Entry[] = [];
  for (const raw of ingestedEntries) {
    const e = normalise(raw);
    const problems = assetQa(e);
    if (problems.length > 0) {
      for (const p of problems) rejected.push({ id: e.id, stage: "asset_qa", reason: p });
      continue;
    }
    normalised.push(e);
  }

  // 06 SIGN + VERSION — content hash over the normalised content.
  // The digest input is defined once in validate.ts and shared with the browser
  // verifier, so the two can never drift and disagree about the same pack.
  const contentHash = sha256(contentDigestInput(
    normalised.map((e) => ({
      id: e.id, simplified: e.simplified, traditional: e.traditional,
      pinyin: e.pinyin, senses: e.senses, pos: e.pos, frequency: e.frequency,
    })),
    new Map(normalised.map((e) => [e.id, e.tones as number[]])),
  ));
  const packVersion = mkPackVersion(`${PACK_ID}@1.0.0+${contentHash.slice(0, 12)}`);

  // 02 MANIFEST + 03 LICENSE GATE
  const manifest: SourceAsset[] = [];
  const admitted: Core60Entry[] = [];
  for (const e of normalised) {
    const asset = toManifestAsset(e, retrievedAt, packVersion);
    const decision = licenceGate(asset);
    if (!decision.allowed) {
      rejected.push({ id: e.id, stage: "licence_gate", reason: decision.reason });
      continue;
    }
    manifest.push(asset);
    admitted.push(e);
  }

  // 07 RUNTIME — build the runtime objects.
  const lexemes: Lexeme[] = [];
  const pronunciations: Pronunciation[] = [];
  const characters: Character[] = [];
  const audio = new Map<string, AudioAsset>();
  const seenChars = new Set<string>();

  for (const e of admitted) {
    const id = mkLexemeId(e.id);
    lexemes.push({
      id,
      simplified: e.simplified,
      traditional: e.traditional,
      pinyin: e.pinyin,
      senses: e.senses,
      pos: e.pos,
      frequency: e.frequency,
      packVersion,
      // Audio-primary listening needs a canonical recording; declared-but-not-
      // provisioned audio must NOT mark the lexeme as audio-ready.
      requiresHumanAudioFor: ["listening"],
    });
    pronunciations.push({
      id: `${e.id}.pron`,
      lexeme: id,
      syllable: e.pinyin,
      tone: e.tones[0],
      tones: e.tones,
      region: "zh-CN",
      sandhi: thirdToneSandhi(e.tones) ? "third-tone sandhi: 3+3 → 2+3" : undefined,
      audioAssetId: `audio:${e.id}`,
      packVersion,
    });
    for (const ch of e.simplified) {
      if (seenChars.has(ch)) continue;
      seenChars.add(ch);
      characters.push({
        id: `char:${ch}` as Character["id"],
        codepoint: `U+${ch.codePointAt(0)!.toString(16).toUpperCase()}`,
        strokes: 0, // stroke data is a separate licensed asset (Hanzi Writer)
        components: [],
        packVersion,
      });
    }
    audio.set(e.id, declareAudio(e.id, e.simplified));
  }

  const edges: Edge[] = CORE60_EDGES
    .filter((e) => admitted.some((a) => a.id === e.from) && admitted.some((a) => a.id === e.to))
    .map((e) => ({ type: e.type as EdgeType, from: e.from, to: e.to, weight: e.weight }));

  const grammarAtoms: GrammarAtom[] = [
    { id: "shi-copula", form: "是", function: "copula: A 是 B", prerequisites: [], contexts: ["identification"], examples: [], packVersion },
    { id: "bu-negation", form: "不", function: "negation before non-有 verbs", prerequisites: [], contexts: ["negation"], examples: [], packVersion },
    { id: "meiyou-negation", form: "没有", function: "negation of 有 / past experience", prerequisites: ["bu-negation"], contexts: ["negation"], examples: [], packVersion },
  ];

  const pack: RuntimePack = {
    packId: PACK_ID,
    packVersion,
    contentHash,
    lexemes,
    characters,
    pronunciations,
    grammarAtoms,
    edges,
    audio,
    manifest,
    attributions: attributionReport(manifest),
  };

  return {
    pack,
    ingested: ingestedEntries.length,
    rejected,
    audioPending: [...audio.values()].filter((a) => !isCanonical(a)).map((a) => a.lexeme),
  };
}

/** 3+3 tone sandhi is the classic Mandarin contextual rule (spec p.10). */
function thirdToneSandhi(tones: number[]): boolean {
  return tones.length >= 2 && tones[0] === 3 && tones[1] === 3;
}

