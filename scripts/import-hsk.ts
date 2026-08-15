/**
 * Derive HSK band membership from the open upstream list.
 *
 *   node scripts/import-hsk.ts [path-to-complete.json]
 *
 * WHAT IS TAKEN, AND WHAT IS DELIBERATELY NOT.
 *
 * Only two fields: the simplified form, and which HSK band it belongs to. That
 * is a factual statement about an official published standard — the Ministry of
 * Education's HSK word lists — and it is all the progress view needs.
 *
 * Everything else in the upstream file is dropped on purpose:
 *
 *   definitions   come from CC-CEDICT (CC BY-SA). Taking them would put a
 *                 share-alike obligation on the pack for data Dyr already has.
 *   frequency     comes from a repository whose own licence describes its word
 *                 lists as Pleco-derived. Not needed, so not taken.
 *   pos, radical  come from SUBTLEX-CH / HanLP / makemeahanzi, each with its own
 *                 terms. Not needed, so not taken.
 *
 * Narrowing to membership keeps the provenance short and clean: the bands trace
 * to elkmovie/hsk30 (MIT, © Pleco Inc., OCR of the official MoE PDF) for HSK 3.0
 * and clem109/hsk-vocabulary (MIT) for HSK 2.0, aggregated by
 * drkameleon/complete-hsk-vocabulary (MIT).
 *
 * HSK NEVER DECIDES READINESS (spec p.9), and HSK reporting is kept separate
 * (p.28). This data feeds a progress VIEW. It is not read by the planner, the
 * frontier or the scheduler, and a test asserts that.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const source = process.argv[2] ?? "/tmp/hsk-complete.json";
const out = process.argv[3] ?? "apps/web/public/packs/hsk-bands.json";

interface UpstreamEntry {
  simplified?: unknown;
  level?: unknown;
}

const raw = JSON.parse(readFileSync(source, "utf8")) as UpstreamEntry[];

/**
 * The two schemes a learner might mean by "HSK".
 *
 * `new` is the current standard (HSK 3.0, 2021), whose top band is published as
 * a single combined 7–9. `old` is HSK 2.0, still how most existing material and
 * most learners talk about levels. Both are offered; neither is invented.
 */
const SCHEMES = { new: "new", old: "old" } as const;

const bands: Record<string, Record<string, string[]>> = { new: {}, old: {} };
let skipped = 0;

for (const entry of raw) {
  const word = typeof entry.simplified === "string" ? entry.simplified.normalize("NFC").trim() : "";
  const levels = Array.isArray(entry.level) ? entry.level : [];
  if (word.length === 0 || levels.length === 0) { skipped++; continue; }

  for (const level of levels) {
    if (typeof level !== "string") continue;
    const [prefix, band] = level.split("-");
    // "newest-*" is a later draft revision; including it alongside the published
    // standard would make the totals mean two different things at once.
    const scheme = prefix === SCHEMES.new ? "new" : prefix === SCHEMES.old ? "old" : undefined;
    if (!scheme || !/^[1-9]$/.test(band ?? "")) continue;
    (bands[scheme][band] ??= []).push(word);
  }
}

// Deterministic output: sorted, de-duplicated. The same input always produces
// the same bytes, so a regeneration shows an empty diff when nothing changed.
const compact: Record<string, Record<string, string>> = { new: {}, old: {} };
const counts: Record<string, Record<string, number>> = { new: {}, old: {} };
for (const scheme of ["new", "old"] as const) {
  for (const band of Object.keys(bands[scheme]).sort()) {
    const unique = [...new Set(bands[scheme][band])].sort();
    // Space-joined rather than a JSON array: same information, a third of the
    // bytes, and this file is fetched by the browser.
    compact[scheme][band] = unique.join(" ");
    counts[scheme][band] = unique.length;
  }
}

const artefact = {
  schemes: {
    new: { label: "HSK 3.0", note: "Current standard (2021). Band 7 covers the published 7–9 range." },
    old: { label: "HSK 2.0", note: "Previous standard, six levels." },
  },
  attribution: [
    {
      what: "HSK 3.0 band membership",
      source: "elkmovie/hsk30",
      url: "https://github.com/elkmovie/hsk30",
      licence: "MIT",
      holder: "Pleco Inc.",
      note: "OCR of the official Ministry of Education HSK 3.0 word list, released by the rights holder under MIT.",
    },
    {
      what: "HSK 2.0 band membership",
      source: "clem109/hsk-vocabulary",
      url: "https://github.com/clem109/hsk-vocabulary",
      licence: "MIT",
      holder: "Clement Venard",
    },
    {
      what: "Aggregation",
      source: "drkameleon/complete-hsk-vocabulary",
      url: "https://github.com/drkameleon/complete-hsk-vocabulary",
      licence: "MIT",
      holder: "Yanis Zafirópulos",
      note: "Only the simplified form and band were taken; definitions, frequency, part-of-speech and radical data were deliberately not used.",
    },
  ],
  counts,
  bands: compact,
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(artefact)}\n`, "utf8");

const total = (s: "new" | "old") => Object.values(counts[s]).reduce((a, b) => a + b, 0);
console.log(`HSK band membership written to ${out}`);
console.log(`  HSK 3.0: ${total("new")} words across ${Object.keys(counts.new).length} bands`);
for (const [b, n] of Object.entries(counts.new)) console.log(`    band ${b}: ${n}`);
console.log(`  HSK 2.0: ${total("old")} words across ${Object.keys(counts.old).length} bands`);
for (const [b, n] of Object.entries(counts.old)) console.log(`    band ${b}: ${n}`);
console.log(`  skipped (no word or no level): ${skipped}`);
