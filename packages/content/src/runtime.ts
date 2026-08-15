/**
 * Browser-safe runtime surface for content.
 *
 * The build pipeline (ingest → … → sign) runs OFFLINE and needs node:crypto;
 * the runtime only ever consumes a finished, signed artefact. Keeping the two
 * apart means a browser bundle never pulls Node built-ins in — and, more
 * importantly, it makes it structurally impossible for a client to re-build or
 * re-sign a pack it is supposed to treat as immutable.
 */
import type {
  Character,
  Edge,
  GrammarAtom,
  Lexeme,
  PackVersion,
  Pronunciation,
} from "@dyr/domain";
import { LanguageGraph } from "@dyr/domain";
import type { AudioAsset } from "./audio.ts";
import type { AttributionEntry, SourceAsset } from "./index.ts";

/** The immutable artefact the runtime consumes. */
export interface RuntimePack {
  packId: string;
  packVersion: PackVersion;
  /** sha256 over the normalised content — changing content changes the version. */
  contentHash: string;
  lexemes: Lexeme[];
  characters: Character[];
  pronunciations: Pronunciation[];
  grammarAtoms: GrammarAtom[];
  edges: Edge[];
  audio: Map<string, AudioAsset>;
  manifest: SourceAsset[];
  attributions: AttributionEntry[];
}

/** Build a LanguageGraph from a runtime pack (the kernel's read model). */
export function packToGraph(pack: RuntimePack): LanguageGraph {
  const g = new LanguageGraph();
  for (const l of pack.lexemes) g.addLexeme(l);
  for (const p of pack.pronunciations) g.addPronunciation(p);
  for (const a of pack.grammarAtoms) g.addGrammarAtom(a);
  for (const e of pack.edges) g.addEdge(e);
  return g;
}
