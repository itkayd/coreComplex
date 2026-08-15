/**
 * DyrKernel — the headless learning brain (spec p.3).
 *
 * Runs the eight observable phases (spec p.5) and emits the causal chain
 * (ADR-0008): AttemptAccepted →(causation) EvidenceValidated →(causation)
 * TraceUpdated →(causation) ConsolidationRecorded →(causation)
 * LearningFactPublished. Reject / self-grade attempts terminate at
 * EvidenceValidated with no TraceUpdated or Fact.
 *
 * Invariants: Rule 1 (four traces), Rule 2 (one update, guarded), Rule 3
 * (headless — no UI/layer/provider-impl imports), Rule 4 (one-way facts).
 * Commands are idempotent on a durable client key (ADR-0007). Failed retrievals
 * schedule an explicit, replayable RepairDirective (ADR-0003).
 */
import {
  type AttemptEnvelope,
  type AttemptId,
  type Clock,
  type CommandOutcome,
  type DeviceId,
  type EventId,
  type FactId,
  type KernelConfig,
  type LanguageGraph,
  type LearnerId,
  type LearningFact,
  type LexemeId,
  type RawAttempt,
  type RepairDirective,
  type Skill,
  type SkillTrace,
  type SubmitAttemptCommand,
  type TaskContract,
  type TaskId,
  type TraceId,
  commandPayloadHash,
  configurationHash,
  deriveSeed,
  makeRepairDirective,
  memoryStateOf,
  traceId,
} from "@dyr/domain";
import { type FsrsAdapter } from "@dyr/fsrs-adapter";
import { TraceStore } from "./traceStore.ts";
import { EventLog } from "./eventLog.ts";
import { evaluateEvidence, type EvidenceResult, type SpeechSignal } from "./evidence.ts";
import { assessWorkload, type WorkloadReport } from "./workload.ts";
import { Frontier } from "./frontier.ts";
import { Planner, PLANNER_VERSION, type Plan } from "./planner.ts";
import { buildRubric } from "./rubrics.ts";
import { type AssetProvider } from "./assets.ts";

export interface KernelDeps {
  learnerId: LearnerId;
  deviceId: DeviceId;
  clock: Clock;
  graph: LanguageGraph;
  fsrs: FsrsAdapter;
  config: KernelConfig;
  assets: AssetProvider;
}

export interface SubmitResult {
  envelope: AttemptEnvelope;
  decision: EvidenceResult["decision"];
  fact?: LearningFact;
  updatedTrace?: SkillTrace;
  repair?: RepairDirective;
}

interface CommandRecord {
  payloadHash: string;
  result: SubmitResult;
}

export class DyrKernel {
  readonly traces = new TraceStore();
  readonly log = new EventLog();
  readonly frontier: Frontier;
  private readonly configHash: string;
  private readonly planner: Planner;
  private readonly facts: LearningFact[] = [];
  private readonly answerKey = new Map<TaskId, string>();
  private readonly signalKey = new Map<TaskId, SpeechSignal>();
  private readonly repairs = new Map<string, RepairDirective>();
  private readonly seenCommands = new Map<string, CommandRecord>();
  private correlation?: EventId;
  private autoCounter = 0;
  private readonly deps: KernelDeps;

  constructor(deps: KernelDeps) {
    this.deps = deps;
    this.configHash = configurationHash(deps.config);
    this.planner = new Planner(this.traces, deps.graph, deps.config, this.configHash, deps.fsrs, deps.assets);
    this.frontier = new Frontier(this.traces, deps.graph);
  }

  private packVersion(): TaskContract["packVersion"] {
    const first = this.deps.graph.allLexemes()[0];
    return (first?.packVersion ?? "pack@0") as TaskContract["packVersion"];
  }

  private now(): number {
    return this.deps.clock.now();
  }

  /** Retrievability via the single authority (ADR-0002). */
  retrievabilityOf(lexeme: LexemeId, skill: Skill): number {
    const t = this.traces.get(traceId(lexeme, skill));
    return t ? this.deps.fsrs.retrievability(memoryStateOf(t), this.now()) : 0;
  }

  workload(opts?: { weakConfidence?: boolean }): WorkloadReport {
    return assessWorkload(this.traces.all(), this.now(), this.deps.config, this.deps.fsrs, {
      weakConfidence: opts?.weakConfidence,
    });
  }

  /** Active, unexpired repair directives (planner input, ADR-0003). */
  activeRepairs(): RepairDirective[] {
    const now = this.now();
    return [...this.repairs.values()].filter((d) => d.expiresAt > now);
  }

  /** PLAN + CUE. */
  planSession(input: {
    budgetMinutes: number;
    candidateIntroductions?: LexemeId[];
    weakConfidence?: boolean;
    requireOffline?: boolean;
  }): Plan {
    const now = this.now();
    const workload = this.workload({ weakConfidence: input.weakConfidence });

    const admitted = (input.candidateIntroductions ?? []).filter((lex) =>
      this.frontier.admit(lex, {
        licensed: (l) => this.deps.assets.licensed(l),
        humanAudioAvailable: (l) => this.deps.assets.hasCanonicalAudio(l),
        knownTokenRatio: (l) => this.deps.assets.knownTokenRatio(l),
        introductionsFrozen: workload.freezeIntroductions,
        knownTokenBand: this.deps.config.knownTokenBand,
        plannerVersion: PLANNER_VERSION,
      }).eligible,
    );

    const seed = deriveSeed(this.deps.learnerId, this.configHash, this.log.length, now);
    const plan = this.planner.plan({
      now,
      budgetMinutes: input.budgetMinutes,
      seed,
      weakestSkill: this.frontier.weakestSkill(),
      admittedIntroductions: admitted,
      introductionsFrozen: workload.freezeIntroductions,
      repairs: this.activeRepairs(),
      requireOffline: input.requireOffline ?? false,
      packVersion: this.packVersion(),
    });

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
      this.traces.ensure(task.lexeme, task.skill);
      this.append("TaskCued", { task }, {
        causationId: planned.eventId,
        correlationId: planned.eventId,
        idempotencyKey: `cue:${task.id}:${this.log.length}`,
      });
    }
    return plan;
  }

  /** Register an answer key / signal for a task cued outside planSession. */
  registerTask(task: TaskContract, expectedAnswer: string, signal?: SpeechSignal): void {
    this.traces.ensure(task.lexeme, task.skill);
    this.answerKey.set(task.id, expectedAnswer);
    if (signal) this.signalKey.set(task.id, signal);
  }

  /**
   * Durable, idempotent command entry point (ADR-0007). A repeat of the same
   * idempotencyKey returns the original result and mutates nothing. A reused key
   * with a different payload is a conflict (first write wins).
   */
  submitCommand(
    cmd: SubmitAttemptCommand,
    task: TaskContract,
    opts?: { signal?: SpeechSignal },
  ): { outcome: CommandOutcome; result?: SubmitResult } {
    const payloadHash = commandPayloadHash(cmd);
    const prior = this.seenCommands.get(cmd.idempotencyKey);
    if (prior) {
      if (prior.payloadHash !== payloadHash) {
        return { outcome: { status: "idempotency_conflict", idempotencyKey: cmd.idempotencyKey } };
      }
      return { outcome: { status: "duplicate", idempotencyKey: cmd.idempotencyKey }, result: prior.result };
    }
    const result = this.applyEvidence(task, cmd.attempt, cmd.attemptId, cmd.occurredAt, opts);
    this.seenCommands.set(cmd.idempotencyKey, { payloadHash, result });
    return { outcome: { status: "applied", idempotencyKey: cmd.idempotencyKey }, result };
  }

  /** Convenience wrapper: builds a durable command with a unique key. */
  submitAttempt(
    task: TaskContract,
    attempt: RawAttempt,
    opts?: { signal?: SpeechSignal },
  ): SubmitResult {
    const attemptId = `att_${task.id}_${this.autoCounter++}` as AttemptId;
    return this.applyEvidence(task, attempt, attemptId, this.now(), opts);
  }

  /** RETRIEVE → EVIDENCE → (UPDATE → CONSOLIDATE → FACT) | terminal reject. */
  private applyEvidence(
    task: TaskContract,
    attempt: RawAttempt,
    attemptId: AttemptId,
    now: number,
    opts?: { signal?: SpeechSignal },
  ): SubmitResult {
    const expectedAnswer = this.answerKey.get(task.id);
    if (expectedAnswer === undefined) {
      throw new Error(`no answer key registered for task ${task.id}; cannot grade`);
    }
    const rubric = buildRubric(task.family);

    const accepted = this.append("AttemptAccepted", { attempt }, {
      correlationId: this.correlation,
      idempotencyKey: `accepted:${attemptId}`,
      occurredAt: now,
    });

    const signal = opts?.signal ?? this.signalKey.get(task.id);
    const { envelope, decision } = evaluateEvidence(
      { attemptId, attempt, task, rubric, expectedAnswer, signal },
      this.deps.config,
    );

    const validated = this.append("EvidenceValidated", { envelope, decision }, {
      causationId: accepted.eventId, // causation: accepted → validated (ADR-0008)
      correlationId: this.correlation,
      idempotencyKey: `evidence:${attemptId}`,
      occurredAt: now,
    });

    if (decision !== "update") {
      // Terminal path — no TraceUpdated, no Fact (ADR-0008).
      return { envelope, decision };
    }

    return this.applySingleUpdate(task, envelope, rubric.rubricVersion, now, validated.eventId, attemptId);
  }

  /** One-update core (Rule 2), guarded. Emits repair on a lapse (ADR-0003). */
  private applySingleUpdate(
    task: TaskContract,
    envelope: AttemptEnvelope,
    rubricVersion: string,
    now: number,
    causationId: EventId,
    attemptId: AttemptId,
  ): SubmitResult {
    const before = this.traces.ensure(task.lexeme, task.skill);
    const othersBefore = this.otherTracesDigest(before.id);

    const rating = envelope.ratingProposal;
    const result = this.deps.fsrs.scheduleReview(memoryStateOf(before), rating, now);

    const traceUpdated = this.append("TraceUpdated", {
      traceId: before.id,
      ratingApplied: rating,
      rubricVersion,
      fsrsAdapterVersion: this.deps.fsrs.version,
      stabilityBefore: before.stability,
      difficultyBefore: before.difficulty,
      memoryAfter: result.state,
    }, {
      causationId, // causation: validated → traceUpdated (ADR-0008)
      correlationId: this.correlation,
      idempotencyKey: `trace:${attemptId}`,
      occurredAt: now,
    });

    const after: SkillTrace = {
      ...before,
      ...result.state,
      lastReview: result.state.lastReview ?? now,
      evidenceCount: before.evidenceCount + 1,
      eventCursor: traceUpdated.localSequence,
    };
    this.traces.put(after);

    if (othersBefore !== this.otherTracesDigest(after.id)) {
      throw new Error("invariant violated: an accepted attempt changed more than one SkillTrace");
    }

    // CONSOLIDATE — transfer/interference metadata (explanation only).
    const transferNotes = this.deps.graph.supportsOf(task.lexeme).map((e) => `support:${e.to}`)
      .concat(this.deps.graph.interferenceOf(task.lexeme).map((e) => `interference:${e.to}`));
    const consolidated = this.append("ConsolidationRecorded", { traceId: after.id, transferNotes }, {
      causationId: traceUpdated.eventId, // causation: traceUpdated → consolidation (ADR-0008)
      correlationId: this.correlation,
      idempotencyKey: `consolidate:${attemptId}`,
      occurredAt: now,
    });

    // REPAIR — a lapse schedules an in-session repair for the SAME trace.
    let repair: RepairDirective | undefined;
    if (rating === "again") {
      const priorAttempt = this.repairs.get(after.id)?.attempt ?? 0;
      repair = makeRepairDirective(after.id, now, priorAttempt + 1);
      this.repairs.set(after.id, repair);
      this.append("RepairScheduled", {
        traceId: after.id,
        eligibleAt: repair.eligibleAt,
        expiresAt: repair.expiresAt,
        reason: repair.reason,
      }, {
        causationId: traceUpdated.eventId,
        correlationId: this.correlation,
        idempotencyKey: `repair:${attemptId}`,
        occurredAt: now,
      });
    } else {
      // A successful retrieval clears any pending repair for this trace.
      this.repairs.delete(after.id);
    }

    // FACT — publish immutable LearningFact outward (Rule 4).
    const fact: LearningFact = {
      id: `fact_${after.id}_${traceUpdated.localSequence}` as FactId,
      trace: after.id,
      lexeme: after.lexeme,
      skill: after.skill,
      ratingApplied: rating,
      stabilityAfter: after.stability,
      difficultyAfter: after.difficulty,
      retrievabilityAtReview: result.retrievabilityAtReview,
      dueAfter: after.due ?? now,
      occurredAt: now,
      sourceSequence: traceUpdated.localSequence,
    };
    this.facts.push(fact);
    this.append("LearningFactPublished", { fact }, {
      causationId: consolidated.eventId, // causation: consolidation → fact (ADR-0008)
      correlationId: this.correlation,
      idempotencyKey: `fact:${attemptId}`,
      occurredAt: now,
    });

    return { envelope, decision: "update", fact, updatedTrace: after, repair };
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
    extra: { causationId?: EventId; correlationId?: EventId; idempotencyKey: string; occurredAt?: number },
  ) {
    return this.log.append<P>({
      learnerId: this.deps.learnerId,
      deviceId: this.deps.deviceId,
      occurredAt: extra.occurredAt ?? this.now(),
      eventType,
      payload,
      plannerVersion: PLANNER_VERSION,
      packVersion: this.packVersion(),
      configurationHash: this.configHash,
      ...extra,
    });
  }
}
