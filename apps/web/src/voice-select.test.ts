/**
 * Choosing a voice is a correctness question, not a preference.
 *
 * The failure this file exists to prevent: a learner taps a Mandarin word and
 * the device reads it in Cantonese, or in English, or not at all — and nothing
 * in the UI says so. Each of those is a wrong pronunciation delivered with the
 * same confidence as a right one, which is worse than silence.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { clampRate, describeVoice, isMandarin, selectMandarinVoice, voiceScore, type VoiceLike } from "./voice-select.ts";

const voice = (name: string, lang: string, localService = true, isDefault = false): VoiceLike =>
  ({ name, lang, localService, default: isDefault });

test("Cantonese is refused outright, not merely ranked last", () => {
  // A Cantonese reading of a Mandarin word is a different language, not a worse
  // accent. Offering it would teach the wrong thing.
  for (const v of [voice("Sin-ji", "zh-HK"), voice("Google 粤語", "yue-HK"), voice("Cantonese", "zh")]) {
    assert.equal(isMandarin(v), false, `${v.name} must not be treated as Mandarin`);
  }
  assert.equal(selectMandarinVoice([voice("Sin-ji", "zh-HK")]), undefined);
});

test("non-Chinese voices are never selected, however many there are", () => {
  const english = [voice("Samantha", "en-US", true, true), voice("Daniel", "en-GB"), voice("Alex", "en-US")];
  assert.equal(selectMandarinVoice(english), undefined, "an English voice reading hanzi is nonsense");
});

test("mainland Mandarin wins over Taiwan, which wins over nothing", () => {
  const tw = voice("Mei-Jia", "zh-TW");
  const cn = voice("Ting-Ting", "zh-CN");
  assert.equal(selectMandarinVoice([tw, cn])?.name, "Ting-Ting");
  assert.equal(selectMandarinVoice([tw, cn].reverse())?.name, "Ting-Ting");
  // Taiwan Mandarin is still Mandarin: a fallback, not a refusal.
  assert.equal(selectMandarinVoice([tw])?.name, "Mei-Jia");
});

test("an offline voice beats a network voice of the same language", () => {
  // Offline is the whole point of a PWA: the app must still speak in a tunnel.
  const network = voice("Google 普通话（中国大陆）", "zh-CN", false, true);
  const local = voice("Ting-Ting", "zh-CN", true);
  assert.equal(selectMandarinVoice([network, local])?.name, "Ting-Ting");
  assert.ok(voiceScore(local) > voiceScore(network));
});

test("a network Mandarin voice still beats no Mandarin voice", () => {
  const only = voice("Google 普通话（中国大陆）", "zh-CN", false);
  assert.equal(selectMandarinVoice([voice("Samantha", "en-US"), only])?.name, only.name);
});

test("no Mandarin voice is a reportable answer, not a crash", () => {
  assert.equal(selectMandarinVoice([]), undefined);
  assert.match(describeVoice(undefined), /no Mandarin voice/);
  // And the description names where the audio comes from, so the learner can
  // tell an on-device voice from one that needs the network.
  assert.match(describeVoice(voice("Ting-Ting", "zh-CN")), /Ting-Ting.*zh-CN.*on-device/);
  assert.match(describeVoice(voice("Google", "zh-CN", false)), /network/);
});

test("underscored and mixed-case tags are still recognised", () => {
  // Android reports zh_CN; some builds report ZH-cn. Both are the same language.
  assert.equal(isMandarin(voice("A", "zh_CN")), true);
  assert.equal(isMandarin(voice("B", "ZH-Hans-CN")), true);
  assert.equal(isMandarin(voice("C", "zh_HK")), false, "a tag quirk must not smuggle Cantonese through");
});

test("playback rate is clamped to a window that stays intelligible", () => {
  // The Web Speech API allows 0.1–10; both extremes are useless for learning,
  // and this window matches the speech service so the two sources behave alike.
  assert.equal(clampRate(0.05), 0.5);
  assert.equal(clampRate(9), 2);
  assert.equal(clampRate(0.6), 0.6);
  assert.equal(clampRate(Number.NaN), 1, "a bad number must not silence playback");
  assert.equal(clampRate(Number.POSITIVE_INFINITY), 1);
});
