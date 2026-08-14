/**
 * Deterministic 365-day simulation (spec p.8 Stage 1 exit: "Property tests +
 * 365-day simulations pass"; p.6 REQUIRED ACCEPTANCE FIXTURE; p.18 WORKLOAD
 * GOVERNOR: bounded backlog).
 *
 * Runnable directly: `node fixtures/sim/simulate.ts`. Also driven by the test
 * suite. A realistic-ish learner: mostly correct, sometimes lapses, over a
 * year of bounded 7-minute sessions.
 */
import { verifyReplay } from "@dyr/kernel";
import { makeHarness, correctAttempt, wrongAttempt } from "./harness.ts";

export interface SimResult {
  days: number;
  sessions: number;
  attempts: number;
  maxPredictedMinutes: number;
  everFroze: boolean;
  finalProfile: Record<string, { retained: number; total: number }>;
  replayHolds: boolean;
  eventCount: number;
}

export function simulate(days = 365, budgetMinutes = 7): SimResult {
  const h = makeHarness("2026-01-01T08:00:00Z");
  let attempts = 0;
  let sessions = 0;
  let maxPredicted = 0;
  let everFroze = false;

  for (let day = 0; day < days; day++) {
    const workload = h.kernel.workload();
    if (workload.freezeIntroductions) everFroze = true;

    const plan = h.kernel.planSession({
      budgetMinutes,
      admittedIntroductions: h.pack.lexemeIds,
    });
    sessions++;
    maxPredicted = Math.max(maxPredicted, plan.predictedMinutes);

    for (const [i, task] of plan.tasks.entries()) {
      const ans = plan.answers.get(task.id)!;
      const production = task.skill === "speaking" || task.skill === "writing";
      // Deterministic ~15% lapse rate keyed to day+index (no RNG needed).
      const lapse = (day * 7 + i * 3) % 20 < 3;
      if (lapse) {
        h.kernel.submitAttempt(task, production
          ? { ...wrongAttempt(task), selfGrade: "again" }
          : wrongAttempt(task));
      } else {
        h.kernel.submitAttempt(task, correctAttempt(task, ans, "normal", production ? "good" : undefined));
      }
      attempts++;
    }
    h.clock.advanceDays(1);
  }

  return {
    days,
    sessions,
    attempts,
    maxPredictedMinutes: maxPredicted,
    everFroze,
    finalProfile: h.kernel.frontier.profile(),
    replayHolds: verifyReplay(h.kernel.traces, h.kernel.log.all()),
    eventCount: h.kernel.log.length,
  };
}

// Allow `node fixtures/sim/simulate.ts` to print a summary.
if (import.meta.url === `file://${process.argv[1]}`) {
  const r = simulate();
  console.log(JSON.stringify(r, null, 2));
}
