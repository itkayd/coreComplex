/**
 * "Hear it" — one entry point, three synthetic sources, one unbreakable rule.
 *
 *   pronounce(text)
 *     │
 *     ├─ local CosyVoice running?  ── yes ──▶  CosyVoice          best, needs a machine
 *     │        no
 *     ├─ device Mandarin voice?    ── yes ──▶  speechSynthesis    free, offline, everywhere
 *     │        no
 *     └─ cloud TTS configured?     ── yes ──▶  /api/speech        generated audio
 *              no
 *              ▼
 *          no audio, said plainly
 *
 * WHY A CHAIN RATHER THAN A CHOICE. The tiers are good at different things and
 * none dominates. CosyVoice sounds far better and returns content-addressed
 * bytes, but needs hardware a phone does not have. The device voice is mediocre
 * but universal, free, offline and instant — and is what almost every learner
 * actually gets. The cloud tier exists for the device that has neither: a
 * locked-down Android with no Chinese voice pack, a desktop Linux browser with
 * no zh-CN voice. On those, the choice is this or silence.
 *
 * ORDER IS DELIBERATE. Quality first, then the offline-capable tier, then the
 * one that costs a request. Putting the cloud tier higher would spend network on
 * devices that already had a perfectly good voice sitting idle.
 *
 * THE RULE ALL THREE OBEY. Everything here is SYNTHETIC (spec p.21). It is:
 *   - always labelled as a generated voice, never as a pronunciation reference;
 *   - never the cue for an audio-primary task — `CanonicalAudioCue` is the only
 *     thing that may speak before an answer, and it plays verified human bytes
 *     or refuses the task outright;
 *   - never evidence: pressing play grades nothing and moves no trace;
 *   - never canonical, which `canSatisfyCanonicalAudio` enforces structurally by
 *     accepting only `sourceType: "human"`.
 *
 * So this file makes audio USEFUL without making it AUTHORITATIVE, which is the
 * distinction the whole audio design rests on.
 */
import { SPEECH_AVAILABLE, SpeechUnavailable, speak, speechServiceReachable } from "./speech.ts";
import {
  DeviceVoiceUnavailable,
  deviceVoiceStatus,
  prepareDeviceUtterance,
} from "./device-voice.ts";
import { CloudVoiceUnavailable, cloudVoiceStatus, fetchCloudClip, resetCloudVoiceCache } from "./cloud-voice.ts";
import { clampRate } from "./voice-select.ts";

export type PronunciationSourceId = "local-service" | "device-voice" | "cloud-voice";

export interface Pronunciation {
  source: PronunciationSourceId;
  /** What the learner is told they are hearing. */
  description: string;
  /** Resolves when playback finishes. */
  play(): Promise<void>;
  stop(): void;
  /** Releases any object URL. Safe to call more than once. */
  release(): void;
}

export type PronounceFailure = "no_source" | "unreachable" | "failed";

export class PronounceError extends Error {
  readonly reason: PronounceFailure;
  constructor(reason: PronounceFailure, message: string) {
    super(message);
    this.name = "PronounceError";
    this.reason = reason;
  }
}

export interface AudioReadiness {
  /** True when SOMETHING can speak on this device. */
  available: boolean;
  source?: PronunciationSourceId;
  description: string;
}

let readiness: Promise<AudioReadiness> | undefined;

/**
 * What this device can do, probed once.
 *
 * Deliberately cached: the Words screen asks for hundreds of rows and the answer
 * cannot change between them. `resetAudioReadiness` exists for Settings, where
 * a learner who has just installed a voice wants to re-check without a reload.
 */
export function audioReadiness(): Promise<AudioReadiness> {
  readiness ??= probe();
  return readiness;
}

export function resetAudioReadiness(): void {
  readiness = undefined;
  resetCloudVoiceCache();
}

async function probe(): Promise<AudioReadiness> {
  // The service is preferred — but CONFIGURED is not the same as RUNNING, and
  // conflating the two is how the word list ends up rendering hundreds of play
  // buttons that every one of them fails. A dev machine serving the app from
  // localhost has a service URL by default and usually no service behind it, so
  // this asks the service whether it is actually there before promising sound.
  if (SPEECH_AVAILABLE && await speechServiceReachable()) {
    return { available: true, source: "local-service", description: "local speech service" };
  }
  const device = await deviceVoiceStatus();
  if (device.available) {
    return { available: true, source: "device-voice", description: device.description };
  }
  // Last tier: a device with no voice of its own. Asking the server costs one
  // request and is the difference between audio and silence on such a device.
  const cloud = await cloudVoiceStatus();
  if (cloud.available) {
    return { available: true, source: "cloud-voice", description: "generated on the server" };
  }
  return { available: false, description: device.description };
}

/**
 * Speak some Mandarin. Prefers the service, falls back to the device voice.
 *
 * Nothing is audible until `play()` is called, so the sound starts inside the
 * tap handler — iOS Safari discards utterances queued before a user gesture.
 */
export async function pronounce(
  text: string,
  opts: { speed?: number } = {},
): Promise<Pronunciation> {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new PronounceError("failed", "nothing to say");
  const speed = clampRate(opts.speed ?? 1);

  if (SPEECH_AVAILABLE) {
    try {
      return await fromService(trimmed, speed);
    } catch (error) {
      // A configured-but-down service is exactly when the device voice earns its
      // place, so this falls through rather than reporting failure.
      if (!(error instanceof SpeechUnavailable)) throw error;
    }
  }

  try {
    const utterance = await prepareDeviceUtterance(trimmed, { rate: speed });
    const device = await deviceVoiceStatus();
    return {
      source: "device-voice",
      description: device.description,
      play: () => utterance.play(),
      stop: () => utterance.stop(),
      release: () => {},
    };
  } catch (error) {
    // A device with no Mandarin voice is precisely what the cloud tier is for.
    if (!(error instanceof DeviceVoiceUnavailable)) {
      throw new PronounceError("failed", (error as Error).message);
    }
  }

  try {
    return await fromCloud(trimmed, speed);
  } catch (error) {
    if (error instanceof CloudVoiceUnavailable) {
      // Every tier has now declined. The UI treats this as "no audio here",
      // which is honest and costs the learner nothing but sound.
      throw new PronounceError("no_source", "this device has no Mandarin voice, and none is configured on the server");
    }
    throw new PronounceError("failed", (error as Error).message);
  }
}

/**
 * The cloud tier, played like any other clip.
 *
 * Speed is applied with `playbackRate` rather than asked of the upstream:
 * browsers preserve pitch, every provider would want a different parameter for
 * it, and one cached clip then serves every speed instead of one per rate.
 */
async function fromCloud(text: string, speed: number): Promise<Pronunciation> {
  const clip = await fetchCloudClip(text);
  const element = new Audio(clip.objectUrl);
  element.playbackRate = speed;
  let released = false;

  return {
    source: "cloud-voice",
    description: clip.fromCache ? "generated on the server (cached here)" : "generated on the server",
    play: () => new Promise<void>((resolve, reject) => {
      element.currentTime = 0;
      element.onended = () => resolve();
      element.onerror = () => reject(new PronounceError("failed", "could not play that clip"));
      element.play().catch(() => reject(new PronounceError("failed", "playback was refused")));
    }),
    stop: () => element.pause(),
    release: () => {
      if (released) return;
      released = true;
      element.pause();
      URL.revokeObjectURL(clip.objectUrl);
    },
  };
}

async function fromService(text: string, speed: number): Promise<Pronunciation> {
  const clip = await speak(text, { speed });
  const element = new Audio(clip.objectUrl);
  // The service bakes speed in when ffmpeg is present; when it could not, apply
  // it here. Browsers preserve pitch for playbackRate, which is what we want.
  element.playbackRate = speed;
  let released = false;

  return {
    source: "local-service",
    description: `${clip.provenance.provider} ${clip.provenance.modelVersion}`,
    play: () => new Promise<void>((resolve, reject) => {
      element.currentTime = 0;
      element.onended = () => resolve();
      element.onerror = () => reject(new PronounceError("failed", "could not play that clip"));
      element.play().catch(() => reject(new PronounceError("failed", "playback was refused")));
    }),
    stop: () => element.pause(),
    release: () => {
      if (released) return;
      released = true;
      element.pause();
      URL.revokeObjectURL(clip.objectUrl);
    },
  };
}
