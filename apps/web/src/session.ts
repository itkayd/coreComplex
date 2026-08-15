/**
 * Plain-body session controller: kernel wiring + offline persistence.
 *
 * Store separation (spec p.24): this stores ONLY the learning event log and the
 * cached content pack. There is no game/profile/points store — the plain body
 * works with every optional layer absent (spec p.8 Stage 2 exit).
 *
 * Persistence is append-only: attempts are appended locally before any UI
 * success, and the kernel is rebuilt at startup by replaying that log
 * (spec p.24 offline+reconnect; p.14 resume after interruption without penalty).
 */
import Dexie, { type Table } from "dexie";
import {
  DEFAULT_CONFIG,
  DeviceId,
  LearnerId,
  SystemClock,
  type EventEnvelope,
  type LexemeId,
  type RawAttempt,
  type Skill,
  type TaskContract,
} from "@dyr/domain";
import { createFsrsAdapter } from "@dyr/fsrs-adapter";
import { DyrKernel, type Plan, type SubmitResult } from "@dyr/kernel";
import {
  importPack,
  packToGraph,
  packAssetProvider,
  type ExportedPack,
  type RuntimePack,
} from "@dyr/content/runtime";

const LEARNER = LearnerId("local-learner");
const DEVICE = DeviceId("web-1");

/** learning.db — events only. Layer stores would be separate databases. */
class LearningDb extends Dexie {
  events!: Table<EventEnvelope, number>;
  constructor() {
    super("dyr-learning");
    this.version(1).stores({ events: "localSequence, eventType, correlationId" });
  }
}

export interface SessionState {
  kernel: DyrKernel;
  pack: RuntimePack;
  lexemeIds: LexemeId[];
}

let db: LearningDb | undefined;

export async function loadPack(): Promise<RuntimePack> {
  const res = await fetch(`${import.meta.env.BASE_URL}packs/dyr-core60.json`);
  if (!res.ok) throw new Error(`pack unavailable (${res.status})`);
  return importPack((await res.json()) as ExportedPack);
}

/** Build a kernel and restore any persisted history. */
export async function openSession(): Promise<SessionState> {
  const pack = await loadPack();
  db ??= new LearningDb();

  const kernel = new DyrKernel({
    learnerId: LEARNER,
    deviceId: DEVICE,
    clock: new SystemClock(),
    graph: packToGraph(pack),
    fsrs: createFsrsAdapter(),
    config: DEFAULT_CONFIG,
    assets: packAssetProvider(pack, { offline: true }),
  });

  const persisted = await db.events.orderBy("localSequence").toArray();
  if (persisted.length > 0) kernel.hydrate(persisted);

  return { kernel, pack, lexemeIds: pack.lexemes.map((l) => l.id) };
}

/** Append every new event to the local log (append-only, never overwritten). */
export async function persistNewEvents(kernel: DyrKernel, fromCursor: number): Promise<number> {
  const all = kernel.log.all();
  const fresh = all.slice(fromCursor);
  if (fresh.length > 0 && db) {
    // Structured-clone safe copies; bulkPut is idempotent on localSequence.
    await db.events.bulkPut(fresh.map((e) => JSON.parse(JSON.stringify(e))));
  }
  return all.length;
}

export async function exportLearningData(kernel: DyrKernel): Promise<string> {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      learnerId: LEARNER,
      events: kernel.log.all(),
      facts: kernel.publishedFacts(),
    },
    null,
    2,
  );
}

export async function deleteAllLearningData(): Promise<void> {
  db ??= new LearningDb();
  await db.events.clear();
}

// ---- Session flow helpers -------------------------------------------------

export type SessionMode = "rescue" | "default" | "core";
export const MODE_MINUTES: Record<SessionMode, number> = { rescue: 3, default: 7, core: 15 };

export interface ActiveSession {
  plan: Plan;
  index: number;
}

export function planSession(state: SessionState, mode: SessionMode): Plan {
  return state.kernel.planSession({
    budgetMinutes: MODE_MINUTES[mode],
    candidateIntroductions: state.lexemeIds,
    requireOffline: true,
  });
}

export function submit(
  state: SessionState,
  task: TaskContract,
  answer: string,
  latencyMs: number,
  opts: { hintsUsed: number; revealed: boolean; replays: number },
): SubmitResult {
  const attempt: RawAttempt = {
    taskId: task.id,
    targetTrace: task.targetTrace,
    answer,
    latencyMs,
    hintsUsed: opts.hintsUsed,
    answerRevealed: opts.revealed,
    audioReplays: opts.replays,
  };
  return state.kernel.submitAttempt(task, attempt);
}

/** Human-readable, non-judgmental skill labels (spec p.28 COPY). */
export const SKILL_LABEL: Record<Skill, string> = {
  listening: "Listening",
  reading: "Reading",
  speaking: "Speaking",
  writing: "Writing",
};
