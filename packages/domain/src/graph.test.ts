import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TASK_FAMILIES,
  ENTRY_FAMILY,
  EDGE_TYPES,
  LanguageGraph,
  LexemeId,
  PackVersion,
  SKILLS,
} from "./index.ts";

test("the graph models Pronunciation and GrammarAtom, not just lexemes (Correction 10)", () => {
  const g = new LanguageGraph();
  const pack = PackVersion("t@1");
  g.addLexeme({ id: LexemeId("bank.n.01"), simplified: "银行", pinyin: "yínháng", senses: ["bank"], pos: "n", frequency: 5, packVersion: pack });
  g.addPronunciation({ id: "p1", lexeme: LexemeId("bank.n.01"), syllable: "yínháng", tone: 2, tones: [2, 2], region: "zh-CN", sandhi: "none", audioAssetId: "a1", packVersion: pack });
  g.addGrammarAtom({ id: "g1", form: "是", function: "copula", prerequisites: [], contexts: ["identify"], examples: [], packVersion: pack });

  const pron = g.pronunciationOf("bank.n.01")!;
  assert.equal(pron.tone, 2);
  assert.equal(pron.region, "zh-CN");
  assert.equal(pron.audioAssetId, "a1");
  assert.equal(g.grammarAtoms.get("g1")!.function, "copula");
});

test("all ten canonical edge types exist (spec p.15)", () => {
  for (const e of ["PREREQUISITE", "CONTAINS", "SENSE_OF", "PHONETIC_FAMILY", "SEMANTIC_COMPONENT", "CONFUSABLE", "SUPPORT", "INTERFERENCE", "EXAMPLE_OF", "EXTERNAL_MAPPING"]) {
    assert.ok((EDGE_TYPES as readonly string[]).includes(e), `edge ${e}`);
  }
});

test("task-family metadata covers every family and names a target skill + rubric (ADR-0009)", () => {
  for (const [family, spec] of Object.entries(DEFAULT_TASK_FAMILIES)) {
    assert.equal(spec.family, family);
    assert.ok(SKILLS.includes(spec.targetSkill), `${family} target skill valid`);
    assert.ok(spec.rubricKind.length > 0, `${family} has a rubric kind`);
    assert.ok(spec.estSeconds > 0, `${family} has a duration`);
  }
});

test("receptive skills are cold-start; production entries need only EXPOSED prereqs (non-linear)", () => {
  // Listening & reading bootstrap from nothing.
  for (const skill of ["listening", "reading"] as const) {
    assert.equal(DEFAULT_TASK_FAMILIES[ENTRY_FAMILY[skill]].prerequisites.length, 0, `${skill} cold-start`);
  }
  // Speaking & writing begin EARLY: their entry families require only an
  // EXPOSED (not retained) prerequisite — never a full four-step chain.
  for (const skill of ["speaking", "writing"] as const) {
    const entry = DEFAULT_TASK_FAMILIES[ENTRY_FAMILY[skill]];
    assert.equal(entry.targetSkill, skill);
    assert.ok(entry.prerequisites.every((p) => p.level === "exposed"), `${skill} entry needs only exposure`);
  }
});
