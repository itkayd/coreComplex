/**
 * Pinyin normalisation: numbered ⇄ tone-marked.
 *
 *   yin2 hang2  ⇄  yín háng
 *
 * Implemented directly rather than via pypinyin, deliberately:
 *
 *   - pypinyin's job is GENERATING pinyin from hanzi (a hard problem needing a
 *     dictionary and heteronym handling). We do not need that: CC-CEDICT ships
 *     the pronunciation, and the spec makes source pronunciation authoritative
 *     (never overwrite it from a generator).
 *   - What we DO need is normalisation between the two written forms, which is
 *     a closed, deterministic transformation over a fixed vowel table.
 *   - Adding a Python runtime to the content build to do that would be a large
 *     dependency for a small, exactly-specified job.
 *
 * pypinyin remains the right choice later if Dyr ever needs to derive pinyin for
 * text that has no dictionary entry; it would sit in the build pipeline, never
 * in the kernel. See docs/THIRD_PARTY_DEPENDENCIES.md.
 */

/** Tone marks by vowel, indexed by tone 1–4 (tone 5 / neutral is unmarked). */
const TONE_MARKS: Record<string, string[]> = {
  a: ["ā", "á", "ǎ", "à"],
  e: ["ē", "é", "ě", "è"],
  i: ["ī", "í", "ǐ", "ì"],
  o: ["ō", "ó", "ǒ", "ò"],
  u: ["ū", "ú", "ǔ", "ù"],
  "ü": ["ǖ", "ǘ", "ǚ", "ǜ"],
};

/** Reverse table: marked vowel → [base vowel, tone]. */
const MARK_TO_TONE = new Map<string, { base: string; tone: number }>();
for (const [base, marks] of Object.entries(TONE_MARKS)) {
  marks.forEach((mark, index) => MARK_TO_TONE.set(mark, { base, tone: index + 1 }));
}

export interface PinyinSyllable {
  /** Syllable without tone, e.g. "hang". ü is written "ü". */
  base: string;
  /** 1–4 lexical tones; 5 = neutral. */
  tone: 1 | 2 | 3 | 4 | 5;
  /** Numbered form, e.g. "hang2". */
  numbered: string;
  /** Tone-marked form, e.g. "háng". */
  marked: string;
  /** Initial consonant cluster ("h"), empty for zero-initial syllables. */
  initial: string;
  /** Final ("ang"). */
  final: string;
}

/**
 * Standard Mandarin initials, longest first so "zh/ch/sh" win over "z/c/s".
 * Order matters: this list is scanned in sequence.
 */
const INITIALS = [
  "zh", "ch", "sh",
  "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x", "r", "z", "c", "s",
  "y", "w",
];

function splitInitialFinal(base: string): { initial: string; final: string } {
  for (const initial of INITIALS) {
    if (base.startsWith(initial)) {
      return { initial, final: base.slice(initial.length) };
    }
  }
  return { initial: "", final: base }; // zero-initial: a, e, o, ai, ou…
}

/**
 * Where the tone mark goes (standard placement):
 *   a or e always take it; in "ou" the o takes it; otherwise the LAST vowel does.
 */
function toneMarkIndex(base: string): number {
  const lower = base.toLowerCase();
  const a = lower.indexOf("a");
  if (a >= 0) return a;
  const e = lower.indexOf("e");
  if (e >= 0) return e;
  const ou = lower.indexOf("ou");
  if (ou >= 0) return ou;
  for (let i = lower.length - 1; i >= 0; i--) {
    if ("aeiouü".includes(lower[i])) return i;
  }
  return -1;
}

/** Parse one numbered syllable ("hang2", "lu:3", "nv3", "ma") into a syllable. */
export function parseNumberedSyllable(input: string): PinyinSyllable {
  const raw = input.trim();
  const match = /^([a-zA-ZüÜ:]+?)([1-5])?$/.exec(raw.replace(/u:/g, "ü").replace(/v/g, "ü"));
  if (!match) throw new Error(`unparseable pinyin syllable: ${input}`);
  const base = match[1].toLowerCase();
  const tone = (match[2] ? Number(match[2]) : 5) as PinyinSyllable["tone"];
  return buildSyllable(base, tone);
}

/** Parse one tone-marked syllable ("háng", "nǚ", "ma") into a syllable. */
export function parseMarkedSyllable(input: string): PinyinSyllable {
  const raw = input.normalize("NFC").trim().toLowerCase();
  let tone: PinyinSyllable["tone"] = 5;
  let base = "";
  for (const char of raw) {
    const found = MARK_TO_TONE.get(char);
    if (found) {
      tone = found.tone as PinyinSyllable["tone"];
      base += found.base;
    } else {
      base += char;
    }
  }
  return buildSyllable(base, tone);
}

function buildSyllable(base: string, tone: PinyinSyllable["tone"]): PinyinSyllable {
  const { initial, final } = splitInitialFinal(base);
  return {
    base,
    tone,
    numbered: tone === 5 ? base : `${base}${tone}`,
    marked: applyToneMark(base, tone),
    initial,
    final,
  };
}

/** Place the tone mark on a toneless syllable. */
export function applyToneMark(base: string, tone: PinyinSyllable["tone"]): string {
  if (tone === 5) return base;
  const index = toneMarkIndex(base);
  if (index < 0) return base;
  const vowel = base[index];
  const marks = TONE_MARKS[vowel];
  if (!marks) return base;
  return `${base.slice(0, index)}${marks[tone - 1]}${base.slice(index + 1)}`;
}

export interface NormalisedPinyin {
  /** Space-separated numbered form: "yin2 hang2". */
  numbered: string;
  /** Tone-marked form: "yín háng". */
  marked: string;
  syllables: PinyinSyllable[];
  /** Lexical tone of each syllable, in order. */
  tones: PinyinSyllable["tone"][];
}

/**
 * Normalise a pinyin string in EITHER representation into both.
 *
 * Both original forms are preserved by the caller — the spec forbids destroying
 * the source representation, so this returns a derived view rather than a
 * replacement.
 */
export function normalisePinyin(input: string): NormalisedPinyin {
  const cleaned = input.normalize("NFC").trim().replace(/\s+/g, " ");
  if (cleaned.length === 0) throw new Error("empty pinyin");

  const syllables = cleaned
    .split(" ")
    .filter((s) => s.length > 0)
    .map((token) => (/[1-5]$/.test(token) || /[a-zA-Z:]+$/.test(token) && !hasToneMark(token)
      ? parseNumberedSyllable(token)
      : parseMarkedSyllable(token)));

  return {
    numbered: syllables.map((s) => s.numbered).join(" "),
    marked: syllables.map((s) => s.marked).join(" "),
    syllables,
    tones: syllables.map((s) => s.tone),
  };
}

function hasToneMark(token: string): boolean {
  for (const char of token.normalize("NFC")) if (MARK_TO_TONE.has(char)) return true;
  return false;
}
