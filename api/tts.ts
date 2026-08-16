/**
 * Cloudflare Workers AI (MeloTTS) — the last pronunciation tier.
 *
 * WHY A SERVER ENDPOINT AT ALL. Two independent reasons, either of which would
 * be sufficient. The deployment's CSP is `connect-src 'self'`, so the browser
 * cannot reach api.cloudflare.com and that restriction is not going to be
 * relaxed to decorate a button. And the Cloudflare token is a bearer credential
 * for an account-wide AI endpoint — putting it in a client bundle would publish
 * it, since this repository is public and the bundle is served to anyone.
 *
 * So the browser asks this function, and this function is the only thing that
 * ever holds the token or contacts Cloudflare. A test asserts no client file
 * names either variable, and the built bundle is scanned for both.
 *
 * WHAT MELOTTS RETURNS. Workers AI answers `@cf/myshell-ai/melotts` with JSON
 * carrying base64 MP3 (`{ result: { audio: "..." }, success: true }`) rather
 * than raw bytes. This decodes it and returns `audio/mpeg`, so the browser gets
 * something an `<audio>` element can play directly and never has to know the
 * provider's response shape. A raw-audio response is also accepted, defensively,
 * in case the endpoint's content type ever changes.
 *
 * SPEED IS NOT SENT UPSTREAM. MeloTTS on Workers AI exposes no rate parameter,
 * and inventing one would silently do nothing. It is validated here (so a bad
 * request is still rejected) and applied in the browser via `playbackRate`,
 * which preserves pitch — and which means ONE cached clip serves every speed
 * instead of one clip per rate.
 *
 * STILL SYNTHETIC. Same constitutional position as CosyVoice and the device
 * voice (spec p.21): never canonical, never a listening cue, never evidence,
 * always labelled. Nothing here can change that — `canSatisfyCanonicalAudio`
 * accepts only `sourceType: "human"`, and `isCanonical` additionally refuses any
 * asset flagged synthetic.
 *
 * Route:
 *   GET  /api/tts?action=health   → { configured }
 *   POST /api/tts { text, speed } → audio/mpeg
 */
import { createHash } from "node:crypto";

/** The model this adapter speaks to. Part of the cache key. */
export const MODEL = "@cf/myshell-ai/melotts";

/** Bumping this invalidates every clip cached by an older adapter. */
export const ADAPTER_VERSION = "dyr-melotts-adapter@1.0.0";

/** MeloTTS language code for Mandarin. */
export const LANG = "zh";

/**
 * Field separator for cache-key material.
 *
 * NUL, written as an escape so it is visible in the source rather than an
 * invisible byte. A separator that cannot occur inside any field means two
 * different field lists can never produce the same joined string — a space
 * would let ["a b", "c"] and ["a", "b c"] collide. `cloud-voice.ts` uses the
 * same constant, and a test pins that the two agree.
 */
export const KEY_SEPARATOR = "\u0000";

/**
 * Longest text accepted. Matches the local speech service's own bound, and
 * caps both the upstream cost and how much private text a request can carry.
 */
export const MAX_TEXT = 500;

/** The same window the other tiers use, so all three behave alike. */
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;

/** Upstream is abandoned after this. A learner must not wait indefinitely. */
export const UPSTREAM_TIMEOUT_MS = 12_000;

export interface CloudflareConfig {
  accountId: string;
  token: string;
}

export type ConfigResult =
  | { ok: true; config: CloudflareConfig }
  | { ok: false; reason: string };

/**
 * Resolve the Cloudflare credentials.
 *
 * `NEXT_PUBLIC_*` is never consulted: those are exposed to client bundles by
 * definition, so a token found there would already be public and accepting it
 * would legitimise the leak.
 */
export function resolveCloudflare(env: Record<string, string | undefined> = process.env): ConfigResult {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  // Names, never values — the reason is returned to the client.
  if (!accountId) return { ok: false, reason: "CLOUDFLARE_ACCOUNT_ID is not set for this deployment" };
  if (!token) return { ok: false, reason: "CLOUDFLARE_API_TOKEN is not set for this deployment" };
  return { ok: true, config: { accountId, token } };
}

export const runUrl = (accountId: string): string =>
  `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${MODEL}`;

export interface ValidRequest {
  text: string;
  speed: number;
}

export type Validation =
  | { ok: true; request: ValidRequest }
  | { ok: false; status: number; error: string };

/**
 * Validate a request body. Pure, so the rules are unit-tested rather than
 * inferred from the handler.
 */
export function validateRequest(body: unknown): Validation {
  if (typeof body !== "object" || body === null) {
    return { ok: false, status: 400, error: "expected a JSON object" };
  }
  const input = body as { text?: unknown; speed?: unknown };

  if (typeof input.text !== "string") return { ok: false, status: 400, error: "text must be a string" };
  const text = input.text.trim();
  if (text.length === 0) return { ok: false, status: 400, error: "text is empty" };
  if (text.length > MAX_TEXT) return { ok: false, status: 413, error: `text exceeds ${MAX_TEXT} characters` };

  // Speed is clamped rather than rejected: an out-of-range rate is a caller bug
  // that should still produce audible speech, not a failed pronunciation.
  const raw = input.speed;
  const speed = typeof raw === "number" && Number.isFinite(raw)
    ? Math.min(MAX_SPEED, Math.max(MIN_SPEED, raw))
    : 1;

  return { ok: true, request: { text, speed } };
}

/**
 * The cache key for a clip.
 *
 * Everything that can change the BYTES is in it — text, model, language and
 * adapter version — and nothing that cannot. Speed is deliberately excluded:
 * it is applied by the browser's `playbackRate`, so one cached clip serves every
 * rate. Including it would multiply identical downloads by the number of speeds
 * a learner happens to press.
 */
export function clipKey(text: string): string {
  return createHash("sha256")
    .update([text.normalize("NFC"), MODEL, LANG, ADAPTER_VERSION].join(KEY_SEPARATOR))
    .digest("hex");
}

/** Pull MP3 bytes out of whatever shape Workers AI answered with. */
export function decodeAudio(contentType: string, payload: ArrayBuffer): Buffer {
  const bytes = Buffer.from(payload);
  if (!contentType.includes("json")) {
    if (bytes.length === 0) throw new Error("upstream returned no audio");
    return bytes;
  }
  const parsed = JSON.parse(bytes.toString("utf8")) as {
    success?: boolean;
    result?: { audio?: unknown };
    errors?: unknown;
  };
  if (parsed.success === false) throw new Error("upstream reported failure");
  const audio = parsed.result?.audio;
  if (typeof audio !== "string" || audio.length === 0) throw new Error("upstream returned no audio");
  const decoded = Buffer.from(audio, "base64");
  if (decoded.length === 0) throw new Error("upstream returned empty audio");
  return decoded;
}

// ---------------------------------------------------------------------------

type Req = { method?: string; url?: string; body?: unknown; headers: Record<string, string | string[] | undefined> };
type Res = {
  status: (code: number) => Res;
  setHeader: (k: string, v: string) => void;
  json: (body: unknown) => void;
  send: (body: unknown) => void;
};

const fail = (res: Res, status: number, error: string, extra: Record<string, unknown> = {}) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json({ ok: false, error, ...extra });
};

export default async function handler(req: Req, res: Res): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const config = resolveCloudflare();

  // Readiness. Answers without spending a request upstream, so the app can
  // decide whether to offer this tier at all for free.
  if (req.method === "GET" && url.searchParams.get("action") === "health") {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      ok: true,
      configured: config.ok,
      model: MODEL,
      adapterVersion: ADAPTER_VERSION,
      ...(config.ok ? {} : { reason: config.reason }),
    });
    return;
  }

  // POST only: generation is not a safe, cacheable, idempotent GET, and keeping
  // the verb narrow keeps the abuse surface narrow with it.
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    fail(res, 405, `method ${req.method} not allowed`);
    return;
  }

  if (!config.ok) {
    // A supported state, not an error: the app simply ends the chain earlier.
    fail(res, 503, config.reason, { configured: false });
    return;
  }

  let body: unknown;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
  } catch {
    fail(res, 400, "body is not valid JSON");
    return;
  }

  const validated = validateRequest(body);
  if (!validated.ok) {
    fail(res, validated.status, validated.error);
    return;
  }
  const { text } = validated.request;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(runUrl(config.config.accountId), {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt: text, lang: LANG }),
    });

    if (!upstream.ok) {
      // The upstream's own body can echo request details and account context.
      // Only the status is logged, and nothing at all is returned.
      console.error(`tts upstream status ${upstream.status}`);
      fail(res, 502, "speech could not be generated");
      return;
    }

    const audio = decodeAudio(
      upstream.headers.get("content-type") ?? "",
      await upstream.arrayBuffer(),
    );

    // Deterministic for a given text, so it is safe to cache hard. The ETag is a
    // hash: the word itself must not travel in a header, or every proxy on the
    // path logs what the learner is studying.
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", String(audio.length));
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.setHeader("ETag", `"${clipKey(text)}"`);
    res.setHeader("X-Dyr-Source", "synthetic");
    res.status(200).send(audio);
  } catch (error) {
    // An abort is a timeout, and is reported as one so the client can decide
    // whether to retry rather than treating it as a permanent failure.
    const aborted = (error as { name?: string })?.name === "AbortError";
    console.error("tts failed:", aborted ? "upstream timed out" : (error as Error)?.message ?? error);
    fail(res, aborted ? 504 : 502, "speech could not be generated");
  } finally {
    clearTimeout(timer);
  }
}
