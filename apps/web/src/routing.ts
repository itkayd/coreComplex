/**
 * Provider routing — the decision, separated from the machinery.
 *
 * WHY THIS FILE EXISTS SEPARATELY. Every concrete provider touches something
 * untestable outside a browser: `speechSynthesis`, `fetch`, `Audio`, or Vite's
 * `import.meta.env`. Routing is where the interesting failures live — a
 * provider that probes true and then fails to play, a chain that falls back
 * forever, a tier consulted when a better one already worked — and none of that
 * should need a browser to verify. So the chain is pure and takes its providers
 * as arguments; `pronounce.ts` supplies the real three.
 *
 * TWO KINDS OF FAILURE, AND BOTH MATTER.
 *
 *   Readiness failure — the provider says up front it cannot work. Cheap to
 *   detect, and the reason the UI can avoid rendering a control that could only
 *   ever fail.
 *
 *   RUNTIME failure — the provider probed true, prepared successfully, and then
 *   threw when actually asked to make a sound. This is not hypothetical: a
 *   device voice can exist and still refuse to speak, and an upstream can accept
 *   a request and then time out. A chain that only falls back during probing
 *   leaves the learner with a button that does nothing, so `play()` itself
 *   resumes the walk from the next provider.
 *
 * NO RECURSION, BY CONSTRUCTION. The walk is an index into a fixed array that
 * only ever moves forward. A provider cannot re-enter the chain, and the worst
 * case is one attempt per provider.
 */

export type PronunciationSourceId = "local-service" | "device-voice" | "cloud-voice";

/**
 * Provenance for generated speech, matching `@dyr/senses`'s contract.
 *
 * `sourceType` is the literal `"synthetic"` — not a boolean a caller could flip,
 * and not optional — so no provider here can construct a result claiming to be a
 * human recording. That is the whole reason the field is shaped this way.
 */
export interface SyntheticSource {
  readonly sourceType: "synthetic";
  readonly provider: string;
  readonly modelVersion: string;
}

/** A prepared, playable clip. */
export interface Playable {
  /** Resolves when playback finishes; rejects if the platform refused. */
  play(): Promise<void>;
  stop(): void;
  /** Releases any object URL. Safe to call more than once. */
  release(): void;
  /** What the learner is told they are hearing. */
  description: string;
}

export interface PronounceOptions {
  speed: number;
  /**
   * An `<audio>` element already unlocked inside the user's tap.
   *
   * Safari will not play audio that was not started by a user gesture, and an
   * async provider chain loses that activation. Providers that play a file use
   * this element rather than constructing their own. See `audio-unlock.ts`.
   */
  element?: HTMLAudioElement;
}

export interface PronunciationProvider {
  readonly id: PronunciationSourceId;
  readonly source: SyntheticSource;
  /** Can this provider work right now? Should be cheap and is cached upstream. */
  probe(): Promise<boolean>;
  /** Build a playable clip, or throw. */
  prepare(text: string, opts: PronounceOptions): Promise<Playable>;
}

export type PronounceFailure = "no_source" | "failed";

export class PronounceError extends Error {
  readonly reason: PronounceFailure;
  constructor(reason: PronounceFailure, message: string) {
    super(message);
    this.name = "PronounceError";
    this.reason = reason;
  }
}

export interface Pronunciation extends Playable {
  source: PronunciationSourceId;
  /** Synthetic, always. Exposed so the UI can label it honestly. */
  provenance: SyntheticSource;
}

export interface Readiness {
  available: boolean;
  source?: PronunciationSourceId;
}

/**
 * The first provider that says it can work.
 *
 * Probing stops at the first success, so a device with a working local service
 * never pays for a network probe of the tiers below it.
 */
export async function firstReady(providers: readonly PronunciationProvider[]): Promise<Readiness> {
  for (const provider of providers) {
    if (await provider.probe().catch(() => false)) {
      return { available: true, source: provider.id };
    }
  }
  return { available: false };
}

interface Attempt {
  index: number;
  provider: PronunciationProvider;
  playable: Playable;
}

/**
 * Walk forward from `from` and return the first provider that both probes true
 * AND prepares successfully.
 *
 * Returns a plain attempt rather than a finished `Pronunciation`, deliberately:
 * the wrapper below is the only thing that wraps, so a fallback never produces a
 * handle nested inside a handle. That nesting was a real bug — the outer handle
 * copied `source` from the inner one *before* the inner one had fallen back, so
 * it reported the wrong provider afterwards.
 */
async function findFrom(
  providers: readonly PronunciationProvider[],
  text: string,
  opts: PronounceOptions,
  from: number,
): Promise<Attempt | undefined> {
  for (let index = from; index < providers.length; index++) {
    const provider = providers[index];
    if (!(await provider.probe().catch(() => false))) continue;
    try {
      return { index, provider, playable: await provider.prepare(text, opts) };
    } catch {
      // Preparation failed despite a positive probe. The next tier is exactly
      // what that situation is for.
    }
  }
  return undefined;
}

/**
 * Prepare a clip from the best available provider, with runtime fallback.
 *
 * `from` is where the walk starts, which is what makes recovery non-recursive:
 * a runtime failure resumes at the next index and can never revisit a provider
 * that already failed.
 */
export async function prepareFrom(
  providers: readonly PronunciationProvider[],
  text: string,
  opts: PronounceOptions,
  from = 0,
): Promise<Pronunciation> {
  const attempt = await findFrom(providers, text, opts, from);
  if (!attempt) {
    throw new PronounceError(
      "no_source",
      from === 0
        ? "no pronunciation source is available on this device"
        : "no other pronunciation source is available",
    );
  }
  return wrap(providers, text, opts, attempt);
}

/**
 * Wrap a prepared clip so a RUNTIME failure continues the chain.
 *
 * The returned handle stays valid across a fallback: `play()` swaps in the
 * replacement's playable and reports the new source, so a caller holding this
 * object does not have to know a substitution happened. `stop()` and `release()`
 * always act on whichever clip is currently live, so nothing is orphaned.
 */
function wrap(
  providers: readonly PronunciationProvider[],
  text: string,
  opts: PronounceOptions,
  attempt: Attempt,
): Pronunciation {
  let current = attempt;

  const handle: Pronunciation = {
    source: current.provider.id,
    provenance: current.provider.source,
    get description() { return current.playable.description; },
    play: async () => {
      // A flat loop, not recursion: `index` only ever increases, so each
      // provider is attempted at most once and the walk always terminates.
      for (;;) {
        try {
          await current.playable.play();
          return;
        } catch (error) {
          current.playable.release();
          const next = await findFrom(providers, text, opts, current.index + 1);
          if (!next) {
            throw new PronounceError("failed", (error as Error)?.message ?? "playback failed");
          }
          current = next;
          // The handle reports where the sound actually came from, so a caller
          // holding it never has to know a substitution happened.
          handle.source = next.provider.id;
          handle.provenance = next.provider.source;
        }
      }
    },
    stop: () => current.playable.stop(),
    release: () => current.playable.release(),
  } as Pronunciation;

  return handle;
}
