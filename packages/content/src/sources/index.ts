/**
 * Offline source ingestion: manifests, inbox discovery, importers, HSK adapter.
 * Build-time only — never imported by the kernel.
 */
export * from "./manifest.ts";
export * from "./inbox.ts";
export * from "./importers.ts";
export * from "./hsk-source.ts";
