/**
 * TaskFamily metadata (ADR-0009, spec Correction 6/10, p.13/p.22).
 *
 * Task/skill logic lives in this data, not a hard-coded switch. Each family
 * declares its cue direction, target skill, rubric kind, evidence/leakage needs
 * and — crucially — its prerequisites as EVIDENCE REQUIREMENTS rather than a
 * universal four-step chain (ADR-0005). This is how speaking begins early
 * (echo/shadow needs only listening exposure) while independent production
 * requires stronger prerequisites.
 */
import type { Skill } from "./skills.ts";
import type { TaskFamily } from "./contracts.ts";
import type { RubricKind } from "./rubric.ts";

export type EvidenceLevel = "exposed" | "retained";

/** A prerequisite: some skill of the SAME lexeme must reach a level. */
export interface PrereqRule {
  skill: Skill;
  level: EvidenceLevel;
}

export type CueDirection =
  | "audio_to_meaning"
  | "hanzi_to_meaning"
  | "hanzi_to_sound"
  | "meaning_to_speech"
  | "meaning_to_hanzi"
  | "scene_to_speech"
  | "audio_to_hanzi";

export interface TaskFamilySpec {
  family: TaskFamily;
  targetSkill: Skill;
  cueDirection: CueDirection;
  rubricKind: RubricKind;
  requiresCanonicalAudio: boolean;
  /**
   * Prerequisites as evidence requirements (ADR-0005). Empty = an entry task
   * that may begin from cold. A self-prerequisite ({skill: sameSkill}) is not
   * used — a channel bootstraps through its own entry family.
   */
  prerequisites: PrereqRule[];
  estSeconds: number;
}

/**
 * The default task-family registry. Deliberately NON-LINEAR:
 *  - listening & reading each have a cold-start entry family;
 *  - echo/shadow speaking needs only listening EXPOSURE (starts day one);
 *  - handwriting/typed writing begin early from reading exposure;
 *  - independent production (timed reply, composition, roleplay) needs stronger,
 *    RETAINED prerequisites.
 * No cross-skill mastery ever propagates; these are admission gates only.
 */
export const DEFAULT_TASK_FAMILIES: Record<TaskFamily, TaskFamilySpec> = {
  // --- Listening ---
  audio_to_meaning: fam("audio_to_meaning", "listening", "audio_to_meaning", "receptive_audio", true, [], 8),
  tone_contrast: fam("tone_contrast", "listening", "audio_to_meaning", "receptive_audio", true, [], 8),
  micro_dictation: fam("micro_dictation", "listening", "audio_to_hanzi", "receptive_audio", true, [{ skill: "listening", level: "exposed" }], 12),
  clip_comprehension: fam("clip_comprehension", "listening", "audio_to_meaning", "receptive_audio", true, [{ skill: "listening", level: "retained" }], 15),
  listen_then_act: fam("listen_then_act", "listening", "audio_to_meaning", "receptive_audio", true, [{ skill: "listening", level: "retained" }], 15),
  // --- Reading ---
  hanzi_to_meaning: fam("hanzi_to_meaning", "reading", "hanzi_to_meaning", "receptive_exact", false, [], 8),
  hanzi_to_sound: fam("hanzi_to_sound", "reading", "hanzi_to_sound", "receptive_exact", false, [{ skill: "reading", level: "exposed" }], 8),
  sentence_cloze: fam("sentence_cloze", "reading", "hanzi_to_meaning", "receptive_exact", false, [{ skill: "reading", level: "retained" }], 12),
  segmentation_reorder: fam("segmentation_reorder", "reading", "hanzi_to_meaning", "receptive_exact", false, [{ skill: "reading", level: "retained" }], 15),
  graded_passage: fam("graded_passage", "reading", "hanzi_to_meaning", "receptive_exact", false, [{ skill: "reading", level: "retained" }], 20),
  // --- Speaking (starts early via echo/shadow) ---
  echo_shadow: fam("echo_shadow", "speaking", "scene_to_speech", "production_speech", true, [{ skill: "listening", level: "exposed" }], 12),
  meaning_to_speech: fam("meaning_to_speech", "speaking", "meaning_to_speech", "production_speech", false, [{ skill: "listening", level: "retained" }], 15),
  substitution: fam("substitution", "speaking", "meaning_to_speech", "production_speech", false, [{ skill: "speaking", level: "exposed" }], 15),
  timed_reply: fam("timed_reply", "speaking", "scene_to_speech", "production_speech", false, [{ skill: "speaking", level: "retained" }], 20),
  roleplay_picture: fam("roleplay_picture", "speaking", "scene_to_speech", "production_speech", false, [{ skill: "speaking", level: "retained" }], 20),
  // --- Writing (typed early; handwriting/composition later) ---
  meaning_to_typed_word: fam("meaning_to_typed_word", "writing", "meaning_to_hanzi", "production_writing", false, [{ skill: "reading", level: "exposed" }], 12),
  audio_to_hanzi: fam("audio_to_hanzi", "writing", "audio_to_hanzi", "production_writing", true, [{ skill: "listening", level: "retained" }], 15),
  stroke_handwriting: fam("stroke_handwriting", "writing", "meaning_to_hanzi", "production_writing", false, [{ skill: "reading", level: "retained" }], 20),
  sentence_construction: fam("sentence_construction", "writing", "meaning_to_hanzi", "production_writing", false, [{ skill: "writing", level: "exposed" }], 20),
  composition_revision: fam("composition_revision", "writing", "meaning_to_hanzi", "production_writing", false, [{ skill: "writing", level: "retained" }], 25),
};

function fam(
  family: TaskFamily,
  targetSkill: Skill,
  cueDirection: CueDirection,
  rubricKind: RubricKind,
  requiresCanonicalAudio: boolean,
  prerequisites: PrereqRule[],
  estSeconds: number,
): TaskFamilySpec {
  return { family, targetSkill, cueDirection, rubricKind, requiresCanonicalAudio, prerequisites, estSeconds };
}

/** The cold-start entry family per skill (used to bootstrap a channel). */
export const ENTRY_FAMILY: Record<Skill, TaskFamily> = {
  listening: "audio_to_meaning",
  reading: "hanzi_to_meaning",
  speaking: "echo_shadow",
  writing: "meaning_to_typed_word",
};
