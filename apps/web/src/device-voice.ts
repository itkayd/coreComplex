/**
 * The device's own Mandarin voice, behind the same synthetic contract.
 *
 * This is the browser half of `voice-select.ts`: everything here touches
 * `window.speechSynthesis`, so nothing here is unit-testable and nothing here
 * makes a decision. Decisions live next door.
 *
 * TWO PLATFORM QUIRKS, both of which look like bugs if you do not handle them:
 *
 *   1. `getVoices()` is empty on the first call in Chrome and on Android. The
 *      list arrives later, on `voiceschanged`. Code that asks once concludes the
 *      device has no Chinese voice and disables audio forever.
 *   2. iOS Safari will not speak at all until it has seen a user gesture, and it
 *      silently drops utterances queued before one. So availability is probed
 *      without speaking, and the first sound always comes from a tap.
 *
 * Provenance is stamped `sourceType: "synthetic"` by construction, exactly as
 * CosyVoice's is. A device voice can no more become canonical than CosyVoice
 * can — see `canSatisfyCanonicalAudio` in @dyr/senses.
 */
import {
  DEVICE_VOICE_ADAPTER_VERSION,
  clampRate,
  describeVoice,
  selectMandarinVoice,
  type VoiceLike,
} from "./voice-select.ts";

export interface DeviceVoiceStatus {
  available: boolean;
  /** Human-readable identity of the selected voice, for the UI and provenance. */
  description: string;
  /** True once the platform has actually delivered its voice list. */
  resolved: boolean;
}

const synth = (): SpeechSynthesis | undefined =>
  typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : undefined;

/**
 * Wait for the platform's voice list.
 *
 * Resolves as soon as voices exist, on `voiceschanged`, or after a short timeout
 * — a timeout is not a failure, it is the answer "this device has none", and it
 * must not hang the Settings screen.
 */
export function loadVoices(timeoutMs = 1500): Promise<VoiceLike[]> {
  const speech = synth();
  if (!speech) return Promise.resolve([]);

  const read = (): VoiceLike[] => speech.getVoices().map((v) => ({
    name: v.name, lang: v.lang, localService: v.localService, default: v.default,
  }));

  const first = read();
  if (first.length > 0) return Promise.resolve(first);

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      speech.removeEventListener("voiceschanged", finish);
      clearTimeout(timer);
      resolve(read());
    };
    const timer = setTimeout(finish, timeoutMs);
    speech.addEventListener("voiceschanged", finish);
  });
}

let cached: { voice: VoiceLike | undefined; resolved: boolean } | undefined;

/** Which Mandarin voice this device will use, if any. Probed once, then cached. */
export async function deviceVoiceStatus(): Promise<DeviceVoiceStatus> {
  if (!cached) {
    const voices = await loadVoices();
    cached = { voice: selectMandarinVoice(voices), resolved: true };
  }
  return {
    available: cached.voice !== undefined,
    description: describeVoice(cached.voice),
    resolved: cached.resolved,
  };
}

/** Forget the probe — used when the platform reports a changed voice list. */
export function resetDeviceVoiceCache(): void {
  cached = undefined;
}

export interface DeviceUtterance {
  /** Resolves when playback finishes; rejects if the platform refused. */
  play(): Promise<void>;
  stop(): void;
  provenance: {
    sourceType: "synthetic";
    provider: string;
    modelVersion: string;
    providerVersion: string;
    generatedAt: number;
  };
}

export class DeviceVoiceUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceVoiceUnavailable";
  }
}

/**
 * Prepare an utterance. Nothing is spoken until `play()`, so the sound always
 * originates in the tap handler — which is what iOS requires.
 */
export async function prepareDeviceUtterance(
  text: string,
  opts: { rate?: number } = {},
): Promise<DeviceUtterance> {
  const speech = synth();
  if (!speech) throw new DeviceVoiceUnavailable("this browser has no speech synthesis");

  const status = await deviceVoiceStatus();
  if (!status.available || !cached?.voice) {
    throw new DeviceVoiceUnavailable("this device has no Mandarin voice installed");
  }
  const chosen = cached.voice;

  return {
    provenance: {
      sourceType: "synthetic",
      provider: "device-speech-synthesis",
      modelVersion: chosen.name,
      providerVersion: DEVICE_VOICE_ADAPTER_VERSION,
      generatedAt: Date.now(),
    },
    stop: () => speech.cancel(),
    play: () => new Promise<void>((resolve, reject) => {
      // Anything still queued is stale by definition: the learner just asked for
      // this word, not the previous one.
      speech.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = chosen.lang;
      utterance.rate = clampRate(opts.rate ?? 1);
      const match = speech.getVoices().find((v) => v.name === chosen.name && v.lang === chosen.lang);
      if (match) utterance.voice = match;

      let settled = false;
      utterance.onend = () => { if (!settled) { settled = true; resolve(); } };
      utterance.onerror = (event) => {
        if (settled) return;
        settled = true;
        // `cancel()` fires an error too; a deliberate stop is not a failure.
        if (event.error === "canceled" || event.error === "interrupted") resolve();
        else reject(new DeviceVoiceUnavailable(`the device voice failed: ${event.error}`));
      };

      speech.speak(utterance);
    }),
  };
}
