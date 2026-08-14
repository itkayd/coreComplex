import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SKILLS,
  type RawAttempt,
  type Skill,
  type TaskContract,
  traceId,
  LexemeId,
  PackVersion,
  TaskId,
  PlannerVersion,
} from "@dyr/domain";
import { makeHarness } from "../../../fixtures/sim/harness.ts";

const lex = LexemeId("bank.n.01"); // 银行, the spec p.4 example word

/** Build a task for one skill whose cue never equals its answer (no leakage). */
function taskFor(skill: Skill): { task: TaskContract; answer: string } {
  const answer = `answer-${skill}`;
  const task: TaskContract = {
    id: `t_${skill}` as TaskId,
    targetTrace: traceId(lex, skill),
    lexeme: lex,
    skill,
    family: "hanzi_to_meaning" as TaskContract["family"],
    cue: `cue-${skill}`,
    requiresHumanAudio: skill === "listening",
    estSeconds: 8,
    isNovel: false,
    plannerVersion: "dyr-planner@1.0.0" as PlannerVersion,
    packVersion: PackVersion("dyr-mini@1.0.0"),
  };
  return { task, answer };
}

function attempt(task: TaskContract, answer: string): RawAttempt {
  return {
    taskId: task.id,
    targetTrace: task.targetTrace,
    answer,
    latencyMs: 8000,
    hintsUsed: 0,
    answerRevealed: false,
    audioReplays: 1,
    selfGrade: undefined,
  };
}

test("Rule 2: one accepted attempt changes exactly one SkillTrace", () => {
  const { kernel } = makeHarness();
  const { task, answer } = taskFor("reading");
  kernel.registerTask(task, answer);

  kernel.submitAttempt(task, attempt(task, answer));

  const touched = kernel.traces.all().filter((t) => t.evidenceCount > 0);
  assert.equal(touched.length, 1, "exactly one trace has evidence");
  assert.equal(touched[0].id, traceId(lex, "reading"));
});

test("Rule 1: the four skill channels are independent for one concept", () => {
  const { kernel } = makeHarness();

  // Succeed on reading, fail on speaking, for the SAME lexeme.
  const reading = taskFor("reading");
  const speaking = taskFor("speaking");
  kernel.registerTask(reading.task, reading.answer);
  kernel.registerTask(speaking.task, speaking.answer);

  kernel.submitAttempt(reading.task, attempt(reading.task, reading.answer)); // correct
  kernel.submitAttempt(speaking.task, {
    ...attempt(speaking.task, "wrong"),
    selfGrade: "again",
  });

  const readTrace = kernel.traces.get(traceId(lex, "reading"))!;
  const speakTrace = kernel.traces.get(traceId(lex, "speaking"))!;
  assert.equal(readTrace.state, "review", "reading succeeded");
  assert.equal(speakTrace.state, "relearning", "speaking failed");
  assert.ok(readTrace.stability > speakTrace.stability, "same word, different reality per channel");

  // Listening and writing were never attempted — they must remain untouched.
  for (const skill of ["listening", "writing"] as Skill[]) {
    const t = kernel.traces.get(traceId(lex, skill));
    assert.ok(!t || t.evidenceCount === 0, `${skill} untouched`);
  }
});

test("a lexeme can carry up to four independent traces", () => {
  const { kernel } = makeHarness();
  for (const skill of SKILLS) {
    const { task, answer } = taskFor(skill);
    kernel.registerTask(task, answer);
    kernel.submitAttempt(task, {
      ...attempt(task, answer),
      selfGrade: skill === "speaking" || skill === "writing" ? "good" : undefined,
    });
  }
  const traces = kernel.traces.all().filter((t) => t.lexeme === lex);
  assert.equal(traces.length, 4);
  assert.equal(new Set(traces.map((t) => t.skill)).size, 4);
});
