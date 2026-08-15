import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HSK30_KRMANIK_AUDIT,
  assignmentFrom,
  auditSource,
  indexBySimplified,
  normalisePinyin,
  parseCedict,
  screenSentence,
  selectEntry,
  staticDifficulty,
  stageOf,
  tokenise,
  vocabularyFrom,
  refineUnknownSpans,
  type HskLevel,
} from "./index.ts";

// ---------------------------------------------------------------------------
// Pinyin normalisation
// ---------------------------------------------------------------------------

test("numbered and marked pinyin normalise to the same canonical pair", () => {
  const fromNumbered = normalisePinyin("yin2 hang2");
  const fromMarked = normalisePinyin("yín háng");
  assert.equal(fromNumbered.numbered, "yin2 hang2");
  assert.equal(fromNumbered.marked, "yín háng");
  assert.deepEqual(fromMarked.tones, fromNumbered.tones);
  assert.equal(fromMarked.numbered, fromNumbered.numbered);
});

test("tone marks land on the correct vowel", () => {
  assert.equal(normalisePinyin("hao3").marked, "hǎo");      // a wins
  assert.equal(normalisePinyin("gou3").marked, "gǒu");      // ou → o
  assert.equal(normalisePinyin("xie4").marked, "xiè");      // e wins
  assert.equal(normalisePinyin("shui3").marked, "shuǐ");    // last vowel
  assert.equal(normalisePinyin("lu:4").marked, "lǜ");       // u: → ü
  assert.equal(normalisePinyin("nv3").marked, "nǚ");        // v → ü
});

test("neutral tone stays unmarked and round-trips", () => {
  const p = normalisePinyin("xie4 xie5");
  assert.equal(p.marked, "xiè xie");
  assert.deepEqual(p.tones, [4, 5]);
  assert.equal(normalisePinyin(p.marked).numbered, "xie4 xie");
});

test("initials and finals are split for pronunciation evidence", () => {
  const [yin, hang] = normalisePinyin("yin2 hang2").syllables;
  assert.equal(yin.initial, "y");
  assert.equal(yin.final, "in");
  assert.equal(hang.initial, "h");
  assert.equal(hang.final, "ang");
  assert.equal(normalisePinyin("an1").syllables[0].initial, "", "zero-initial syllable");
});

// ---------------------------------------------------------------------------
// CC-CEDICT
// ---------------------------------------------------------------------------

const CEDICT_SAMPLE = [
  "# CC-CEDICT",
  "#! version=1",
  "#! subversion=0",
  "銀行 银行 [yin2 hang2] /bank/CL:家[jia1],個|个[ge4]/",
  "你好 你好 [ni3 hao3] /hello/hi/how are you?/",
  "行 行 [xing2] /to walk/to go/to travel/",
  "行 行 [hang2] /row/line/profession/",
  "銀 银 [yin2] /silver/",
  "malformed line without brackets",
  "壞 坏 [huai4] /CL:個|个[ge4]/",
].join("\n");

test("CC-CEDICT lines parse into simplified, traditional, pinyin and senses", () => {
  const report = parseCedict(CEDICT_SAMPLE);
  const bank = report.entries.find((e) => e.simplified === "银行")!;
  assert.equal(bank.traditional, "銀行");
  assert.equal(bank.pinyinNumbered, "yin2 hang2", "original numbered form preserved verbatim");
  assert.equal(bank.pinyinMarked, "yín háng", "tone-marked form derived, not substituted");
  assert.deepEqual(bank.definitions, ["bank"]);
  assert.deepEqual(bank.classifiers, ["家[jia1],個|个[ge4]"], "classifier kept as metadata, not a meaning");
  assert.equal(report.sourceVersion, "1");
});

test("distinct senses are preserved rather than collapsed", () => {
  const hello = parseCedict(CEDICT_SAMPLE).entries.find((e) => e.simplified === "你好")!;
  assert.deepEqual(hello.definitions, ["hello", "hi", "how are you?"]);
});

test("heteronyms are kept as separate entries and selectable by pronunciation", () => {
  const index = indexBySimplified(parseCedict(CEDICT_SAMPLE).entries);
  const xing = index.get("行")!;
  assert.equal(xing.length, 2, "行 has two pronunciations");
  assert.deepEqual(selectEntry(xing, "hang2")!.definitions, ["row", "line", "profession"]);
  assert.deepEqual(selectEntry(xing, "xing2")!.definitions, ["to walk", "to go", "to travel"]);
});

test("malformed and meaning-free lines are rejected WITH reasons, not dropped silently", () => {
  const report = parseCedict(CEDICT_SAMPLE);
  assert.ok(report.rejected.some((r) => r.reason === "malformed_entry"));
  assert.ok(report.rejected.some((r) => r.reason === "only_metadata_senses"), "坏 had only a classifier");
});

test("parsing is deterministic", () => {
  assert.deepEqual(parseCedict(CEDICT_SAMPLE), parseCedict(CEDICT_SAMPLE));
});

// ---------------------------------------------------------------------------
// HSK model + source admission
// ---------------------------------------------------------------------------

test("HSK 3.0 keeps nine levels across three stages", () => {
  assert.equal(stageOf(1), "elementary");
  assert.equal(stageOf(4), "intermediate");
  assert.equal(stageOf(9), "advanced");
});

test("a combined 7-9 band is preserved as published, not invented into a level", () => {
  const a = assignmentFrom({ lexemeId: "x.n.01", simplified: "某", publishedBand: "7-9", sourceName: "src" });
  assert.equal(a.publishedBand, "7-9", "original classification retained");
  assert.equal(a.level, 7, "internal model still uses the nine-level scale");
  assert.equal(a.stage, "advanced");
  // A source that DOES distinguish 8 needs no redesign:
  assert.equal(assignmentFrom({ lexemeId: "y.n.01", simplified: "另", publishedBand: "8", sourceName: "s" }).level, 8);
});

test("SOURCE AUDIT: Pleco-derived HSK lists are rejected however the repo is licensed", () => {
  const decisions = auditSource(HSK30_KRMANIK_AUDIT);
  const pleco = decisions.find((d) => d.component.includes("Pleco"))!;
  assert.equal(pleco.verdict, "reject", "an MIT wrapper does not launder a Pleco origin");
  assert.match(pleco.reason, /Pleco/);
});

test("SOURCE AUDIT: the official HSK syllabus is rejected for unestablished rights", () => {
  const decisions = auditSource(HSK30_KRMANIK_AUDIT);
  const official = decisions.find((d) => d.component.includes("official"))!;
  assert.equal(official.verdict, "reject");
});

test("SOURCE AUDIT: genuinely open components of the same repo are admitted", () => {
  const decisions = auditSource(HSK30_KRMANIK_AUDIT);
  assert.equal(decisions.find((d) => d.component.includes("CC-CEDICT"))!.verdict, "admit");
  assert.equal(decisions.find((d) => d.component.includes("SUBTLEX"))!.verdict, "admit");
  // Admission is per COMPONENT: one repository yields both verdicts.
  assert.equal(new Set(decisions.map((d) => d.verdict)).size > 1, true);
});

test("SOURCE AUDIT: NC / ND / UNKNOWN are rejected and odd licences go to human review", () => {
  const decisions = auditSource({
    sourceName: "mixed", url: "https://example.invalid",
    components: [
      { component: "nc", licenseSpdx: "CC-BY-NC-4.0" },
      { component: "nd", licenseSpdx: "CC-BY-ND-4.0" },
      { component: "unknown", licenseSpdx: "UNKNOWN" },
      { component: "odd", licenseSpdx: "WTFPL" },
    ],
  });
  assert.equal(decisions[0].verdict, "reject");
  assert.equal(decisions[1].verdict, "reject");
  assert.equal(decisions[2].verdict, "reject");
  assert.equal(decisions[3].verdict, "human_review", "uncertain → review, never a guess");
});

// ---------------------------------------------------------------------------
// Tokenisation
// ---------------------------------------------------------------------------

const VOCAB = vocabularyFrom([
  { id: "i.pron.01", simplified: "我" },
  { id: "go.v.01", simplified: "去" },
  { id: "bank.n.01", simplified: "银行", traditional: "銀行" },
  { id: "take.v.01", simplified: "取" },
  { id: "money.n.01", simplified: "钱" },
  { id: "like.v.01", simplified: "喜欢" },
  { id: "china.n.01", simplified: "中国" },
  { id: "drink.v.01", simplified: "喝" },
  { id: "coffee.n.01", simplified: "咖啡" },
]);

test("TOKENISATION: 银行 stays one lexeme, not 银 + 行", () => {
  const { tokens } = tokenise("我去银行取钱。", VOCAB);
  const surfaces = tokens.map((t) => t.text);
  assert.deepEqual(surfaces, ["我", "去", "银行", "取", "钱", "。"]);
  const bank = tokens.find((t) => t.text === "银行")!;
  assert.equal(bank.lexemeId, "bank.n.01");
  assert.equal(bank.kind, "lexeme");
});

test("TOKENISATION: 我喜欢中国 segments by word, not by character", () => {
  const surfaces = tokenise("我喜欢中国", VOCAB).tokens.map((t) => t.text);
  assert.deepEqual(surfaces, ["我", "喜欢", "中国"]);
});

test("character offsets are preserved for highlighting", () => {
  const { tokens } = tokenise("我去银行取钱。", VOCAB);
  for (const token of tokens) {
    assert.equal("我去银行取钱。".slice(token.start, token.end), token.text, `offsets for ${token.text}`);
  }
});

test("traditional forms resolve to the same canonical lexeme id", () => {
  assert.equal(tokenise("銀行", VOCAB).tokens[0].lexemeId, "bank.n.01");
});

test("unknown vocabulary is reported as unknown spans, never mis-attributed", () => {
  const { tokens, coverage } = tokenise("我去图书馆", VOCAB);
  const unknown = tokens.find((t) => t.kind === "unknown")!;
  assert.equal(unknown.text, "图书馆");
  assert.equal(unknown.lexemeId, undefined);
  assert.ok(coverage < 1);
});

test("a fallback segmenter may only refine UNKNOWN spans", () => {
  const result = tokenise("我去图书馆", VOCAB);
  const refined = refineUnknownSpans(result, {
    name: "stub", version: "0",
    segment: (span) => (span === "图书馆" ? ["图书", "馆"] : [span]),
  });
  const surfaces = refined.tokens.map((t) => t.text);
  assert.deepEqual(surfaces, ["我", "去", "图书", "馆"]);
  // Canonical spans are untouched, and the version records the fallback.
  assert.equal(refined.tokens.find((t) => t.text === "我")!.lexemeId, "i.pron.01");
  assert.match(refined.tokeniserVersion, /stub@0/);
  for (const t of refined.tokens) assert.equal("我去图书馆".slice(t.start, t.end), t.text, "offsets survive refinement");
});

test("tokenisation is deterministic for a sentence + vocabulary", () => {
  assert.deepEqual(tokenise("我去银行取钱。", VOCAB), tokenise("我去银行取钱。", VOCAB));
});

// ---------------------------------------------------------------------------
// Sentence difficulty
// ---------------------------------------------------------------------------

const LEVELS = new Map<string, HskLevel>([
  ["i.pron.01", 1], ["like.v.01", 1], ["drink.v.01", 1], ["coffee.n.01", 2],
  ["go.v.01", 1], ["bank.n.01", 2], ["take.v.01", 2], ["money.n.01", 1],
]);

test("static lexical level resolves to the highest token level (HSK1,1,1,2 → 2)", () => {
  const { tokens } = tokenise("我喜欢喝咖啡。", VOCAB);
  const d = staticDifficulty({ tokens, levels: LEVELS, targetLexemeIds: ["coffee.n.01"], targetLevel: 2 });
  assert.equal(d.lexicalLevel, 2);
  assert.equal(d.lexemeCount, 4);
  assert.equal(d.unknownTokenCount, 0);
  assert.equal(d.atOrBelowTargetRatio, 1);
  assert.deepEqual(d.outOfLevelTokens, []);
});

test("vocabulary above the target level is named, not just counted", () => {
  const { tokens } = tokenise("我喜欢喝咖啡。", VOCAB);
  const d = staticDifficulty({ tokens, levels: LEVELS, targetLexemeIds: [], targetLevel: 1 });
  assert.deepEqual(d.outOfLevelTokens, ["咖啡"]);
  assert.ok(d.atOrBelowTargetRatio < 1);
});

test("static difficulty carries NO learner-specific field", () => {
  const { tokens } = tokenise("我去银行取钱。", VOCAB);
  const d = staticDifficulty({ tokens, levels: LEVELS, targetLexemeIds: ["bank.n.01"], targetLevel: 2 });
  // knownTokenRatio depends on live SkillTrace state and belongs to the kernel.
  assert.equal("knownTokenRatio" in d, false);
  assert.ok(d.targetDensity > 0);
});

test("sentence quality screening rejects the right candidates", () => {
  const base = { language: "cmn", tokens: tokenise("我去银行取钱。", VOCAB).tokens, targetLexemeIds: ["bank.n.01"] };
  assert.deepEqual(screenSentence({ ...base, text: "我去银行取钱。", translation: "I go to the bank." }), []);
  assert.ok(screenSentence({ ...base, text: "我去银行取钱。", translation: "  " }).includes("no_translation"));
  assert.ok(screenSentence({ ...base, text: "我去银行取钱。", translation: "ok", language: "eng" }).includes("not_mandarin"));
  assert.ok(screenSentence({ ...base, text: "hello", translation: "ok" }).includes("no_chinese_characters"));
  assert.ok(
    screenSentence({ ...base, text: "我去银行取钱。", translation: "ok", targetLexemeIds: ["coffee.n.01"] })
      .includes("target_lexeme_absent"),
  );
});
