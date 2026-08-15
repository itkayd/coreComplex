/**
 * Source manifests for locally-supplied files.
 *
 * Network access must never be required to compile a release pack. Sources are
 * acquired externally, dropped into `sources/inbox/`, and described by a
 * `manifest.json` that carries the provenance the licence gate needs. The
 * importer then hashes the actual bytes and refuses anything whose provenance is
 * absent, denied or contradicted by the file on disk.
 *
 * This is the reproducibility property that matters: a release pack is built
 * from an immutable local snapshot, not from whatever an upstream API returned
 * that day.
 */

/** Provenance a human supplies alongside a downloaded file. */
export interface SourceManifest {
  /** Stable id, e.g. "cc-cedict". */
  sourceId: string;
  /** Human-readable name recorded in attribution. */
  sourceName: string;
  /** Upstream page the file came from. */
  sourceUrl: string;
  /** Upstream's own version/date string, e.g. "2026-08-01" or "1_0_ts". */
  sourceVersion: string;
  /** ISO timestamp of when the operator downloaded it. */
  retrievedAt: string;
  licenseSpdx: string;
  licenseUrl?: string;
  author?: string;
  attributionText?: string;
  redistributionAllowed: boolean;
  derivativeAllowed: boolean;
  /** Files this manifest describes, relative to the manifest's directory. */
  files: SourceFileDeclaration[];
  notes?: string;
}

export interface SourceFileDeclaration {
  path: string;
  /** Expected sha256, when the operator recorded one. Verified if present. */
  sha256?: string;
  /** What the file is, so an importer can pick the right parser. */
  role: string;
}

export interface ManifestIssue {
  path: string;
  message: string;
}

const REQUIRED_STRINGS: (keyof SourceManifest)[] = [
  "sourceId", "sourceName", "sourceUrl", "sourceVersion", "retrievedAt", "licenseSpdx",
];

/**
 * Validate a manifest's shape. Licence ADMISSION is a separate decision made by
 * the licence gate — a well-formed manifest can still be rejected.
 */
export function validateManifest(input: unknown): { valid: true; manifest: SourceManifest } | { valid: false; issues: ManifestIssue[] } {
  const issues: ManifestIssue[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { valid: false, issues: [{ path: "$", message: "manifest must be a JSON object" }] };
  }
  const m = input as Record<string, unknown>;

  for (const key of REQUIRED_STRINGS) {
    if (typeof m[key] !== "string" || (m[key] as string).length === 0) {
      issues.push({ path: String(key), message: "required, non-empty string" });
    }
  }
  if (typeof m.redistributionAllowed !== "boolean") {
    issues.push({ path: "redistributionAllowed", message: "required boolean — rights are never inferred" });
  }
  if (typeof m.derivativeAllowed !== "boolean") {
    issues.push({ path: "derivativeAllowed", message: "required boolean — rights are never inferred" });
  }
  if (typeof m.retrievedAt === "string" && Number.isNaN(Date.parse(m.retrievedAt))) {
    issues.push({ path: "retrievedAt", message: "must be an ISO-8601 timestamp" });
  }

  const files = m.files;
  if (!Array.isArray(files) || files.length === 0) {
    issues.push({ path: "files", message: "declare at least one file" });
  } else {
    files.forEach((file, index) => {
      const at = `files[${index}]`;
      if (typeof file !== "object" || file === null) {
        issues.push({ path: at, message: "expected an object" });
        return;
      }
      const f = file as Record<string, unknown>;
      if (typeof f.path !== "string" || f.path.length === 0) issues.push({ path: `${at}.path`, message: "required" });
      if (typeof f.path === "string" && (f.path.includes("..") || f.path.startsWith("/"))) {
        issues.push({ path: `${at}.path`, message: "must be a relative path inside the source directory" });
      }
      if (typeof f.role !== "string" || f.role.length === 0) issues.push({ path: `${at}.role`, message: "required" });
      if (f.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(String(f.sha256))) {
        issues.push({ path: `${at}.sha256`, message: "must be a 64-character hex sha256" });
      }
    });
  }

  return issues.length === 0
    ? { valid: true, manifest: input as SourceManifest }
    : { valid: false, issues };
}

/** A manifest template an operator can copy and fill in. */
export function manifestTemplate(sourceId: string, sourceName: string, sourceUrl: string): SourceManifest {
  return {
    sourceId,
    sourceName,
    sourceUrl,
    sourceVersion: "REPLACE-with-upstream-version-or-date",
    retrievedAt: new Date(0).toISOString(),
    licenseSpdx: "REPLACE-with-SPDX-id",
    licenseUrl: "",
    author: "",
    attributionText: "",
    redistributionAllowed: false,
    derivativeAllowed: false,
    files: [{ path: "REPLACE-filename", role: "REPLACE-role", sha256: undefined }],
    notes: "",
  };
}
