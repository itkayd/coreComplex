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
    matchPolicy:
      spec.rubricKind === "receptive_exact" || isWriting ? "normalised" : "semantic_variants",
    latencyBandMs: { fast: spec.estSeconds * 400, expected: spec.estSeconds * 1000 },
    leakage: DEFAULT_LEAKAGE,
    requiresCanonicalAudio: spec.requiresCanonicalAudio,
    ...(isSpeech ? { speechComponents: SPEECH_COMPONENTS, automationConfidenceFloor: 0.6 } : {}),
    ...(isWriting ? { writingContext: family === "stroke_handwriting" ? "handwriting" as const : "typed" as const } : {}),
  };
}
