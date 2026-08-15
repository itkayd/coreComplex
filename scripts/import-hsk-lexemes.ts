/**
 * Derive a teachable HSK 1 lexeme set from the open upstream list.
 *
 *   node scripts/import-hsk-lexemes.ts [complete.json] [out.ts]
 *
 * WHY THIS EXISTS. The Words screen made the real limit visible: Dyr taught 60
 * words against HSK 3.0's 10,969. The content, not the engine, is the bottleneck.
 *
 * LICENCE, AND WHY THESE ENTRIES ARE NOT CC0. The Core 60 glosses were authored
 * for this project and released CC0. These are different: the definitions come
 * from CC-CEDICT, which is CC BY-SA. Share-alike is a real obligation, so these
 * entries carry their own licence and their own attribution rather than being
 * quietly folded into the CC0 set. The pack format was built for exactly this —
 * every SourceAsset carries its own licence — so one pack can hold both, and the
 * attribution report names each correctly.
 *
 * QUALITY, HONESTLY. A dictionary is not a syllabus. CC-CEDICT glosses are
 * written for reference, not for a learner meeting a word for the first time, so
 * this cleans them hard: classifier annotations, cross-references, variant-of
 * notes and erhua spellings are dropped, long glosses are rejected, and at most
 * three senses survive. Where a word has several pronunciations (吧 is bā, ba and
 * biā) the FIRST form is taken, which is the aggregator's ordering and is not
 * always the one a beginner wants. Entries that cannot be cleaned into something
 * short and teachable are skipped rather than shipped — a bad gloss teaches a
 * wrong thing, and the Core 60 remains the hand-checked core.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { normalisePinyin } from "../packages/domain/src/pinyin.ts";
import { CORE60 } from "../packages/content/src/packs/core60.data.ts";

const source = process.argv[2] ?? "/tmp/hsk-complete.json";
const out = process.argv[3] ?? "packages/content/src/packs/hsk1.data.ts";
const BAND = "new-1";

interface Form {
  traditional?: string;
  transcriptions?: { pinyin?: string; numeric?: string };
  meanings?: string[];
}
interface Entry {
  simplified?: string;
  level?: string[];
  frequency?: number;
  pos?: string[];
  forms?: Form[];
}

const raw = JSON.parse(readFileSync(source, "utf8")) as Entry[];

/** Part-of-speech codes the upstream uses → the short forms the pack speaks. */
const POS: Record<string, string> = {
  n: "n", v: "v", a: "adj", adj: "adj", d: "adv", adv: "adv", p: "prep", prep: "prep",
  c: "conj", conj: "conj", r: "pron", pron: "pron", m: "num", num: "num", q: "cl",
  u: "part", y: "part", e: "interj", o: "interj", i: "idiom", h: "pref", k: "suf",
  t: "n", s: "n", f: "n", b: "adj", z: "adj", nr: "n", ns: "n", nt: "n", nz: "n",
};

/**
 * Reject a gloss outright rather than ship a confusing one.
 *
 * These patterns are all *reference* apparatus — useful in a dictionary, noise or
 * actively misleading on a flashcard.
 */
const REJECT = [
  /^CL:/i,                    // classifier annotation
  /\bvariant of\b/i,          // points at another headword
  /\bsee \S/i,
  /\babbr\. for\b/i,
  /\berhua variant\b/i,
  /\bold variant\b/i,
  /\bused in\b/i,
  /\bsurname\b/i,
  /^\(onom\.\)/i,             // onomatopoeia glosses read as nonsense alone
  /\bTaiwan pr\./i,
  /^also pr\./i,
];

/** Trim a CC-CEDICT gloss into something a learner can read on a card. */
function cleanGloss(raw: string): string | undefined {
  let s = raw.trim();
  if (s.length === 0) return undefined;
  if (REJECT.some((re) => re.test(s))) return undefined;

  // Drop a trailing classifier note: "book CL:本[ben3]" → "book".
  s = s.replace(/\s*CL:.*$/i, "").trim();
  // Strip bracketed pinyin annotations: "贴吧[tie1 ba1]" → "贴吧".
  s = s.replace(/\[[^\]]*\]/g, "").trim();
  // A leading parenthetical is usually a register or grammar note. Keep it only
  // when it is the whole gloss (particles genuinely have no other definition).
  const withoutLead = s.replace(/^\([^)]*\)\s*/, "").trim();
  if (withoutLead.length > 0) s = withoutLead;

  s = s.replace(/\s+/g, " ").replace(/[;,]\s*$/, "").trim();
  if (s.length === 0 || s.length > 42) return undefined;   // too long to be a cue
  if (/[一-鿿]/.test(s)) return undefined;          // still contains hanzi
  if (s.split(" ").length > 6) return undefined;            // a sentence, not a gloss
  return s;
}

/** `yín háng` + pos → `yinhang.n.01`, matching the pack's id grammar. */
function makeId(pinyin: string, pos: string, taken: Set<string>): string | undefined {
  let base: string;
  try {
    base = normalisePinyin(pinyin).numbered.replace(/[0-9\s]/g, "").toLowerCase();
  } catch {
    return undefined;
  }
  base = base.replace(/[^a-z]/g, "");
  if (base.length === 0) return undefined;
  const kind = /^[a-z]+$/.test(pos) ? pos : "x";
  for (let n = 1; n < 100; n++) {
    const id = `${base}.${kind}.${String(n).padStart(2, "0")}`;
    if (!taken.has(id)) { taken.add(id); return id; }
  }
  return undefined;
}

const coreForms = new Set(CORE60.map((e) => e.simplified.normalize("NFC")));
const takenIds = new Set(CORE60.map((e) => e.id));
const rows: string[] = [];
const skipped: Record<string, number> = {};
const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };

const band = raw
  .filter((e) => (e.level ?? []).includes(BAND))
  .sort((a, b) => (a.simplified ?? "").localeCompare(b.simplified ?? ""));

for (const entry of band) {
  const simplified = (entry.simplified ?? "").normalize("NFC").trim();
  if (simplified.length === 0) { skip("no form"); continue; }
  // The hand-authored Core 60 wins: it is CC0 and its glosses were checked.
  if (coreForms.has(simplified)) { skip("already in Core 60"); continue; }

  const form = entry.forms?.[0];
  const marked = form?.transcriptions?.pinyin?.trim();
  const numeric = form?.transcriptions?.numeric?.trim();
  if (!marked || !numeric) { skip("no pronunciation"); continue; }

  let tones: number[];
  let pinyin: string;
  try {
    const normalised = normalisePinyin(numeric);
    tones = normalised.tones;
    pinyin = normalised.marked;
  } catch { skip("unparseable pinyin"); continue; }

  // The pack's own QA requires one tone per written syllable.
  if (tones.length !== pinyin.split(" ").length) { skip("tone/syllable mismatch"); continue; }

  const senses: string[] = [];
  for (const meaning of form?.meanings ?? []) {
    const cleaned = cleanGloss(meaning);
    if (cleaned && !senses.includes(cleaned)) senses.push(cleaned);
    if (senses.length === 3) break;
  }
  if (senses.length === 0) { skip("no usable gloss"); continue; }

  const pos = POS[(entry.pos ?? [])[0] ?? ""] ?? "x";
  const id = makeId(pinyin, pos, takenIds);
  if (!id) { skip("no id"); continue; }

  // Upstream frequency is a rank (1 = most common). The pack wants a Zipf-style
  // prior where higher means more common, so invert it into a bounded band that
  // sits just below the hand-authored Core 60's 5.0–7.0.
  const rank = typeof entry.frequency === "number" && entry.frequency > 0 ? entry.frequency : 5000;
  const frequency = Number(Math.max(3.0, 6.2 - Math.log10(rank + 1)).toFixed(2));

  const traditional = (form?.traditional ?? simplified).normalize("NFC");
  rows.push(
    `  { id: ${JSON.stringify(id)}, simplified: ${JSON.stringify(simplified)}, `
    + `traditional: ${JSON.stringify(traditional)}, pinyin: ${JSON.stringify(pinyin)}, `
    + `tones: [${tones.join(", ")}], senses: ${JSON.stringify(senses)}, `
    + `pos: ${JSON.stringify(pos)}, frequency: ${frequency} },`,
  );
}

const header = `/**
 * HSK 1 expansion set — derived, NOT authored here.
 *
 * GENERATED by scripts/import-hsk-lexemes.ts. Do not edit by hand: rerun the
 * script so the provenance stays true.
 *
 * PROVENANCE AND LICENCE. Band membership comes from the official Ministry of
 * Education HSK 3.0 word list (elkmovie/hsk30, MIT, © Pleco Inc., an OCR of the
 * published standard). The definitions come from CC-CEDICT, which is CC BY-SA,
 * aggregated by drkameleon/complete-hsk-vocabulary (MIT).
 *
 * These entries are therefore CC-BY-SA-4.0, NOT CC0 like the Core 60. Share-alike
 * is a real obligation and is not laundered by aggregation, so every entry here
 * carries its own licence and its own attribution in the pack manifest. The pack
 * format was designed for exactly this: a SourceAsset licence is per asset, so
 * one release can hold both sets and describe each correctly.
 *
 * QUALITY. A dictionary is not a syllabus. Glosses were cleaned hard — classifier
 * notes, cross-references, variant-of notes and over-long definitions are
 * dropped, and an entry that could not be cleaned into something short and
 * teachable was skipped rather than shipped. Words already in the hand-authored
 * Core 60 are excluded: that set is CC0 and its glosses were checked by hand.
 *
 * Audio is not bundled here either. Human-recorded Mandarin is canonical
 * (spec p.21); these entries declare the audio they need and stay reading-only
 * until a licensed recording is provisioned and verified.
 */
import type { Core60Entry } from "./core60.data.ts";

/** The licence these entries ship under — share-alike, unlike the Core 60. */
export const HSK1_LICENCE = "CC-BY-SA-4.0";
export const HSK1_LICENCE_URL = "https://creativecommons.org/licenses/by-sa/4.0/";
export const HSK1_ATTRIBUTION =
  "HSK 3.0 band membership: elkmovie/hsk30 (MIT, © Pleco Inc.), an OCR of the official "
  + "Ministry of Education word list. Definitions: CC-CEDICT (CC BY-SA), aggregated by "
  + "drkameleon/complete-hsk-vocabulary (MIT).";
export const HSK1_SOURCE_NAME = "CC-CEDICT via complete-hsk-vocabulary (HSK 3.0 band 1)";

export const HSK1: Core60Entry[] = [
`;

writeFileSync(out, `${header}${rows.join("\n")}\n];\n`, "utf8");

console.log(`wrote ${rows.length} HSK 1 lexemes to ${out}`);
console.log(`band size: ${band.length}`);
for (const [why, n] of Object.entries(skipped).sort((a, b) => b[1] - a[1])) {
  console.log(`  skipped ${String(n).padStart(4)}  ${why}`);
}
