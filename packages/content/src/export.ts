/**
 * Pack export (spec p.7 stage 07 RUNTIME, p.15 VERSION RULE).
 *
 * A released pack is an immutable, signed artefact built OFFLINE and shipped to
 * the runtime. The runtime never re-runs the build pipeline — which is also why
 * the browser never needs node:crypto: it loads a finished, versioned artefact.
 *
 * PROVENANCE IS INTERNED, NOT DROPPED.
 *
 * Every asset genuinely carries provenance (spec p.20), and that requirement is
 * about the DATA, not about how many times the same sentence is repeated in a
 * file. Profiling a 2,000-word pack showed 73% of the bytes were identical
 * licence prose duplicated per asset, against 19% actual learning content — 5.5
 * MB, of which roughly 4 MB said the same two things over and over.
 *
 * So the shared fields live once in `sources`, and each manifest row names the
 * source it belongs to. `importPack` expands them back into full SourceAssets,
 * so the licence gate, the attribution report and every consumer see exactly
 * what they saw before. Nothing about provenance is weakened: an asset with no
 * resolvable source is refused at import rather than silently losing its licence.
 *
 * `attributions` is likewise no longer shipped: it is a pure function of the
 * manifest, so transmitting it was sending the same prose a third time. It is
 * projected on import and `npm run attributions` still writes the standalone
 * report the spec asks for (p.28).
 *
 * That projection deliberately does NOT re-run the licence gate. Admission is a
 * build-time authority (a client must not be able to re-decide what may ship),
 * and every asset in a released manifest has already passed it. Pulling the gate
 * into the runtime would also drag the build pipeline — and node:crypto — into
 * the browser bundle.
 */
import type { AttributionEntry, SourceAsset } from "./index.ts";
import type { RuntimePack } from "./runtime.ts";
import type { AudioAsset } from "./audio.ts";

/** The provenance shared by every asset from one source, stored once. */
export type SourceRecord = Omit<SourceAsset, "id" | "sha256">;

/** One asset: only what actually differs, plus which source it came from. */
export interface ManifestRow {
  id: string;
  sha256: string;
  /** Index into `sources`. */
  source: number;
}

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
  /** Distinct provenance records, referenced by the manifest. */
  sources: SourceRecord[];
  manifest: ManifestRow[];
}

export const PIPELINE_VERSION = "dyr-content-pipeline@2.0.0";

/** The key that decides whether two assets share a provenance record. */
function sourceKey(asset: SourceAsset): string {
  const { id: _id, sha256: _sha256, ...shared } = asset;
  return JSON.stringify(shared);
}

export function exportPack(pack: RuntimePack): ExportedPack {
  const sources: SourceRecord[] = [];
  const index = new Map<string, number>();
  const manifest: ManifestRow[] = pack.manifest.map((asset) => {
    const key = sourceKey(asset);
    let at = index.get(key);
    if (at === undefined) {
      const { id: _id, sha256: _sha256, ...shared } = asset;
      at = sources.push(shared as SourceRecord) - 1;
      index.set(key, at);
    }
    return { id: asset.id, sha256: asset.sha256, source: at };
  });

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
    // Only PROVISIONED audio ships. A `declared` row carries no information
    // beyond "this lexeme still needs a recording", which the lexeme itself
    // already says — 2,000 identical placeholders was 13% of the artefact.
    // `importPack` reconstructs them, so consumers see no difference.
    audio: [...pack.audio.values()]
      .filter((a) => a.state !== "declared")
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    sources,
    manifest,
  };
}

export class PackProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackProvenanceError";
  }
}

/** Expand the interned manifest back into full, per-asset SourceAssets. */
export function expandManifest(exported: ExportedPack): SourceAsset[] {
  return exported.manifest.map((row) => {
    const shared = exported.sources[row.source];
    // An asset whose provenance cannot be resolved has, in effect, none — and
    // shipping content with no licence is the thing the gate exists to prevent.
    if (!shared) {
      throw new PackProvenanceError(`asset ${row.id} references source ${row.source}, which does not exist`);
    }
    return { ...shared, id: row.id, sha256: row.sha256 };
  });
}

/** Rehydrate an exported artefact into the runtime shape the kernel consumes. */
export function importPack(exported: ExportedPack): RuntimePack {
  const manifest = expandManifest(exported);
  return {
    packId: exported.packId,
    packVersion: exported.packVersion as RuntimePack["packVersion"],
    contentHash: exported.contentHash,
    lexemes: exported.lexemes,
    characters: exported.characters,
    pronunciations: exported.pronunciations,
    grammarAtoms: exported.grammarAtoms,
    edges: exported.edges,
    audio: rehydrateAudio(exported),
    manifest,
    attributions: projectAttributions(manifest),
  };
}

/**
 * Rebuild the full audio map: what shipped, plus a `declared` placeholder for
 * every lexeme that still needs a recording.
 *
 * The gate reads the same thing either way — a declared asset has never
 * satisfied `isCanonical` — so this restores the shape without restoring the
 * bytes.
 */
function rehydrateAudio(exported: ExportedPack): RuntimePack["audio"] {
  const audio = new Map(exported.audio.map((a) => [a.lexeme, a]));
  for (const lexeme of exported.lexemes) {
    const id = String(lexeme.id);
    if (audio.has(id)) continue;
    audio.set(id, { id: `audio:${id}`, lexeme: id, transcript: lexeme.simplified, state: "declared" });
  }
  return audio;
}

/**
 * Attribution rows for an ALREADY-ADMITTED manifest.
 *
 * A projection, not a decision: it reformats what the build already gated rather
 * than re-deciding admission in the client. Sorted by id so the same pack always
 * yields the same report.
 */
export function projectAttributions(manifest: SourceAsset[]): AttributionEntry[] {
  return manifest
    .map((a) => ({
      id: a.id,
      sourceName: a.sourceName,
      licenseSpdx: a.licenseSpdx,
      licenseUrl: a.licenseUrl,
      author: a.author,
      attributionText: a.attributionText,
      sha256: a.sha256,
      immutableVersion: String(a.immutableVersion),
    }))
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/** Deterministic JSON for the artefact (stable key order via explicit shape). */
export function serialisePack(pack: RuntimePack): string {
  return JSON.stringify(exportPack(pack), null, 2);
}
