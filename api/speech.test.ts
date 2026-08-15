/**
 * The cloud tier's guard rails.
 *
 * This is the only part of the app that makes an outbound request to somewhere
 * that is not us, so the tests that matter are the refusals: a metered provider,
 * a plaintext endpoint, and a configuration that does not exist at all. The
 * happy path is a proxy — there is not much to get wrong once the URL is
 * accepted, and quite a lot to get wrong in accepting it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MAX_TEXT, PAID_SPEECH_HOSTS, clipId, resolveCloudTts, upstreamUrl } from "./speech.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const SOURCE = readFileSync(join(here, "speech.ts"), "utf8");
/** Implementation only — the comments necessarily name what is being ruled out. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const reason = (r: ReturnType<typeof resolveCloudTts>) => (r as { reason: string }).reason;

test("NO DEFAULT ENDPOINT — the tier is off until someone chooses a provider", () => {
  // The brief was explicit: no paid API, no hardcoded cloud endpoint, no API
  // keys. Shipping a default would mean either a metered service or an
  // undocumented free one, and picking either on the owner's behalf is not this
  // code's call to make.
  const result = resolveCloudTts({});
  assert.equal(result.ok, false);
  assert.match(reason(result), /DYR_CLOUD_TTS_URL/);
});

test("A PAID SPEECH SERVICE IS REFUSED, not merely discouraged", () => {
  for (const host of PAID_SPEECH_HOSTS) {
    const result = resolveCloudTts({ DYR_CLOUD_TTS_URL: `https://${host}/v1/speak?text={text}` });
    assert.equal(result.ok, false, `${host} was accepted`);
    assert.match(reason(result), /self-hosted and free/);
  }
  // Subdomains count: texttospeech.googleapis.com is the same service.
  const sub = resolveCloudTts({ DYR_CLOUD_TTS_URL: "https://texttospeech.googleapis.com/v1?text={text}" });
  assert.equal(sub.ok, false);
});

test("a plaintext endpoint is refused — the learner's text would be in the clear", () => {
  assert.equal(resolveCloudTts({ DYR_CLOUD_TTS_URL: "http://tts.example.com/say?text={text}" }).ok, false);
  assert.equal(resolveCloudTts({ DYR_CLOUD_TTS_URL: "https://tts.example.com/say?text={text}" }).ok, true);
  // Localhost is exempt: there is no network to eavesdrop on.
  assert.equal(resolveCloudTts({ DYR_CLOUD_TTS_URL: "http://127.0.0.1:8080/say" }).ok, true);
});

test("nonsense configuration is reported rather than thrown", () => {
  assert.equal(resolveCloudTts({ DYR_CLOUD_TTS_URL: "not a url" }).ok, false);
  assert.match(reason(resolveCloudTts({ DYR_CLOUD_TTS_URL: "not a url" })), /valid URL/);
});

test("the upstream URL is built from a template, or conventionally", () => {
  const templated = resolveCloudTts({ DYR_CLOUD_TTS_URL: "https://tts.example.com/v1?q={text}&l={lang}" });
  assert.ok(templated.ok);
  assert.equal(
    upstreamUrl(templated.config, "银行"),
    "https://tts.example.com/v1?q=%E9%93%B6%E8%A1%8C&l=zh-CN",
  );

  // No placeholder: a plain endpoint works unmodified.
  const plain = resolveCloudTts({ DYR_CLOUD_TTS_URL: "https://tts.example.com/speak" });
  assert.ok(plain.ok);
  assert.equal(upstreamUrl(plain.config, "你好"), "https://tts.example.com/speak?text=%E4%BD%A0%E5%A5%BD&lang=zh-CN");
  // …and an existing query string is preserved rather than clobbered.
  const withQuery = resolveCloudTts({ DYR_CLOUD_TTS_URL: "https://tts.example.com/speak?voice=female" });
  assert.ok(withQuery.ok);
  assert.match(upstreamUrl(withQuery.config, "你好"), /\?voice=female&text=/);
});

test("the clip id identifies the word without naming it", () => {
  // Used as an ETag. The word itself must not travel in a header, or every proxy
  // on the path logs what the learner is studying.
  const id = clipId("银行");
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.equal(clipId("银行"), id, "the same word must give the same id, or nothing caches");
  assert.notEqual(clipId("银行"), clipId("行"));
  assert.ok(!id.includes("银"));
});

test("the media type is the upstream's, declared rather than guessed", () => {
  const ogg = resolveCloudTts({ DYR_CLOUD_TTS_URL: "https://tts.example.com/s", DYR_CLOUD_TTS_MEDIA_TYPE: "audio/ogg" });
  assert.equal(ogg.ok && ogg.config.mediaType, "audio/ogg");
  const dflt = resolveCloudTts({ DYR_CLOUD_TTS_URL: "https://tts.example.com/s" });
  assert.equal(dflt.ok && dflt.config.mediaType, "audio/mpeg");
});

test("text is bounded before it is sent anywhere", () => {
  assert.equal(MAX_TEXT, 500);
  assert.ok(SOURCE.includes("text.length > MAX_TEXT"), "the handler must enforce the bound");
});

test("the upstream never leaks to the client", () => {
  // The 502 body is a fixed string; the host and error go to the function log.
  assert.match(SOURCE, /speech could not be generated/);
  assert.ok(!/res\.status\(502\)[\s\S]{0,200}error instanceof Error \? error\.message/.test(SOURCE),
    "an upstream error message must not be returned to the client");
});

test("THE BROWSER NEVER LEARNS THE UPSTREAM EXISTS", () => {
  // `connect-src 'self'` is what guarantees this app talks to nobody. The client
  // tier must therefore call our own endpoint and hold no provider URL at all.
  const client = readFileSync(join(root, "apps/web/src/cloud-voice.ts"), "utf8");
  assert.ok(client.includes("api/speech"), "the browser must go through the same-origin endpoint");
  assert.ok(!client.includes("DYR_CLOUD_TTS_URL"), "the client must not name the upstream variable");
  assert.ok(!/https?:\/\/(?!localhost)/.test(client), "the client must contain no absolute URL");

  // And the CSP must still forbid third-party connections.
  const csp = readFileSync(join(root, "vercel.json"), "utf8");
  assert.match(csp, /connect-src 'self'/);
});

test("a generated clip is still synthetic, and cannot become canonical", () => {
  // The whole tier is a convenience. Nothing in it may produce a human-recorded
  // asset, and the canonical gate accepts only `sourceType: "human"`.
  for (const forbidden of ["canonical", "humanRecorded", "verified"]) {
    assert.ok(!CODE.includes(forbidden), `api/speech.ts must not reason about ${forbidden}`);
  }
  const router = readFileSync(join(root, "apps/web/src/pronounce.ts"), "utf8");
  assert.match(router, /cloud-voice/);
  // The router is the only thing that reaches this tier, and it is the file that
  // documents the synthetic rule.
  assert.match(router, /SYNTHETIC/);
});

test("no credential is committed alongside the code", () => {
  assert.ok(SOURCE.includes("process.env"), "configuration must come from the environment");
  assert.ok(!/\bDYR_CLOUD_TTS_URL\s*=\s*["']https?:/.test(SOURCE), "an endpoint is hardcoded in the source");
});
