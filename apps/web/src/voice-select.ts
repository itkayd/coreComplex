/**
 * Choosing a device voice for Mandarin — the pure part, so it can be tested.
 *
 * WHY A DEVICE VOICE AT ALL. The CosyVoice service (apps/service) produces much
 * better audio, but it needs a GPU, model weights and a process the learner runs
 * on their own machine. A phone opening the deployed PWA has none of that, so
 * until now the deployed app had no audio whatsoever: `SPEECH_AVAILABLE` was
 * false and the "Hear it" control was not even rendered. Every mobile browser
 * already ships Mandarin text-to-speech, free, offline, with no key and no
 * account — so the honest fix is to use it as a second synthetic source rather
 * than to ship an app that cannot make a sound.
 *
 * WHAT IT IS NOT. Exactly the same constitutional position as CosyVoice (spec
 * p.21): a device voice is SYNTHETIC. It can never be canonical, never satisfies
 * the listening prerequisite, never cues an audio-primary task, and is always
 * labelled as generated. It is a convenience for hearing a word you are already
 * looking at, nothing more. `canSatisfyCanonicalAudio` in @dyr/senses is what
 * enforces that, and it only ever returns true for `"human"`.
 *
 * WHICH VOICE. Left to the platform, `speechSynthesis` will happily read Chinese
 * text with an English voice, which sounds like nonsense and teaches a wrong
 * thing. So the voice is chosen deliberately:
 *
 *   - Cantonese (zh-HK, yue) is REJECTED, not merely deprioritised. This app
 *     teaches Mandarin; a Cantonese reading of 谢谢 is not a slow-but-usable
 *     approximation, it is a different language and would actively mislead.
 *   - Mainland Mandarin (zh-CN / zh-Hans) is preferred over Taiwan (zh-TW),
 *     which is still Mandarin and is kept as a fallback rather than refused.
 *   - Local (on-device) voices are preferred over network ones, because they
 *     work offline — which is the whole point of a PWA on a phone in a tunnel.
 *
 * The DOM's SpeechSynthesisVoice is structurally typed here so this module has
 * no browser dependency and runs under `node --test`.
 */

/** The part of SpeechSynthesisVoice that matters for choosing one. */
export interface VoiceLike {
  name: string;
  lang: string;
  localService: boolean;
  default?: boolean;
}

/** Adapter identity, recorded in provenance. Bump on a behaviour change. */
export const DEVICE_VOICE_ADAPTER_VERSION = "dyr-device-voice-adapter@1.0.0";

/** BCP-47 tags that are Cantonese, not Mandarin. Never usable here. */
const CANTONESE = /^(yue|zh-(hk|yue))\b/i;

const normaliseTag = (lang: string): string => lang.replace(/_/g, "-").toLowerCase();

/** Is this voice speaking Mandarin Chinese at all? */
export function isMandarin(voice: VoiceLike): boolean {
  const tag = normaliseTag(voice.lang);
  if (CANTONESE.test(tag)) return false;
  // A name can also give Cantonese away when the tag is a bare "zh".
  if (/cantonese|粤|廣東|广东/i.test(voice.name)) return false;
  return tag === "zh" || tag.startsWith("zh-");
}

/**
 * Preference score — higher is better. Only ever applied to Mandarin voices.
 *
 * Deliberately coarse: the exact ordering between two mainland local voices
 * does not matter, but the difference between a mainland voice and a Taiwan one,
 * or between an offline voice and one that needs the network, does.
 */
export function voiceScore(voice: VoiceLike): number {
  const tag = normaliseTag(voice.lang);
  let score = 0;
  if (tag.startsWith("zh-cn") || tag.startsWith("zh-hans")) score += 100;
  else if (tag === "zh") score += 60;
  else if (tag.startsWith("zh-tw") || tag.startsWith("zh-hant")) score += 40;
  else score += 20;
  // Offline voices keep the app usable with no network, which is the point.
  if (voice.localService) score += 30;
  if (voice.default === true) score += 5;
  return score;
}

/**
 * Pick the best Mandarin voice, or `undefined` when the platform has none.
 *
 * `undefined` is a real answer, not a failure to handle: some Linux browsers and
 * some locked-down Android builds genuinely ship no Chinese voice, and the UI
 * must say so rather than silently reading hanzi in English.
 */
export function selectMandarinVoice(voices: readonly VoiceLike[]): VoiceLike | undefined {
  const usable = voices.filter(isMandarin);
  if (usable.length === 0) return undefined;
  // Stable: equal scores keep the platform's own ordering.
  return usable.reduce((best, voice) => (voiceScore(voice) > voiceScore(best) ? voice : best));
}

/**
 * Clamp a requested rate into what the API accepts and what stays intelligible.
 *
 * The Web Speech API nominally allows 0.1–10; anything near those ends is
 * useless for learning, and 0.5–2.0 is the same window the CosyVoice service
 * uses, so the two sources behave identically from the UI's point of view.
 */
export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.min(2, Math.max(0.5, rate));
}

/**
 * A short, human label for the chosen voice — shown so the learner knows what
 * they are listening to and that it is not a recording of a person.
 */
export function describeVoice(voice: VoiceLike | undefined): string {
  if (!voice) return "no Mandarin voice on this device";
  const where = voice.localService ? "on-device" : "network";
  return `${voice.name} (${voice.lang}, ${where})`;
}
