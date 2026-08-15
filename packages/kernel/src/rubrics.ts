/**
 * Rubric registry (ADR-0004). Builds a versioned TaskRubric for each task
 * family from its metadata. In production these would ship inside immutable
 * content packs; here they are derived deterministically from
 * DEFAULT_TASK_FAMILIES so the version is stable and reproducible.
 */
import {
  type TaskFamily,
  type TaskRubric,
  type SpeechComponent,
  DEFAULT_TASK_FAMILIES,
  DEFAULT_LEAKAGE,
} from "@dyr/domain";

export const RUBRIC_VERSION = "dyr-rubric@1.0.0";

const SPEECH_COMPONENTS: SpeechComponent[] = [
  "transcript",
  "initials_finals",
  "tone",
  "rhythm",
  "fluency",
];

export function buildRubric(family: TaskFamily): TaskRubric {
  const spec = DEFAULT_TASK_FAMILIES[family];
  const isSpeech = spec.rubricKind === "production_speech";
  const isWriting = spec.rubricKind === "production_writing";
  return {
    rubricId: `${family}.rubric`,
    rubricVersion: RUBRIC_VERSION,
    kind: spec.rubricKind,
    skill: spec.targetSkill,
    // Receptive tasks accept the alternatives the pack itself declares, supplied
    // by the planner as a "|"-separated key: every sense of a word, and both
    // written notations of the same pinyin. `semantic_variants` degrades exactly
    // to `normalised` when there is only one alternative, so this loosens
    // nothing — it stops a correct answer being marked wrong because the pack
    // listed a synonym second. Production WRITING stays `normalised`: the
    // expected answer is the hanzi, and there is only one right string.
    matchPolicy: isWriting ? "normalised" : "semantic_variants",
    latencyBandMs: { fast: spec.estSeconds * 400, expected: spec.estSeconds * 1000 },
    leakage: DEFAULT_LEAKAGE,
    requiresCanonicalAudio: spec.requiresCanonicalAudio,
    ...(isSpeech ? { speechComponents: SPEECH_COMPONENTS, automationConfidenceFloor: 0.6 } : {}),
    ...(isWriting ? { writingContext: family === "stroke_handwriting" ? "handwriting" as const : "typed" as const } : {}),
  };
}
