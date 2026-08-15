/**
 * Read-only brain observatory (spec p.17, p.19).
 *
 *   "Watch the brain think without giving the screen control."
 *
 * STRICTLY READ-ONLY (p.19): no endpoint or UI control may write a grade, due
 * time, stability, difficulty, desired retention or event. The observatory is
 * diagnostic infrastructure, not the learner's ordinary UI. Its frames are
 * versioned projections of the kernel's event cursor; dropping a frame never
 * changes learning state (LIVE CONTRACT, p.17).
 *
 * This module only *reads* from a DyrKernel. It exposes no mutators.
 */
import {
  type EventEnvelope,
  type Skill,
  type SkillTrace,
  memoryStateOf,
} from "@dyr/domain";
import type { FsrsAdapter } from "@dyr/fsrs-adapter";
import { DyrKernel } from "./kernel.ts";
import type { FrontierProfile } from "./frontier.ts";
import type { WorkloadReport } from "./workload.ts";

export interface TraceSnapshot {
  id: string;
  lexeme: string;
  skill: Skill;
  R: number;
  S: number;
  D: number;
  state: string;
  due?: number;
  evidenceCount: number;
  eventCursor: number;
}

export interface ObservatoryFrame {
  /** Monotonic cursor = number of events observed. Frames are versioned by it. */
  cursor: number;
  now: number;
  profile: FrontierProfile;
  weakestSkill: Skill;
  workload: WorkloadReport;
  traces: TraceSnapshot[];
}

export class Observatory {
  private readonly kernel: DyrKernel;
  private readonly fsrs: FsrsAdapter;
  private readonly now: () => number;
  constructor(kernel: DyrKernel, fsrs: FsrsAdapter, now: () => number) {
    this.kernel = kernel;
    this.fsrs = fsrs;
    this.now = now;
  }

  private snapshot(t: SkillTrace, now: number): TraceSnapshot {
    return {
      id: t.id,
      lexeme: t.lexeme,
      skill: t.skill,
      R: Number(this.fsrs.retrievability(memoryStateOf(t), now).toFixed(4)),
      S: Number(t.stability.toFixed(4)),
      D: Number(t.difficulty.toFixed(4)),
      state: t.state,
      due: t.due,
      evidenceCount: t.evidenceCount,
      eventCursor: t.eventCursor,
    };
  }

  /** A full versioned projection frame. Purely derived; writes nothing. */
  frame(): ObservatoryFrame {
    const now = this.now();
    return {
      cursor: this.kernel.log.length,
      now,
      profile: this.kernel.frontier.profile(),
      weakestSkill: this.kernel.frontier.weakestSkill(),
      workload: this.kernel.workload(),
      traces: this.kernel.traces.all().map((t) => this.snapshot(t, now)),
    };
  }

  /** The p.5 phase-orbit chain, for the observatory's PHASE ORBIT panel. */
  phaseOrbit(): string[] {
    return ["decay", "plan", "cue", "retrieve", "evidence", "update", "consolidate", "fact"];
  }

  /** Immutable event frames for the REPLAY panel (pause/step/compare). */
  eventFrames(): readonly EventEnvelope[] {
    return this.kernel.log.all();
  }
}
