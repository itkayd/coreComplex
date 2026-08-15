/**
 * Chinese tokenisation, with Dyr's own vocabulary as the authority.
 *
 *   我去银行取钱。 → 我 / 去 / 银行 / 取 / 钱 / 。
 *   not              我 / 去 / 银 / 行 / 取 / 钱 / 。
 *
 * The rule the spec fixes: the LanguageGraph is canonical lexical identity;
 * a statistical segmenter (Jieba) may only ever be a fallback for text whose
 * words Dyr does not yet know. That ordering matters — if Jieba decided lexeme
 * identity, the same sentence could segment differently after a library upgrade
 * and silently change which trace a task belongs to.
 *
 * This implementation is longest-match over the pack vocabulary, which is
 * deterministic for a given (sentence, pack version, tokeniser version) and
 * needs no external dependency. Unknown runs are emitted as `unknown` tokens
 * carrying their offsets, so a fallback segmenter can refine exactly those spans
 * later without touching the spans Dyr already owns.
 */

export const TOKENISER_VERSION = "dyr-tokeniser@1.0.0";

export type TokenKind = "lexeme" | "unknown" | "punctuation" | "latin" | "digit";

export interface SentenceToken {
  /** Surface text of the token. */
  text: string;
  /** Dyr lexeme id when the token resolved to known vocabulary. */
  lexemeId?: string;
  kind: TokenKind;
  /** Character offsets into the ORIGINAL sentence — needed for highlighting. */
  start: number;
  end: number;
}

export interface TokeniseResult {
  tokens: SentenceToken[];
  tokeniserVersion: string;
  /** Fraction of Chinese characters covered by known vocabulary, 0..1. */
  coverage: number;
}

/** simplified/traditional surface → lexeme id. Built from the pack. */
export type Vocabulary = Map<string, string>;

const PUNCTUATION = /[　-〿＀-￯!-/:-@[-`{-~]/;
const HAN = /[㐀-䶿一-鿿豈-﫿]/;
const LATIN = /[A-Za-z]/;
const DIGIT = /[0-9]/;

/**
 * Longest-match tokenisation against the canonical vocabulary.
 *
 * `maxWordLength` bounds the lookahead; Mandarin words in a learner pack are
 * short, and the bound keeps the scan linear in practice.
 */
export function tokenise(sentence: string, vocabulary: Vocabulary, maxWordLength = 6): TokeniseResult {
  const text = sentence.normalize("NFC");
  const tokens: SentenceToken[] = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (PUNCTUATION.test(char)) {
      tokens.push({ text: char, kind: "punctuation", start: index, end: index + 1 });
      index += 1;
      continue;
    }
    if (/\s/.test(char)) { index += 1; continue; }

    if (LATIN.test(char) || DIGIT.test(char)) {
      let end = index;
      while (end < text.length && (LATIN.test(text[end]) || DIGIT.test(text[end]))) end++;
      tokens.push({
        text: text.slice(index, end),
        kind: DIGIT.test(char) ? "digit" : "latin",
        start: index,
        end,
      });
      index = end;
      continue;
    }

    // Longest known word starting here wins — this is what keeps 银行 whole.
    let matched: { surface: string; lexemeId: string } | undefined;
    const limit = Math.min(maxWordLength, text.length - index);
    for (let length = limit; length >= 1; length--) {
      const candidate = text.slice(index, index + length);
      const lexemeId = vocabulary.get(candidate);
      if (lexemeId) { matched = { surface: candidate, lexemeId }; break; }
    }

    if (matched) {
      tokens.push({
        text: matched.surface,
        lexemeId: matched.lexemeId,
        kind: "lexeme",
        start: index,
        end: index + matched.surface.length,
      });
      index += matched.surface.length;
      continue;
    }

    // Unknown: emit the maximal run of unrecognised Han characters as one span,
    // so a fallback segmenter can refine precisely this region later.
    let end = index;
    while (end < text.length && HAN.test(text[end]) && !startsKnownWord(text, end, vocabulary, maxWordLength)) end++;
    if (end === index) end = index + 1;
    tokens.push({ text: text.slice(index, end), kind: "unknown", start: index, end });
    index = end;
  }

  const hanTotal = [...text].filter((c) => HAN.test(c)).length;
  const hanKnown = tokens
    .filter((t) => t.kind === "lexeme")
    .reduce((sum, t) => sum + [...t.text].filter((c) => HAN.test(c)).length, 0);

  return {
    tokens,
    tokeniserVersion: TOKENISER_VERSION,
    coverage: hanTotal === 0 ? 1 : Number((hanKnown / hanTotal).toFixed(4)),
  };
}

function startsKnownWord(text: string, at: number, vocabulary: Vocabulary, maxWordLength: number): boolean {
  const limit = Math.min(maxWordLength, text.length - at);
  for (let length = limit; length >= 1; length--) {
    if (vocabulary.has(text.slice(at, at + length))) return true;
  }
  return false;
}

/**
 * Optional refinement hook for unknown spans.
 *
 * A statistical segmenter (Jieba or similar, running in the BUILD pipeline —
 * never the kernel) can be supplied here. It is only ever offered spans Dyr
 * could not resolve, so it can never re-cut a span that canonical vocabulary
 * already claimed, and the tokeniser stays deterministic where it matters.
 */
export interface FallbackSegmenter {
  readonly name: string;
  readonly version: string;
  segment(unknownSpan: string): string[];
}

export function refineUnknownSpans(result: TokeniseResult, segmenter: FallbackSegmenter): TokeniseResult {
  const tokens: SentenceToken[] = [];
  for (const token of result.tokens) {
    if (token.kind !== "unknown" || token.text.length < 2) { tokens.push(token); continue; }
    let offset = token.start;
    for (const piece of segmenter.segment(token.text)) {
      if (piece.length === 0) continue;
      tokens.push({ text: piece, kind: "unknown", start: offset, end: offset + piece.length });
      offset += piece.length;
    }
  }
  return { ...result, tokens, tokeniserVersion: `${result.tokeniserVersion}+${segmenter.name}@${segmenter.version}` };
}

/** Build the canonical vocabulary from pack lexemes (simplified + traditional). */
export function vocabularyFrom(
  lexemes: { id: string; simplified: string; traditional?: string }[],
): Vocabulary {
  const vocabulary: Vocabulary = new Map();
  for (const lexeme of lexemes) {
    vocabulary.set(lexeme.simplified.normalize("NFC"), lexeme.id);
    if (lexeme.traditional) vocabulary.set(lexeme.traditional.normalize("NFC"), lexeme.id);
  }
  return vocabulary;
}
