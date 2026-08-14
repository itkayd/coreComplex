import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG,
  type RawAttempt,
  type TaskContract,
  traceId,
  LexemeId,
  PackVersion,
  PlannerVersion,
  TaskId,
  AttemptId,
} from "@dyr/domain";
import { evaluateEvidence } from "./evidence.ts";

const lex = LexemeId("bank.n.01");

function task(overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    id: "t1" as TaskId,
    targetTrace: traceId(lex, overrides.skill ?? "reading"),
    lexeme: lex,
    skill: "reading",
    family: "hanzi_to_meaning" as TaskContract["family"],
    cue: "银行",
    requiresHumanAudio: false,
    estSeconds: 8,
    isNovel: false,
    plannerVersion: "dyr-planner@1.0.0" as PlannerVersion,
    packVersion: PackVersion("dyr-mini@1.0.0"),
    ...overrides,
  };
}

function attempt(o: Partial<RawAttempt> = {}): RawAttempt {
  return {
    taskId: "t1" as TaskId,
    targetTrace: traceId(lex, "reading"),
    answer: "bank",
    latencyMs: 8000,
    hintsUsed: 0,
    answerRevealed: false,
    audioReplays: 1,
    ...o,
  };
}

const ev = (t: TaskContract, a: RawAttempt, signalConfidence?: number) =>
  evaluateEvidence(
    { attemptId: "a1" as AttemptId, attempt: a, task: t, expectedAnswer: "bank", signalConfidence },
    DEFAULT_CONFIG,
  );

test("a clean correct answer updates with high confidence", () => {
  const r = ev(task(), attempt());
  assert.equal(r.decision, "update");
  assert.equal(r.envelope.confidence, "high");
  assert.equal(r.envelope.directRetrieval, true);
});

test("a wrong answer is real evidence and updates as 'again'", () => {
  const r = ev(task(), attempt({ answer: "car" }));
  assert.equal(r.envelope.ratingProposal, "again");
  assert.equal(r.decision, "update");
});

test("hints reduce evidence strength", () => {
  const clean = ev(task(), attempt()).envelope.evidenceStrength;
  const hinted = ev(task(), attempt({ hintsUsed: 2 })).envelope.evidenceStrength;
  assert.ok(hinted < clean, `${hinted} < ${clean}`);
});

test("a revealed answer never auto-passes as mastery", () => {
  const r = ev(task(), attempt({ answerRevealed: true }));
  assert.equal(r.envelope.directRetrieval, false);
  assert.notEqual(r.decision, "update"); // asks the learner instead
});

test("low speech signal asks for a self-grade and does NOT auto-fail (p.17)", () => {
  const speakTask = task({ skill: "speaking", targetTrace: traceId(lex, "speaking") });
  const r = ev(speakTask, attempt({ selfGrade: undefined }), 0.3); // below floor 0.6
  assert.equal(r.envelope.confidence, "low");
  assert.equal(r.decision, "ask_self_grade");
  assert.notEqual(r.envelope.ratingProposal === "again" && r.decision === "update", true);
});

test("a provided self-grade lets a low-confidence attempt update", () => {
  const speakTask = task({ skill: "speaking", targetTrace: traceId(lex, "speaking") });
  const r = ev(speakTask, attempt({ selfGrade: "good" }), 0.3);
  assert.equal(r.decision, "update");
});
