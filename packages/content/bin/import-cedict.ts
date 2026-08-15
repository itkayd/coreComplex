/** `npm run content:import:cedict` — parse a locally supplied CC-CEDICT dump. */
import { importCedict } from "../src/sources/index.ts";
import { indexBySimplified } from "../src/import/cedict.ts";
import { buildCore60Pack } from "../src/pipeline.ts";

const report = importCedict(process.argv[2] ?? "sources/inbox");
if (!report.installed) {
  console.log(report.message);
  process.exit(0); // absence is a state to report, not a build failure
}
console.log(report.message);

// Show what it would contribute to the Stage 2 pack.
const index = indexBySimplified(report.entries);
const { pack } = buildCore60Pack();
let matched = 0;
const missing: string[] = [];
for (const lexeme of pack.lexemes) {
  if (index.has(lexeme.simplified)) matched++;
  else missing.push(`${lexeme.simplified} (${lexeme.id})`);
}
console.log(`Core 60 coverage: ${matched}/${pack.lexemes.length} headwords found in CC-CEDICT`);
if (missing.length > 0) console.log(`  not found: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ` … +${missing.length - 10}` : ""}`);
