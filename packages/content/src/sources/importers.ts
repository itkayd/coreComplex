/**
 * Local-file importers: CC-CEDICT, human-audio candidates, Tatoeba exports.
 *
 * All three read from `sources/inbox/` and require no network. Each returns a
 * report rather than throwing on absence — a missing source is a state to
 * describe, not a build failure.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseCedict, type CedictEntry, type CedictParseReport } from "../import/cedict.ts";
import { decodeWav, screenAudio, type ScreeningResult } from "../audio-analysis.ts";
import { classifyUpstream, runAudioQa, type AudioAsset, type AudioProvenance } from "../audio.ts";
import { licenceGate, type SourceAsset } from "../index.ts";
import {
  DEFAULT_INBOX, fileForRole, inspectSource, readTextMaybeGzip, resolveInside,
  type SourceStatus,
} from "./inbox.ts";

// ---------------------------------------------------------------------------
// CC-CEDICT
// ---------------------------------------------------------------------------

export const CEDICT_SOURCE_ID = "cc-cedict";
export const CEDICT_ROLE = "dictionary";

export interface CedictImportReport {
  installed: boolean;
  status: SourceStatus;
  sha256?: string;
  parsed?: CedictParseReport;
  /** Entries indexed by simplified headword. */
  entries: CedictEntry[];
  message: string;
}

export function importCedict(inboxDir = DEFAULT_INBOX): CedictImportReport {
  const status = inspectSource(CEDICT_SOURCE_ID, inboxDir);
  if (status.state !== "ready") {
    return {
      installed: false,
      status,
      entries: [],
      message: [
        "CC-CEDICT source not installed.",
        `Place the downloaded CC-CEDICT file in:`,
        `  ${join(inboxDir, CEDICT_SOURCE_ID)}/`,
        "Then run:",
        "  npm run content:import:cedict",
        ...(status.issues.length > 0 ? ["", "Problems:", ...status.issues.map((i) => `  - ${i}`)] : []),
      ].join("\n"),
    };
  }

  const file = fileForRole(status, CEDICT_ROLE) ?? status.files[0];
  const parsed = parseCedict(readTextMaybeGzip(file.absolutePath));
  return {
    installed: true,
    status,
    sha256: file.sha256,
    parsed,
    entries: parsed.entries,
    message: `CC-CEDICT: ${parsed.entries.length} entries parsed, ${parsed.rejected.length} rejected (sha256 ${file.sha256.slice(0, 12)}…)`,
  };
}

// ---------------------------------------------------------------------------
// Human audio candidates (provider-agnostic)
// ---------------------------------------------------------------------------

export const AUDIO_SOURCE_ID = "audio";

/**
 * One candidate recording, in a provider-neutral shape.
 *
 * Provider-specific importers (Tatoeba, Wikimedia, a personal recording session)
 * convert their upstream metadata INTO this, so the pipeline is not wired to any
 * one provider.
 */
export interface AudioCandidate {
  /** Path relative to the audio source directory, e.g. "files/bank.n.01.wav". */
  file: string;
  /** Dyr lexeme (or sentence) this recording is for. */
  lexemeId?: string;
  sentenceId?: string;
  /** What the recording actually says. */
  transcript: string;
  language: string;
  region?: string;
  speaker?: string;
  /** Where the recording came from. Recorded verbatim, never defaulted. */
  source: string;
  /**
   * Approved-family classification. When omitted it is inferred from `source`;
   * when `source` matches no known family it stays absent rather than being
   * guessed. It is never silently set to "original-recording".
   */
  upstreamFamily?: AudioAsset["upstream"];
  upstreamId?: string;
  upstreamUrl?: string;
  /** AUDIO licence — separate from any sentence licence. */
  licenseSpdx: string;
  licenseUrl?: string;
  attributionText?: string;
  redistributionAllowed: boolean;
  derivativeAllowed: boolean;
  /** Expected hash, verified against the bytes when supplied. */
  sha256?: string;
  /** Syllable count, used to screen duration against the transcript. */
  syllables?: number;
  /**
   * Marks a development/test recording. Flagged assets are refused by the
   * production pack build; only the fixture builder opts in to them.
   */
  fixture?: boolean;
}

export type AudioRejectionCode =
  | "file_missing"
  | "file_path_escape"
  | "hash_mismatch"
  | "unreadable_audio"
  | "licence_missing"
  | "licence_not_redistributable"
  | "licence_non_commercial"
  | "licence_no_derivatives"
  | "licence_conflicts_with_batch"
  | "no_target"
  | "signal_screening_failed";

export interface AudioCandidateResult {
  candidate: AudioCandidate;
  accepted: boolean;
  rejections: AudioRejectionCode[];
  detail: string[];
  sha256?: string;
  durationMs?: number;
  screening?: ScreeningResult;
  /**
   * The verified-contained path the bytes were read from. Carried here so no
   * caller has to re-join an untrusted relative path and re-open the escape.
   */
  absolutePath?: string;
  byteLength?: number;
  /** Present only when accepted: a human-provenance asset, never synthetic. */
  asset?: AudioAsset;
}

export interface AudioImportReport {
  installed: boolean;
  status: SourceStatus;
  results: AudioCandidateResult[];
  accepted: AudioCandidateResult[];
  message: string;
}

/**
 * Ingest human-audio candidates.
 *
 * `transcodingAllowed` matters legally: an ND licence permits redistribution but
 * forbids derivatives, so normalising or transcoding such a clip would breach the
 * terms. We therefore reject ND rather than quietly shipping an unmodified file
 * through a pipeline that assumes it may transform audio.
 */
export function importAudioCandidates(inboxDir = DEFAULT_INBOX): AudioImportReport {
  const status = inspectSource(AUDIO_SOURCE_ID, inboxDir);
  if (status.state !== "ready") {
    return {
      installed: false, status, results: [], accepted: [],
      message: [
        "Human audio candidates not installed.",
        `Create ${join(inboxDir, AUDIO_SOURCE_ID)}/ containing:`,
        "  manifest.json          provenance for the batch",
        "  candidates.json        the per-recording metadata array",
        "  files/…                the recordings (PCM WAV)",
        "Then run:",
        "  npm run content:import:audio",
        ...(status.issues.length > 0 ? ["", "Problems:", ...status.issues.map((i) => `  - ${i}`)] : []),
      ].join("\n"),
    };
  }

  const dir = dirname((fileForRole(status, "candidates") ?? status.files[0]).absolutePath);
  const candidatesFile = fileForRole(status, "candidates") ?? status.files[0];
  let candidates: AudioCandidate[];
  try {
    const parsed = JSON.parse(readFileSync(candidatesFile.absolutePath, "utf8"));
    candidates = Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return {
      installed: true, status, results: [], accepted: [],
      message: `candidates file is not valid JSON: ${(error as Error).message}`,
    };
  }

  const results = candidates.map((candidate) => evaluateAudioCandidate(candidate, dir, status.manifest));
  const accepted = results.filter((r) => r.accepted);
  return {
    installed: true, status, results, accepted,
    message: `Audio: ${candidates.length} candidates, ${accepted.length} accepted, ${results.length - accepted.length} rejected`,
  };
}

/**
 * Evaluate one candidate: rights, then bytes, then signal.
 *
 * `batch` is the source manifest covering the whole drop. It is deliberately NOT
 * a source of rights: a broad batch grant must not upgrade an individual
 * recording whose own terms are narrower, and a recording claiming a right the
 * batch denies is a contradiction to escalate, not to resolve automatically.
 */
export function evaluateAudioCandidate(
  candidate: AudioCandidate,
  baseDir: string,
  batch?: { licenseSpdx?: string; redistributionAllowed?: boolean; derivativeAllowed?: boolean },
): AudioCandidateResult {
  const rejections: AudioRejectionCode[] = [];
  const detail: string[] = [];

  // --- licence, decided before a byte is read ---
  const spdx = (candidate.licenseSpdx ?? "").trim();
  if (spdx.length === 0 || /unknown/i.test(spdx)) {
    rejections.push("licence_missing");
    detail.push("audio licence is absent — rights are never inferred from the batch manifest or the sentence licence");
  } else {
    if (/-NC/i.test(spdx)) { rejections.push("licence_non_commercial"); detail.push(`NC licence: ${spdx}`); }
    if (/-ND/i.test(spdx)) {
      rejections.push("licence_no_derivatives");
      detail.push(`ND licence: ${spdx} — the audio pipeline normalises/transcodes, which a no-derivatives licence forbids`);
    }
    if (!candidate.redistributionAllowed) {
      rejections.push("licence_not_redistributable");
      detail.push("this recording does not grant redistribution");
    }
    // A recording claiming MORE than the batch it arrived in is a contradiction.
    if (batch) {
      if (candidate.redistributionAllowed && batch.redistributionAllowed === false) {
        rejections.push("licence_conflicts_with_batch");
        detail.push("recording claims redistribution but the batch manifest denies it — human review required");
      }
      if (candidate.derivativeAllowed && batch.derivativeAllowed === false) {
        rejections.push("licence_conflicts_with_batch");
        detail.push("recording claims derivative rights but the batch manifest denies them — human review required");
      }
    }
  }

  if (!candidate.lexemeId && !candidate.sentenceId) {
    rejections.push("no_target");
    detail.push("candidate names neither a lexemeId nor a sentenceId");
  }

  // --- bytes ---
  // The candidates file is operator-supplied, sometimes machine-generated from an
  // upstream export, so its paths are untrusted: resolve inside the source tree
  // or refuse to read at all.
  const resolved = resolveInside(baseDir, candidate.file ?? "");
  let sha256: string | undefined;
  let screening: ScreeningResult | undefined;
  let durationMs: number | undefined;
  let absolutePath: string | undefined;
  let byteLength: number | undefined;

  if (!resolved.ok) {
    rejections.push("file_path_escape");
    detail.push(resolved.reason);
  } else if (!existsSync(resolved.absolutePath) || !statSync(resolved.absolutePath).isFile()) {
    rejections.push("file_missing");
    detail.push(`missing file: ${candidate.file}`);
  } else {
    const bytes = readFileSync(resolved.absolutePath);
    absolutePath = resolved.absolutePath;
    byteLength = bytes.byteLength;
    sha256 = createHash("sha256").update(bytes).digest("hex");
    if (candidate.sha256 && candidate.sha256.toLowerCase() !== sha256) {
      rejections.push("hash_mismatch");
      detail.push(`hash mismatch: declared ${candidate.sha256}, actual ${sha256}`);
    }
    try {
      screening = screenAudio(decodeWav(new Uint8Array(bytes)), {
        syllables: candidate.syllables ?? Math.max(1, [...candidate.transcript].filter((c) => /[一-鿿]/.test(c)).length),
      });
      durationMs = Math.round(screening.metrics.durationMs);
      if (!screening.passed) {
        rejections.push("signal_screening_failed");
        detail.push(...screening.failures.map((f) => `signal: ${f}`));
      }
    } catch (error) {
      rejections.push("unreadable_audio");
      detail.push(`cannot decode (PCM WAV expected): ${(error as Error).message}`);
    }
  }

  if (rejections.length > 0) {
    return { candidate, accepted: false, rejections, detail, sha256, durationMs, screening, absolutePath, byteLength };
  }

  // Accepted: a HUMAN asset carrying its real origin. `synthetic` is absent by
  // construction, so this can never be confused with CosyVoice output.
  const provenance: AudioProvenance = {
    sourceName: candidate.source,
    upstream: candidate.upstreamFamily ?? classifyUpstream(candidate.source),
    upstreamId: candidate.upstreamId,
    upstreamUrl: candidate.upstreamUrl,
    licenseSpdx: candidate.licenseSpdx,
    licenseUrl: candidate.licenseUrl,
    attributionText: candidate.attributionText,
    speaker: candidate.speaker,
    region: candidate.region,
    language: candidate.language,
    sourceSha256: sha256!,
    fixture: candidate.fixture,
  };
  const asset: AudioAsset = {
    id: `audio:${candidate.lexemeId ?? candidate.sentenceId}`,
    lexeme: candidate.lexemeId ?? candidate.sentenceId!,
    transcript: candidate.transcript,
    state: "unverified", // becomes `verified` only after the human review
    upstream: provenance.upstream,
    upstreamId: candidate.upstreamId,
    licenseSpdx: candidate.licenseSpdx,
    speaker: candidate.speaker,
    region: candidate.region,
    sha256,
    durationMs,
    provenance,
  };
  return { candidate, accepted: true, rejections: [], detail, sha256, durationMs, screening, absolutePath, byteLength, asset };
}

/**
 * Promote a screened candidate to canonical using a reviewer's declarations.
 *
 * Kept separate from ingestion so no importer can self-certify: passing objective
 * signal screening says a recording is clean, not that it is human, correctly
 * transcribed, correctly segmented, or clear of licence and consent problems.
 *
 * When `review` is supplied its `audioSha256` MUST equal the candidate's actual
 * hash. A review of different bytes is not a weaker signal — it is not evidence
 * about this recording at all, so it is refused outright.
 */
export function certifyCandidate(
  result: AudioCandidateResult,
  human: { humanRecorded: boolean; transcriptMatches: boolean; segmentationVerified: boolean; licenceAndConsentClear: boolean },
  review?: { audioSha256: string; reviewedBy: string; reviewedAt: string; notes?: string },
): { asset?: AudioAsset; state: string; failures: string[] } {
  if (!result.accepted || !result.asset || !result.screening) {
    return { state: "rejected", failures: ["candidate did not pass ingestion"] };
  }
  if (review && review.audioSha256.toLowerCase() !== (result.sha256 ?? "").toLowerCase()) {
    return {
      state: "unverified",
      failures: [`review_hash_mismatch: review covers ${review.audioSha256.slice(0, 12)}…, candidate is ${(result.sha256 ?? "none").slice(0, 12)}…`],
    };
  }
  const qa = runAudioQa({
    asset: result.asset,
    humanRecorded: human.humanRecorded,
    transcriptMatches: human.transcriptMatches,
    segmentationVerified: human.segmentationVerified,
    clean: true,
    naturalPace: true,
    licenceAndConsentClear: human.licenceAndConsentClear,
    screening: { passed: result.screening.passed, failures: result.screening.failures },
  });
  return {
    asset: qa.state === "verified"
      ? {
          ...result.asset,
          state: "verified",
          review: review
            ? { audioSha256: review.audioSha256.toLowerCase(), reviewedBy: review.reviewedBy, reviewedAt: review.reviewedAt, notes: review.notes }
            : undefined,
        }
      : undefined,
    state: qa.state,
    failures: qa.failures,
  };
}

// ---------------------------------------------------------------------------
// Tatoeba local exports
// ---------------------------------------------------------------------------

export const TATOEBA_SOURCE_ID = "tatoeba";

export interface TatoebaSentence {
  id: string;
  language: string;
  text: string;
  /** Contributor username from `sentences_detailed.csv`, when supplied. */
  contributor?: string;
  /** Sentence licence from `sentences_detailed.csv`, when supplied. */
  license?: string;
}

export interface TatoebaAudioRow {
  audioId: string;
  sentenceId: string;
  username?: string;
  /** Audio licence — SEPARATE from the sentence licence. Empty means reject. */
  license?: string;
  attributionUrl?: string;
}

export interface TatoebaImportReport {
  installed: boolean;
  status: SourceStatus;
  mandarinSentences: TatoebaSentence[];
  translations: Map<string, string[]>;
  audioRows: TatoebaAudioRow[];
  /** Audio rows dropped because the AUDIO licence field was empty/unknown. */
  audioRejectedForLicence: number;
  message: string;
}

const splitTsv = (line: string): string[] => line.split("\t");

/**
 * Parse the official Tatoeba exports from local files.
 *
 * Roles the manifest may declare:
 *   `sentences`            sentences.csv            id \t lang \t text
 *   `sentences_detailed`   sentences_detailed.csv   id \t lang \t text \t username \t … \t licence
 *   `links`                links.csv                sentenceId \t translationId
 *   `sentences_with_audio` sentences_with_audio.csv sentenceId \t audioId \t username \t licence \t attributionUrl
 */
export function importTatoeba(inboxDir = DEFAULT_INBOX): TatoebaImportReport {
  const status = inspectSource(TATOEBA_SOURCE_ID, inboxDir);
  const empty = {
    mandarinSentences: [] as TatoebaSentence[],
    translations: new Map<string, string[]>(),
    audioRows: [] as TatoebaAudioRow[],
    audioRejectedForLicence: 0,
  };
  if (status.state !== "ready") {
    return {
      installed: false, status, ...empty,
      message: [
        "Tatoeba exports not installed.",
        `Place the official exports in ${join(inboxDir, TATOEBA_SOURCE_ID)}/ with roles:`,
        "  sentences | sentences_detailed | links | sentences_with_audio",
        "Then run:",
        "  npm run content:import:tatoeba",
        ...(status.issues.length > 0 ? ["", "Problems:", ...status.issues.map((i) => `  - ${i}`)] : []),
      ].join("\n"),
    };
  }

  const byId = new Map<string, TatoebaSentence>();
  const detailed = fileForRole(status, "sentences_detailed");
  const plain = fileForRole(status, "sentences");
  const sentencesFile = detailed ?? plain;

  if (sentencesFile) {
    for (const line of readTextMaybeGzip(sentencesFile.absolutePath).split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      const cols = splitTsv(line);
      if (cols.length < 3) continue;
      const [id, language, text] = cols;
      byId.set(id, {
        id, language, text,
        contributor: detailed ? cols[3] : undefined,
        // sentences_detailed.csv carries the licence in a later column.
        license: detailed ? cols[5] ?? cols[4] : undefined,
      });
    }
  }

  const mandarinSentences = [...byId.values()]
    .filter((s) => s.language === "cmn" || s.language === "zho" || s.language.startsWith("zh"))
    .sort((a, b) => Number(a.id) - Number(b.id));

  const translations = new Map<string, string[]>();
  const links = fileForRole(status, "links");
  if (links) {
    for (const line of readTextMaybeGzip(links.absolutePath).split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      const [from, to] = splitTsv(line);
      const target = byId.get(to);
      if (!target || target.language !== "eng") continue;
      const list = translations.get(from) ?? [];
      list.push(target.text);
      translations.set(from, list);
    }
  }

  const audioRows: TatoebaAudioRow[] = [];
  let audioRejectedForLicence = 0;
  const audioFile = fileForRole(status, "sentences_with_audio");
  if (audioFile) {
    for (const line of readTextMaybeGzip(audioFile.absolutePath).split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      const cols = splitTsv(line);
      if (cols.length < 2) continue;
      const [sentenceId, audioId, username, license, attributionUrl] = cols;
      // AUDIO licence is separate: an absent field is a rejection, never an
      // inheritance from the sentence.
      if (!license || license.trim().length === 0 || /unknown/i.test(license)) {
        audioRejectedForLicence++;
        continue;
      }
      audioRows.push({ audioId, sentenceId, username, license, attributionUrl });
    }
  }

  return {
    installed: true, status, mandarinSentences, translations, audioRows, audioRejectedForLicence,
    message: `Tatoeba: ${mandarinSentences.length} Mandarin sentences, ${translations.size} with English translations, ${audioRows.length} licensed audio rows (${audioRejectedForLicence} audio rows rejected for missing licence)`,
  };
}
