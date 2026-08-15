import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG,
  type RawAttempt,
  type TaskContract,
  type TaskFamily,
  traceId,
  LexemeId,
  PackVersion,
  PlannerVersion,
  TaskId,
  AttemptId,
} from "@dyr/domain";
import { evaluateEvidence, type SpeechSignal } from "./evidence.ts";
import { buildRubric } from "./rubrics.ts";

const lex = LexemeId("bank.n.01");

function task(family: TaskFamily, skill: TaskContract["skill"]): TaskContract {
  return {
    id: "t1" as TaskId,
    targetTrace: traceId(lex, skill),
    lexeme: lex,
    skill,
    family,
    cue: "银行",
    rubricId: `${family}.rubric`,
    rubricVersion: "dyr-rubric@1.0.0",
    assetRefs: [],
    requiresHumanAudio: false,
    estSeconds: 8,
    isNovel: false,
    isRepair: false,
    plannerVersion: "dyr-planner@2.0.0" as PlannerVersion,
    packVersion: PackVersion("dyr-mini@1.0.0"),
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

const ev = (t: TaskContract, a: RawAttempt, signal?: SpeechSignal) =>
  evaluateEvidence(
    { attemptId: "a1" as AttemptId, attempt: a, task: t, rubric: buildRubric(t.family), expectedAnswer: "bank", signal },
    DEFAULT_CONFIG,
  );

const reading = () => task("hanzi_to_meaning", "reading");
const speaking = () => task("meaning_to_speech", "speaking");

test("a clean correct answer updates with high confidence", () => {
  const r = ev(reading(), attempt());
  assert.equal(r.decision, "update");
  assert.equal(r.envelope.confidence, "high");
  assert.equal(r.envelope.directRetrieval, true);
});

test("a wrong answer is real evidence and updates as 'again'", () => {
  const r = ev(reading(), attempt({ answer: "car" }));
  assert.equal(r.envelope.ratingProposal, "again");
  assert.equal(r.decision, "update");
});

test("hints reduce evidence strength (rubric leakage policy)", () => {
  const clean = ev(reading(), attempt()).envelope.evidenceStrength;
  const hinted = ev(reading(), attempt({ hintsUsed: 2 })).envelope.evidenceStrength;
  assert.ok(hinted < clean, `${hinted} < ${clean}`);
});

test("a revealed answer never auto-passes as mastery", () => {
  const r = ev(reading(), attempt({ answerRevealed: true }));
  assert.equal(r.envelope.directRetrieval, false);
  assert.notEqual(r.decision, "update");
});

test("low speech signal asks for a self-grade and does NOT auto-fail (p.17)", () => {
  const r = ev(speaking(), attempt({ selfGrade: undefined }), { confidence: 0.3 });
  assert.equal(r.envelope.confidence, "low");
  assert.equal(r.decision, "ask_self_grade");
});

test("speech components are recorded separately, never as one number (Correction 5)", () => {
  const signal: SpeechSignal = { confidence: 0.9, components: { tone: 0.5, initials_finals: 0.8, rhythm: 0.7 } };
  const r = ev(speaking(), attempt({ selfGrade: "good" }), signal);
  const codes = r.envelope.reasonCodes.map((c) => c.code);
  assert.ok(codes.includes("speech_tone"));
  assert.ok(codes.includes("speech_initials_finals"));
  assert.ok(codes.includes("asr_not_authoritative"), "ASR match is not pronunciation proof");
});

test("a provided self-grade lets a low-confidence attempt update", () => {
  const r = ev(speaking(), attempt({ selfGrade: "good" }), { confidence: 0.3 });
  assert.equal(r.decision, "update");
});
