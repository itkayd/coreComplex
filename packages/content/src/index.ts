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

export function licenceGate(asset: SourceAsset): LicenceDecision {
  const spdx = asset.licenseSpdx ?? "";
  if (!spdx || spdx === "UNKNOWN") return { allowed: false, reason: "missing or unknown licence" };
  for (const bad of DENY_SUBSTRINGS) {
    if (spdx.includes(bad) || asset.sourceName.includes(bad)) {
      return { allowed: false, reason: `denied source/licence token: ${bad}` };
    }
  }
  if (!asset.redistributionAllowed) return { allowed: false, reason: "no redistribution rights" };
  if (!ALLOW.has(spdx)) return { allowed: false, reason: `licence not on allowlist: ${spdx}` };
  return { allowed: true, reason: `allowed under ${spdx}` };
}
