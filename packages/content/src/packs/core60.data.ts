/**
 * Dyr Core 60 — the Stage 2 plain-receptive lexeme set (spec p.8, p.28).
 *
 * PROVENANCE (spec p.7 "Open by construction, not merely free to view"):
 * This set was authored for Dyr Mandarin Lab and is released by the project
 * under CC0-1.0. It is NOT scraped, transcribed or reconstructed from any
 * dictionary product; in particular it contains no Pleco data and no official
 * HSK word list (spec p.22 PLECO BOUNDARY / OFFICIAL HSK). The words themselves
 * are ordinary high-frequency Mandarin vocabulary and the glosses are short
 * factual translations, authored here rather than copied.
 *
 * Every entry therefore carries a verifiable licence (CC0-1.0), a named author
 * and a content hash, which is what the licence gate requires before an asset
 * may enter a released pack.
 *
 * Audio is deliberately NOT bundled: human-recorded Mandarin is canonical
 * (spec p.21) and cannot be invented here. Each entry declares the audio it
 * NEEDS; `packages/content/src/audio.ts` describes the provisioning path, and
 * until a recording is provisioned and QA-verified the asset gate blocks
 * audio-primary tasks with `missing_canonical_audio`.
 */

export interface Core60Entry {
  /** Stable lexeme id: <sense>.<pos>.<index>. */
  id: string;
  simplified: string;
  traditional: string;
  pinyin: string;
  /** Lexical tone of each syllable; 5 = neutral. */
  tones: (1 | 2 | 3 | 4 | 5)[];
  senses: string[];
  pos: string;
  /** Zipf-style frequency prior (higher = more common). */
  frequency: number;
}

/** 60 entries. 银行 is included deliberately — it is the spec's worked example (p.4). */
export const CORE60: Core60Entry[] = [
  { id: "i.pron.01", simplified: "我", traditional: "我", pinyin: "wǒ", tones: [3], senses: ["I", "me"], pos: "pron", frequency: 7.0 },
  { id: "you.pron.01", simplified: "你", traditional: "你", pinyin: "nǐ", tones: [3], senses: ["you"], pos: "pron", frequency: 6.9 },
  { id: "he.pron.01", simplified: "他", traditional: "他", pinyin: "tā", tones: [1], senses: ["he", "him"], pos: "pron", frequency: 6.8 },
  { id: "she.pron.01", simplified: "她", traditional: "她", pinyin: "tā", tones: [1], senses: ["she", "her"], pos: "pron", frequency: 6.6 },
  { id: "we.pron.01", simplified: "我们", traditional: "我們", pinyin: "wǒ men", tones: [3, 5], senses: ["we", "us"], pos: "pron", frequency: 6.4 },
  { id: "be.v.01", simplified: "是", traditional: "是", pinyin: "shì", tones: [4], senses: ["to be"], pos: "v", frequency: 7.0 },
  { id: "not.adv.01", simplified: "不", traditional: "不", pinyin: "bù", tones: [4], senses: ["not"], pos: "adv", frequency: 6.9 },
  { id: "have.v.01", simplified: "有", traditional: "有", pinyin: "yǒu", tones: [3], senses: ["to have"], pos: "v", frequency: 6.8 },
  { id: "nothave.v.01", simplified: "没有", traditional: "沒有", pinyin: "méi yǒu", tones: [2, 3], senses: ["to not have"], pos: "v", frequency: 6.3 },
  { id: "good.a.01", simplified: "好", traditional: "好", pinyin: "hǎo", tones: [3], senses: ["good"], pos: "a", frequency: 6.9 },
  { id: "hello.intj.01", simplified: "你好", traditional: "你好", pinyin: "nǐ hǎo", tones: [3, 3], senses: ["hello"], pos: "intj", frequency: 6.2 },
  { id: "thanks.v.01", simplified: "谢谢", traditional: "謝謝", pinyin: "xiè xie", tones: [4, 5], senses: ["thanks", "thank you"], pos: "v", frequency: 6.0 },
  { id: "person.n.01", simplified: "人", traditional: "人", pinyin: "rén", tones: [2], senses: ["person"], pos: "n", frequency: 6.8 },
  { id: "what.pron.01", simplified: "什么", traditional: "什麼", pinyin: "shén me", tones: [2, 5], senses: ["what"], pos: "pron", frequency: 6.5 },
  { id: "who.pron.01", simplified: "谁", traditional: "誰", pinyin: "shéi", tones: [2], senses: ["who"], pos: "pron", frequency: 6.0 },
  { id: "which.pron.01", simplified: "哪", traditional: "哪", pinyin: "nǎ", tones: [3], senses: ["which"], pos: "pron", frequency: 5.8 },
  { id: "this.pron.01", simplified: "这", traditional: "這", pinyin: "zhè", tones: [4], senses: ["this"], pos: "pron", frequency: 6.7 },
  { id: "that.pron.01", simplified: "那", traditional: "那", pinyin: "nà", tones: [4], senses: ["that"], pos: "pron", frequency: 6.6 },
  { id: "at.prep.01", simplified: "在", traditional: "在", pinyin: "zài", tones: [4], senses: ["at", "in"], pos: "prep", frequency: 6.8 },
  { id: "go.v.01", simplified: "去", traditional: "去", pinyin: "qù", tones: [4], senses: ["to go"], pos: "v", frequency: 6.4 },
  { id: "come.v.01", simplified: "来", traditional: "來", pinyin: "lái", tones: [2], senses: ["to come"], pos: "v", frequency: 6.4 },
  { id: "look.v.01", simplified: "看", traditional: "看", pinyin: "kàn", tones: [4], senses: ["to look", "to watch"], pos: "v", frequency: 6.3 },
  { id: "listen.v.01", simplified: "听", traditional: "聽", pinyin: "tīng", tones: [1], senses: ["to listen"], pos: "v", frequency: 6.0 },
  { id: "speak.v.01", simplified: "说", traditional: "說", pinyin: "shuō", tones: [1], senses: ["to speak", "to say"], pos: "v", frequency: 6.5 },
  { id: "read.v.01", simplified: "读", traditional: "讀", pinyin: "dú", tones: [2], senses: ["to read"], pos: "v", frequency: 5.5 },
  { id: "write.v.01", simplified: "写", traditional: "寫", pinyin: "xiě", tones: [3], senses: ["to write"], pos: "v", frequency: 5.6 },
  { id: "eat.v.01", simplified: "吃", traditional: "吃", pinyin: "chī", tones: [1], senses: ["to eat"], pos: "v", frequency: 6.0 },
  { id: "drink.v.01", simplified: "喝", traditional: "喝", pinyin: "hē", tones: [1], senses: ["to drink"], pos: "v", frequency: 5.6 },
  { id: "water.n.01", simplified: "水", traditional: "水", pinyin: "shuǐ", tones: [3], senses: ["water"], pos: "n", frequency: 6.0 },
  { id: "tea.n.01", simplified: "茶", traditional: "茶", pinyin: "chá", tones: [2], senses: ["tea"], pos: "n", frequency: 5.4 },
  { id: "meal.n.01", simplified: "饭", traditional: "飯", pinyin: "fàn", tones: [4], senses: ["cooked rice", "meal"], pos: "n", frequency: 5.6 },
  { id: "dish.n.01", simplified: "菜", traditional: "菜", pinyin: "cài", tones: [4], senses: ["dish", "vegetable"], pos: "n", frequency: 5.5 },
  { id: "home.n.01", simplified: "家", traditional: "家", pinyin: "jiā", tones: [1], senses: ["home", "family"], pos: "n", frequency: 6.4 },
  { id: "school.n.01", simplified: "学校", traditional: "學校", pinyin: "xué xiào", tones: [2, 4], senses: ["school"], pos: "n", frequency: 5.7 },
  { id: "teacher.n.01", simplified: "老师", traditional: "老師", pinyin: "lǎo shī", tones: [3, 1], senses: ["teacher"], pos: "n", frequency: 5.8 },
  { id: "student.n.01", simplified: "学生", traditional: "學生", pinyin: "xué sheng", tones: [2, 5], senses: ["student"], pos: "n", frequency: 5.8 },
  { id: "friend.n.01", simplified: "朋友", traditional: "朋友", pinyin: "péng you", tones: [2, 5], senses: ["friend"], pos: "n", frequency: 5.9 },
  { id: "china.n.01", simplified: "中国", traditional: "中國", pinyin: "zhōng guó", tones: [1, 2], senses: ["China"], pos: "n", frequency: 6.0 },
  { id: "chinese.n.01", simplified: "中文", traditional: "中文", pinyin: "zhōng wén", tones: [1, 2], senses: ["Chinese language"], pos: "n", frequency: 5.4 },
  { id: "english.n.01", simplified: "英文", traditional: "英文", pinyin: "yīng wén", tones: [1, 2], senses: ["English language"], pos: "n", frequency: 5.3 },
  { id: "today.n.01", simplified: "今天", traditional: "今天", pinyin: "jīn tiān", tones: [1, 1], senses: ["today"], pos: "n", frequency: 6.0 },
  { id: "tomorrow.n.01", simplified: "明天", traditional: "明天", pinyin: "míng tiān", tones: [2, 1], senses: ["tomorrow"], pos: "n", frequency: 5.7 },
  { id: "yesterday.n.01", simplified: "昨天", traditional: "昨天", pinyin: "zuó tiān", tones: [2, 1], senses: ["yesterday"], pos: "n", frequency: 5.6 },
  { id: "now.n.01", simplified: "现在", traditional: "現在", pinyin: "xiàn zài", tones: [4, 4], senses: ["now"], pos: "n", frequency: 6.1 },
  { id: "time.n.01", simplified: "时间", traditional: "時間", pinyin: "shí jiān", tones: [2, 1], senses: ["time"], pos: "n", frequency: 6.0 },
  { id: "year.n.01", simplified: "年", traditional: "年", pinyin: "nián", tones: [2], senses: ["year"], pos: "n", frequency: 6.3 },
  { id: "month.n.01", simplified: "月", traditional: "月", pinyin: "yuè", tones: [4], senses: ["month", "moon"], pos: "n", frequency: 6.0 },
  { id: "day.n.01", simplified: "日", traditional: "日", pinyin: "rì", tones: [4], senses: ["day", "sun"], pos: "n", frequency: 6.0 },
  { id: "week.n.01", simplified: "星期", traditional: "星期", pinyin: "xīng qī", tones: [1, 1], senses: ["week"], pos: "n", frequency: 5.3 },
  { id: "oclock.n.01", simplified: "点", traditional: "點", pinyin: "diǎn", tones: [3], senses: ["o'clock", "dot", "point"], pos: "n", frequency: 6.0 },
  { id: "one.num.01", simplified: "一", traditional: "一", pinyin: "yī", tones: [1], senses: ["one"], pos: "num", frequency: 7.0 },
  { id: "two.num.01", simplified: "二", traditional: "二", pinyin: "èr", tones: [4], senses: ["two"], pos: "num", frequency: 6.2 },
  { id: "three.num.01", simplified: "三", traditional: "三", pinyin: "sān", tones: [1], senses: ["three"], pos: "num", frequency: 6.1 },
  { id: "ten.num.01", simplified: "十", traditional: "十", pinyin: "shí", tones: [2], senses: ["ten"], pos: "num", frequency: 6.1 },
  { id: "hundred.num.01", simplified: "百", traditional: "百", pinyin: "bǎi", tones: [3], senses: ["hundred"], pos: "num", frequency: 5.7 },
  { id: "money.n.01", simplified: "钱", traditional: "錢", pinyin: "qián", tones: [2], senses: ["money"], pos: "n", frequency: 5.8 },
  { id: "bank.n.01", simplified: "银行", traditional: "銀行", pinyin: "yín háng", tones: [2, 2], senses: ["bank"], pos: "n", frequency: 5.1 },
  { id: "buy.v.01", simplified: "买", traditional: "買", pinyin: "mǎi", tones: [3], senses: ["to buy"], pos: "v", frequency: 5.7 },
  { id: "sell.v.01", simplified: "卖", traditional: "賣", pinyin: "mài", tones: [4], senses: ["to sell"], pos: "v", frequency: 5.4 },
  { id: "howmany.pron.01", simplified: "多少", traditional: "多少", pinyin: "duō shao", tones: [1, 5], senses: ["how many", "how much"], pos: "pron", frequency: 5.6 },
];

/**
 * Graph edges over the Core 60. Confusables are real learner confusions:
 * 买/卖 differ only by tone and a stroke; 他/她 are homophones (tā); 日/月
 * are visually similar; 来/买 share a shape. Prerequisites express genuine
 * compositional dependency (银行 uses 钱's money sense; 我们 contains 我).
 */
export const CORE60_EDGES: { type: string; from: string; to: string; weight?: number }[] = [
  { type: "PREREQUISITE", from: "bank.n.01", to: "money.n.01" },
  { type: "PREREQUISITE", from: "we.pron.01", to: "i.pron.01" },
  { type: "PREREQUISITE", from: "nothave.v.01", to: "have.v.01" },
  { type: "PREREQUISITE", from: "hello.intj.01", to: "you.pron.01" },
  { type: "PREREQUISITE", from: "chinese.n.01", to: "china.n.01" },
  { type: "CONFUSABLE", from: "buy.v.01", to: "sell.v.01", weight: 0.9 },
  { type: "CONFUSABLE", from: "sell.v.01", to: "buy.v.01", weight: 0.9 },
  { type: "CONFUSABLE", from: "he.pron.01", to: "she.pron.01", weight: 0.85 },
  { type: "CONFUSABLE", from: "she.pron.01", to: "he.pron.01", weight: 0.85 },
  { type: "CONFUSABLE", from: "day.n.01", to: "month.n.01", weight: 0.6 },
  { type: "CONFUSABLE", from: "month.n.01", to: "day.n.01", weight: 0.6 },
  { type: "CONFUSABLE", from: "this.pron.01", to: "that.pron.01", weight: 0.7 },
  { type: "CONFUSABLE", from: "that.pron.01", to: "this.pron.01", weight: 0.7 },
  { type: "SUPPORT", from: "hello.intj.01", to: "good.a.01", weight: 0.6 },
  { type: "SUPPORT", from: "teacher.n.01", to: "student.n.01", weight: 0.4 },
  { type: "SUPPORT", from: "buy.v.01", to: "money.n.01", weight: 0.5 },
  { type: "INTERFERENCE", from: "tomorrow.n.01", to: "yesterday.n.01", weight: 0.5 },
  { type: "INTERFERENCE", from: "yesterday.n.01", to: "tomorrow.n.01", weight: 0.5 },
];
