/**
 * @dyr/content — manifests, normalisation and pack tooling (spec p.7, p.20,
 * p.22, p.25).
 *
 *   "Open by construction, not merely free to view."
 *
 * Every bundled asset carries machine-verifiable provenance, exact licence
 * terms and an immutable content-pack version (p.7). This package owns the
 * SourceAsset manifest (p.20) and the licence gate. It does NOT import the
 * kernel; it produces the versioned language packs the kernel consumes.
 */
import type { PackVersion } from "@dyr/domain";

/** SourceAsset manifest — the exact fields listed on spec p.20. */
export interface SourceAsset {
  id: string;
  type: "lexeme" | "sentence" | "character" | "audio" | "video";
  sourceName: string;
  upstreamId?: string;
  upstreamUrl?: string;
  retrievedAt: number;
  immutableVersion: PackVersion;
  licenseSpdx: string;
  licenseUrl?: string;
  author?: string;
  attributionText?: string;
  redistributionAllowed: boolean;
  derivativeAllowed: boolean;
  modificationNote?: string;
  /**
   * An explicit, recorded permission from the rights holder that clears an
   * otherwise-denied provenance token.
   *
   * The deny list is a blunt substring check on purpose: it exists to stop
   * unreviewed content that merely *looks* like it came from a forbidden source.
   * But a blunt check cannot tell "Pleco's proprietary dictionary, taken without
   * permission" from "an OCR of a government standard that Pleco Inc. themselves
   * published under MIT" — and the second is exactly the kind of open licensing
   * the specification's ALLOW list is for.
   *
   * So the override is structural rather than verbal. Renaming a source to dodge
   * the substring would be evasion; recording who granted what, under which
   * licence, is provenance. A grant only ever clears a denied TOKEN — the licence
   * itself must still be on the allowlist, and redistribution must still be
   * granted.
   */
  rightsGrant?: {
    /** Who holds the rights and issued the licence. */
    holder: string;
    /** The licence they issued it under; must still pass the allowlist. */
    licence: string;
    /** Where that grant can be verified. */
    url: string;
    /** Why this is not the thing the deny rule targets. */
    note: string;
  };
  sha256: string;
  languageTag: string; // e.g. "zh-CN"
  region?: string;
  qualityState: "raw" | "verified" | "rejected";
  consentRestrictions?: string[];
}

/**
 * DEFAULT PACK licence policy (spec p.7). ALLOW: CC0/public domain, CC BY and
 * CC BY-SA with attribution, MIT/Apache-2.0, Unicode data terms, Arphic when
 * obligations are met. DENY: unknown/missing licence, CC BY-NC, CC BY-ND,
 * free-to-view-only, scraped/reconstructed commercial content, and ANY Pleco
 * or unlicensed HSK data.
 */
const ALLOW = new Set([
  "CC0-1.0",
  "CC-BY-4.0",
  "CC-BY-SA-4.0",
  "MIT",
  "Apache-2.0",
  "Unicode-DFS-2016",
]);
const DENY_SUBSTRINGS = ["-NC", "-ND", "Pleco", "UNKNOWN", "PROPRIETARY"];

export interface LicenceDecision {
  allowed: boolean;
  reason: string;
}

/** One attribution row for the reproducible attribution output (spec p.28). */
export interface AttributionEntry {
  id: string;
  sourceName: string;
  licenseSpdx: string;
  licenseUrl?: string;
  author?: string;
  attributionText?: string;
  sha256: string;
  immutableVersion: string;
}

/**
 * Deterministic attribution report over a set of assets (spec p.28 "reproducible
 * attribution output"; GET /attributions, spec p.24). Sorted by id so the same
 * inputs always yield byte-identical output; only redistributable, allowed
 * assets appear.
 */
export function attributionReport(assets: SourceAsset[]): AttributionEntry[] {
  return assets
    .filter((a) => licenceGate(a).allowed)
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

export function licenceGate(asset: SourceAsset): LicenceDecision {
  const spdx = asset.licenseSpdx ?? "";
  if (!spdx || spdx === "UNKNOWN") return { allowed: false, reason: "missing or unknown licence" };

  // A licence token is never overridable: NC and ND describe the terms
  // themselves, and no third-party grant can change what a licence says.
  for (const bad of DENY_SUBSTRINGS) {
    if (spdx.includes(bad)) return { allowed: false, reason: `denied licence token: ${bad}` };
  }

  // A SOURCE token is a heuristic about origin, and origin can be cleared by a
  // recorded grant from the rights holder — but only by that, never by wording.
  const grant = asset.rightsGrant;
  for (const bad of DENY_SUBSTRINGS) {
    if (!asset.sourceName.includes(bad)) continue;
    if (!grant) return { allowed: false, reason: `denied source token: ${bad}` };
    if (!ALLOW.has(grant.licence)) {
      return { allowed: false, reason: `rights grant for "${bad}" cites a licence that is not allowed: ${grant.licence}` };
    }
    if (grant.holder.length === 0 || grant.url.length === 0) {
      return { allowed: false, reason: `rights grant for "${bad}" does not name a holder and a verifiable source` };
    }
  }

  if (!asset.redistributionAllowed) return { allowed: false, reason: "no redistribution rights" };
  if (!ALLOW.has(spdx)) return { allowed: false, reason: `licence not on allowlist: ${spdx}` };
  return {
    allowed: true,
    reason: grant ? `allowed under ${spdx}; ${grant.holder} granted ${grant.licence}` : `allowed under ${spdx}`,
  };
}

// Pack pipeline, audio provisioning and the AssetProvider implementation.
export * from "./audio.ts";
export * from "./audio-runtime.ts";
export * from "./runtime.ts";
export * from "./validate.ts";
export * from "./pipeline.ts";
export * from "./provider.ts";
export { CORE60, CORE60_EDGES } from "./packs/core60.data.ts";
export type { Core60Entry } from "./packs/core60.data.ts";
export * from "./export.ts";
export * from "./write.ts";
export * from "./audio-analysis.ts";
export * from "./import/index.ts";
export * from "./sources/index.ts";
