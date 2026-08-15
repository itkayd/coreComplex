/**
 * HSK progress — a REPORT, never an input to scheduling.
 *
 * The specification is explicit on this: HSK "never decides readiness" (p.9) and
 * HSK reporting is kept separate (p.28). Nothing in this file is read by the
 * planner, the frontier or the scheduler. It answers a question the learner
 * genuinely has — "how far through HSK am I, and what is next?" — by looking at
 * memory state that was decided entirely without reference to HSK.
 *
 * Band membership is loaded lazily from `packs/hsk-bands.json`, so the 59 KB of
 * word lists never sits in the app bundle or delays a session.
 *
 * The honest part of this view is the fourth bucket. Dyr can only teach what is
 * in the installed content pack, and the pack is 60 words against HSK's 10,969.
 * A progress screen that quietly counted only teachable words would imply the
 * remaining thousands do not exist. They do, and they are shown.
 */
import { traceId, type LexemeId, type Skill } from "@dyr/domain";
import type { DyrKernel } from "@dyr/kernel";
import { isRetained } from "@dyr/kernel";
import type { RuntimePack } from "@dyr/content/runtime";

export type HskScheme = "new" | "old";

export interface HskBandData {
  schemes: Record<HskScheme, { label: string; note: string }>;
  attribution: { what: string; source: string; url: string; licence: string; holder: string; note?: string }[];
  counts: Record<HskScheme, Record<string, number>>;
  bands: Record<HskScheme, Record<string, string>>;
}

let cached: HskBandData | undefined;
let inflight: Promise<HskBandData | undefined> | undefined;

/** Load the band lists once. Returns undefined if unavailable — never throws. */
export async function loadHskBands(baseUrl: string): Promise<HskBandData | undefined> {
  if (cached) return cached;
  inflight ??= (async () => {
    try {
      const res = await fetch(`${baseUrl}hsk-bands.json`);
      if (!res.ok) return undefined;
      const data = (await res.json()) as HskBandData;
      if (!data?.bands?.new || !data?.bands?.old) return undefined;
      cached = data;
      return data;
    } catch {
      return undefined;
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}

/**
 * Where one word stands.
 *
 * `known` is deliberately strict: it means the trace has reached review state,
 * i.e. it survived a real interval. A word answered correctly once is `learning`,
 * because getting it right while it is still fresh is not yet knowing it.
 */
export type WordState = "known" | "learning" | "available" | "unavailable";

export interface WordProgress {
  word: string;
  state: WordState;
  lexemeId?: string;
  pinyin?: string;
  gloss?: string;
}

export interface BandProgress {
  band: string;
  label: string;
  total: number;
  known: number;
  learning: number;
  available: number;
  /** In HSK, but no content pack teaches it yet. */
  unavailable: number;
  words: WordProgress[];
}

export interface HskProgress {
  scheme: HskScheme;
  schemeLabel: string;
  bands: BandProgress[];
  total: number;
  known: number;
  learning: number;
  available: number;
  unavailable: number;
  /** Words the learner knows that are not in this HSK scheme at all. */
  offList: number;
}

const bandLabel = (scheme: HskScheme, band: string): string =>
  scheme === "new" && band === "7" ? "HSK 7–9" : `HSK ${band}`;

/**
 * Compute progress for one scheme.
 *
 * `skill` selects which channel counts as knowing. Reading is the default
 * because it is the channel the current pack can actually open; the four traces
 * stay independent, and this never merges them into one number.
 */
export function computeHskProgress(
  data: HskBandData,
  pack: RuntimePack,
  kernel: DyrKernel,
  scheme: HskScheme,
  skill: Skill = "reading",
): HskProgress {
  // simplified form → the pack's lexeme, so HSK words can be matched to content.
  const byForm = new Map<string, RuntimePack["lexemes"][number]>();
  for (const lexeme of pack.lexemes) byForm.set(lexeme.simplified.normalize("NFC"), lexeme);

  const stateOf = (lexemeId: LexemeId): WordState => {
    const trace = kernel.traces.get(traceId(lexemeId, skill));
    if (!trace || trace.state === "new") return "available";
    return isRetained(trace) ? "known" : "learning";
  };

  const inScheme = new Set<string>();
  const bands: BandProgress[] = [];

  for (const band of Object.keys(data.bands[scheme]).sort()) {
    const words = data.bands[scheme][band].split(" ").filter((w) => w.length > 0);
    const progress: WordProgress[] = [];
    let known = 0, learning = 0, available = 0, unavailable = 0;

    for (const word of words) {
      inScheme.add(word);
      const lexeme = byForm.get(word);
      if (!lexeme) {
        unavailable++;
        progress.push({ word, state: "unavailable" });
        continue;
      }
      const state = stateOf(lexeme.id);
      if (state === "known") known++;
      else if (state === "learning") learning++;
      else available++;
      progress.push({
        word,
        state,
        lexemeId: String(lexeme.id),
        pinyin: lexeme.pinyin,
        gloss: lexeme.senses[0],
      });
    }

    bands.push({
      band,
      label: bandLabel(scheme, band),
      total: words.length,
      known, learning, available, unavailable,
      words: progress,
    });
  }

  // Words the learner knows that this scheme does not list at all — real
  // knowledge that would otherwise be invisible on this screen.
  let offList = 0;
  for (const lexeme of pack.lexemes) {
    if (inScheme.has(lexeme.simplified.normalize("NFC"))) continue;
    if (stateOf(lexeme.id) === "known") offList++;
  }

  const sum = (pick: (b: BandProgress) => number) => bands.reduce((a, b) => a + pick(b), 0);
  return {
    scheme,
    schemeLabel: data.schemes[scheme].label,
    bands,
    total: sum((b) => b.total),
    known: sum((b) => b.known),
    learning: sum((b) => b.learning),
    available: sum((b) => b.available),
    unavailable: sum((b) => b.unavailable),
    offList,
  };
}

/**
 * The band the learner is working on: the first that is not finished.
 *
 * "Finished" means every word the pack can teach in that band is known. It does
 * NOT mean the whole band is known — that would be impossible while most of the
 * band has no content, and it would leave the view permanently stuck on HSK 1.
 */
export function currentBand(progress: HskProgress): BandProgress | undefined {
  return progress.bands.find((b) => b.known < b.known + b.learning + b.available) ?? progress.bands[0];
}
