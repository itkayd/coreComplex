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
  loadVerifiedPack,
  packAudioUrls,
  packToGraph,
  packAssetProvider,
  PackRejected,
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

/**
 * Load the content pack — and REFUSE it unless it validates and its content
 * still hashes to the value it claims.
 *
 * A pack arrives as JSON over the network: TypeScript guarantees nothing about
 * it at runtime. An unverified pack could be truncated, stale or swapped, and
 * teaching from content of unknown provenance is exactly what the licence and
 * immutability rules exist to prevent.
 */
/**
 * Where the pack and its content-addressed audio live. Audio paths inside the
 * pack are relative to this, so nothing from the build machine's filesystem is
 * ever exposed to the browser.
 */
export const PACK_BASE_URL = `${import.meta.env.BASE_URL}packs/`;

export async function loadPack(): Promise<RuntimePack> {
  const res = await fetch(`${PACK_BASE_URL}dyr-core60.json`);
  if (!res.ok) throw new Error(`pack unavailable (${res.status})`);
  try {
    return importPack(await loadVerifiedPack(await res.json()));
  } catch (error) {
    if (error instanceof PackRejected) {
      throw new Error(`content pack rejected (${error.reason}): ${error.message}`);
    }
    throw error;
  }
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

  // Install this pack's audio for offline use. Deliberately driven from the
  // app rather than a precache list baked into the worker: the pack knows its
  // own recordings, the cache is named for the pack version, and a future
  // larger pack can be installed or evicted independently of the app shell.
  void installPackAudio(pack);

  return { kernel, pack, lexemeIds: pack.lexemes.map((l) => l.id) };
}

/** Ask the service worker to cache exactly this pack's canonical recordings. */
export async function installPackAudio(pack: RuntimePack): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const urls = packAudioUrls(pack, PACK_BASE_URL);
  if (urls.length === 0) return;
  const registration = await navigator.serviceWorker.ready.catch(() => undefined);
  registration?.active?.postMessage({
    type: "dyr:install-pack",
    packVersion: String(pack.packVersion),
    urls,
  });
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
  opts: { hintsUsed: number; revealed: boolean; audioPlays: number },
): SubmitResult {
  const attempt: RawAttempt = {
    taskId: task.id,
    targetTrace: task.targetTrace,
    answer,
    latencyMs,
    hintsUsed: opts.hintsUsed,
    answerRevealed: opts.revealed,
    // A real count of how many times the learner played the clip. The rubric
    // allows one free play (`freeAudioReplays: 1`) and penalises each further
    // one, so this must come from playback events — the previous hardcoded 1
    // claimed every reading task had played audio and every listening task had
    // played it exactly once.
    audioReplays: opts.audioPlays,
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
