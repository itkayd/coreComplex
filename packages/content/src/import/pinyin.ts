/**
 * Pinyin normalisation lives in `@dyr/domain`.
 *
 * It moved there because it is pure language vocabulary — the same closed
 * numbered ⇄ tone-marked transformation the domain already reasons about via
 * `Pronunciation.tones` — and the planner needs it to accept an answer typed in
 * either notation. Duplicating the vowel tables in two packages would be a
 * correctness hazard: the two copies would eventually disagree about a syllable.
 *
 * Re-exported by name so the content importers keep their existing entry point
 * without widening `@dyr/content`'s surface to the whole domain.
 */
export {
  applyToneMark,
  normalisePinyin,
  parseMarkedSyllable,
  parseNumberedSyllable,
  type NormalisedPinyin,
  type PinyinSyllable,
} from "@dyr/domain";
