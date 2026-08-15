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
import { canonicalAudioDigestRows, contentDigestInput } from "./validate.ts";
import { declareAudio, isCanonical, type AudioAsset } from "./audio.ts";
import type { CanonicalAudio } from "./sources/certify.ts";
import { CORE60, CORE60_EDGES, type Core60Entry } from "./packs/core60.data.ts";
import {
  HSK1, HSK1_ATTRIBUTION, HSK1_LICENCE, HSK1_LICENCE_URL, HSK1_RIGHTS_GRANT, HSK1_SOURCE_NAME,
} from "./packs/hsk1.data.ts";

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export interface BuildReport {
  pack: RuntimePack;
  ingested: number;
  rejected: { id: string; stage: string; reason: string }[];
  /** Lexemes whose canonical audio is not yet provisioned. */
  audioPending: string[];
  /** Runtime audio files the artefact references and the writer must emit. */
  audioFiles: { path: string; absolutePath: string; sha256: string; bytes: number }[];
}

export interface BuildOptions {
  retrievedAt?: number;
  /**
   * Certified canonical recordings to compile into this release.
   *
   * An EXPLICIT input on purpose. The build never searches the filesystem for
   * audio: what ships is exactly what a caller passed, which is what makes the
   * result reproducible and reviewable. Supplying a different set produces a
   * different content hash and therefore a new pack version — an already-released
   * pack is never mutated in place (spec p.15 VERSION RULE).
   */
  canonicalAudio?: CanonicalAudio[];
  /**
   * Permit fixture recordings into the pack. Only the fixture builder sets this;
   * production builds refuse flagged assets so a test recording can never be
   * mistaken for human canonical audio.
   */
  allowFixtureAudio?: boolean;
}

/** Thrown when a build is asked to ship audio it must not ship. */
export class AudioRefused extends Error {
  readonly lexeme: string;
  constructor(lexeme: string, message: string) {
    super(message);
    this.name = "AudioRefused";
    this.lexeme = lexeme;
  }
}

const PACK_ID = "dyr-core60";
const LICENCE = "CC0-1.0";
const AUTHOR = "Dyr Mandarin Lab";

/**
 * The pack holds two differently-licensed sets, and says so per asset.
 *
 * The Core 60 was authored here and is CC0. The HSK 1 expansion carries
 * CC-CEDICT definitions, which are CC BY-SA — share-alike is a real obligation
 * and aggregation does not launder it. Folding them into one licence would make
 * the attribution output false, so provenance is decided per entry.
 */
const HSK1_IDS = new Set(HSK1.map((e) => e.id));

interface Provenance {
  licenceSpdx: string;
  licenceUrl: string;
  sourceName: string;
  author: string;
  attribution: string;
  rightsGrant?: SourceAsset["rightsGrant"];
}

function provenanceFor(id: string): Provenance {
  return HSK1_IDS.has(id)
    ? {
        licenceSpdx: HSK1_LICENCE,
        licenceUrl: HSK1_LICENCE_URL,
        sourceName: HSK1_SOURCE_NAME,
        author: "CC-CEDICT contributors",
        attribution: HSK1_ATTRIBUTION,
        rightsGrant: { ...HSK1_RIGHTS_GRANT },
      }
    : {
        licenceSpdx: LICENCE,
        licenceUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
        sourceName: "Dyr Core 60 (authored)",
        author: AUTHOR,
        attribution: `${AUTHOR} — Dyr Core 60 (CC0-1.0)`,
      };
}

/** 02 MANIFEST — one SourceAsset per ingested lexeme, with real provenance. */
function toManifestAsset(e: Core60Entry, retrievedAt: number, version: PackVersion): SourceAsset {
  const body = JSON.stringify([e.id, e.simplified, e.traditional, e.pinyin, e.senses, e.pos]);
  const p = provenanceFor(e.id);
  return {
    id: e.id,
    type: "lexeme",
    sourceName: p.sourceName,
    retrievedAt,
    immutableVersion: version,
    licenseSpdx: p.licenceSpdx,
    licenseUrl: p.licenceUrl,
    author: p.author,
    attributionText: p.attribution,
    rightsGrant: p.rightsGrant,
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
export function buildCore60Pack(opts: BuildOptions = {}): BuildReport {
  const retrievedAt = opts.retrievedAt ?? 0;
  const rejected: BuildReport["rejected"] = [];

  // 05b AUDIO ADMISSION — refuse anything that must never reach a release,
  // before it can influence the content hash.
  const canonicalById = new Map<string, CanonicalAudio>();
  for (const entry of opts.canonicalAudio ?? []) {
    const { asset } = entry;
    if (asset.synthetic) {
      throw new AudioRefused(asset.lexeme, `synthetic audio can never be canonical (${asset.lexeme})`);
    }
    if (asset.state !== "verified") {
      throw new AudioRefused(asset.lexeme, `audio for ${asset.lexeme} is ${asset.state}, not verified`);
    }
    if (!asset.runtime?.sha256) {
      throw new AudioRefused(asset.lexeme, `audio for ${asset.lexeme} has no runtime bytes`);
    }
    if (asset.provenance?.fixture && !opts.allowFixtureAudio) {
      throw new AudioRefused(asset.lexeme, `fixture audio for ${asset.lexeme} may not enter a production pack`);
    }
    if (canonicalById.has(asset.lexeme)) {
      throw new AudioRefused(asset.lexeme, `two canonical recordings supplied for ${asset.lexeme}`);
    }
    canonicalById.set(asset.lexeme, entry);
  }

  // 01 INGEST — deterministic order by id.
  const ingestedEntries = [...CORE60, ...HSK1].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

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
  // Canonical audio is part of pack identity: swapping a recording must mint a
  // new version rather than leaving a verifying hash over stale metadata.
  const audioRows = canonicalAudioDigestRows(
    normalised.map((e) => canonicalById.get(e.id)?.asset).filter((a) => a !== undefined),
  );
  const contentHash = sha256(contentDigestInput(
    normalised.map((e) => ({
      id: e.id, simplified: e.simplified, traditional: e.traditional,
      pinyin: e.pinyin, senses: e.senses, pos: e.pos, frequency: e.frequency,
    })),
    new Map(normalised.map((e) => [e.id, e.tones as number[]])),
    audioRows,
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
    // A certified recording replaces the declared placeholder; without one the
    // slot stays `declared` and the kernel's asset gate keeps refusing
    // audio-primary tasks for this lexeme. That refusal is the correct
    // behaviour, not a gap to paper over.
    const certified = canonicalById.get(e.id);
    audio.set(e.id, certified ? certified.asset : declareAudio(e.id, e.simplified));
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

  // The bytes the artefact references. Emitted by the writer alongside the JSON;
  // deduplicated by hash, because two lexemes may legitimately share a recording.
  const audioFiles = new Map<string, BuildReport["audioFiles"][number]>();
  for (const e of admitted) {
    const certified = canonicalById.get(e.id);
    if (!certified?.asset.runtime) continue;
    const { path, sha256: hash, bytes } = certified.asset.runtime;
    audioFiles.set(path, { path, absolutePath: certified.absolutePath, sha256: hash, bytes });
  }

  return {
    pack,
    ingested: ingestedEntries.length,
    rejected,
    audioPending: [...audio.values()].filter((a) => !isCanonical(a)).map((a) => a.lexeme),
    audioFiles: [...audioFiles.values()].sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
}

/** 3+3 tone sandhi is the classic Mandarin contextual rule (spec p.10). */
function thirdToneSandhi(tones: number[]): boolean {
  return tones.length >= 2 && tones[0] === 3 && tones[1] === 3;
}

