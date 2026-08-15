/**
 * Pack export (spec p.7 stage 07 RUNTIME, p.15 VERSION RULE).
 *
 * A released pack is an immutable, signed artefact built OFFLINE and shipped to
 * the runtime. The runtime never re-runs the build pipeline — which is also why
 * the browser never needs node:crypto: it loads a finished, versioned artefact.
 */
import type { RuntimePack } from "./pipeline.ts";
import type { AudioAsset } from "./audio.ts";

/** The serialisable form of a built pack. */
export interface ExportedPack {
  packId: string;
  packVersion: string;
  contentHash: string;
  builtWith: { pipeline: string };
  lexemes: RuntimePack["lexemes"];
  characters: RuntimePack["characters"];
  pronunciations: RuntimePack["pronunciations"];
  grammarAtoms: RuntimePack["grammarAtoms"];
  edges: RuntimePack["edges"];
  audio: AudioAsset[];
  manifest: RuntimePack["manifest"];
  attributions: RuntimePack["attributions"];
}

export const PIPELINE_VERSION = "dyr-content-pipeline@1.0.0";

export function exportPack(pack: RuntimePack): ExportedPack {
  return {
    packId: pack.packId,
    packVersion: String(pack.packVersion),
    contentHash: pack.contentHash,
    builtWith: { pipeline: PIPELINE_VERSION },
    lexemes: pack.lexemes,
    characters: pack.characters,
    pronunciations: pack.pronunciations,
    grammarAtoms: pack.grammarAtoms,
    edges: pack.edges,
    // Map -> sorted array so the artefact is byte-stable.
    audio: [...pack.audio.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    manifest: pack.manifest,
    attributions: pack.attributions,
  };
}

/** Rehydrate an exported artefact into the runtime shape the kernel consumes. */
export function importPack(exported: ExportedPack): RuntimePack {
  return {
    packId: exported.packId,
    packVersion: exported.packVersion as RuntimePack["packVersion"],
    contentHash: exported.contentHash,
    lexemes: exported.lexemes,
    characters: exported.characters,
    pronunciations: exported.pronunciations,
    grammarAtoms: exported.grammarAtoms,
    edges: exported.edges,
    audio: new Map(exported.audio.map((a) => [a.lexeme, a])),
    manifest: exported.manifest,
    attributions: exported.attributions,
  };
}

/** Deterministic JSON for the artefact (stable key order via explicit shape). */
export function serialisePack(pack: RuntimePack): string {
  return JSON.stringify(exportPack(pack), null, 2);
}
