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
 * The read-only graph the kernel queries during planning and frontier
 * admission. It never mutates; a new pack version means a new Graph.
 */
export class LanguageGraph {
  readonly lexemes = new Map<string, Lexeme>();
  readonly sentences = new Map<string, Sentence>();
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
