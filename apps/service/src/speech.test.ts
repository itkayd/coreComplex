import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SynthesisError, canSatisfyCanonicalAudio } from "@dyr/senses";
import { loadConfig, assertNoPaidDependencies, PAID_HOSTS_FOR_TEST } from "./config.ts";
import { SpeechCache, cacheKey, normaliseText } from "./cache.ts";
import { CosyVoiceProvider, COSYVOICE_ADAPTER_VERSION } from "./providers/cosyvoice.ts";
import { SpeechService, clampSpeed } from "./service.ts";
import { pcm16ToWav, pcm16DurationMs } from "./audio/wav.ts";
import { atempoChain } from "./audio/transcode.ts";

const scratch = (): string => mkdtempSync(join(tmpdir(), "dyr-speech-test-"));

/** A fake CosyVoice server returning headerless PCM16, exactly like upstream. */
function fakeCosyVoice(opts: { pcmBytes?: number; fail?: "network" | "http"; onCall?: () => void } = {}) {
  let calls = 0;
  const fetchImpl = (async (_url: string | URL | Request, _init?: RequestInit) => {
    calls++;
    opts.onCall?.();
    if (opts.fail === "network") throw new Error("ECONNREFUSED");
    if (opts.fail === "http") return new Response("boom", { status: 500 });
    // Simulate a short utterance: 22050 Hz * 0.5 s * 2 bytes.
    const bytes = opts.pcmBytes ?? 22050;
    const pcm = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i += 2) pcm[i] = i % 251;
    return new Response(pcm, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

function makeService(dir: string, fetchImpl: typeof fetch, overrides: Parameters<typeof loadConfig>[0] = {}) {
  const config = loadConfig({ cacheDir: dir, outputFormat: "wav", ffmpegPath: undefined, ...overrides });
  const provider = new CosyVoiceProvider({
    baseUrl: config.cosyvoiceUrl,
    modelVersion: config.modelVersion,
    defaultVoice: config.defaultVoice,
    sampleRate: config.sampleRate,
    maxTextLength: config.maxTextLength,
    requestTimeoutMs: 5000,
    fetchImpl,
    now: () => 1_700_000_000_000,
  });
  return new SpeechService({ config, provider, cache: new SpeechCache(dir), now: () => 1_700_000_000_000 });
}

// ---- Provenance -----------------------------------------------------------

test("every generated asset is stamped synthetic with provider and model version", async () => {
  const dir = scratch();
  try {
    const { fetchImpl } = fakeCosyVoice();
    const result = await makeService(dir, fetchImpl).synthesise({ text: "我明天下午要去银行取钱。", language: "zh-CN" });
    assert.equal(result.provenance.sourceType, "synthetic");
    assert.equal(result.provenance.provider, "cosyvoice");
    assert.equal(result.provenance.modelVersion, "FunAudioLLM/Fun-CosyVoice3-0.5B-2512");
    assert.equal(result.provenance.providerVersion, COSYVOICE_ADAPTER_VERSION);
    assert.ok(result.provenance.generatedAt > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("synthetic provenance can NEVER satisfy a canonical-audio requirement", async () => {
  const dir = scratch();
  try {
    const { fetchImpl } = fakeCosyVoice();
    const result = await makeService(dir, fetchImpl).synthesise({ text: "银行", language: "zh-CN" });
    assert.equal(canSatisfyCanonicalAudio(result.provenance), false);
    // And there is no way to construct a "human" result through this path:
    // sourceType is the literal "synthetic" in the contract.
    assert.equal(result.provenance.sourceType, "synthetic");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- Cache determinism ----------------------------------------------------

test("identical text + voice + speed + model give the SAME cache identity", () => {
  const base = { text: "银行", language: "zh-CN", voice: "中文女", speed: 1, provider: "cosyvoice", providerVersion: "v1", modelVersion: "m1", format: "ogg" };
  assert.equal(cacheKey(base), cacheKey({ ...base }));
  // Whitespace-only differences normalise to the same key.
  assert.equal(cacheKey(base), cacheKey({ ...base, text: "  银行  " }));
  assert.equal(cacheKey(base), cacheKey({ ...base, speed: 1.0 }));
});

test("a different MODEL, VOICE, SPEED, ADAPTER or FORMAT gives a DIFFERENT identity", () => {
  const base = { text: "银行", language: "zh-CN", voice: "中文女", speed: 1, provider: "cosyvoice", providerVersion: "v1", modelVersion: "m1", format: "ogg" };
  const key = cacheKey(base);
  assert.notEqual(key, cacheKey({ ...base, modelVersion: "m2" }), "model version");
  assert.notEqual(key, cacheKey({ ...base, voice: "中文男" }), "voice");
  assert.notEqual(key, cacheKey({ ...base, speed: 0.9 }), "speed");
  assert.notEqual(key, cacheKey({ ...base, providerVersion: "v2" }), "adapter version");
  assert.notEqual(key, cacheKey({ ...base, format: "wav" }), "format");
  assert.notEqual(key, cacheKey({ ...base, provider: "melotts" }), "provider");
  assert.notEqual(key, cacheKey({ ...base, text: "银行。" }), "punctuation changes prosody");
});

test("a repeated request is served from cache without calling CosyVoice again", async () => {
  const dir = scratch();
  try {
    const fake = fakeCosyVoice();
    const service = makeService(dir, fake.fetchImpl);
    const first = await service.synthesise({ text: "你好", language: "zh-CN" });
    const second = await service.synthesise({ text: "你好", language: "zh-CN" });
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(second.audioId, first.audioId);
    assert.equal(fake.calls(), 1, "engine called exactly once");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("audioId is a content address, never a filesystem path", async () => {
  const dir = scratch();
  try {
    const { fetchImpl } = fakeCosyVoice();
    const r = await makeService(dir, fetchImpl).synthesise({ text: "银行", language: "zh-CN" });
    assert.match(r.audioId, /^[a-f0-9]{64}$/);
    assert.equal(r.url, `/speech/audio/${r.audioId}`);
    assert.ok(!r.url.includes(dir), "no filesystem path leaks to the client");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("path-traversal style ids are rejected before touching disk", () => {
  assert.equal(SpeechCache.isValidId("../../etc/passwd"), false);
  assert.equal(SpeechCache.isValidId("abc"), false);
  assert.equal(SpeechCache.isValidId("a".repeat(64)), true);
});

// ---- Offline behaviour ----------------------------------------------------

test("an UNCACHED request fails gracefully when the engine is unavailable", async () => {
  const dir = scratch();
  try {
    const { fetchImpl } = fakeCosyVoice({ fail: "network" });
    const service = makeService(dir, fetchImpl);
    await assert.rejects(
      () => service.synthesise({ text: "没有缓存", language: "zh-CN" }),
      (e: unknown) => e instanceof SynthesisError && e.code === "speech_service_unavailable",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CACHED audio stays usable when the engine is unavailable (offline)", async () => {
  const dir = scratch();
  try {
    // Generate while the engine is up...
    const online = makeService(dir, fakeCosyVoice().fetchImpl);
    const generated = await online.synthesise({ text: "银行", language: "zh-CN" });

    // ...then take the engine away entirely. The cache still answers.
    const offline = makeService(dir, fakeCosyVoice({ fail: "network" }).fetchImpl);
    const served = await offline.synthesise({ text: "银行", language: "zh-CN" });
    assert.equal(served.cached, true);
    assert.equal(served.audioId, generated.audioId);
    assert.ok(offline.read(served.audioId)!.audio.length > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an engine HTTP error surfaces as synthesis_failed, not a crash", async () => {
  const dir = scratch();
  try {
    const { fetchImpl } = fakeCosyVoice({ fail: "http" });
    await assert.rejects(
      () => makeService(dir, fetchImpl).synthesise({ text: "错误", language: "zh-CN" }),
      (e: unknown) => e instanceof SynthesisError && e.code === "synthesis_failed",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- Request validation ---------------------------------------------------

test("empty text, wrong language and over-long text are rejected", async () => {
  const dir = scratch();
  try {
    const service = makeService(dir, fakeCosyVoice().fetchImpl);
    await assert.rejects(() => service.synthesise({ text: "  ", language: "zh-CN" }),
      (e: unknown) => e instanceof SynthesisError && e.code === "invalid_request");
    await assert.rejects(() => service.synthesise({ text: "hello", language: "en-US" as "zh-CN" }),
      (e: unknown) => e instanceof SynthesisError && e.code === "unsupported_language");
    await assert.rejects(() => service.synthesise({ text: "字".repeat(5000), language: "zh-CN" }),
      (e: unknown) => e instanceof SynthesisError && e.code === "text_too_long");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("speed is clamped to a sane, pitch-preservable band", () => {
  assert.equal(clampSpeed(0.1), 0.5);
  assert.equal(clampSpeed(9), 2);
  assert.equal(clampSpeed(Number.NaN), 1);
  assert.equal(clampSpeed(0.85), 0.85);
});

// ---- CosyVoice framing ----------------------------------------------------

test("headerless CosyVoice PCM is framed into a valid WAV", () => {
  const pcm = new Uint8Array(4410); // 0.1 s at 22050 Hz, 16-bit mono
  const wav = pcm16ToWav(pcm, { sampleRate: 22050, channels: 1, bitsPerSample: 16 });
  const text = String.fromCharCode(...wav.slice(0, 4)) + String.fromCharCode(...wav.slice(8, 12));
  assert.equal(text, "RIFFWAVE");
  assert.equal(wav.length, 44 + pcm.length);
  const view = new DataView(wav.buffer);
  assert.equal(view.getUint32(24, true), 22050, "sample rate in header");
  assert.equal(view.getUint16(22, true), 1, "mono");
  assert.equal(pcm16DurationMs(pcm, 22050), 100);
});

test("atempo is chained so speeds outside 0.5–2.0 remain expressible", () => {
  assert.deepEqual(atempoChain(1), ["atempo=1"]);
  assert.deepEqual(atempoChain(0.75), ["atempo=0.75"]);
  assert.equal(atempoChain(4).length, 2, "4x needs two stages");
  const product = atempoChain(4).map((s) => Number(s.split("=")[1])).reduce((a, b) => a * b, 1);
  assert.ok(Math.abs(product - 4) < 1e-6, `stages multiply back to the request: ${product}`);
});

test("normaliseText collapses whitespace but preserves Chinese punctuation", () => {
  assert.equal(normaliseText("  我 明天  去银行。 "), "我 明天 去银行。");
});

// ---- No paid dependencies -------------------------------------------------

test("the service refuses to start against a paid speech SaaS", () => {
  for (const host of PAID_HOSTS_FOR_TEST) {
    assert.throws(
      () => assertNoPaidDependencies({ cosyvoiceUrl: `https://${host}/v1/tts` }),
      /paid speech service/,
      `${host} must be refused`,
    );
  }
  // A local engine is fine.
  assert.doesNotThrow(() => assertNoPaidDependencies({ cosyvoiceUrl: "http://127.0.0.1:50000" }));
});

test("the default configuration points at localhost and needs no API key", () => {
  const config = loadConfig({ cacheDir: "/tmp/unused-dyr" });
  assert.match(config.cosyvoiceUrl, /^http:\/\/127\.0\.0\.1:/);
  const serialised = JSON.stringify(config).toLowerCase();
  for (const forbidden of ["api_key", "apikey", "secret", "token", "bearer"]) {
    assert.ok(!serialised.includes(forbidden), `config must not carry ${forbidden}`);
  }
});

// ---- Privacy --------------------------------------------------------------

test("generated speech is not kept indefinitely — the cache can be pruned", async () => {
  const dir = scratch();
  try {
    const service = makeService(dir, fakeCosyVoice().fetchImpl);
    await service.synthesise({ text: "私人文本", language: "zh-CN" });
    const cache = new SpeechCache(dir);
    assert.ok(readdirSync(dir).length > 0);
    // Everything older than 0 ms is stale, so a prune clears private text.
    const removed = cache.prune(0, Date.now() + 1000);
    assert.ok(removed >= 1, "pruned generated audio");
    assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
