/**
 * Workload governor (spec p.18).
 *
 *   "Simulate 7-day and 30-day due minutes under high, expected and low
 *    recall. Freeze introductions when forecasts exceed the declared budget,
 *    confidence is weak, or lapse repair is dominating. Zero new items is a
 *    valid and often correct plan."
 *
 * The governor never schedules; it only forecasts future minute-load and
 * returns an explainable freeze decision that the planner and frontier honour.
 */
import {
  type KernelConfig,
  type Skill,
  type SkillTrace,
  DAY,
  isProduction,
} from "@dyr/domain";

export type RecallScenario = "high" | "expected" | "low";

export interface HorizonForecast {
  horizonDays: number;
  scenario: RecallScenario;
  /** Predicted review minutes falling inside the horizon. */
  dueMinutes: number;
}

export interface WorkloadReport {
  forecasts: HorizonForecast[];
  freezeIntroductions: boolean;
  lapseRepairShare: number;
  reasons: string[];
}

/** Per-review cost, minutes. Production skills cost more than recognition. */
function perReviewMinutes(skill: Skill): number {
  return isProduction(skill) ? 0.25 : 0.13;
}

/** Scenario interval multipliers — low recall shrinks intervals, adding load. */
const INTERVAL_FACTOR: Record<RecallScenario, number> = {
  high: 1.0,
  expected: 0.7,
  low: 0.4,
};

function forecastMinutes(
  traces: SkillTrace[],
  horizonDays: number,
  scenario: RecallScenario,
): number {
  let minutes = 0;
  for (const t of traces) {
    if (t.state === "new" || t.stability <= 0) continue;
    const effectiveInterval = Math.max(0.5, t.stability * INTERVAL_FACTOR[scenario]);
    const reviews = Math.max(1, Math.ceil(horizonDays / effectiveInterval));
    minutes += reviews * perReviewMinutes(t.skill);
  }
  return Number(minutes.toFixed(2));
}

export function assessWorkload(
  traces: SkillTrace[],
  now: number,
  config: KernelConfig,
  opts: { weakConfidence?: boolean; dailyBudgetMinutes?: number } = {},
): WorkloadReport {
  const dailyBudget = opts.dailyBudgetMinutes ?? config.sessionMinutes.default;
  const forecasts: HorizonForecast[] = [];
  for (const horizonDays of config.forecastHorizonsDays) {
    for (const scenario of ["high", "expected", "low"] as RecallScenario[]) {
      forecasts.push({
        horizonDays,
        scenario,
        dueMinutes: forecastMinutes(traces, horizonDays, scenario),
      });
    }
  }

  const reasons: string[] = [];
  let freeze = false;

  // 1) Expected 7-day load exceeds the budget the learner can actually spend.
  const expected7 = forecasts.find(
    (f) => f.horizonDays === 7 && f.scenario === "expected",
  )!;
  const budget7 = dailyBudget * 7;
  if (expected7.dueMinutes > budget7) {
    freeze = true;
    reasons.push(
      `expected 7-day load ${expected7.dueMinutes}m exceeds budget ${budget7}m`,
    );
  }

  // 2) Lapse repair dominating — too many traces are relearning.
  const relearning = traces.filter((t) => t.state === "relearning").length;
  const active = traces.filter((t) => t.state !== "new").length || 1;
  const lapseRepairShare = Number((relearning / active).toFixed(3));
  if (lapseRepairShare > 0.3) {
    freeze = true;
    reasons.push(`lapse repair dominating (${(lapseRepairShare * 100) | 0}% relearning)`);
  }

  // 3) Confidence in recent evidence is weak.
  if (opts.weakConfidence) {
    freeze = true;
    reasons.push("recent evidence confidence weak");
  }

  return { forecasts, freezeIntroductions: freeze, lapseRepairShare, reasons };
}
