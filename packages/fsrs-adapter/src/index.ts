/**
 * @dyr/fsrs-adapter — the ONLY package that imports `ts-fsrs`.
 *
 * Spec p.14: "Use FSRS as an adapter, not as the whole brain." ts-fsrs owns
 * memory-parameter updates; the Dyr kernel owns evidence validity, trace
 * identity, constraints, progression and explanations.
 *
 * ADR-0001 (real ts-fsrs), ADR-0002 (single retrievability authority),
 * ADR-0003 (short-term repair via learning/relearning steps).
 *
 * Library: ts-fsrs 5.4.1 (MIT), github.com/open-spaced-repetition/ts-fsrs
 * (spec p.32 #14). Determinism: fuzz is disabled and the clock is injected, so
 * `scheduleReview` is a pure function of (state, rating, now). ts-fsrs types
 * never cross this boundary — the kernel sees only domain-neutral `MemoryState`.
 */
import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  FSRSVersion,
  Rating as TsRating,
  State as TsState,
  type Card,
  type FSRS,
  type FSRSParameters,
  type Grade,
} from "ts-fsrs";
import {
  type MemoryState,
  type Millis,
  type Rating,
  type TraceState,
  RATING_VALUE,
  hashValue,
} from "@dyr/domain";

const DAY = 86_400_000;

export interface ScheduleResult {
  state: MemoryState;
  /** Retrievability observed at the moment of this review (for the LearningFact). */
  retrievabilityAtReview: number;
}

/** Domain-facing scheduler contract. The kernel depends only on this. */
export interface FsrsAdapter {
  readonly version: string;
  /** Serialisable config metadata, persisted so decisions are reproducible. */
  readonly parameters: FsrsAdapterParameters;
  /** A fresh, never-reviewed memory state. */
  initialState(): MemoryState;
  /** Pure: same (state, rating, now) → same result. */
  scheduleReview(state: MemoryState, rating: Rating, now: Millis): ScheduleResult;
  /** Retrievability of a state at `now`, in [0,1]. The single authority. */
  retrievability(state: MemoryState, now: Millis): number;
}

export interface FsrsAdapterParameters {
  library: "ts-fsrs";
  libraryVersion: string;
  requestRetention: number;
  maximumIntervalDays: number;
  enableShortTerm: boolean;
  enableFuzz: false;
  learningSteps: readonly string[];
  relearningSteps: readonly string[];
  /** Deterministic hash of the effective ts-fsrs parameters. */
  configHash: string;
}

export interface FsrsConfig {
  requestRetention?: number;
  maximumIntervalDays?: number;
  /** Learning steps (spec/ADR-0003 short-term repair). */
  learningSteps?: readonly string[];
  relearningSteps?: readonly string[];
  /** Optional pinned weights; defaults to ts-fsrs library defaults. */
  weights?: readonly number[];
}

const STATE_TO_TS: Record<TraceState, TsState> = {
  new: TsState.New,
  learning: TsState.Learning,
  review: TsState.Review,
  relearning: TsState.Relearning,
};
const TS_TO_STATE: Record<TsState, TraceState> = {
  [TsState.New]: "new",
  [TsState.Learning]: "learning",
  [TsState.Review]: "review",
  [TsState.Relearning]: "relearning",
};

function ratingToGrade(rating: Rating): Grade {
  // Domain RATING_VALUE (again=1..easy=4) matches ts-fsrs Rating enum values.
  return RATING_VALUE[rating] as unknown as Grade;
}

export function createFsrsAdapter(config: FsrsConfig = {}): FsrsAdapter {
  const params: FSRSParameters = generatorParameters({
    request_retention: config.requestRetention ?? 0.9,
    maximum_interval: config.maximumIntervalDays ?? 36500,
    enable_fuzz: false, // determinism (ADR-0001)
    enable_short_term: true, // short-term repair (ADR-0003)
    ...(config.learningSteps ? { learning_steps: config.learningSteps } : {}),
    ...(config.relearningSteps ? { relearning_steps: config.relearningSteps } : {}),
    ...(config.weights ? { w: config.weights } : {}),
  });
  const engine: FSRS = fsrs(params);

  const parameters: FsrsAdapterParameters = {
    library: "ts-fsrs",
    libraryVersion: FSRSVersion,
    requestRetention: params.request_retention,
    maximumIntervalDays: params.maximum_interval,
    enableShortTerm: params.enable_short_term,
    enableFuzz: false,
    learningSteps: params.learning_steps as readonly string[],
    relearningSteps: params.relearning_steps as readonly string[],
    configHash: hashValue({
      w: params.w,
      r: params.request_retention,
      m: params.maximum_interval,
      ls: params.learning_steps,
      rs: params.relearning_steps,
      st: params.enable_short_term,
    }),
  };
  const version = `dyr-fsrs-adapter@2.0.0/ts-fsrs@${FSRSVersion}#${parameters.configHash}`;

  /** Reconstruct a ts-fsrs Card from domain-neutral MemoryState. */
  function toCard(state: MemoryState, now: Millis): Card {
    if (state.state === "new" || state.lastReview === undefined) {
      return createEmptyCard(new Date(now));
    }
    return {
      due: new Date(state.due ?? now),
      stability: state.stability,
      difficulty: state.difficulty,
      elapsed_days: 0, // recomputed by ts-fsrs from last_review
      scheduled_days: state.scheduledDays,
      learning_steps: state.learningSteps,
      reps: state.reps,
      lapses: state.lapses,
      state: STATE_TO_TS[state.state],
      last_review: new Date(state.lastReview),
    };
  }

  function fromCard(card: Card): MemoryState {
    return {
      stability: card.stability,
      difficulty: card.difficulty,
      state: TS_TO_STATE[card.state],
      due: card.due.getTime(),
      lastReview: card.last_review ? card.last_review.getTime() : undefined,
      reps: card.reps,
      lapses: card.lapses,
      learningSteps: card.learning_steps,
      scheduledDays: card.scheduled_days,
    };
  }

  return {
    version,
    parameters,

    initialState(): MemoryState {
      return {
        stability: 0,
        difficulty: 0,
        state: "new",
        reps: 0,
        lapses: 0,
        learningSteps: 0,
        scheduledDays: 0,
      };
    },

    retrievability(state: MemoryState, now: Millis): number {
      if (state.state === "new" || state.lastReview === undefined) return 0;
      return engine.get_retrievability(toCard(state, now), new Date(now), false);
    },

    scheduleReview(state: MemoryState, rating: Rating, now: Millis): ScheduleResult {
      const card = toCard(state, now);
      const retrievabilityAtReview =
        state.state === "new" || state.lastReview === undefined
          ? 0
          : engine.get_retrievability(card, new Date(now), false);
      const { card: nextCard } = engine.next(card, new Date(now), ratingToGrade(rating));
      return { state: fromCard(nextCard), retrievabilityAtReview };
    },
  };
}

export type { MemoryState } from "@dyr/domain";
