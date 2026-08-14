/**
 * DyrKernel — the headless learning brain (spec p.3: "The kernel is the brain;
 * everything else is a layer").
 *
 * It runs the eight observable phases of one review (spec p.5):
 *   DECAY -> PLAN -> CUE -> RETRIEVE -> EVIDENCE -> UPDATE -> CONSOLIDATE -> FACT
 * and emits the causal event chain (spec p.5):
 *   AttemptAccepted -> EvidenceValidated -> TraceUpdated
 *   -> ConsolidationRecorded -> LearningFactPublished
 *
 * Invariants enforced here:
 *   Rule 2 (One Update): an accepted attempt changes exactly one SkillTrace.
 *   Rule 3 (Headless):   no UI/game/provider import; runs and replays alone.
 *   Rule 4 (One-way):    LearningFacts are published outward, never read back.
 */
import {
  type AttemptEnvelope,
  type AttemptId,
  type Clock,
  type DeviceId,
  type EventId,
  type FactId,
  type KernelConfig,
  type LanguageGraph,
  type LearnerId,
  type LearningFact,
  type LexemeId,
  type RawAttempt,
  type Skill,
  type SkillTrace,
  type TaskContract,
  type TaskId,
  configurationHash,
  deriveSeed,
  retrievability,
} from "@dyr/domain";
import { type FsrsAdapter, type MemoryState } from "@dyr/fsrs-adapter";
import { TraceStore } from "./traceStore.ts";
import { EventLog } from "./eventLog.ts";
import { evaluateEvidence, type EvidenceResult } from "./evidence.ts";
import { assessWorkload, type WorkloadReport } from "./workload.ts";
import { Frontier, type AdmissionContext } from "./frontier.ts";
import { Planner, PLANNER_VERSION, type Plan, type PlanRequest } from "./planner.ts";

export interface KernelDeps {
  learnerId: LearnerId;
  deviceId: DeviceId;
  clock: Clock;
  graph: LanguageGraph;
  fsrs: FsrsAdapter;
  config: KernelConfig;
  admission: Pick<
    AdmissionContext,
    "licensed" | "humanAudioAvailable" | "knownTokenRatio"
  >;
}

export interface SubmitResult {
  envelope: AttemptEnvelope;
  decision: EvidenceResult["decision"];
  fact?: LearningFact;
  updatedTrace?: SkillTrace;
}

export class DyrKernel {
  readonly traces = new TraceStore();
  readonly log = new EventLog();
  private readonly configHash: string;
  private readonly planner: Planner;
  readonly frontier: Frontier;
  private readonly facts: LearningFact[] = [];
  private readonly answerKey = new Map<TaskId, string>();
  private readonly signalKey = new Map<TaskId, number>();
  private correlation?: EventId;
  private readonly deps: KernelDeps;

  constructor(deps: KernelDeps) {
    this.deps = deps;
    this.configHash = configurationHash(deps.config);
    this.planner = new Planner(this.traces, deps.graph, deps.config, this.configHash);
    this.frontier = new Frontier(this.traces, deps.graph);
  }

  private packVersion(): TaskContract["packVersion"] {
    const first = this.deps.graph.allLexemes()[0];
    return (first?.packVersion ?? "pack@0") as TaskContract["packVersion"];
  }

  /** DECAY: read-only current-retrievability view (no writes). */
  retrievabilityOf(lexeme: LexemeId, skill: Skill): number {
    const t = this.traces.get(`${lexeme}::${skill}` as SkillTrace["id"]);
    return t ? retrievability(t, this.deps.clock.now()) : 0;
  }

  /** Workload governor report at the current instant. */
  workload(opts?: { weakConfidence?: boolean }): WorkloadReport {
    return assessWorkload(this.traces.all(), this.deps.clock.now(), this.deps.config, {
      weakConfidence: opts?.weakConfidence,
    });
  }

  /**
   * PLAN + CUE. Produces a bounded, explainable plan and emits SessionPlanned
   * plus one TaskCued per task. Stores the private answer key so later
   * attempts can be validated without ever leaking answers into the contract.
   */
  planSession(input: {
    budgetMinutes: number;
    admittedIntroductions?: LexemeId[];
    weakConfidence?: boolean;
  }): Plan {
    const now = this.deps.clock.now();
    const workload = this.workload({ weakConfidence: input.weakConfidence });

    const admitted = (input.admittedIntroductions ?? []).filter((lex) => {
      const res = this.frontier.admit(lex, {
        ...this.deps.admission,
        introductionsFrozen: workload.freezeIntroductions,
        knownTokenBand: this.deps.config.knownTokenBand,
        plannerVersion: PLANNER_VERSION,
      });
      return res.eligible;
    });

    const seed = deriveSeed(this.deps.learnerId, this.configHash, this.log.length, now);
    const req: PlanRequest = {
      now,
      budgetMinutes: input.budgetMinutes,
      seed,
      weakestSkill: this.frontier.weakestSkill(),
      admittedIntroductions: admitted,
      introductionsFrozen: workload.freezeIntroductions,
      packVersion: this.packVersion(),
    };
    const plan = this.planner.plan(req);

    // Refresh the private answer key for this plan.
    this.answerKey.clear();
    for (const [taskId, answer] of plan.answers) this.answerKey.set(taskId, answer);

    const planned = this.append("SessionPlanned", {
      budgetMinutes: input.budgetMinutes,
      taskIds: plan.tasks.map((t) => t.id),
      predictedMinutes: plan.predictedMinutes,
      reasonCodes: plan.reasonCodes,
    }, { idempotencyKey: `plan:${this.deps.learnerId}:${this.log.length}` });
    this.correlation = planned.eventId;

    for (const task of plan.tasks) {
      // Ensure the target trace exists so review candidates resolve next time.
      this.traces.ensure(task.lexeme, task.skill);
      this.append("TaskCued", { task }, {
        causationId: planned.eventId,
        correlationId: planned.eventId,
        idempotencyKey: `cue:${task.id}:${this.log.length}`,
      });
    }
    return plan;
  }

  /** Register the expected answer + optional signal for a task cued elsewhere. */
  registerTask(task: TaskContract, expectedAnswer: string, signalConfidence?: number): void {
    this.traces.ensure(task.lexeme, task.skill);
    this.answerKey.set(task.id, expectedAnswer);
    if (signalConfidence !== undefined) this.signalKey.set(task.id, signalConfidence);
  }

  /**
   * RETRIEVE -> EVIDENCE -> UPDATE -> CONSOLIDATE -> FACT.
   * Returns the decision and, when the policy updates memory, the LearningFact.
   */
  submitAttempt(
    task: TaskContract,
    attempt: RawAttempt,
    opts?: { signalConfidence?: number },
  ): SubmitResult {
    const now = this.deps.clock.now();
    const expectedAnswer = this.answerKey.get(task.id);
    if (expectedAnswer === undefined) {
      throw new Error(`no answer key registered for task ${task.id}; cannot grade`);
    }
    const attemptId = `att_${task.id}_${this.log.length}` as AttemptId;

    // AttemptAccepted — the raw attempt enters the log.
    const accepted = this.append("AttemptAccepted", { attempt }, {
      correlationId: this.correlation,
      idempotencyKey: `attempt:${attemptId}`,
    });

    // EVIDENCE — validate into an envelope with confidence + reason codes.
    const signalConfidence =
      opts?.signalConfidence ?? this.signalKey.get(task.id);
    const { envelope, decision } = evaluateEvidence(
      { attemptId, attempt, task, expectedAnswer, signalConfidence },
      this.deps.config,
    );

    this.append("EvidenceValidated", { envelope, decision }, {
      causationId: accepted.eventId,
      correlationId: this.correlation,
      idempotencyKey: `evidence:${attemptId}`,
    });

    if (decision !== "update") {
      // reject / ask_self_grade: NO memory write (Rule: passive != mastery).
      return { envelope, decision };
    }

    // UPDATE — exactly one SkillTrace changes (Rule 2). Guarded below.
    const fact = this.applySingleUpdate(task, envelope, now, accepted.eventId);
    return { envelope, decision, fact, updatedTrace: this.traces.get(task.targetTrace) };
  }

  /** The one-update core. Enforces that no other trace mutates. */
  private applySingleUpdate(
    task: TaskContract,
    envelope: AttemptEnvelope,
    now: number,
    causationId: EventId,
  ): LearningFact {
    const before = this.traces.ensure(task.lexeme, task.skill);
    const othersBefore = this.otherTracesDigest(before.id);

    const state: MemoryState = {
      stability: before.stability,
      difficulty: before.difficulty,
      state: before.state,
      lastReview: before.lastReview,
    };
    const rating = envelope.ratingProposal;
    const result = this.deps.fsrs.scheduleReview(state, rating, now);

    const traceUpdated = this.append("TraceUpdated", {
      traceId: before.id,
      ratingApplied: rating,
      stabilityBefore: before.stability,
      stabilityAfter: result.stability,
      difficultyBefore: before.difficulty,
      difficultyAfter: result.difficulty,
      dueAfter: result.due,
    }, {
      causationId,
      correlationId: this.correlation,
      idempotencyKey: `trace:${before.id}:${this.log.length}`,
    });

    const after: SkillTrace = {
      ...before,
      stability: result.stability,
      difficulty: result.difficulty,
      state: result.state,
      due: result.due,
      lastReview: now,
      evidenceCount: before.evidenceCount + 1,
      eventCursor: traceUpdated.localSequence,
    };
    this.traces.put(after);

    // Rule 2 guard: every other trace must be byte-for-byte unchanged.
    const othersAfter = this.otherTracesDigest(after.id);
    if (othersBefore !== othersAfter) {
      throw new Error("invariant violated: an accepted attempt changed more than one SkillTrace");
    }

    // CONSOLIDATE — record transfer/interference metadata (explanation only).
    const transferNotes = this.deps.graph
      .supportsOf(task.lexeme)
      .map((e) => `support:${e.to}`)
      .concat(this.deps.graph.interferenceOf(task.lexeme).map((e) => `interference:${e.to}`));
    this.append("ConsolidationRecorded", { traceId: after.id, transferNotes }, {
      causationId: traceUpdated.eventId,
      correlationId: this.correlation,
      idempotencyKey: `consolidate:${after.id}:${this.log.length}`,
    });

    // FACT — publish an immutable LearningFact outward (Rule 4, one-way).
    const fact: LearningFact = {
      id: `fact_${after.id}_${traceUpdated.localSequence}` as FactId,
      trace: after.id,
      lexeme: after.lexeme,
      skill: after.skill,
      ratingApplied: rating,
      stabilityAfter: result.stability,
      difficultyAfter: result.difficulty,
      retrievabilityAtReview: result.retrievabilityAtReview,
      dueAfter: result.due,
      occurredAt: now,
      sourceSequence: traceUpdated.localSequence,
    };
    this.facts.push(fact);
    this.append("LearningFactPublished", { fact }, {
      causationId: traceUpdated.eventId,
      correlationId: this.correlation,
      idempotencyKey: `fact:${fact.id}`,
    });
    return fact;
  }

  private otherTracesDigest(exceptId: string): string {
    return JSON.stringify(
      this.traces.all().filter((t) => t.id !== exceptId).map((t) => [
        t.id, t.stability, t.difficulty, t.state, t.due ?? -1, t.evidenceCount,
      ]),
    );
  }

  publishedFacts(): readonly LearningFact[] {
    return this.facts;
  }

  private append<P>(
    eventType: Parameters<EventLog["append"]>[0]["eventType"],
    payload: P,
    extra: { causationId?: EventId; correlationId?: EventId; idempotencyKey: string },
  ) {
    return this.log.append<P>({
      learnerId: this.deps.learnerId,
      deviceId: this.deps.deviceId,
      occurredAt: this.deps.clock.now(),
      eventType,
      payload,
      plannerVersion: PLANNER_VERSION,
      packVersion: this.packVersion(),
      configurationHash: this.configHash,
      ...extra,
    });
  }
}
