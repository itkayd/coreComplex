/**
 * "Hear it" — three synthetic providers, one order, one unbreakable rule.
 *
 *   user taps 🔊
 *        │
 *        ▼
 *   1. local CosyVoice running?  ── yes ──▶  best quality, needs a machine
 *        │ no
 *   2. device Mandarin voice?    ── yes ──▶  free, offline, on almost every phone
 *        │ no
 *   3. Cloudflare MeloTTS        ── yes ──▶  /api/tts, natural, needs network once
 *        │ no
 *        ▼
 *   PronounceError — the control is not rendered, and Settings says why
 *
 * WHY THIS ORDER, having considered CosyVoice → Cloudflare → device.
 *
 * The brief invited the cloud tier to sit second, on the grounds that MeloTTS
 * sounds better than a stock system voice. It usually does. It is still the
 * wrong place for it, for reasons that outrank quality here:
 *
 *   RELIABILITY, the stated first priority. The device voice depends on nothing
 *   — no network, no account, no upstream quota, no third party's availability.
 *   Cloudflare depends on all of them. Putting a networked provider ahead of a
 *   local one makes the common case fragile to improve the rare case.
 *
 *   LATENCY. `speechSynthesis` speaks in tens of milliseconds. A Workers AI
 *   round trip plus MP3 transfer is hundreds at best, on a control a learner
 *   taps repeatedly while reading a word list.
 *
 *   OFFLINE, which the brief lists explicitly. On a phone in a tunnel the device
 *   voice works and the cloud does not. Ordering the cloud first would mean a
 *   first-time word is silent offline even though the phone could have said it.
 *
 *   COST. Every cloud clip is a Workers AI request. Spending one on a device
 *   that already has a perfectly good voice sitting idle buys nothing.
 *
 * So the cloud tier is where it does the most good: on the devices that
 * genuinely cannot speak — a locked-down Android with no Chinese voice pack, a
 * desktop Linux browser with no zh-CN speech-dispatcher voice, a device whose
 * only Chinese voice is Cantonese (refused outright, because a Cantonese reading
 * of a Mandarin word is a wrong answer delivered confidently). For those the
 * choice was silence, and now it is natural Mandarin.
 *
 * The order lives in ONE array below. Changing it is a one-line edit and needs
 * no UI change, which is the point of the provider abstraction.
 *
 * THE RULE ALL THREE OBEY. Everything here is SYNTHETIC (spec p.21):
 *   - always labelled as a generated voice, never as a pronunciation reference;
 *   - never the cue for an audio-primary task — `CanonicalAudioCue` is the only
 *     component that speaks before an answer, and it plays verified human bytes
 *     or refuses the task outright;
 *   - never evidence: pressing play grades nothing and moves no trace;
 *   - never canonical — `canSatisfyCanonicalAudio` accepts only `"human"`, and
 *     `isCanonical` additionally refuses anything flagged synthetic.
 */
import { SPEECH_AVAILABLE, SpeechUnavailable, speak, speechServiceReachable } from "./speech.ts";
import { deviceVoiceStatus, prepareDeviceUtterance } from "./device-voice.ts";
import {
  MODEL, cloudVoiceStatus, fetchCloudClip, resetCloudVoiceCache,
} from "./cloud-voice.ts";
import { playThrough, unlockAudio } from "./audio-unlock.ts";
import { clampRate } from "./voice-select.ts";
import {
  PronounceError, firstReady, prepareFrom,
  type Playable, type PronounceOptions, type Pronunciation,
  type PronunciationProvider, type PronunciationSourceId,
} from "./routing.ts";

export { PronounceError } from "./routing.ts";
export type { Pronunciation, PronunciationSourceId } from "./routing.ts";

// ---------------------------------------------------------------------------
// The three providers.

/** Tier 1 — the local CosyVoice service. Best audio, needs a machine. */
const localService: PronunciationProvider = {
  id: "local-service",
  source: { sourceType: "synthetic", provider: "cosyvoice", modelVersion: "local-service" },
  // CONFIGURED IS NOT RUNNING. A dev machine serving the app from localhost has
  // a service URL by default and usually nothing behind it; conflating the two
  // is what once made the Words screen render hundreds of failing buttons.
  probe: async () => SPEECH_AVAILABLE && await speechServiceReachable(),
  prepare: async (text, opts) => {
    let clip: Awaited<ReturnType<typeof speak>>;
    try {
      clip = await speak(text, { speed: opts.speed });
    } catch (error) {
      if (error instanceof SpeechUnavailable) throw error;
      throw error;
    }
    return elementClip(
      clip.objectUrl,
      opts,
      `${clip.provenance.provider} ${clip.provenance.modelVersion}`,
    );
  },
};

/** Tier 2 — the device's own Mandarin voice. Free, offline, everywhere. */
const deviceVoice: PronunciationProvider = {
  id: "device-voice",
  source: { sourceType: "synthetic", provider: "device-speech-synthesis", modelVersion: "platform" },
  probe: async () => (await deviceVoiceStatus()).available,
  prepare: async (text, opts) => {
    const utterance = await prepareDeviceUtterance(text, { rate: opts.speed });
    const status = await deviceVoiceStatus();
    return {
      description: status.description,
      play: () => utterance.play(),
      stop: () => utterance.stop(),
      release: () => {},
    };
  },
};

/** Tier 3 — Cloudflare Workers AI / MeloTTS, proxied by `/api/tts`. */
const cloudVoice: PronunciationProvider = {
  id: "cloud-voice",
  source: { sourceType: "synthetic", provider: "cloudflare-workers-ai", modelVersion: MODEL },
  probe: async () => (await cloudVoiceStatus()).available,
  prepare: async (text, opts) => {
    const clip = await fetchCloudClip(text, opts.speed);
    return elementClip(
      clip.objectUrl,
      opts,
      clip.fromCache ? "generated voice (cached here)" : "generated voice",
    );
  },
};

/**
 * The chain. Order is the whole policy — see the note at the top of this file.
 */
export const PROVIDERS: readonly PronunciationProvider[] = [localService, deviceVoice, cloudVoice];

/**
 * Play a file through the element the tap already unlocked.
 *
 * Falling back to a fresh `Audio` keeps this working in tests and on platforms
 * with no activation requirement; on iOS that fresh element would be blocked,
 * which is exactly why the caller passes one in.
 */
function elementClip(objectUrl: string, opts: PronounceOptions, description: string): Playable {
  const element = opts.element ?? new Audio();
  let released = false;
  return {
    description,
    play: () => playThrough(element, objectUrl, opts.speed),
    stop: () => element.pause(),
    release: () => {
      if (released) return;
      released = true;
      element.pause();
      URL.revokeObjectURL(objectUrl);
    },
  };
}

// ---------------------------------------------------------------------------
// Readiness.

export interface AudioReadiness {
  /** True when SOMETHING can speak on this device. */
  available: boolean;
  source?: PronunciationSourceId;
  description: string;
}

const DESCRIPTION: Record<PronunciationSourceId, string> = {
  "local-service": "local speech service",
  "device-voice": "this device's Mandarin voice",
  "cloud-voice": "generated on the server",
};

let readiness: Promise<AudioReadiness> | undefined;

/**
 * What this device can do, probed once.
 *
 * Cached because the Words screen asks for hundreds of rows and the answer
 * cannot change between them. `resetAudioReadiness` exists for Settings, where a
 * learner who has just installed a voice wants to re-check without a reload.
 *
 * Readiness is a claim about ACTUAL usable behaviour, not about configuration:
 * every probe here either reaches the thing it describes or asks the platform
 * directly. It is still only a claim — which is why `play()` falls back too.
 */
export function audioReadiness(): Promise<AudioReadiness> {
  readiness ??= (async () => {
    const ready = await firstReady(PROVIDERS);
    if (!ready.available || !ready.source) {
      return { available: false, description: (await deviceVoiceStatus()).description };
    }
    return { available: true, source: ready.source, description: DESCRIPTION[ready.source] };
  })();
  return readiness;
}

export function resetAudioReadiness(): void {
  readiness = undefined;
  resetCloudVoiceCache();
}

// ---------------------------------------------------------------------------

/**
 * Speak some Mandarin, using the best provider that actually works.
 *
 * MUST be called from a user gesture on iOS. `unlockAudio()` runs first and
 * synchronously, before any await, so Safari's activation is claimed while it
 * still exists — see `audio-unlock.ts`.
 */
export async function pronounce(
  text: string,
  opts: { speed?: number } = {},
): Promise<Pronunciation> {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new PronounceError("failed", "nothing to say");

  // Synchronous, and first: everything after this point is async, and by then
  // the gesture is gone.
  const element = unlockAudio();

  return prepareFrom(PROVIDERS, trimmed, { speed: clampRate(opts.speed ?? 1), element });
}
