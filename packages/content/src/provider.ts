/**
 * AssetProvider backed by a built RuntimePack (spec §20: content implements the
 * domain provider contract; it never imports the kernel).
 *
 * The honest behaviour that matters here: `hasCanonicalAudio` is true ONLY for a
 * QA-verified human recording. A merely declared clip returns false, so the
 * kernel's plan-time gate refuses audio-primary tasks with
 * `missing_canonical_audio` rather than teaching listening from audio that does
 * not exist.
 */
import type { AssetProvider, LexemeId } from "@dyr/domain";
import { isCanonical } from "./audio.ts";
import type { RuntimePack } from "./pipeline.ts";

export interface ProviderOptions {
  /**
   * Fraction of surrounding tokens already known. The plain receptive slice has
   * no sentence corpus yet, so this is a constant inside the comprehensible-
   * input band (spec p.6: normally 95–98%). It becomes a real computation when
   * graded passages arrive.
   */
  knownTokenRatio?: number;
  /** Whether the pack's text assets are cached for offline use. */
  offline?: boolean;
  /** Rubric versions this build knows about. */
  knownRubricVersions?: readonly string[];
}

export function packAssetProvider(pack: RuntimePack, opts: ProviderOptions = {}): AssetProvider {
  const licensedIds = new Set(pack.manifest.map((a) => a.id));
  const knownTokenRatio = opts.knownTokenRatio ?? 0.96;
  const offline = opts.offline ?? true;
  const rubricVersions = opts.knownRubricVersions;

  return {
    licensed: (lexeme: LexemeId) => licensedIds.has(String(lexeme)),
    hasCanonicalAudio: (lexeme: LexemeId) => isCanonical(pack.audio.get(String(lexeme))),
    // A transcript is only trustworthy once the recording it describes is verified.
    hasTranscript: (lexeme: LexemeId) => isCanonical(pack.audio.get(String(lexeme))),
    // Stroke data ships as a separately-licensed asset (Hanzi Writer, MIT +
    // Arphic); it is not bundled in this pack, so handwriting stays gated.
    hasStrokeData: () => false,
    hasRubric: (_id: string, version: string) =>
      rubricVersions === undefined ? true : rubricVersions.includes(version),
    offlineAvailable: () => offline,
    knownTokenRatio: () => knownTokenRatio,
  };
}
