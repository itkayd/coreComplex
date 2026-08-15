/**
 * Workload governor (spec p.18; ADR-0006, Correction 4).
 *
 * Forecasts start from each trace's ACTUAL current scheduling state and roll
 * future reviews forward deterministically through the FSRS adapter under three
 * versioned recall scenarios. Only reviews that fall due inside the horizon
 * count — a trace due after the window contributes nothing. Freezes
 * introductions when the specification requires it (overload, lapse-repair
 * dominance, or weak confidence). Zero new items is a valid plan.
 */
import {
  type KernelConfig,
  type Rating,
  type Skill,
  type SkillTrace,
  isProduction,
  memoryStateOf,
} from "@dyr/domain";
import type { FsrsAdapter } from "@dyr/fsrs-adapter";

export const WORKLOAD_SCENARIOS_VERSION = "dyr-workload-scenarios@1.0.0";

export type RecallScenario = "high" | "expected" | "low";

/** Deterministic, versioned rating policy per scenario (ADR-0006). */
function scenarioRating(scenario: RecallScenario, step: number): Rating {
  switch (scenario) {
    case "high":
      return "good";
    case "expected":
      return step % 4 === 3 ? "hard" : "good";
    case "low":
      return step % 2 === 0 ? "again" : "good";
  }
}

function perReviewMinutes(skill: Skill): number {
  return isProduction(skill) ? 0.25 : 0.13;
}

export interface HorizonForecast {
  horizonDays: number;
  scenario: RecallScenario;
  reviews: number;
  dueMinutes: number;
  perSkillMinutes: Record<Skill, number>;
  relearningMinutes: number;
}

export interface WorkloadReport {
  scenariosVersion: string;
  forecasts: HorizonForecast[];
  /** Traces overdue right now (minutes). */
  backlogMinutes: number;
  lapseRepairShare: number;
  freezeIntroductions: boolean;
  reasons: string[];
}

const DAY = 86_400_000;

function forecast(
  traces: SkillTrace[],
  now: number,
  horizonDays: number,
  scenario: RecallScenario,
  fsrs: FsrsAdapter,
): HorizonForecast {
  const horizonEnd = now + horizonDays * DAY;
  const perSkillMinutes: Record<Skill, number> = { listening: 0, reading: 0, speaking: 0, writing: 0 };
  let reviews = 0;
  let dueMinutes = 0;
  let relearningMinutes = 0;

  for (const trace of traces) {
    if (trace.state === "new" || trace.due === undefined) continue;
    let state = memoryStateOf(trace);
    let due = trace.due;
    // Roll forward deterministically; cap iterations for safety.
    for (let step = 0; step < 400; step++) {
      if (due > horizonEnd) break; // not due within the horizon (Correction 4)
      const reviewAt = Math.max(due, now);
      if (reviewAt > horizonEnd) break;
      const rating = scenarioRating(scenario, step);
      const wasRelearning = state.state === "relearning";
      const mins = perReviewMinutes(trace.skill);
      reviews += 1;
      dueMinutes += mins;
      perSkillMinutes[trace.skill] += mins;
      if (wasRelearning || rating === "again") relearningMinutes += mins;
      const result = fsrs.scheduleReview(state, rating, reviewAt);
      state = result.state;
      if (state.due === undefined) break;
      due = state.due;
    }
  }

  return {
    horizonDays,
    scenario,
    reviews,
    dueMinutes: round2(dueMinutes),
    perSkillMinutes: mapRound(perSkillMinutes),
    relearningMinutes: round2(relearningMinutes),
  };
}

export function assessWorkload(
  traces: SkillTrace[],
  now: number,
  config: KernelConfig,
  fsrs: FsrsAdapter,
  opts: { weakConfidence?: boolean; dailyBudgetMinutes?: number } = {},
): WorkloadReport {
  const dailyBudget = opts.dailyBudgetMinutes ?? config.sessionMinutes.default;
  const forecasts: HorizonForecast[] = [];
  for (const horizonDays of config.forecastHorizonsDays) {
    for (const scenario of ["high", "expected", "low"] as RecallScenario[]) {
      forecasts.push(forecast(traces, now, horizonDays, scenario, fsrs));
    }
  }

  // Backlog = minutes already overdue right now.
  let backlogMinutes = 0;
  for (const t of traces) {
    if (t.state !== "new" && t.due !== undefined && t.due < now) backlogMinutes += perReviewMinutes(t.skill);
  }

  const relearning = traces.filter((t) => t.state === "relearning").length;
  const active = traces.filter((t) => t.state !== "new").length || 1;
  const lapseRepairShare = round3(relearning / active);

  const reasons: string[] = [];
  let freeze = false;

  const expected7 = forecasts.find((f) => f.horizonDays === 7 && f.scenario === "expected")!;
  const budget7 = dailyBudget * 7;
  if (expected7.dueMinutes > budget7) {
    freeze = true;
    reasons.push(`expected 7-day load ${expected7.dueMinutes}m exceeds budget ${budget7}m`);
  }
  if (lapseRepairShare > 0.3) {
    freeze = true;
    reasons.push(`lapse repair dominating (${Math.floor(lapseRepairShare * 100)}% relearning)`);
  }
  if (opts.weakConfidence) {
    freeze = true;
    reasons.push("recent evidence confidence weak");
  }

  return {
    scenariosVersion: WORKLOAD_SCENARIOS_VERSION,
    forecasts,
    backlogMinutes: round2(backlogMinutes),
    lapseRepairShare,
    freezeIntroductions: freeze,
    reasons,
  };
}

const round2 = (n: number): number => Number(n.toFixed(2));
const round3 = (n: number): number => Number(n.toFixed(3));
function mapRound(m: Record<Skill, number>): Record<Skill, number> {
  return { listening: round2(m.listening), reading: round2(m.reading), speaking: round2(m.speaking), writing: round2(m.writing) };
}
