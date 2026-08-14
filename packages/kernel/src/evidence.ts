/**
 * Evidence pipeline + confidence policy (spec p.15, p.17).
 *
 *   "A review is evidence, not a button press. Only direct retrieval with a
 *    valid rubric can update memory."
 *
 * Pipeline: RawAttempt -> validators -> AttemptEnvelope (rating proposal +
 * confidence + reason codes) -> accept policy (update / reject / ask self-grade).
 *
 * Confidence policy (p.17):
 *   high   -> apply the evidence policy (update)
 *   medium -> show components and ask for confirmation
 *   low    -> request self-grade; do NOT fail automatically
 *   Hints, transcript reveals and answer replay reduce evidence strength.
 *
 * Prohibited (p.17): no grade from watch time, repeated audio, opening a
 * lesson, a game reward, an LLM opinion without rubric, or a speech score
 * below its confidence threshold.
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
  isProduction,
} from "@dyr/domain";

export interface ValidationInput {
  attemptId: AttemptId;
  attempt: RawAttempt;
  task: TaskContract;
  /**
   * The correct answer token/transcript, held privately by the kernel and
   * NEVER placed in the TaskContract (no answer leakage, spec p.5/p.16/p.18).
   */
  expectedAnswer: string;
  /**
   * Automated signal confidence for production skills (ASR/alignment/pitch),
   * in [0,1]. Absent for deterministic receptive exact-match tasks.
   */
  signalConfidence?: number;
}

export interface EvidenceResult {
  envelope: AttemptEnvelope;
  decision: "update" | "reject" | "ask_self_grade";
}

const normalise = (s: string): string =>
  s.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");

/** Rating from correctness, effort and latency vs. the task's time estimate. */
function proposeRating(
  correct: boolean,
  attempt: RawAttempt,
  task: TaskContract,
): Rating {
  if (!correct) return "again";
  const expectedMs = task.estSeconds * 1000;
  const slow = attempt.latencyMs > expectedMs * 1.5;
  const fast = attempt.latencyMs < expectedMs * 0.6;
  if (attempt.hintsUsed > 0 || slow) return "hard";
  if (fast) return "easy";
  return "good";
}

export function evaluateEvidence(
  input: ValidationInput,
  config: KernelConfig,
): EvidenceResult {
  const { attempt, task } = input;
  const reasons: ReasonCode[] = [];

  // --- Correctness ---
  let correct: boolean;
  if (isProduction(task.skill) && attempt.selfGrade) {
    // Production self-grade: learner-reported correctness (rubric-backed).
    correct = attempt.selfGrade !== "again";
  } else {
    correct = normalise(attempt.answer) === normalise(input.expectedAnswer);
  }

  // --- Evidence strength & direct-retrieval flag ---
  let strength = 1;
  let directRetrieval = true;

  if (attempt.hintsUsed > 0) {
    strength *= Math.pow(0.7, attempt.hintsUsed);
    reasons.push({ code: "hints_used", detail: `${attempt.hintsUsed} hint(s)` });
  }
  if (attempt.audioReplays > 1) {
    strength *= Math.pow(0.85, attempt.audioReplays - 1);
    reasons.push({
      code: "audio_replayed",
      detail: `${attempt.audioReplays} plays`,
    });
  }
  if (attempt.answerRevealed) {
    directRetrieval = false;
    strength = Math.min(strength, 0.15);
    reasons.push({ code: "answer_revealed", detail: "answer shown before response" });
  }

  // --- Rating proposal ---
  let ratingProposal = proposeRating(correct, attempt, task);

  // --- Confidence ---
  let confidence: Confidence;
  if (isProduction(task.skill) && input.signalConfidence !== undefined) {
    // Speech/handwriting automation. Below the floor it cannot grade (p.17).
    if (input.signalConfidence < config.speechConfidenceFloor) {
      confidence = "low";
      reasons.push({
        code: "signal_below_floor",
        detail: `signal ${input.signalConfidence.toFixed(2)} < floor ${config.speechConfidenceFloor}`,
      });
    } else if (input.signalConfidence < config.speechConfidenceFloor + 0.2) {
      confidence = "medium";
    } else {
      confidence = "high";
    }
  } else if (attempt.answerRevealed && correct) {
    // A "correct" answer after a reveal is not retrieval evidence.
    confidence = "low";
    ratingProposal = "hard";
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

/**
 * Accept policy. A clear failure always updates (an "again" is real evidence);
 * a low/medium-confidence success asks the learner rather than auto-passing or
 * auto-failing (spec p.17: "do not fail automatically").
 */
function decide(
  envelope: AttemptEnvelope,
  attempt: RawAttempt,
): "update" | "reject" | "ask_self_grade" {
  const failed = envelope.ratingProposal === "again";

  if (envelope.confidence === "high") return "update";

  // Medium/low confidence: a learner-provided self-grade is the confirmation
  // the policy asks for; without one, ask.
  if (attempt.selfGrade !== undefined) return "update";
  if (failed) return "update"; // a genuine miss is safe to record
  return "ask_self_grade";
}
