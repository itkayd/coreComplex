/**
 * fixtures/packs — a tiny, fully-licensed test pack (spec p.25: "tiny licensed
 * test packs and deterministic simulations").
 *
 * Every lexeme here is drawn from CC0 / CC BY-SA style open sources (CC-CEDICT,
 * Unihan), so the whole pack passes the DEFAULT PACK ALLOW list (spec p.7):
 * nothing here is NC, ND, unknown-licence, or scraped commercial content, and
 * nothing derives from Pleco/HSK data. Provenance is explicit per asset, which
 * is what OPEN BY CONSTRUCTION (spec p.7) demands.
 */
import {
  type Lexeme,
  type LexemeId,
  LanguageGraph,
  LexemeId as mkLexemeId,
  PackVersion,
} from "@dyr/domain";
import type { AssetProvider } from "@dyr/kernel";

export const PACK_VERSION = PackVersion("dyr-mini@1.0.0");

/** SPDX ids we accept; used by the admission licence gate below. */
const ALLOWED_LICENCES = new Set(["CC0-1.0", "CC-BY-SA-4.0", "MIT"]);

interface PackEntry extends Omit<Lexeme, "id" | "packVersion"> {
  id: string;
  licence: string; // SPDX, verified against ALLOWED_LICENCES
  hasHumanAudio: boolean;
}

const ENTRIES: PackEntry[] = [
  { id: "hello.n.01", simplified: "你好", pinyin: "nǐ hǎo", senses: ["hello"], pos: "intj", frequency: 6.2, licence: "CC-BY-SA-4.0", hasHumanAudio: true },
  { id: "thanks.v.01", simplified: "谢谢", pinyin: "xiè xie", senses: ["thanks"], pos: "v", frequency: 6.0, licence: "CC-BY-SA-4.0", hasHumanAudio: true },
  { id: "person.n.01", simplified: "人", pinyin: "rén", senses: ["person"], pos: "n", frequency: 6.8, licence: "CC-BY-SA-4.0", hasHumanAudio: true },
  { id: "money.n.01", simplified: "钱", pinyin: "qián", senses: ["money"], pos: "n", frequency: 5.6, licence: "CC-BY-SA-4.0", hasHumanAudio: true },
  { id: "bank.n.01", simplified: "银行", pinyin: "yín háng", senses: ["bank"], pos: "n", frequency: 5.1, licence: "CC-BY-SA-4.0", hasHumanAudio: true },
  { id: "good.a.01", simplified: "好", pinyin: "hǎo", senses: ["good"], pos: "a", frequency: 6.9, licence: "CC-BY-SA-4.0", hasHumanAudio: true },
  { id: "be.v.01", simplified: "是", pinyin: "shì", senses: ["to be"], pos: "v", frequency: 7.0, licence: "CC-BY-SA-4.0", hasHumanAudio: true },
  { id: "matter.n.01", simplified: "事", pinyin: "shì", senses: ["matter", "affair"], pos: "n", frequency: 5.9, licence: "CC-BY-SA-4.0", hasHumanAudio: false },
];

export interface MiniPack {
  graph: LanguageGraph;
  lexemeIds: LexemeId[];
  /** Assets keyed by lexeme, recording licence + human-audio provenance. */
  provenance: Map<string, { licence: string; hasHumanAudio: boolean }>;
}

export function buildMiniPack(): MiniPack {
  const graph = new LanguageGraph();
  const provenance = new Map<string, { licence: string; hasHumanAudio: boolean }>();
  const lexemeIds: LexemeId[] = [];

  for (const e of ENTRIES) {
    const id = mkLexemeId(e.id);
    lexemeIds.push(id);
    provenance.set(e.id, { licence: e.licence, hasHumanAudio: e.hasHumanAudio });
    graph.addLexeme({
      id,
      simplified: e.simplified,
      pinyin: e.pinyin,
      senses: e.senses,
      pos: e.pos,
      frequency: e.frequency,
      packVersion: PACK_VERSION,
      requiresHumanAudioFor: e.hasHumanAudio ? ["listening"] : [],
    });
  }

  // Edges: a prerequisite chain, a support pair and a confusable pair.
  graph.addEdge({ type: "PREREQUISITE", from: "bank.n.01", to: "money.n.01" });
  graph.addEdge({ type: "PREREQUISITE", from: "money.n.01", to: "person.n.01" });
  graph.addEdge({ type: "SUPPORT", from: "hello.n.01", to: "good.a.01", weight: 0.5 });
  graph.addEdge({ type: "CONFUSABLE", from: "be.v.01", to: "matter.n.01", weight: 0.8 });
  graph.addEdge({ type: "CONFUSABLE", from: "matter.n.01", to: "be.v.01", weight: 0.8 });

  // Pronunciation + grammar nodes (ADR-0009): 银行 = yín(2) háng(2), zh-CN.
  graph.addPronunciation({
    id: "bank.n.01.pron", lexeme: mkLexemeId("bank.n.01"), syllable: "yínháng",
    tone: 2, tones: [2, 2], region: "zh-CN", audioAssetId: "audio:bank.n.01", speaker: "cv-zh-001",
    packVersion: PACK_VERSION,
  });
  graph.addGrammarAtom({
    id: "shi-copula", form: "是", function: "copula (A 是 B)", prerequisites: [],
    contexts: ["identification"], examples: [], packVersion: PACK_VERSION,
  });

  return { graph, lexemeIds, provenance };
}

/**
 * AssetProvider for the mini pack. `matter.n.01` deliberately has NO human
 * audio, so any audio-primary task for it must be rejected at plan time with
 * `missing_canonical_audio` (Correction 7).
 */
export function miniAssets(pack: MiniPack): AssetProvider {
  const audio = (lexeme: LexemeId) => pack.provenance.get(lexeme)?.hasHumanAudio ?? false;
  return {
    licensed: (lexeme) => {
      const p = pack.provenance.get(lexeme);
      return p !== undefined && ALLOWED_LICENCES.has(p.licence);
    },
    hasCanonicalAudio: audio,
    hasTranscript: audio,
    hasStrokeData: () => true,
    hasRubric: () => true,
    offlineAvailable: () => true,
    knownTokenRatio: () => 0.96,
  };
}
