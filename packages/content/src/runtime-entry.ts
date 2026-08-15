/**
 * `@dyr/content/runtime` — the browser-safe entry point.
 *
 * Deliberately excludes the build pipeline (and therefore node:crypto): a
 * client consumes finished, signed packs and must never be able to build or
 * re-sign one.
 */
export * from "./runtime.ts";
export * from "./validate.ts";
export * from "./audio.ts";
export * from "./audio-runtime.ts";
export * from "./audio-analysis.ts";
export * from "./provider.ts";
export { importPack, exportPack, type ExportedPack } from "./export.ts";

// Types only. The licence GATE is a build-time authority: a client consumes
// packs that were already gated and signed, and must not be able to re-run or
// re-decide admission. Exporting the functions here would also drag the build
// pipeline (and node:crypto) into the browser bundle.
export type { SourceAsset, AttributionEntry, LicenceDecision } from "./index.ts";
