/**
 * Constrained session planner (spec p.18).
 *
 *   "The best next task must also fit the learner's life."
 *
 * Deterministic and explainable: it maximises learning value inside a declared
 * time budget while controlling fatigue, interference and future backlog.
 *
 * Replay test (p.18): same snapshot, events, clock and seed must return the
 * same tasks in the same order with the same explanation. Every non-obvious
 * choice therefore flows through the injected seed, never a global RNG.
 *
 * Output (p.18): ordered TaskContracts, predicted minutes, objective
 * components, rejected candidates, reason codes, planner version and
 * configuration hash.
 */
import {
  type KernelConfig,
  type LanguageGraph,
  type Lexeme,
  type LexemeId,
  type Millis,
  type PackVersion,
  type PlannerVersion,
  type Skill,
  type TaskContract,
  type TaskFamily,
  type TaskId,
  SKILLS,
  isProduction,
  latenessDays,
  mulberry32,
  retrievability,
  traceId,
} from "@dyr/domain";
import { TraceStore } from "./traceStore.ts";
import { isRetained } from "./frontier.ts";

export const PLANNER_VERSION = "dyr-planner@1.0.0" as PlannerVersion;

export interface PlanRequest {
  now: Millis;
  budgetMinutes: number;
  seed: number;
  weakestSkill: Skill;
  /** Lexemes the frontier has admitted for introduction, in priority order. */
  admittedIntroductions: LexemeId[];
  /** Governor decision — when true, zero new items are planned (valid, p.18). */
  introductionsFrozen: boolean;
  packVersion: PackVersion;
}

export interface CandidateScore {
  taskId: TaskId;
  lexeme: LexemeId;
  skill: Skill;
  isNovel: boolean;
  components: Record<string, number>;
  objective: number;
}

export interface RejectedCandidate {
  taskId: TaskId;
  reason: string;
}

export interface Plan {
  tasks: TaskContract[];
  /** Private answer key — held by the kernel, never surfaced to the learner. */
  answers: Map<TaskId, string>;
  predictedMinutes: number;
  objectiveComponents: CandidateScore[];
  rejected: RejectedCandidate[];
  reasonCodes: { code: string; detail: string }[];
  plannerVersion: PlannerVersion;
  configurationHash: string;
}

/** Fixed component weights. Bundled into PLANNER_VERSION for reproducibility. */
const WEIGHTS = {
  retrievabilityRisk: 3.0,
  lateness: 2.0,
  functionalValue: 1.0,
  weakestRepair: 1.5,
  prerequisiteLeverage: 1.2,
  lapseRepair: 2.5,
  evidencePerMinute: 1.0,
} as const;

const EST_SECONDS: Record<"receptive" | "production", number> = {
  receptive: 8,
  production: 15,
};

export class Planner {
  /** lexeme -> how many other lexemes depend on it (transfer leverage). */
  private readonly leverage = new Map<string, number>();
  private readonly traces: TraceStore;
  private readonly graph: LanguageGraph;
  private readonly config: KernelConfig;
  private readonly configHash: string;

  constructor(
    traces: TraceStore,
    graph: LanguageGraph,
    config: KernelConfig,
    configHash: string,
  ) {
    this.traces = traces;
    this.graph = graph;
    this.config = config;
    this.configHash = configHash;
    for (const lex of graph.allLexemes()) {
      for (const pre of graph.prerequisitesOf(lex.id)) {
        this.leverage.set(pre, (this.leverage.get(pre) ?? 0) + 1);
      }
    }
  }

  /**
   * The per-lexeme channel-opening order. A word enters through a receptive
   * channel (listening first when human audio exists, else reading), then the
   * other receptive channel, then production (speaking, writing). This makes
   * progression a four-dimensional frontier (spec p.6) rather than a single
   * track, while keeping each skill's readiness independent (Rule 1).
   */
  private channelOrder(lex: Lexeme): Skill[] {
    const audio = lex.requiresHumanAudioFor?.includes("listening") ?? false;
    return audio
      ? ["listening", "reading", "speaking", "writing"]
      : ["reading", "listening", "speaking", "writing"];
  }

  /**
   * The next channel to open for a lexeme: the first channel in its order that
   * has no retained trace yet, provided the preceding channel is already
   * retained (or it is the entry channel). Returns null when every channel is
   * open, or the predecessor is not yet ready.
   */
  private nextChannelToOpen(lex: Lexeme): Skill | null {
    const order = this.channelOrder(lex);
    for (let i = 0; i < order.length; i++) {
      const skill = order[i];
      const t = this.traces.get(traceId(lex.id, skill));
      const opened = t !== undefined && t.state !== "new";
      if (opened) continue;
      if (i === 0) return skill; // entry channel is always eligible
      const prev = this.traces.get(traceId(lex.id, order[i - 1]));
      return prev !== undefined && isRetained(prev) ? skill : null;
    }
    return null;
  }

  private taskShape(skill: Skill, lex: Lexeme): {
    family: TaskFamily;
    cue: string;
    answer: string;
    requiresHumanAudio: boolean;
  } {
    const meaning = lex.senses[0] ?? lex.simplified;
    switch (skill) {
      case "listening":
        return { family: "audio_to_meaning", cue: `audio:${lex.id}`, answer: meaning, requiresHumanAudio: true };
      case "reading":
        return { family: "hanzi_to_meaning", cue: lex.simplified, answer: meaning, requiresHumanAudio: false };
      case "speaking":
        return { family: "meaning_to_speech", cue: meaning, answer: lex.pinyin, requiresHumanAudio: false };
      case "writing":
        return { family: "meaning_to_typed_word", cue: meaning, answer: lex.simplified, requiresHumanAudio: false };
    }
  }

  private scoreReview(lex: Lexeme, skill: Skill, now: Millis): {
    components: Record<string, number>;
    objective: number;
  } {
    const t = this.traces.ensure(lex.id, skill);
    const r = retrievability(t, now);
    const late = latenessDays(t, now);
    const components = {
      retrievabilityRisk: (1 - r) * WEIGHTS.retrievabilityRisk,
      lateness: Math.min(late, 14) / 14 * WEIGHTS.lateness,
      functionalValue: normFreq(lex.frequency) * WEIGHTS.functionalValue,
      weakestRepair: 0, // filled by caller (needs weakestSkill)
      prerequisiteLeverage:
        Math.min(this.leverage.get(lex.id) ?? 0, 8) / 8 * WEIGHTS.prerequisiteLeverage,
      lapseRepair: t.state === "relearning" ? WEIGHTS.lapseRepair : 0,
      evidencePerMinute: WEIGHTS.evidencePerMinute, // even quality per minute baseline
    };
    return { components, objective: sum(components) };
  }

  plan(req: PlanRequest): Plan {
    const reasonCodes: { code: string; detail: string }[] = [];
    const rejected: RejectedCandidate[] = [];
    const rng = mulberry32(req.seed);

    // --- Build review candidates: any non-new trace at or approaching due. ---
    const soon = req.now + 12 * 3_600_000; // 12h look-ahead window
    const candidates: Array<{
      score: CandidateScore;
      contract: TaskContract;
      answer: string;
    }> = [];

    for (const lex of this.graph.allLexemes()) {
      for (const skill of SKILLS) {
        const id = traceId(lex.id, skill);
        const t = this.traces.get(id);
        if (!t || t.state === "new") continue;
        if (t.due === undefined || t.due > soon) continue;

        const shape = this.taskShape(skill, lex);
        const { components, objective } = this.scoreReview(lex, skill, req.now);
        if (skill === req.weakestSkill) {
          components.weakestRepair = WEIGHTS.weakestRepair;
        }
        const total = sum(components);
        const taskId = `task_${lex.id}_${skill}` as TaskId;
        candidates.push({
          score: { taskId, lexeme: lex.id, skill, isNovel: false, components, objective: total },
          contract: this.buildContract(taskId, lex, skill, shape, false, req),
          answer: shape.answer,
        });
      }
    }

    // --- Build introduction candidates (respecting freeze + novelty ceiling). ---
    let noveltyRemaining = req.introductionsFrozen ? 0 : this.config.noveltyCeiling;
    if (req.introductionsFrozen) {
      reasonCodes.push({ code: "introductions_frozen", detail: "workload governor froze new items" });
    }
    for (const lexId of req.admittedIntroductions) {
      if (noveltyRemaining <= 0) break;
      const lex = this.graph.lexemes.get(lexId);
      if (!lex) continue;
      // Open only the NEXT channel whose predecessor is already retained
      // (curriculum p.9: overlapping phases, each skill its own readiness).
      const skill = this.nextChannelToOpen(lex);
      if (skill === null) continue; // fully opened, or predecessor not ready
      const shape = this.taskShape(skill, lex);
      const components = {
        retrievabilityRisk: WEIGHTS.retrievabilityRisk, // brand new -> maximal risk
        lateness: 0,
        functionalValue: normFreq(lex.frequency) * WEIGHTS.functionalValue,
        weakestRepair: skill === req.weakestSkill ? WEIGHTS.weakestRepair : 0,
        prerequisiteLeverage:
          Math.min(this.leverage.get(lex.id) ?? 0, 8) / 8 * WEIGHTS.prerequisiteLeverage,
        lapseRepair: 0,
        evidencePerMinute: WEIGHTS.evidencePerMinute,
      };
      const taskId = `task_${lex.id}_${skill}_intro` as TaskId;
      candidates.push({
        score: { taskId, lexeme: lex.id, skill, isNovel: true, components, objective: sum(components) },
        contract: this.buildContract(taskId, lex, skill, shape, true, req),
        answer: shape.answer,
      });
      noveltyRemaining--;
    }

    // --- Deterministic ordering: objective desc, then taskId, then seeded jitter. ---
    candidates.sort((a, b) => {
      if (b.score.objective !== a.score.objective) return b.score.objective - a.score.objective;
      if (a.score.taskId < b.score.taskId) return -1;
      if (a.score.taskId > b.score.taskId) return 1;
      return 0;
    });

    // --- Greedy selection under the time budget + diversity + confusable safety. ---
    const budgetSeconds = req.budgetMinutes * 60;
    let usedSeconds = 0;
    let novelUsed = 0;
    const chosen: TaskContract[] = [];
    const answers = new Map<TaskId, string>();
    const objectiveComponents: CandidateScore[] = [];
    const chosenLexemes = new Set<string>();
    const skillRun: Skill[] = [];

    for (const c of candidates) {
      const est = c.contract.estSeconds;

      if (usedSeconds + est > budgetSeconds) {
        rejected.push({ taskId: c.score.taskId, reason: "exceeds_time_budget" });
        continue;
      }
      if (c.score.isNovel && novelUsed >= this.config.noveltyCeiling) {
        rejected.push({ taskId: c.score.taskId, reason: "novelty_ceiling" });
        continue;
      }
      // Confusable safety: never pair a lexeme with its confusable in one session.
      const confusableClash = this.graph
        .confusablesOf(c.score.lexeme)
        .some((e) => chosenLexemes.has(e.to));
      if (confusableClash) {
        rejected.push({ taskId: c.score.taskId, reason: "confusable_pairing" });
        continue;
      }
      // Diversity: avoid a third consecutive task in the same skill.
      const lastTwoSame =
        skillRun.length >= 2 &&
        skillRun[skillRun.length - 1] === c.score.skill &&
        skillRun[skillRun.length - 2] === c.score.skill;
      if (lastTwoSame && rng.next() < 0.5) {
        rejected.push({ taskId: c.score.taskId, reason: "modality_switch_smoothing" });
        continue;
      }

      chosen.push(c.contract);
      answers.set(c.score.taskId, c.answer);
      objectiveComponents.push(c.score);
      chosenLexemes.add(c.score.lexeme);
      skillRun.push(c.score.skill);
      usedSeconds += est;
      if (c.score.isNovel) novelUsed++;
    }

    if (chosen.length === 0) {
      reasonCodes.push({ code: "empty_plan", detail: "no due traces and introductions frozen — valid zero-item plan" });
    } else {
      reasonCodes.push({ code: "planned", detail: `${chosen.length} task(s), ${novelUsed} new` });
    }

    return {
      tasks: chosen,
      answers,
      predictedMinutes: Number((usedSeconds / 60).toFixed(2)),
      objectiveComponents,
      rejected,
      reasonCodes,
      plannerVersion: PLANNER_VERSION,
      configurationHash: this.configHash,
    };
  }

  private buildContract(
    id: TaskId,
    lex: Lexeme,
    skill: Skill,
    shape: { family: TaskFamily; cue: string; requiresHumanAudio: boolean },
    isNovel: boolean,
    req: PlanRequest,
  ): TaskContract {
    return {
      id,
      targetTrace: traceId(lex.id, skill),
      lexeme: lex.id,
      skill,
      family: shape.family,
      cue: shape.cue,
      requiresHumanAudio: shape.requiresHumanAudio,
      estSeconds: isProduction(skill) ? EST_SECONDS.production : EST_SECONDS.receptive,
      isNovel,
      plannerVersion: PLANNER_VERSION,
      packVersion: req.packVersion,
    };
  }
}

function sum(components: Record<string, number>): number {
  return Number(Object.values(components).reduce((a, b) => a + b, 0).toFixed(6));
}

/** Map a Zipf-ish frequency prior into [0,1]. */
function normFreq(freq: number): number {
  return Math.max(0, Math.min(1, freq / 7));
}
