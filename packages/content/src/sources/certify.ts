/**
 * Certification: candidates + reviews → a deterministic canonical audio set.
 *
 * This is the join that was previously missing. Ingestion produced candidates,
 * review produced declarations, and the pack build ignored both and shipped
 * `declared` audio regardless. Certification is where they meet, and it is the
 * ONLY way an `AudioAsset` reaches `verified`.
 *
 * Every step below refuses rather than guesses:
 *   - a candidate targeting an id the pack does not contain cannot count toward
 *     coverage, however good the recording is;
 *   - a transcript that disagrees with the pack's surface form is a mis-filed
 *     recording, not a pronunciation the learner should hear;
 *   - two certified recordings for one lexeme are ambiguous, and picking the
 *     first would make the release depend on file order;
 *   - a review bound to different bytes does not apply.
 *
 * The output is content-addressed: the runtime path is derived from the bytes,
 * so it carries no lexeme id (a cached URL cannot leak a listening answer) and
 * identical recordings deduplicate.
 */
import { extname } from "node:path";
import { certifyCandidate, type AudioCandidateResult, type AudioRejectionCode } from "./importers.ts";
import { loadReviews, reviewFor, staleReviews, type AudioReview, type ReviewStore } from "./review.ts";
import type { AudioAsset, AudioRuntimeRef } from "../audio.ts";

/** Why a candidate did not become canonical. */
export type CertificationCode =
  | AudioRejectionCode
  | "unknown_target"
  | "transcript_mismatch"
  | "duplicate_target"
  | "not_reviewed"
  | "review_hash_mismatch"
  | "review_declined";

export interface CertificationOutcome {
  lexemeId: string;
  file: string;
  sha256?: string;
  certified: boolean;
  codes: CertificationCode[];
  detail: string[];
}

/** One recording, certified and ready to be compiled into a pack. */
export interface CanonicalAudio {
  asset: AudioAsset;
  /** Absolute path to the bytes, used only by the offline build. */
  absolutePath: string;
}

export interface CanonicalAudioSet {
  /** Certified recordings, keyed by lexeme id, in deterministic id order. */
  entries: CanonicalAudio[];
  outcomes: CertificationOutcome[];
  /** Lexemes in the target list with no certified recording. */
  missing: string[];
  /** Lexeme ids with more than one certified candidate — a refusal, not a pick. */
  duplicates: string[];
  /** Reviews whose bytes are no longer among the candidates. */
  stale: AudioReview[];
  reviewIssues: ReviewStore["issues"];
}

/** What the pack expects: the id and surface form each recording must match. */
export interface CertificationTarget {
  lexemeId: string;
  /** The written form the recording must correspond to. */
  simplified: string;
  /** Accepted alternates, e.g. the traditional form of the same word. */
  variants?: string[];
}

/**
 * Compare a spoken transcript to the pack's expected surface form.
 *
 * Deliberately narrow. Normalisation covers exactly what is safely equivalent
 * for identifying WHICH word was recorded:
 *   - Unicode NFC, so decomposed and composed forms agree;
 *   - whitespace, including the full-width ideographic space;
 *   - CJK punctuation a supplier may have left on the end of a citation form.
 *
 * It does NOT fold simplified and traditional together. 银行 and 銀行 are the
 * same lexeme but different written forms, so the traditional form is accepted
 * only when the pack declares it as a variant — matched, never inferred by
 * conversion. Tone, pinyin and per-syllable tone sequences stay separate
 * concepts on the pronunciation node; nothing here scores pronunciation.
 */
export function normaliseTranscript(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[\s　]+/g, "")
    .replace(/[。，、！？；：""''《》〈〉（）【】.,!?;:"'()\[\]]+/g, "");
}

export function transcriptMatchesTarget(transcript: string, target: CertificationTarget): boolean {
  const actual = normaliseTranscript(transcript);
  const accepted = [target.simplified, ...(target.variants ?? [])].map(normaliseTranscript);
  return accepted.includes(actual);
}

/** Deterministic runtime path: content-addressed, carrying no lexeme id. */
export function runtimeRefFor(sha256: string, bytes: number, sourceFile: string): AudioRuntimeRef {
  const ext = (extname(sourceFile) || ".wav").toLowerCase();
  const mediaType = ext === ".opus" ? "audio/opus" : ext === ".ogg" ? "audio/ogg" : ext === ".mp3" ? "audio/mpeg" : "audio/wav";
  return {
    path: `audio/${sha256}${ext}`,
    sha256,
    bytes,
    mediaType,
    // The bytes are shipped exactly as supplied. Preserving the relationship
    // explicitly means a future normalisation step can set `transform` and a
    // different `sha256` without the provenance record becoming a guess.
    derivedFrom: sha256,
    transform: "none",
  };
}

export interface CertifyOptions {
  /** The lexemes a release must cover. */
  targets: CertificationTarget[];
  /** Loaded review records. */
  reviews: ReviewStore;
}

/**
 * Certify ingested candidates against the pack's targets and the review file.
 *
 * Pure with respect to the filesystem: the caller supplies candidates and
 * reviews, so this is directly testable and the same function serves the CLI,
 * the gate and the tests.
 */
export function certifyAudioSet(results: AudioCandidateResult[], opts: CertifyOptions): CanonicalAudioSet {
  const byId = new Map(opts.targets.map((t) => [t.lexemeId, t]));
  const outcomes: CertificationOutcome[] = [];
  const certifiedByLexeme = new Map<string, CanonicalAudio[]>();

  for (const result of results) {
    const lexemeId = result.candidate.lexemeId ?? result.candidate.sentenceId ?? "";
    const codes: CertificationCode[] = [];
    const detail: string[] = [];
    const record = () => outcomes.push({ lexemeId, file: result.candidate.file, sha256: result.sha256, certified: false, codes, detail });

    if (!result.accepted) {
      codes.push(...result.rejections);
      detail.push(...result.detail);
      record();
      continue;
    }

    // A lexeme-level pack is being built; a sentence recording is a valid asset
    // but cannot stand in for the word it happens to contain.
    const target = result.candidate.lexemeId ? byId.get(result.candidate.lexemeId) : undefined;
    if (!target) {
      codes.push("unknown_target");
      detail.push(result.candidate.sentenceId && !result.candidate.lexemeId
        ? `sentence recording ${result.candidate.sentenceId} cannot satisfy lexeme-level canonical audio`
        : `"${lexemeId}" is not a lexeme in this pack`);
      record();
      continue;
    }

    if (!transcriptMatchesTarget(result.candidate.transcript, target)) {
      codes.push("transcript_mismatch");
      detail.push(`recording says "${result.candidate.transcript}", pack expects "${target.simplified}"`
        + (target.variants?.length ? ` (or ${target.variants.join(", ")})` : ""));
      record();
      continue;
    }

    const review = reviewFor(opts.reviews, target.lexemeId, result.sha256 ?? "");
    if (!review) {
      codes.push("not_reviewed");
      detail.push(`no review bound to ${(result.sha256 ?? "").slice(0, 12)}… — signal QA alone never certifies`);
      record();
      continue;
    }

    const certification = certifyCandidate(result, review, review);
    if (!certification.asset) {
      codes.push(certification.failures.some((f) => f.startsWith("review_hash_mismatch")) ? "review_hash_mismatch" : "review_declined");
      detail.push(...certification.failures);
      record();
      continue;
    }

    const asset: AudioAsset = {
      ...certification.asset,
      runtime: runtimeRefFor(result.sha256!, result.byteLength ?? 0, result.candidate.file),
    };
    const list = certifiedByLexeme.get(target.lexemeId) ?? [];
    // `absolutePath` comes from the containment-checked resolution done at
    // ingestion, so the build never re-joins the untrusted relative path.
    list.push({ asset, absolutePath: result.absolutePath! });
    certifiedByLexeme.set(target.lexemeId, list);
    outcomes.push({ lexemeId: target.lexemeId, file: result.candidate.file, sha256: result.sha256, certified: true, codes: [], detail: [] });
  }

  // Two certified recordings for one lexeme: the release would depend on which
  // one the filesystem listed first. Refuse both and make the reviewer choose by
  // removing a review record.
  const duplicates: string[] = [];
  const entries: CanonicalAudio[] = [];
  for (const [lexemeId, list] of [...certifiedByLexeme].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (list.length > 1) {
      duplicates.push(lexemeId);
      for (const outcome of outcomes) {
        if (outcome.lexemeId === lexemeId && outcome.certified) {
          outcome.certified = false;
          outcome.codes = ["duplicate_target"];
          outcome.detail = [`${list.length} certified recordings for ${lexemeId}; remove all but one review record`];
        }
      }
      continue;
    }
    entries.push(list[0]);
  }

  const certifiedIds = new Set(entries.map((e) => e.asset.lexeme));
  const presentHashes = new Set(results.map((r) => r.sha256 ?? "").filter(Boolean));

  return {
    entries,
    outcomes,
    missing: opts.targets.map((t) => t.lexemeId).filter((id) => !certifiedIds.has(id)).sort(),
    duplicates,
    stale: staleReviews(opts.reviews, presentHashes),
    reviewIssues: opts.reviews.issues,
  };
}

/** Convenience: load reviews from disk and certify. */
export function certifyFromDisk(
  results: AudioCandidateResult[],
  targets: CertificationTarget[],
  reviewDir?: string,
): CanonicalAudioSet {
  return certifyAudioSet(results, { targets, reviews: loadReviews(reviewDir) });
}
