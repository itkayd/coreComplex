/**
 * Canonical language model (spec p.15): "Language objects are a graph, not a
 * deck." Six node kinds and ten edge kinds. Released packs are immutable;
 * corrections create a new pack version (VERSION RULE, p.15), so every node
 * carries the packVersion it came from.
 */
import type {
  CharacterId,
  LexemeId,
  PackVersion,
  SentenceId,
} from "./ids.ts";
import type { Skill } from "./skills.ts";

export const EDGE_TYPES = [
  "PREREQUISITE",
  "CONTAINS",
  "SENSE_OF",
  "PHONETIC_FAMILY",
  "SEMANTIC_COMPONENT",
  "CONFUSABLE",
  "SUPPORT",
  "INTERFERENCE",
  "EXAMPLE_OF",
  "EXTERNAL_MAPPING",
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

export interface Edge {
  type: EdgeType;
  from: string;
  to: string;
  /** Optional strength in [0,1] for SUPPORT / INTERFERENCE / CONFUSABLE. */
  weight?: number;
}

/** LEXEME node — simplified, traditional, pinyin, senses, POS, frequency. */
export interface Lexeme {
  id: LexemeId;
  simplified: string;
  traditional?: string;
  pinyin: string;
  senses: string[];
  pos: string;
  /** Zipf-style frequency prior (higher = more common). */
  frequency: number;
  packVersion: PackVersion;
  /** Assets required before this lexeme may be taught in a given skill. */
  requiresHumanAudioFor?: Skill[];
}

/** SENTENCE node — tokens, alternatives, provenance, audio and difficulty. */
export interface Sentence {
  id: SentenceId;
  text: string;
  tokens: LexemeId[];
  gloss: string;
  hasHumanAudio: boolean;
  difficulty: number;
  packVersion: PackVersion;
}

export interface Character {
  id: CharacterId;
  codepoint: string;
  strokes: number;
  components: CharacterId[];
  packVersion: PackVersion;
}

/**
 * PRONUNCIATION node (ADR-0009): syllable, tone, region, sandhi metadata and
 * speaker/audio association. Evidence/explanation only — never a new scheduler
 * dimension (spec §14).
 */
export interface Pronunciation {
  id: string;
  lexeme: LexemeId;
  syllable: string;
  /**
   * Primary (first-syllable) lexical tone, kept for quick display.
   * For anything that reasons about pronunciation, use `tones`.
   */
  tone: 1 | 2 | 3 | 4 | 5;
  /**
   * Lexical tone of EVERY syllable, in order: 银行 (yín háng) is [2, 2].
   * A single tone cannot describe a multi-syllable word, and tone sequence is
   * exactly what sandhi rules and pronunciation evidence need.
   */
  tones: (1 | 2 | 3 | 4 | 5)[];
  region: string; // e.g. "zh-CN"
  /** Contextual tone-sandhi notes, e.g. "third-tone sandhi before third tone". */
  sandhi?: string;
  /** Canonical human-recorded audio asset id, if any (spec p.21). */
  audioAssetId?: string;
  speaker?: string;
  packVersion: PackVersion;
}

/**
 * GRAMMAR ATOM node (ADR-0009): form, function, prerequisites, contexts and
 * examples. Explanation/eligibility metadata, not a scheduler dimension.
 */
export interface GrammarAtom {
  id: string;
  form: string;
  function: string;
  prerequisites: string[];
  contexts: string[];
  examples: SentenceId[];
  packVersion: PackVersion;
}

/**
 * The read-only graph the kernel queries during planning and frontier
 * admission. It never mutates; a new pack version means a new Graph.
 */
export class LanguageGraph {
  readonly lexemes = new Map<string, Lexeme>();
  readonly sentences = new Map<string, Sentence>();
  readonly pronunciations = new Map<string, Pronunciation>();
  readonly grammarAtoms = new Map<string, GrammarAtom>();
  private readonly edges: Edge[] = [];
  private readonly outByType = new Map<string, Edge[]>();

  addLexeme(l: Lexeme): this {
    this.lexemes.set(l.id, l);
    return this;
  }
  addSentence(s: Sentence): this {
    this.sentences.set(s.id, s);
    return this;
  }
  addPronunciation(p: Pronunciation): this {
    this.pronunciations.set(p.id, p);
    return this;
  }
  addGrammarAtom(g: GrammarAtom): this {
    this.grammarAtoms.set(g.id, g);
    return this;
  }
  pronunciationOf(lexeme: string): Pronunciation | undefined {
    for (const p of this.pronunciations.values()) if (p.lexeme === lexeme) return p;
    return undefined;
  }
  addEdge(e: Edge): this {
    this.edges.push(e);
    const key = `${e.type}:${e.from}`;
    const list = this.outByType.get(key) ?? [];
    list.push(e);
    this.outByType.set(key, list);
    return this;
  }

  private out(type: EdgeType, from: string): Edge[] {
    return this.outByType.get(`${type}:${from}`) ?? [];
  }

  prerequisitesOf(id: string): string[] {
    return this.out("PREREQUISITE", id).map((e) => e.to);
  }
  supportsOf(id: string): Edge[] {
    return this.out("SUPPORT", id);
  }
  interferenceOf(id: string): Edge[] {
    return this.out("INTERFERENCE", id);
  }
  confusablesOf(id: string): Edge[] {
    return this.out("CONFUSABLE", id);
  }

  allLexemes(): Lexeme[] {
    // Deterministic order — sorted by id — so planning/frontier are stable.
    return [...this.lexemes.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
  }
}
