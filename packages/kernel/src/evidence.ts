/**
 * Evidence pipeline + confidence policy (spec p.15, p.17; ADR-0004).
 *
 *   "A review is evidence, not a button press."
 *
 * Validation is driven by the task's versioned TaskRubric. Receptive tasks use
 * a matching policy; production tasks keep evidence components separate
 * (transcript, initials/finals, tone, rhythm, fluency) and never collapse them
 * into one opaque number. Low-confidence automation defers to a self-grade
 * rather than auto-failing (spec p.17). Copy-typing and ASR transcript match
 * are explicitly NOT authoritative recall.
 */
import {
  type AttemptEnvelope,
  type AttemptId,
  type Confidence,
  type KernelConfig,
  type RawAttempt,
  type Rating,
  type ReasonCode,
  type TaskContract,
  type TaskRubric,
} from "@dyr/domain";

export interface SpeechSignal {
  /** Overall automation confidence in [0,1]. */
  confidence: number;
  /** Optional per-component scores in [0,1]; kept separate, never averaged into a grade. */
  components?: Partial<Record<"transcript" | "initials_finals" | "tone" | "rhythm" | "fluency", number>>;
}

export interface ValidationInput {
  attemptId: AttemptId;
  attempt: RawAttempt;
  task: TaskContract;
  rubric: TaskRubric;
  /** Correct answer, held privately by the kernel; never in the contract. */
  expectedAnswer: string;
  /** Automated speech/handwriting signal for production tasks. */
  signal?: SpeechSignal;
}

export interface EvidenceResult {
  envelope: AttemptEnvelope;
  decision: "update" | "reject" | "ask_self_grade";
}

function normalise(s: string): string {
  return s.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function matches(answer: string, expected: string, rubric: TaskRubric): boolean {
  if (rubric.matchPolicy === "exact") return answer === expected;
  const a = normalise(answer);
  if (rubric.matchPolicy === "normalised") return a === normalise(expected);
  // semantic_variants: accept "|"-separated variants in the expected key.
  return expected.split("|").map(normalise).includes(a);
}

function proposeRating(correct: boolean, attempt: RawAttempt, rubric: TaskRubric): Rating {
  if (!correct) return "again";
  const slow = attempt.latencyMs > rubric.latencyBandMs.expected * 1.5;
  const fast = attempt.latencyMs <= rubric.latencyBandMs.fast;
  if (attempt.hintsUsed > 0 || slow) return "hard";
  if (fast) return "easy";
  return "good";
}

export function evaluateEvidence(
  input: ValidationInput,
  _config: KernelConfig,
): EvidenceResult {
  const { attempt, task, rubric } = input;
  const reasons: ReasonCode[] = [];
  const isProductionSpeech = rubric.kind === "production_speech";

  // --- Correctness ---
  let correct: boolean;
  if (isProductionSpeech && attempt.selfGrade) {
    correct = attempt.selfGrade !== "again";
  } else {
    correct = matches(attempt.answer, input.expectedAnswer, rubric);
  }

  // --- Evidence strength & direct-retrieval flag (leakage policy) ---
  let strength = 1;
  let directRetrieval = true;
  const lk = rubric.leakage;

  if (attempt.hintsUsed > 0) {
    strength *= Math.pow(lk.hintPenalty, attempt.hintsUsed);
    reasons.push({ code: "hints_used", detail: `${attempt.hintsUsed} hint(s)` });
  }
  if (attempt.audioReplays > lk.freeAudioReplays) {
    strength *= Math.pow(lk.audioReplayPenalty, attempt.audioReplays - lk.freeAudioReplays);
    reasons.push({ code: "audio_replayed", detail: `${attempt.audioReplays} plays` });
  }
  if (attempt.answerRevealed) {
    directRetrieval = false;
    strength = Math.min(strength, 0.15);
    reasons.push({ code: "answer_revealed", detail: "answer shown before response" });
  }

  let ratingProposal = proposeRating(correct, attempt, rubric);

  // --- Confidence ---
  let confidence: Confidence;
  if (isProductionSpeech && input.signal) {
    const floor = rubric.automationConfidenceFloor ?? 0.6;
    // Record components separately for explanation (never averaged into a grade).
    if (input.signal.components) {
      for (const [k, v] of Object.entries(input.signal.components)) {
        reasons.push({ code: `speech_${k}`, detail: String(Number(v).toFixed(2)) });
      }
    }
    // ASR transcript match alone is not pronunciation mastery.
    reasons.push({ code: "asr_not_authoritative", detail: "transcript match is not pronunciation proof" });
    if (input.signal.confidence < floor) {
      confidence = "low";
      reasons.push({ code: "signal_below_floor", detail: `${input.signal.confidence.toFixed(2)} < ${floor}` });
    } else if (input.signal.confidence < floor + 0.2) {
      confidence = "medium";
    } else {
      confidence = "high";
    }
  } else if (attempt.answerRevealed && correct) {
    confidence = "low";
    ratingProposal = "hard";
  } else if (rubric.writingContext === "typed" && attempt.answerRevealed) {
    // Copy-typing is never independent recall.
    confidence = "low";
    reasons.push({ code: "copy_typing_not_recall", detail: "typed with answer visible" });
  } else if (strength < 0.5) {
    confidence = "medium";
  } else {
    confidence = "high";
  }

  const envelope: AttemptEnvelope = {
    attemptId: input.attemptId,
    taskId: task.id,
    targetTrace: task.targetTrace,
    ratingProposal,
    confidence,
    reasonCodes: reasons,
    evidenceStrength: Number(strength.toFixed(4)),
    directRetrieval,
  };

  return { envelope, decision: decide(envelope, attempt) };
}

function decide(
  envelope: AttemptEnvelope,
  attempt: RawAttempt,
): "update" | "reject" | "ask_self_grade" {
  const failed = envelope.ratingProposal === "again";
  if (envelope.confidence === "high") return "update";
  if (attempt.selfGrade !== undefined) return "update";
  if (failed) return "update"; // a genuine miss is safe to record
  return "ask_self_grade";
}
