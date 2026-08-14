/**
 * @dyr/kernel — evidence, traces, graph, planner, frontier, workload and
 * replay (spec p.25 monorepo shape).
 *
 * Dependency CI (spec p.23): the kernel imports NO UI, game, reward, profile,
 * narrative or provider implementation. It depends only on @dyr/domain (pure
 * vocabulary) and @dyr/fsrs-adapter (the pinned FSRS boundary).
 */
export { TraceStore } from "./traceStore.ts";
export { EventLog } from "./eventLog.ts";
export { evaluateEvidence } from "./evidence.ts";
export type { EvidenceResult, ValidationInput } from "./evidence.ts";
export { assessWorkload } from "./workload.ts";
export type { WorkloadReport, HorizonForecast, RecallScenario } from "./workload.ts";
export { Frontier, isRetained } from "./frontier.ts";
export type {
  FrontierProfile,
  SkillProgress,
  AdmissionContext,
  AdmissionResult,
} from "./frontier.ts";
export { Planner, PLANNER_VERSION } from "./planner.ts";
export type { Plan, PlanRequest, CandidateScore } from "./planner.ts";
export { DyrKernel } from "./kernel.ts";
export type { KernelDeps, SubmitResult } from "./kernel.ts";
export { replayTraces, verifyReplay } from "./replay.ts";
export { Observatory } from "./observatory.ts";
export type { ObservatoryFrame, TraceSnapshot } from "./observatory.ts";
