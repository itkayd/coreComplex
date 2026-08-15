/**
 * Build the Core 60 pack into an immutable, versioned JSON artefact.
 * Usage: node packages/content/bin/build-pack.ts [outDir]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCore60Pack, serialisePack } from "../src/index.ts";

const outDir = process.argv[2] ?? "packs";
const report = buildCore60Pack();
mkdirSync(outDir, { recursive: true });

const file = join(outDir, `${report.pack.packId}.json`);
writeFileSync(file, serialisePack(report.pack), "utf8");

console.log(`pack:        ${report.pack.packId}`);
console.log(`version:     ${report.pack.packVersion}`);
console.log(`contentHash: ${report.pack.contentHash}`);
console.log(`lexemes:     ${report.pack.lexemes.length} (rejected ${report.rejected.length})`);
console.log(`audio:       ${report.pack.audio.size} declared, ${report.audioPending.length} awaiting canonical recordings`);
console.log(`written:     ${file}`);
