/**
 * Constrained session planner (spec p.18; ADR-0005/0006).
 *
 * Deterministic and explainable. Non-linear task eligibility (ADR-0005):
 * each task family declares prerequisites as evidence requirements, so speaking
 * and writing can begin early without waiting for reading to be retained. Every
 * emitted TaskContract passes a per-task asset gate (Correction 7). Failed
 * retrievals produce RepairDirectives that surface as in-session repair tasks
 * (ADR-0003). Retrievability comes only from the FSRS adapter (ADR-0002).
 */
import {
  type FsrsAdapter,
} from "@dyr/fsrs-adapter";
import {
  type KernelConfig,
  type LanguageGraph,
  type Lexeme,
  type LexemeId,
  type Millis,
  type PackVersion,
  type PlannerVersion,
  type RepairDirective,
  type Skill,
  type TaskContract,
  type TaskFamily,
  type TaskId,
  type TaskFamilySpec,
  type CueDirection,
  DEFAULT_TASK_FAMILIES,
  SKILLS,
  latenessDays,
  memoryStateOf,
  mulberry32,
  traceId,
  normalisePinyin,
} from "@dyr/domain";
import { TraceStore } from "./traceStore.ts";
import { isRetained } from "./frontier.ts";
import { buildRubric, RUBRIC_VERSION } from "./rubrics.ts";
import { checkTaskAssets, type AssetProvider, type AssetReasonCode } from "./assets.ts";

export const PLANNER_VERSION = "dyr-planner@2.0.0" as PlannerVersion;

export interface PlanRequest {
  now: Millis;
  budgetMinutes: number;
  seed: number;
  weakestSkill: Skill;
  admittedIntroductions: LexemeId[];
  introductionsFrozen: boolean;
  repairs: RepairDirective[];
  requireOffline: boolean;
  packVersion: PackVersion;
}

export interface CandidateScore {
  taskId: TaskId;
  lexeme: LexemeId;
  skill: Skill;
  family: TaskFamily;
  kind: "review" | "repair" | "introduction";
  components: Record<string, number>;
  objective: number;
}

export interface RejectedCandidate {
  taskId: TaskId;
  reason: string;
}

export interface Plan {
  tasks: TaskContract[];
  answers: Map<TaskId, string>;
  predictedMinutes: number;
  objectiveComponents: CandidateScore[];
  rejected: RejectedCandidate[];
  reasonCodes: { code: string; detail: string }[];
  plannerVersion: PlannerVersion;
  rubricVersion: string;
  configurationHash: string;
}

const WEIGHTS = {
  retrievabilityRisk: 3.0,
  lateness: 2.0,
  functionalValue: 1.0,
  weakestRepair: 1.5,
  prerequisiteLeverage: 1.2,
  lapseRepair: 2.5,
  repairDirective: 4.0,
} as const;

export class Planner {
  private readonly leverage = new Map<string, number>();
  private readonly traces: TraceStore;
  private readonly graph: LanguageGraph;
  private readonly config: KernelConfig;
  private readonly configHash: string;
  private readonly fsrs: FsrsAdapter;
  private readonly assets: AssetProvider;

  constructor(
    traces: TraceStore,
    graph: LanguageGraph,
    config: KernelConfig,
    configHash: string,
    fsrs: FsrsAdapter,
    assets: AssetProvider,
  ) {
    this.traces = traces;
    this.graph = graph;
    this.config = config;
    this.configHash = configHash;
    this.fsrs = fsrs;
    this.assets = assets;
    for (const lex of graph.allLexemes()) {
      for (const pre of graph.prerequisitesOf(lex.id)) {
        this.leverage.set(pre, (this.leverage.get(pre) ?? 0) + 1);
      }
    }
  }

  /**
   * The best family that can OPEN a skill channel for a lexeme right now: the
   * cold-start entry family if it needs no prerequisites, otherwise the
   * lowest-cost family whose evidence prerequisites are already satisfied.
   * Returns undefined when nothing yet unlocks this channel (ADR-0005).
   */
  private bestEntryFamily(lex: Lexeme, skill: Skill): TaskFamilySpec | undefined {
    const forSkill = Object.values(DEFAULT_TASK_FAMILIES)
      .filter((s) => s.targetSkill === skill)
      .sort((a, b) => (a.estSeconds - b.estSeconds) || (a.family < b.family ? -1 : 1));
    for (const spec of forSkill) {
      if (spec.prerequisites.length === 0) return spec; // cold-start entry
      if (this.familyEligible(lex, spec)) return spec; // prereqs met
    }
    return undefined;
  }

  /** Evidence-requirement eligibility (ADR-0005): non-linear, per family. */
  private familyEligible(lex: Lexeme, spec: TaskFamilySpec): boolean {
    return spec.prerequisites.every((rule) => {
      const t = this.traces.get(traceId(lex.id, rule.skill));
      if (!t || t.state === "new") return false;
      if (rule.level === "exposed") return t.evidenceCount > 0;
      return isRetained(t); // "retained"
    });
  }

  /**
   * The accepted answers for a cue direction, "|"-separated.
   *
   * Two kinds of alternative, both of which the pack already asserts are the
   * same answer — this is not leniency, it is not marking a correct answer wrong:
   *
   *   MEANING — every declared sense counts. 我 declares ["I", "me"]; grading
   *   only the first would fail a learner who knew the word perfectly well.
   *
   *   PINYIN — both written notations count. "wǒ" and "wo3" encode the SAME
   *   syllable and the SAME tone, so accepting both costs no tone information.
   *   Toneless "wo" is deliberately NOT accepted: it discards the tone, and tone
   *   is part of the word (spec p.10). This also makes the task answerable on a
   *   phone keyboard, which cannot type tone marks.
   */
  private cueAnswer(dir: CueDirection, lex: Lexeme): { cue: string; answer: string } {
    const meaning = lex.senses[0] ?? lex.simplified;
    const meanings = lex.senses.length > 0 ? lex.senses.join("|") : lex.simplified;
    switch (dir) {
      case "audio_to_meaning": return { cue: `audio:${lex.id}`, answer: meanings };
      case "hanzi_to_meaning": return { cue: lex.simplified, answer: meanings };
      case "hanzi_to_sound": return { cue: lex.simplified, answer: pinyinAnswers(lex.pinyin) };
      case "meaning_to_speech": return { cue: meaning, answer: pinyinAnswers(lex.pinyin) };
      case "scene_to_speech": return { cue: `scene:${lex.id}`, answer: pinyinAnswers(lex.pinyin) };
      case "meaning_to_hanzi": return { cue: meaning, answer: lex.simplified };
      case "audio_to_hanzi": return { cue: `audio:${lex.id}`, answer: lex.simplified };
    }
  }

  private buildTask(
    lex: Lexeme,
    spec: TaskFamilySpec,
    kind: "review" | "repair" | "introduction",
    req: PlanRequest,
  ): { contract: TaskContract; answer: string } | { rejected: AssetReasonCode[]; taskId: TaskId } {
    const rubric = buildRubric(spec.family);
    const { cue, answer } = this.cueAnswer(spec.cueDirection, lex);
    const suffix = kind === "introduction" ? "_intro" : kind === "repair" ? "_repair" : "";
    const taskId = `task_${lex.id}_${spec.family}${suffix}` as TaskId;

    // Per-task asset gate (Correction 7).
    const gate = checkTaskAssets(this.assets, lex.id, spec.targetSkill, rubric, {
      requireOffline: req.requireOffline,
      family: spec.family,
    });
    if (!gate.ok) return { rejected: gate.blockers, taskId };

    const assetRefs = rubric.requiresCanonicalAudio ? [`audio:${lex.id}`] : [];
    const contract: TaskContract = {
      id: taskId,
      targetTrace: traceId(lex.id, spec.targetSkill),
      lexeme: lex.id,
      skill: spec.targetSkill,
      family: spec.family,
      cue,
      rubricId: rubric.rubricId,
      rubricVersion: rubric.rubricVersion,
      assetRefs,
      requiresHumanAudio: rubric.requiresCanonicalAudio,
      estSeconds: spec.estSeconds,
      isNovel: kind === "introduction",
      isRepair: kind === "repair",
      plannerVersion: PLANNER_VERSION,
      packVersion: req.packVersion,
    };
    return { contract, answer };
  }

  private scoreReview(lex: Lexeme, skill: Skill, now: Millis): Record<string, number> {
    const t = this.traces.ensure(lex.id, skill);
    const r = this.fsrs.retrievability(memoryStateOf(t), now);
    const late = latenessDays(t, now);
    return {
      retrievabilityRisk: (1 - r) * WEIGHTS.retrievabilityRisk,
      lateness: (Math.min(late, 14) / 14) * WEIGHTS.lateness,
      functionalValue: normFreq(lex.frequency) * WEIGHTS.functionalValue,
      weakestRepair: 0,
      prerequisiteLeverage: (Math.min(this.leverage.get(lex.id) ?? 0, 8) / 8) * WEIGHTS.prerequisiteLeverage,
      lapseRepair: t.state === "relearning" ? WEIGHTS.lapseRepair : 0,
      repairDirective: 0,
    };
  }

  plan(req: PlanRequest): Plan {
    const reasonCodes: { code: string; detail: string }[] = [];
    const rejected: RejectedCandidate[] = [];
    const rng = mulberry32(req.seed);
    const soon = req.now + 12 * 3_600_000;

    type Cand = { score: CandidateScore; contract: TaskContract; answer: string };
    const candidates: Cand[] = [];

    const pushCandidate = (
      lex: Lexeme,
      spec: TaskFamilySpec,
      kind: "review" | "repair" | "introduction",
      components: Record<string, number>,
    ): void => {
      const built = this.buildTask(lex, spec, kind, req);
      if ("rejected" in built) {
        for (const code of built.rejected) rejected.push({ taskId: built.taskId, reason: code });
        return;
      }
      if (spec.targetSkill === req.weakestSkill) components.weakestRepair = WEIGHTS.weakestRepair;
      const objective = sum(components);
      candidates.push({
        score: { taskId: built.contract.id, lexeme: lex.id, skill: spec.targetSkill, family: spec.family, kind, components, objective },
        contract: built.contract,
        answer: built.answer,
      });
    };

    // --- Repair candidates (highest priority; same trace only) ---
    const repairByTrace = new Map<string, RepairDirective>();
    for (const d of req.repairs) {
      if (d.eligibleAt <= req.now && req.now < d.expiresAt) repairByTrace.set(d.trace, d);
    }
    for (const [trace, directive] of repairByTrace) {
      const [lexId, skill] = splitTrace(trace);
      const lex = this.graph.lexemes.get(lexId);
      if (!lex) continue;
      const spec = entrySpecFor(skill);
      const components = { ...this.scoreReview(lex, skill, req.now), repairDirective: WEIGHTS.repairDirective * directive.attempt };
      pushCandidate(lex, spec, "repair", components);
    }

    // --- Review candidates: due (or nearly-due) non-new traces ---
    for (const lex of this.graph.allLexemes()) {
      for (const skill of SKILLS) {
        const t = this.traces.get(traceId(lex.id, skill));
        if (!t || t.state === "new") continue;
        if (t.due === undefined || t.due > soon) continue;
        if (repairByTrace.has(traceId(lex.id, skill))) continue; // repaired instead
        pushCandidate(lex, currentSpecFor(skill), "review", this.scoreReview(lex, skill, req.now));
      }
    }

    // --- Introduction candidates (non-linear eligibility, ADR-0005) ---
    // For each admitted lexeme and each skill whose channel is not yet open,
    // pick the single best eligible family that opens it. Because eligibility is
    // per-family evidence requirements (not a fixed chain), speaking/writing can
    // open as soon as their prerequisites are met — e.g. echo/shadow speaking
    // once listening is merely EXPOSED, in parallel with reading.
    if (!req.introductionsFrozen) {
      for (const lexId of req.admittedIntroductions) {
        const lex = this.graph.lexemes.get(lexId);
        if (!lex) continue;
        for (const skill of SKILLS) {
          const t = this.traces.get(traceId(lex.id, skill));
          if (t && t.state !== "new") continue; // channel already open
          const spec = this.bestEntryFamily(lex, skill);
          if (!spec) continue; // no eligible family opens this channel yet
          const components = {
            retrievabilityRisk: WEIGHTS.retrievabilityRisk,
            lateness: 0,
            functionalValue: normFreq(lex.frequency) * WEIGHTS.functionalValue,
            weakestRepair: 0,
            prerequisiteLeverage: (Math.min(this.leverage.get(lex.id) ?? 0, 8) / 8) * WEIGHTS.prerequisiteLeverage,
            lapseRepair: 0,
            repairDirective: 0,
          };
          pushCandidate(lex, spec, "introduction", components);
        }
      }
    } else {
      reasonCodes.push({ code: "introductions_frozen", detail: "workload governor froze new items" });
    }

    // --- Deterministic ordering ---
    candidates.sort((a, b) => {
      if (b.score.objective !== a.score.objective) return b.score.objective - a.score.objective;
      return a.score.taskId < b.score.taskId ? -1 : a.score.taskId > b.score.taskId ? 1 : 0;
    });

    // --- Greedy selection under budget + novelty ceiling + confusable safety ---
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
      if (usedSeconds + est > budgetSeconds) { rejected.push({ taskId: c.score.taskId, reason: "exceeds_time_budget" }); continue; }
      if (c.score.kind === "introduction" && novelUsed >= this.config.noveltyCeiling) { rejected.push({ taskId: c.score.taskId, reason: "novelty_ceiling" }); continue; }
      if (this.graph.confusablesOf(c.score.lexeme).some((e) => chosenLexemes.has(e.to))) { rejected.push({ taskId: c.score.taskId, reason: "confusable_pairing" }); continue; }
      const lastTwoSame = skillRun.length >= 2 && skillRun.at(-1) === c.score.skill && skillRun.at(-2) === c.score.skill;
      if (lastTwoSame && rng.next() < 0.5) { rejected.push({ taskId: c.score.taskId, reason: "modality_switch_smoothing" }); continue; }

      chosen.push(c.contract);
      answers.set(c.score.taskId, c.answer);
      objectiveComponents.push(c.score);
      chosenLexemes.add(c.score.lexeme);
      skillRun.push(c.score.skill);
      usedSeconds += est;
      if (c.score.kind === "introduction") novelUsed++;
    }

    reasonCodes.push(chosen.length === 0
      ? { code: "empty_plan", detail: "no eligible tasks — valid zero-item plan" }
      : { code: "planned", detail: `${chosen.length} task(s), ${novelUsed} new, ${objectiveComponents.filter((c) => c.kind === "repair").length} repair` });

    return {
      tasks: chosen,
      answers,
      predictedMinutes: Number((usedSeconds / 60).toFixed(2)),
      objectiveComponents,
      rejected,
      reasonCodes,
      plannerVersion: PLANNER_VERSION,
      rubricVersion: RUBRIC_VERSION,
      configurationHash: this.configHash,
    };
  }
}

function sum(components: Record<string, number>): number {
  return Number(Object.values(components).reduce((a, b) => a + b, 0).toFixed(6));
}
function normFreq(freq: number): number {
  return Math.max(0, Math.min(1, freq / 7));
}
function splitTrace(trace: string): [LexemeId, Skill] {
  const i = trace.lastIndexOf("::");
  return [trace.slice(0, i) as LexemeId, trace.slice(i + 2) as Skill];
}
/** The cold-start entry family spec for a skill. */
function entrySpecFor(skill: Skill): TaskFamilySpec {
  const entry: Record<Skill, TaskFamily> = {
    listening: "audio_to_meaning", reading: "hanzi_to_meaning",
    speaking: "echo_shadow", writing: "meaning_to_typed_word",
  };
  return DEFAULT_TASK_FAMILIES[entry[skill]];
}
/** For reviews we reuse the entry family's rubric/cue for the skill. */
function currentSpecFor(skill: Skill): TaskFamilySpec {
  return entrySpecFor(skill);
}

/**
 * Both written notations of the same pinyin, "|"-separated: "wǒ|wo3".
 *
 * Tone is preserved in both, so nothing about the answer is weakened. Falls back
 * to the source form alone if the string cannot be parsed — the spec forbids
 * destroying the source representation, so an unparseable pronunciation is
 * graded as written rather than dropped.
 */
export function pinyinAnswers(pinyin: string): string {
  try {
    const { marked, numbered } = normalisePinyin(pinyin);
    const forms = new Set([pinyin.trim(), marked, numbered, numbered.replace(/\s+/g, "")]);
    return [...forms].filter((f) => f.length > 0).join("|");
  } catch {
    return pinyin;
  }
}
