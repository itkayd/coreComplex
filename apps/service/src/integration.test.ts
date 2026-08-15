import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { SpeechCache } from "./cache.ts";
import { CosyVoiceProvider } from "./providers/cosyvoice.ts";
import { SpeechService, createSpeechServer } from "./service.ts";

/**
 * End-to-end integration over REAL TCP.
 *
 * The stand-in server implements CosyVoice's actual wire contract as read from
 * upstream `runtime/python/fastapi/server.py`:
 *
 *   POST /inference_sft, multipart form fields `tts_text` + `spk_id`,
 *   responding with a stream of HEADERLESS little-endian PCM int16.
 *
 * That exercises everything on our side of the boundary — HTTP shape, multipart
 * encoding, PCM framing, caching, content-addressed delivery — against a real
 * socket. It does not exercise the neural model itself, which requires weights
 * from ModelScope/HuggingFace and a local GPU/CPU runtime.
 */
function startFakeCosyVoice(): Promise<{ server: Server; url: string; calls: () => number; lastText: () => string }> {
  let calls = 0;
  let lastText = "";
  const server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/inference_sft")) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      calls++;
      const body = Buffer.concat(chunks).toString("utf8");
      // Multipart body carries the form fields upstream declares.
      const match = /name="tts_text"\r?\n\r?\n([\s\S]*?)\r?\n--/.exec(body);
      lastText = match ? match[1] : "";
      const hasSpk = body.includes('name="spk_id"');
      if (!lastText || !hasSpk) { res.writeHead(422).end(); return; }

      // 0.5 s of PCM16 @22050 Hz, headerless — exactly what CosyVoice yields.
      const frames = 22050 / 2;
      const pcm = Buffer.alloc(frames * 2);
      for (let i = 0; i < frames; i++) {
        pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / 22050) * 12000), i * 2);
      }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(pcm);
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolvePromise({
        server,
        url: `http://127.0.0.1:${address.port}`,
        calls: () => calls,
        lastText: () => lastText,
      });
    });
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => resolvePromise((server.address() as { port: number }).port));
  });
}

test("END TO END over real HTTP: synthesise a Mandarin sentence, then serve it from cache", async () => {
  const engine = await startFakeCosyVoice();
  const dir = mkdtempSync(join(tmpdir(), "dyr-e2e-"));
  const config = loadConfig({ cacheDir: dir, cosyvoiceUrl: engine.url, outputFormat: "wav", ffmpegPath: undefined });
  const provider = new CosyVoiceProvider({
    baseUrl: config.cosyvoiceUrl,
    modelVersion: config.modelVersion,
    defaultVoice: config.defaultVoice,
    sampleRate: config.sampleRate,
    maxTextLength: config.maxTextLength,
    requestTimeoutMs: 10000,
  });
  const service = new SpeechService({ config, provider, cache: new SpeechCache(dir) });
  const api = createSpeechServer(service, config);
  const port = await listen(api);
  const base = `http://127.0.0.1:${port}`;

  try {
    // --- health ---
    const health = await (await fetch(`${base}/speech/health`)).json();
    assert.equal(health.provider, "cosyvoice");
    assert.equal(health.modelVersion, "FunAudioLLM/Fun-CosyVoice3-0.5B-2512");

    // --- synthesise the sentence from the brief ---
    const sentence = "我明天下午要去银行取钱。";
    const res = await fetch(`${base}/speech/synthesise`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: sentence, language: "zh-CN", voice: "default", speed: 1.0 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.match(body.audioId, /^[a-f0-9]{64}$/);
    assert.equal(body.url, `/speech/audio/${body.audioId}`);
    assert.equal(body.cached, false);
    assert.equal(body.provenance.sourceType, "synthetic");
    assert.equal(body.provenance.provider, "cosyvoice");
    assert.ok(body.durationMs > 400 && body.durationMs < 600, `~500ms, got ${body.durationMs}`);
    // The engine really received our text, form-encoded.
    assert.equal(engine.lastText(), sentence);

    // --- fetch the audio bytes ---
    const audioRes = await fetch(`${base}${body.url}`);
    assert.equal(audioRes.status, 200);
    assert.equal(audioRes.headers.get("x-dyr-source-type"), "synthetic");
    assert.equal(audioRes.headers.get("x-dyr-model-version"), "FunAudioLLM/Fun-CosyVoice3-0.5B-2512");
    const audio = new Uint8Array(await audioRes.arrayBuffer());
    assert.equal(String.fromCharCode(...audio.slice(0, 4)), "RIFF", "headerless PCM was framed as WAV");
    assert.equal(String.fromCharCode(...audio.slice(8, 12)), "WAVE");
    assert.ok(audio.length > 20000, "real audio bytes returned");

    // --- second identical request is served from cache ---
    const again = await (await fetch(`${base}/speech/synthesise`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: sentence, language: "zh-CN", voice: "default", speed: 1.0 }),
    })).json();
    assert.equal(again.cached, true);
    assert.equal(again.audioId, body.audioId);
    assert.equal(engine.calls(), 1, "engine invoked exactly once for two identical requests");

    // --- a bad audio id cannot escape the cache directory ---
    assert.equal((await fetch(`${base}/speech/audio/..%2F..%2Fetc%2Fpasswd`)).status, 400);
    assert.equal((await fetch(`${base}/speech/audio/${"a".repeat(64)}`)).status, 404);
  } finally {
    api.close();
    engine.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("END TO END: the service answers 503 when the engine is down and nothing is cached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dyr-e2e-down-"));
  // Port 1 is not listening — a realistic 'engine not started' situation.
  const config = loadConfig({ cacheDir: dir, cosyvoiceUrl: "http://127.0.0.1:1", outputFormat: "wav" });
  const provider = new CosyVoiceProvider({
    baseUrl: config.cosyvoiceUrl,
    modelVersion: config.modelVersion,
    defaultVoice: config.defaultVoice,
    sampleRate: config.sampleRate,
    maxTextLength: config.maxTextLength,
    requestTimeoutMs: 3000,
  });
  const service = new SpeechService({ config, provider, cache: new SpeechCache(dir) });
  const api = createSpeechServer(service, config);
  const port = await listen(api);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/speech/synthesise`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "服务器没有运行", language: "zh-CN" }),
    });
    assert.equal(res.status, 503, "graceful, typed failure — not a crash");
    const body = await res.json();
    assert.equal(body.error, "speech_service_unavailable");

    const health = await (await fetch(`http://127.0.0.1:${port}/speech/health`)).json();
    assert.equal(health.engineReachable, false, "health reports the engine is down");
  } finally {
    api.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
