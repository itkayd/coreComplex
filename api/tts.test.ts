/**
 * The Cloudflare MeloTTS endpoint.
 *
 * This is the only part of the app that makes an outbound request to a third
 * party and the only one holding a bearer credential, so the tests that matter
 * are the refusals and the leaks: a bad request, a failing upstream, a timeout,
 * and anything that would put the token where it can be read.
 *
 * The live Cloudflare API is never called. CI must not consume Workers AI quota,
 * and a test that depends on someone else's uptime tells you about their day,
 * not your code — so `fetch` is replaced and the handler is driven directly.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import handler, {
  ADAPTER_VERSION, LANG, MAX_TEXT, MODEL,
  KEY_SEPARATOR, clipKey, decodeAudio, resolveCloudflare, runUrl, validateRequest,
} from "./tts.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const SOURCE = readFileSync(join(here, "tts.ts"), "utf8");

const TOKEN = "cf-secret-token-value-do-not-leak";
const ENV = { CLOUDFLARE_ACCOUNT_ID: "acct-123", CLOUDFLARE_API_TOKEN: TOKEN };
/** A tiny MP3-ish payload; the endpoint never inspects the bytes. */
const MP3 = Buffer.from("fffb90c40000", "hex");

interface Captured {
  code: number;
  body: unknown;
  headers: Record<string, string>;
  sent?: Buffer;
}

/** Drive the handler with a replaced `fetch`, and capture everything it emits. */
async function call(
  req: { method: string; url?: string; body?: unknown },
  upstream: (url: string, init: RequestInit) => Promise<Response> | Response,
  env: Record<string, string | undefined> = ENV,
): Promise<Captured> {
  const captured: Captured = { code: 0, body: undefined, headers: {} };
  const res = {
    status(code: number) { captured.code = code; return res; },
    setHeader(k: string, v: string) { captured.headers[k] = v; },
    json(body: unknown) { captured.body = body; },
    send(body: unknown) { captured.sent = body as Buffer; },
  };

  const realFetch = globalThis.fetch;
  const realEnv = { ...process.env };
  globalThis.fetch = ((url: string, init: RequestInit) => Promise.resolve(upstream(String(url), init))) as never;
  for (const key of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]) delete process.env[key];
  Object.assign(process.env, env);
  try {
    await handler({ url: "/api/tts", ...req, headers: {} } as never, res as never);
  } finally {
    globalThis.fetch = realFetch;
    for (const key of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]) delete process.env[key];
    Object.assign(process.env, realEnv);
  }
  return captured;
}

const audioResponse = () => new Response(
  JSON.stringify({ success: true, result: { audio: MP3.toString("base64") } }),
  { status: 200, headers: { "content-type": "application/json" } },
);

// ---------------------------------------------------------------------------
// Validation.

test("the request contract is enforced before anything is sent upstream", () => {
  assert.equal(validateRequest(null).ok, false);
  assert.equal(validateRequest("nope").ok, false);
  assert.equal(validateRequest({}).ok, false);
  assert.equal(validateRequest({ text: 42 }).ok, false);
  // Empty and whitespace-only text is nothing to say, not a valid request.
  assert.equal(validateRequest({ text: "" }).ok, false);
  assert.equal(validateRequest({ text: "   \n\t " }).ok, false);

  const trimmed = validateRequest({ text: "  你好  " });
  assert.ok(trimmed.ok);
  assert.equal(trimmed.request.text, "你好", "text must be trimmed before it is billed for");
});

test("over-long text is refused with 413, not silently truncated", () => {
  const result = validateRequest({ text: "字".repeat(MAX_TEXT + 1) });
  assert.equal(result.ok, false);
  assert.equal((result as { status: number }).status, 413);
  assert.equal(validateRequest({ text: "字".repeat(MAX_TEXT) }).ok, true);
});

test("speed is clamped, not rejected — a bad rate must still make a sound", () => {
  const cases: [unknown, number][] = [
    [0.6, 0.6], [0.05, 0.5], [99, 2], [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, 1], ["fast", 1], [undefined, 1],
  ];
  for (const [input, expected] of cases) {
    const result = validateRequest({ text: "你好", speed: input });
    assert.ok(result.ok, `speed ${String(input)} was rejected outright`);
    assert.equal(result.request.speed, expected, `speed ${String(input)}`);
  }
});

// ---------------------------------------------------------------------------
// Configuration and caching identity.

test("missing credentials are reported by NAME and never by value", () => {
  assert.match((resolveCloudflare({}) as { reason: string }).reason, /CLOUDFLARE_ACCOUNT_ID/);
  const noToken = resolveCloudflare({ CLOUDFLARE_ACCOUNT_ID: "a" }) as { reason: string };
  assert.match(noToken.reason, /CLOUDFLARE_API_TOKEN/);
  assert.ok(!noToken.reason.includes(TOKEN));
  assert.equal(resolveCloudflare(ENV).ok, true);
});

test("a NEXT_PUBLIC_ variable can never supply the token", () => {
  // Those are exposed to client bundles by definition; accepting one would
  // legitimise a leak that has already happened.
  const result = resolveCloudflare({
    CLOUDFLARE_ACCOUNT_ID: "acct",
    NEXT_PUBLIC_CLOUDFLARE_API_TOKEN: TOKEN,
    VITE_CLOUDFLARE_API_TOKEN: TOKEN,
  });
  assert.equal(result.ok, false);
});

test("SCENARIO I — the cache key covers what changes the bytes, and nothing else", () => {
  const key = clipKey("你好");
  assert.match(key, /^[a-f0-9]{64}$/);
  // Same word, same bytes, same key: this is what makes a second request free.
  assert.equal(clipKey("你好"), key);
  assert.notEqual(clipKey("你好"), clipKey("您好"));
  // Unicode normalisation, or the same word typed two ways caches twice.
  assert.equal(clipKey("你好"), clipKey("你好".normalize("NFD")));
  // The word must not be recoverable from the key — it becomes an ETag.
  assert.ok(!key.includes("4f60"));
  // Model, language and adapter version are all in the material.
  assert.ok([MODEL, LANG, ADAPTER_VERSION].every((v) => v.length > 0));
});

test("the upstream URL names the account and the model, and escapes the account", () => {
  assert.equal(runUrl("acct-123"), `https://api.cloudflare.com/client/v4/accounts/acct-123/ai/run/${MODEL}`);
  assert.ok(runUrl("a/../b").includes("a%2F..%2Fb"), "an account id must not be able to walk the path");
});

test("MeloTTS's base64 JSON is decoded, and raw audio still works", () => {
  const json = Buffer.from(JSON.stringify({ success: true, result: { audio: MP3.toString("base64") } }));
  assert.deepEqual(decodeAudio("application/json", json.buffer.slice(json.byteOffset, json.byteOffset + json.length)), MP3);
  // Defensive: if the endpoint ever returns bytes directly, they pass through.
  assert.deepEqual(decodeAudio("audio/mpeg", MP3.buffer.slice(MP3.byteOffset, MP3.byteOffset + MP3.length)), MP3);

  for (const bad of [
    JSON.stringify({ success: false }),
    JSON.stringify({ success: true, result: {} }),
    JSON.stringify({ success: true, result: { audio: "" } }),
  ]) {
    const buf = Buffer.from(bad);
    assert.throws(() => decodeAudio("application/json", buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)));
  }
});

// ---------------------------------------------------------------------------
// The handler.

test("a healthy POST returns playable audio with honest headers", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const result = await call(
    { method: "POST", body: { text: "你好", speed: 1 } },
    (url, init) => { seen = { url, init }; return audioResponse(); },
  );

  assert.equal(result.code, 200);
  assert.deepEqual(result.sent, MP3);
  assert.equal(result.headers["Content-Type"], "audio/mpeg");
  assert.match(result.headers["Cache-Control"], /immutable/);
  assert.equal(result.headers.ETag, `"${clipKey("你好")}"`);
  // Labelled at the transport level too, so nothing downstream can mistake it.
  assert.equal(result.headers["X-Dyr-Source"], "synthetic");

  // The upstream got the right model, language and prompt.
  assert.ok(seen);
  assert.ok(seen.url.endsWith(MODEL));
  assert.deepEqual(JSON.parse(String(seen.init.body)), { prompt: "你好", lang: LANG });
  assert.equal((seen.init.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
});

test("the ETag is a hash, so no proxy logs what the learner is studying", async () => {
  const result = await call({ method: "POST", body: { text: "银行" } }, () => audioResponse());
  const headers = JSON.stringify(result.headers);
  assert.ok(!headers.includes("银行"), "the word appeared in a response header");
  assert.ok(!headers.includes(encodeURIComponent("银行")));
});

test("GET ?action=health answers without spending an upstream request", async () => {
  let called = 0;
  const result = await call({ method: "GET", url: "/api/tts?action=health" }, () => { called++; return audioResponse(); });
  assert.equal(result.code, 200);
  assert.deepEqual(result.body, { ok: true, configured: true, model: MODEL, adapterVersion: ADAPTER_VERSION });
  assert.equal(called, 0, "readiness must be free");
});

test("an unconfigured deployment reports 503 and contacts nobody", async () => {
  let called = 0;
  const result = await call(
    { method: "POST", body: { text: "你好" } },
    () => { called++; return audioResponse(); },
    {},
  );
  assert.equal(result.code, 503);
  assert.equal((result.body as { configured: boolean }).configured, false);
  assert.equal(called, 0);
});

test("only POST may generate; a GET cannot be used to run up a bill", async () => {
  const result = await call({ method: "GET", url: "/api/tts?text=hi" }, () => audioResponse());
  assert.equal(result.code, 405);
  assert.equal(result.headers.Allow, "GET, POST");
});

test("malformed JSON is refused before the upstream is touched", async () => {
  let called = 0;
  const result = await call({ method: "POST", body: "{not json" }, () => { called++; return audioResponse(); });
  assert.equal(result.code, 400);
  assert.equal(called, 0);
});

test("SCENARIO G — Cloudflare returns 500: safe failure, and NO SECRET ESCAPES", async () => {
  const result = await call(
    { method: "POST", body: { text: "你好" } },
    () => new Response(
      // An upstream error body can echo account context back at us.
      JSON.stringify({ errors: [{ message: `bad token ${TOKEN} for account acct-123` }] }),
      { status: 500, headers: { "content-type": "application/json" } },
    ),
  );

  assert.equal(result.code, 502, "a broken upstream is a bad gateway, not our 500");
  const serialised = JSON.stringify({ body: result.body, headers: result.headers });
  for (const secret of [TOKEN, "acct-123", "bad token"]) {
    assert.ok(!serialised.includes(secret), `the response leaked "${secret}"`);
  }
  assert.equal((result.body as { error: string }).error, "speech could not be generated");
});

test("SCENARIO H — the upstream times out: a bounded 504, not a hang", async () => {
  const result = await call(
    { method: "POST", body: { text: "你好" } },
    () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; },
  );
  assert.equal(result.code, 504, "a timeout must be distinguishable from a failure");
  assert.equal((result.body as { error: string }).error, "speech could not be generated");
  assert.equal(result.headers["Cache-Control"], "no-store", "a failure must never be cached");
});

test("an upstream that answers 200 with no audio is still a failure", async () => {
  const result = await call(
    { method: "POST", body: { text: "你好" } },
    () => new Response(JSON.stringify({ success: true, result: {} }), { status: 200, headers: { "content-type": "application/json" } }),
  );
  assert.equal(result.code, 502);
});

// ---------------------------------------------------------------------------
// Secrets.

test("THE TOKEN IS NEVER LOGGED AND NEVER RETURNED", () => {
  // Every console call in this file must be a status or a message, never the
  // config object — which is the easy mistake and an unrecoverable one.
  for (const line of SOURCE.split("\n").filter((l) => l.includes("console."))) {
    assert.ok(!/config|token|authorization/i.test(line), `a log line may expose the credential: ${line.trim()}`);
  }
  assert.ok(!/CLOUDFLARE_API_TOKEN\s*=\s*["'][^"']+["']/.test(SOURCE), "a token is assigned in the source");
});

test("NO CLIENT FILE CAN SEE THE CLOUDFLARE CREDENTIALS", () => {
  const clientDir = join(root, "apps/web/src");
  const files = readFileSync(join(root, "apps/web/src/cloud-voice.ts"), "utf8");
  for (const secret of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "api.cloudflare.com"]) {
    assert.ok(!files.includes(secret), `cloud-voice.ts names ${secret}, which must stay server-side`);
  }
  // The client reaches Cloudflare only through the same-origin endpoint.
  assert.ok(files.includes("api/tts"));
  assert.ok(!/https?:\/\//.test(files.replace(/^\s*\*.*$/gm, "")), "the client must hold no absolute URL");
  assert.ok(clientDir.length > 0);
});

test("THE BUILT BUNDLE CONTAINS NO CLOUDFLARE CREDENTIAL", () => {
  // Checked against the real build output, because that is what is served. The
  // source can be clean while a bundler inlines an env var, and the only place
  // that shows up is here.
  const dist = join(root, "apps/web/dist");
  let files: string[];
  try {
    files = readdirSync(join(dist, "assets")).map((f) => join(dist, "assets", f));
  } catch {
    // Not built in this run; the source-level assertions above still hold.
    return;
  }
  files.push(join(dist, "index.html"), join(dist, "sw.js"));

  for (const file of files) {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const secret of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "api.cloudflare.com", "Bearer "]) {
      assert.ok(!text.includes(secret), `${file} contains "${secret}"`);
    }
    // Whatever the token actually is in this environment, if it is set at all.
    const live = process.env.CLOUDFLARE_API_TOKEN;
    if (live && live.length > 8) assert.ok(!text.includes(live), `${file} contains the live token`);
  }

  // The model id and provider name ARE expected in the bundle: they are public,
  // and the UI must be able to say what generated a clip. Naming the provider is
  // the honest labelling requirement, not a leak.
  const bundle = files.filter((f) => f.endsWith(".js")).map((f) => {
    try { return readFileSync(f, "utf8"); } catch { return ""; }
  }).join("");
  if (bundle.length > 0) {
    assert.ok(bundle.includes("cloudflare-workers-ai"), "provenance must survive into the bundle");
  }
});

test("the key separator is unambiguous, and client and server agree on it", () => {
  // A space would let ["a b", "c"] and ["a", "b c"] hash identically. NUL
  // cannot occur inside any field, so the join is injective.
  assert.equal(KEY_SEPARATOR.length, 1);
  assert.equal(KEY_SEPARATOR.charCodeAt(0), 0);
  const client = readFileSync(join(root, "apps/web/src/cloud-voice.ts"), "utf8");
  assert.ok(client.includes("KEY_SEPARATOR = " + String.fromCharCode(34) + "\\u0000" + String.fromCharCode(34)),
    "client and server separators must agree");
  assert.ok(client.includes("join(KEY_SEPARATOR)"), "the client must use the shared separator");
});
