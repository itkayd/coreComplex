/**
 * The single entry point the release build uses to obtain canonical audio.
 *
 * Node-only. Reads the inbox and the review file, certifies against the pack's
 * own lexemes, and hands back an explicit set for `buildCore60Pack`. Keeping this
 * out of `pipeline.ts` is deliberate: the compiler stays a pure function of its
 * arguments, and exactly one place decides where audio comes from.
 */
import { CORE60 } from "../packs/core60.data.ts";
import { certifyFromDisk, type CanonicalAudioSet, type CertificationTarget } from "./certify.ts";
import { importAudioCandidates } from "./importers.ts";
import { DEFAULT_INBOX } from "./inbox.ts";
import { DEFAULT_REVIEW_DIR } from "./review.ts";

/** The Core 60 targets, with the traditional form accepted as a variant. */
export function core60Targets(): CertificationTarget[] {
  return CORE60.map((e) => ({
    lexemeId: e.id,
    simplified: e.simplified,
    variants: e.traditional && e.traditional !== e.simplified ? [e.traditional] : [],
  }));
}

export interface ReleaseAudio extends CanonicalAudioSet {
  /** False when no candidates have been supplied — a state, not a failure. */
  installed: boolean;
  message: string;
}

export function loadReleaseAudio(
  opts: { inboxDir?: string; reviewDir?: string } = {},
): ReleaseAudio {
  const imported = importAudioCandidates(opts.inboxDir ?? DEFAULT_INBOX);
  const set = certifyFromDisk(imported.results, core60Targets(), opts.reviewDir ?? DEFAULT_REVIEW_DIR);
  return {
    ...set,
    installed: imported.installed,
    message: imported.installed
      ? `${set.entries.length} certified of ${imported.results.length} candidates`
      : imported.message,
  };
}
