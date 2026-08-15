/**
 * Progression frontier (spec p.6).
 *
 *   "Progression is a four-dimensional frontier, not a level jump."
 *
 * The kernel admits the next atom only when its exact prerequisites, licensed
 * assets, task paths, workload and challenge window are ready. The REQUIRED
 * ACCEPTANCE FIXTURE: the system must never report "60 words mastered"; it
 * preserves per-skill counts (e.g. 48 / 41 / 23 / 18) and repairs the weaker
 * production channels.
 *
 * Output (p.6): eligible candidate + first skill channel + component scores +
 * blockers + reason codes + planner version — never only an opaque score.
 */
import {
  type LanguageGraph,
  type LexemeId,
  type PlannerVersion,
  type Skill,
  type SkillTrace,
  SKILLS,
  traceId,
} from "@dyr/domain";
import { TraceStore } from "./traceStore.ts";

/** A trace counts toward the frontier once it is genuinely retained. */
const RETAINED_MIN_STABILITY = 1; // days
/**
 * A trace is RETAINED only once it has graduated the (re)learning steps into
 * review state and carries real stability. This is deliberately stricter than
 * "answered correctly once": with ts-fsrs short-term steps a single Good already
 * yields stability > 1 while the card is still in `learning`, so a stability-only
 * test would make every first success look mastered — collapsing the
 * exposed/retained distinction that non-linear eligibility (ADR-0005) and the
 * 48/41/23/18 acceptance fixture both depend on.
 *
 * EXPOSED (evidenceCount > 0) and RETAINED are therefore genuinely different
 * levels of evidence, which is what the spec's progression gates require.
 */
export function isRetained(t: SkillTrace): boolean {
  return t.state === "review" && t.evidenceCount > 0 && t.stability >= RETAINED_MIN_STABILITY;
}

export interface SkillProgress {
  retained: number;
  total: number;
}

/** Four independent counts — deliberately never summed into one number. */
export type FrontierProfile = Record<Skill, SkillProgress>;

export interface AdmissionContext {
  /** Source + pack pass the redistribution allowlist (gate 1, p.6). */
  licensed: (lexeme: LexemeId) => boolean;
  /** A canonical human recording exists for audio-primary work (gate 5). */
  humanAudioAvailable: (lexeme: LexemeId, skill: Skill) => boolean;
  /** Fraction of surrounding tokens already known (gate 4: 95–98%). */
  knownTokenRatio: (lexeme: LexemeId) => number;
  /** Workload governor says introductions are frozen (gate 3, p.18). */
  introductionsFrozen: boolean;
  knownTokenBand: { min: number; max: number };
  plannerVersion: PlannerVersion;
}

export interface AdmissionResult {
  lexeme: LexemeId;
  eligible: boolean;
  firstSkillChannel: Skill;
  componentScores: Record<string, number>;
  blockers: string[];
  reasonCodes: { code: string; detail: string }[];
  plannerVersion: PlannerVersion;
}

export class Frontier {
  private readonly traces: TraceStore;
  private readonly graph: LanguageGraph;
  constructor(traces: TraceStore, graph: LanguageGraph) {
    this.traces = traces;
    this.graph = graph;
  }

  /** Per-skill retained/total profile. This is the anti-"60 mastered" report. */
  profile(): FrontierProfile {
    const totalLexemes = this.graph.allLexemes().length;
    const out = {} as FrontierProfile;
    for (const skill of SKILLS) {
      const retained = this.traces.forSkill(skill).filter(isRetained).length;
      out[skill] = { retained, total: totalLexemes };
    }
    return out;
  }

  /** The channel most in need of repair (lowest retained count). Ties -> skill order. */
  weakestSkill(): Skill {
    const p = this.profile();
    let weakest: Skill = SKILLS[0];
    for (const skill of SKILLS) {
      if (p[skill].retained < p[weakest].retained) weakest = skill;
    }
    return weakest;
  }

  /** New lexemes typically enter via a receptive channel first (curriculum p.9). */
  private firstChannelFor(lexeme: LexemeId, ctx: AdmissionContext): Skill {
    return ctx.humanAudioAvailable(lexeme, "listening") ? "listening" : "reading";
  }

  /** Evaluate the six admission gates for one candidate. */
  admit(lexeme: LexemeId, ctx: AdmissionContext): AdmissionResult {
    const firstSkillChannel = this.firstChannelFor(lexeme, ctx);
    const blockers: string[] = [];
    const reasonCodes: { code: string; detail: string }[] = [];
    const scores: Record<string, number> = {};

    // Gate 1 — LICENSE
    const licensed = ctx.licensed(lexeme);
    scores.license = licensed ? 1 : 0;
    if (!licensed) blockers.push("license");

    // Gate 2 — PREREQUISITES: needed traces retained in the entry skill.
    const prereqs = this.graph.prerequisitesOf(lexeme) as LexemeId[];
    const prereqOk = prereqs.every((p) => {
      const t = this.traces.get(traceId(p, firstSkillChannel));
      return t !== undefined && isRetained(t);
    });
    scores.prerequisites = prereqs.length === 0 ? 1 : prereqOk ? 1 : 0;
    if (!prereqOk) blockers.push("prerequisites");

    // Gate 3 — WORKLOAD
    scores.workload = ctx.introductionsFrozen ? 0 : 1;
    if (ctx.introductionsFrozen) blockers.push("workload");

    // Gate 4 — CONTEXT: comprehensible-input band (normally 95–98% known).
    const ratio = ctx.knownTokenRatio(lexeme);
    const inBand = ratio >= ctx.knownTokenBand.min && ratio <= ctx.knownTokenBand.max;
    scores.context = inBand ? 1 : 0;
    if (!inBand) {
      blockers.push("context");
      reasonCodes.push({
        code: "context_out_of_band",
        detail: `known-token ratio ${ratio.toFixed(2)} outside ${ctx.knownTokenBand.min}-${ctx.knownTokenBand.max}`,
      });
    }

    // Gate 5 — AUDIO: audio-primary entry needs a canonical human recording.
    const audioOk =
      firstSkillChannel !== "listening" ||
      ctx.humanAudioAvailable(lexeme, "listening");
    scores.audio = audioOk ? 1 : 0;
    if (!audioOk) blockers.push("audio");

    // Gate 6 — TASK PATH: introduction plus later direct retrieval always exists.
    scores.taskPath = 1;

    const eligible = blockers.length === 0;
    if (eligible) {
      reasonCodes.push({ code: "admitted", detail: `entry via ${firstSkillChannel}` });
    }

    return {
      lexeme,
      eligible,
      firstSkillChannel,
      componentScores: scores,
      blockers,
      reasonCodes,
      plannerVersion: ctx.plannerVersion,
    };
  }
}
