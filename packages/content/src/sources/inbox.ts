/**
 * Local source inbox.
 *
 *   sources/inbox/<sourceId>/manifest.json + declared files
 *
 * Discovery, hashing and admission for manually-supplied source files. Absence
 * of a source is NOT an error: the compiler reports what is missing and how to
 * supply it, and keeps building whatever it legitimately can.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { licenceGate, type SourceAsset } from "../index.ts";
import { validateManifest, type SourceManifest } from "./manifest.ts";

export const DEFAULT_INBOX = "sources/inbox";

export type SourceState =
  /** No directory / no manifest — nothing supplied yet. */
  | "not_installed"
  /** Manifest present but malformed. */
  | "invalid_manifest"
  /** Manifest fine, but a declared file is missing or its hash disagrees. */
  | "files_missing"
  /** Provenance is well-formed but the licence gate refuses it. */
  | "licence_rejected"
  /** Installed, hashed and admissible. */
  | "ready";

export interface InstalledFile {
  role: string;
  path: string;
  absolutePath: string;
  bytes: number;
  sha256: string;
  /** True when the manifest declared a hash and the bytes disagree. */
  hashMismatch: boolean;
}

export interface SourceStatus {
  sourceId: string;
  state: SourceState;
  manifest?: SourceManifest;
  files: InstalledFile[];
  issues: string[];
  /** What the operator should do next, when something is missing. */
  action?: string;
}

/**
 * Resolve a supplier-declared relative path INSIDE a source directory, or refuse.
 *
 * `join(baseDir, declared)` is not enough: `../../etc/passwd` joins perfectly
 * happily and then reads a file the operator never declared. A candidates file
 * is operator-supplied data, sometimes generated from an upstream export, so it
 * is treated as untrusted input.
 *
 * Three separate escapes are refused:
 *   - absolute paths (POSIX `/x` and Windows `C:\x` / UNC `\\host\share`);
 *   - `..` traversal, checked after normalisation rather than by substring;
 *   - symlinks pointing outside the tree, checked against the real path.
 */
export function resolveInside(baseDir: string, declared: string): { ok: true; absolutePath: string } | { ok: false; reason: string } {
  if (declared.length === 0) return { ok: false, reason: "empty path" };
  if (isAbsolute(declared) || /^[a-zA-Z]:[\\/]/.test(declared) || declared.startsWith("\\\\")) {
    return { ok: false, reason: `absolute paths are not allowed: ${declared}` };
  }
  if (declared.includes("\0")) return { ok: false, reason: "path contains a NUL byte" };

  const base = resolve(baseDir);
  const target = resolve(base, declared);
  const contains = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
  if (!contains(base, target)) {
    return { ok: false, reason: `path escapes the source directory: ${declared}` };
  }

  // Symlink escape: a link inside the tree may still point outside it.
  try {
    const realBase = realpathSync(base);
    const realTarget = realpathSync(target);
    if (!contains(realBase, realTarget)) {
      return { ok: false, reason: `path resolves through a symlink outside the source directory: ${declared}` };
    }
  } catch {
    // Target does not exist yet — containment of the lexical path already holds,
    // and the caller reports the missing file separately.
  }

  return { ok: true, absolutePath: target };
}

export function sha256File(absolutePath: string): string {
  return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
}

/**
 * Read a possibly-gzipped text file. CC-CEDICT and the Tatoeba exports both
 * ship compressed, and requiring the operator to decompress by hand is an easy
 * way to get a corrupted source.
 */
export function readTextMaybeGzip(absolutePath: string): string {
  const raw = readFileSync(absolutePath);
  // gzip magic number
  if (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    return gunzipSync(raw).toString("utf8");
  }
  return raw.toString("utf8");
}

/** Inspect one source directory. */
export function inspectSource(sourceId: string, inboxDir = DEFAULT_INBOX): SourceStatus {
  const dir = join(inboxDir, sourceId);
  const manifestPath = join(dir, "manifest.json");
  const install = `Place the files in ${dir}/ with a manifest.json (see sources/README.md).`;

  if (!existsSync(dir) || !existsSync(manifestPath)) {
    return { sourceId, state: "not_installed", files: [], issues: [], action: install };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return {
      sourceId, state: "invalid_manifest", files: [],
      issues: [`manifest.json is not valid JSON: ${(error as Error).message}`],
      action: install,
    };
  }

  const validation = validateManifest(parsed);
  if (!validation.valid) {
    return {
      sourceId, state: "invalid_manifest", files: [],
      issues: validation.issues.map((i) => `${i.path}: ${i.message}`),
      action: install,
    };
  }
  const manifest = validation.manifest;

  const files: InstalledFile[] = [];
  const issues: string[] = [];
  for (const declared of manifest.files) {
    const resolved = resolveInside(dir, declared.path);
    if (!resolved.ok) {
      issues.push(`declared file rejected: ${resolved.reason}`);
      continue;
    }
    const absolutePath = resolved.absolutePath;
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      issues.push(`declared file missing: ${declared.path}`);
      continue;
    }
    const sha256 = sha256File(absolutePath);
    const hashMismatch = declared.sha256 !== undefined && declared.sha256.toLowerCase() !== sha256;
    if (hashMismatch) {
      issues.push(`hash mismatch for ${declared.path}: manifest says ${declared.sha256}, file is ${sha256}`);
    }
    files.push({
      role: declared.role,
      path: declared.path,
      absolutePath,
      bytes: statSync(absolutePath).size,
      sha256,
      hashMismatch,
    });
  }

  if (issues.length > 0) {
    return { sourceId, state: "files_missing", manifest, files, issues, action: install };
  }

  // Licence admission, using the same gate that governs bundled assets.
  const probe: SourceAsset = {
    id: manifest.sourceId,
    type: "lexeme",
    sourceName: manifest.sourceName,
    upstreamUrl: manifest.sourceUrl,
    retrievedAt: Date.parse(manifest.retrievedAt),
    immutableVersion: manifest.sourceVersion as SourceAsset["immutableVersion"],
    licenseSpdx: manifest.licenseSpdx,
    licenseUrl: manifest.licenseUrl,
    author: manifest.author,
    attributionText: manifest.attributionText,
    redistributionAllowed: manifest.redistributionAllowed,
    derivativeAllowed: manifest.derivativeAllowed,
    sha256: files[0]?.sha256 ?? "",
    languageTag: "zh-CN",
    qualityState: "raw",
  };
  const decision = licenceGate(probe);
  if (!decision.allowed) {
    return {
      sourceId, state: "licence_rejected", manifest, files,
      issues: [decision.reason],
      action: "Supply a source whose licence permits redistribution, or record the grant that does.",
    };
  }

  return { sourceId, state: "ready", manifest, files, issues: [] };
}

/** Every source directory currently present in the inbox. */
export function listInstalledSources(inboxDir = DEFAULT_INBOX): string[] {
  if (!existsSync(inboxDir)) return [];
  return readdirSync(inboxDir)
    .filter((name) => statSync(join(inboxDir, name)).isDirectory())
    .sort();
}

/** Find a declared file by role within a ready source. */
export function fileForRole(status: SourceStatus, role: string): InstalledFile | undefined {
  return status.files.find((f) => f.role === role);
}
