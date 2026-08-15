/**
 * What counts as a correct answer.
 *
 * A grading rule that marks a knowledgeable learner wrong is not strictness, it
 * is a defect: it injects false "again" ratings into FSRS and schedules repair
 * for a word the learner knows. These tests pin the two alternatives the pack
 * itself asserts are the same answer, and pin the one that is NOT accepted.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CONFIG, DeviceId, LearnerId, LanguageGraph, LexemeId, PackVersion,
  type Lexeme,
} from "@dyr/domain";
import { createFsrsAdapter } from "@dyr/fsrs-adapter";
import { DyrKernel } from "./kernel.ts";
import { buildRubric } from "./rubrics.ts";
import { pinyinAnswers } from "./planner.ts";

const PACK = PackVersion("test@1.0.0");

function lexeme(over: Omit<Partial<Lexeme>, "id"> & { id: string }): Lexeme {
  const { id, ...rest } = over;
  return {
    simplified: "我", traditional: "我", pinyin: "wǒ",
    senses: ["I", "me"], pos: "pron", frequency: 7,
    packVersion: PACK,
    ...rest,
    id: LexemeId(id),
  } as Lexeme;
}

function kernelWith(lexemes: Lexeme[]): DyrKernel {
  const graph = new LanguageGraph();
  for (const l of lexemes) graph.addLexeme(l);
  return new DyrKernel({
    learnerId: LearnerId("l"), deviceId: DeviceId("d"),
    clock: { now: () => Date.parse("2026-08-15T09:00:00Z") },
    graph, fsrs: createFsrsAdapter(), config: DEFAULT_CONFIG,
    assets: {
      licensed: () => true,
      hasCanonicalAudio: () => false,
      hasTranscript: () => false,
      hasStrokeData: () => false,
      hasRubric: () => true,
      offlineAvailable: () => true,
      knownTokenRatio: () => 0.96,
    },
  });
}

/** Plan a session and grade `answer` against the first task of `family`. */
function gradeAnswer(lex: Lexeme, family: string, answer: string) {
  const kernel = kernelWith([lex]);
  const plan = kernel.planSession({
    budgetMinutes: 15, candidateIntroductions: [lex.id], requireOffline: true,
  });
  const task = plan.tasks.find((t) => t.family === family);
  assert.ok(task, `no ${family} task was planned (got ${plan.tasks.map((t) => t.family).join(", ")})`);
  const result = kernel.submitAttempt(task, {
    taskId: task.id, targetTrace: task.targetTrace, answer,
    latencyMs: 4000, hintsUsed: 0, answerRevealed: false, audioReplays: 0,
  });
  return result.envelope.ratingProposal;
}

test("every declared sense of a word is accepted, not only the first", () => {
  const lex = lexeme({ id: "i.pron.01", senses: ["I", "me"] });
  assert.notEqual(gradeAnswer(lex, "hanzi_to_meaning", "I"), "again");
  assert.notEqual(gradeAnswer(lex, "hanzi_to_meaning", "me"), "again",
    "the pack declares 'me' as a sense of 我; grading only senses[0] fails a learner who knows the word");
  // Case and surrounding whitespace are notation, not knowledge.
  assert.notEqual(gradeAnswer(lex, "hanzi_to_meaning", "  ME  "), "again");
});

test("a genuinely wrong meaning is still wrong", () => {
  const lex = lexeme({ id: "i.pron.01", senses: ["I", "me"] });
  assert.equal(gradeAnswer(lex, "hanzi_to_meaning", "you"), "again");
  assert.equal(gradeAnswer(lex, "hanzi_to_meaning", ""), "again");
});

test("pinyin is accepted in either notation, because both carry the tone", () => {
  const variants = pinyinAnswers("wǒ").split("|");
  assert.ok(variants.includes("wǒ"), `tone-marked form missing from ${variants.join("|")}`);
  assert.ok(variants.includes("wo3"), "numbered form missing — unreachable on a phone keyboard otherwise");
  // Toneless is NOT accepted: it discards the tone, and tone is part of the word.
  assert.ok(!variants.includes("wo"), `toneless pinyin must not be accepted (${variants.join("|")})`);
  // A different tone is a different word.
  assert.ok(!variants.includes("wo1") && !variants.includes("wò"), variants.join("|"));
});

test("multi-syllable pinyin keeps every tone in both notations", () => {
  const variants = pinyinAnswers("yín háng").split("|");
  assert.ok(variants.includes("yín háng"));
  assert.ok(variants.includes("yin2 hang2"));
  assert.ok(variants.includes("yin2hang2"), "spaces between syllables are notation, not knowledge");
  assert.ok(!variants.includes("yin hang"), "toneless must not be accepted");
});

test("unparseable pinyin is graded as written rather than dropped", () => {
  // The spec forbids destroying the source representation.
  assert.equal(pinyinAnswers("???"), "???");
});

test("writing still requires the exact hanzi — variants must not leak in", () => {
  const rubric = buildRubric("meaning_to_typed_word");
  assert.equal(rubric.matchPolicy, "normalised");
  const lex = lexeme({ id: "i.pron.01" });
  const kernel = kernelWith([lex]);
  const first = kernel.planSession({ budgetMinutes: 15, candidateIntroductions: [lex.id], requireOffline: true });
  const intro = first.tasks.find((t) => t.family === "hanzi_to_meaning");
  assert.ok(intro);
  kernel.submitAttempt(intro, {
    taskId: intro.id, targetTrace: intro.targetTrace, answer: "I",
    latencyMs: 3000, hintsUsed: 0, answerRevealed: false, audioReplays: 0,
  });
  const plan = kernel.planSession({ budgetMinutes: 15, candidateIntroductions: [lex.id], requireOffline: true });
  const typed = plan.tasks.find((t) => t.family === "meaning_to_typed_word");
  assert.ok(typed);
  assert.equal(plan.answers.get(typed.id), "我", "the writing answer must stay a single exact string");
});
