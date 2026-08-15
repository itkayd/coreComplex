/**
 * One account, and no way to create a second.
 *
 * WHY THIS EXISTS, AND WHAT IT ACTUALLY PROTECTS.
 *
 * Until now `/api/sync` trusted a `learnerId` the browser supplied. That is
 * fine for a local-first app with no backup, and became a real hole the moment
 * a database was attached: anyone who guessed or read a learner id could read,
 * append to, or delete that learner's entire memory history. The migration
 * comments say as much. This is the fix — the learner id is now DERIVED FROM A
 * VERIFIED SESSION and the client's is ignored entirely.
 *
 * BE PRECISE ABOUT THE BOUNDARY. This protects the learning log, which is the
 * only private thing here. It does not make the app itself secret: the PWA is a
 * static bundle on a public URL, and the content pack is deliberately public
 * (CC0 and CC BY-SA, content-addressed, verifiable by anyone). A lock screen in
 * front of public JavaScript would be theatre; a server-enforced session in
 * front of a personal history is not. So the lock is honest about which of the
 * two it is.
 *
 * NO SIGN-UP ROUTE EXISTS. Not "sign-ups are disabled" — there is no code path
 * that can create an account. The single credential lives in the deployment's
 * environment, is set by the owner, and is never in this repository. A second
 * account would require someone to add one.
 *
 * NO PASSWORD DATABASE, DELIBERATELY. One account does not need a users table,
 * a reset flow or an email provider, and every one of those is attack surface
 * bought for nothing. The credential is an environment variable compared in
 * constant time.
 *
 * WHAT THIS IS NOT STRONG AGAINST. A serverless function has no shared state,
 * so there is no rate limiting — an attacker can guess as fast as they can send
 * requests. The mitigation is length, enforced rather than advised:
 * `MIN_PASSPHRASE` characters, checked at configuration time, so a deployment
 * cannot be stood up with a guessable one. If this ever needs to resist a
 * determined attacker, it needs a real identity provider — Supabase Auth is one
 * import away — and that is a different piece of work.
 *
 * Routes:
 *   GET    /api/auth   → { authenticated, configured }
 *   POST   /api/auth   { passphrase } → sets the session cookie
 *   DELETE /api/auth   → clears it
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** The only learner this deployment has. Stable, so a backup survives a redeploy. */
export const OWNER = "owner";

export const COOKIE = "dyr_session";
/** Ninety days: long enough that a phone stays logged in, short enough to expire. */
export const SESSION_DAYS = 90;

/**
 * Enforced, not advised. With no rate limiting, length is the entire defence,
 * and a deployment that can be stood up with "hunter2" will be.
 */
export const MIN_PASSPHRASE = 12;

export interface AuthConfig {
  passphrase: string;
  /** HMAC key for session cookies. */
  secret: string;
}

export type AuthConfigResult =
  | { ok: true; config: AuthConfig }
  | { ok: false; reason: string };

/**
 * Resolve the single credential.
 *
 * `DYR_SESSION_SECRET` is optional: when it is absent the signing key is derived
 * from the passphrase, so the owner has exactly ONE variable to set. Setting it
 * separately is better — it lets the passphrase change without logging every
 * device out, and vice versa — but requiring two variables to get started would
 * be friction for no security gain.
 */
export function resolveAuth(env: Record<string, string | undefined> = process.env): AuthConfigResult {
  const passphrase = env.DYR_ACCESS_PASSPHRASE;
  if (!passphrase) {
    return { ok: false, reason: "DYR_ACCESS_PASSPHRASE is not set for this deployment" };
  }
  if (passphrase.length < MIN_PASSPHRASE) {
    // Refusing to start beats running with a credential that can be guessed.
    return { ok: false, reason: `DYR_ACCESS_PASSPHRASE must be at least ${MIN_PASSPHRASE} characters` };
  }
  const secret = env.DYR_SESSION_SECRET ?? `derived:${passphrase}`;
  return { ok: true, config: { passphrase, secret } };
}

// ---------------------------------------------------------------------------
// Sessions.

const b64url = (input: Buffer | string): string =>
  Buffer.from(input as never).toString("base64url");

const sign = (payload: string, secret: string): string =>
  createHmac("sha256", secret).update(payload).digest("base64url");

/**
 * A signed, self-contained session. No server-side store, because there is
 * nothing to store: one account, and the only claim is "the owner proved they
 * know the passphrase at time T".
 */
export function mintSession(secret: string, now: number = Date.now()): string {
  const payload = b64url(JSON.stringify({
    sub: OWNER,
    iat: now,
    exp: now + SESSION_DAYS * 86_400_000,
  }));
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Verify a session token.
 *
 * The signature is checked BEFORE the payload is parsed, so nothing an attacker
 * controls is interpreted until it has been proved authentic — an unsigned token
 * never reaches `JSON.parse`.
 */
export function verifySession(token: string | undefined, secret: string, now: number = Date.now()): boolean {
  if (!token) return false;
  const cut = token.lastIndexOf(".");
  if (cut <= 0) return false;
  const payload = token.slice(0, cut);
  if (!constantTimeEqual(token.slice(cut + 1), sign(payload, secret))) return false;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as
      { sub?: unknown; exp?: unknown };
    if (claims.sub !== OWNER) return false;
    return typeof claims.exp === "number" && claims.exp > now;
  } catch {
    return false;
  }
}

/**
 * Constant-time comparison that does not leak length either.
 *
 * `timingSafeEqual` throws on a length mismatch, and branching on that would
 * leak how long the secret is. Hashing both sides first makes every comparison
 * the same 32 bytes regardless of input.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const digest = (v: string) => createHmac("sha256", "compare").update(v).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** Read one cookie out of a request header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * The cookie a session is carried in.
 *
 * HttpOnly so no script can read it — including any script that ever manages to
 * run on this origin. Secure so it never crosses plain HTTP. SameSite=Lax so it
 * is not attached to cross-site requests, which is what makes the state-changing
 * routes safe from CSRF without a separate token.
 */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return [
    `${COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

export const clearedCookie = (): string => sessionCookie("", 0);

/** Is this request the owner? The one question the rest of the API asks. */
export function authenticate(
  headers: Record<string, string | string[] | undefined>,
  env: Record<string, string | undefined> = process.env,
  now: number = Date.now(),
): boolean {
  const config = resolveAuth(env);
  if (!config.ok) return false;
  const raw = headers.cookie ?? headers.Cookie;
  const header = Array.isArray(raw) ? raw.join("; ") : raw;
  return verifySession(readCookie(header, COOKIE), config.config.secret, now);
}

// ---------------------------------------------------------------------------

type Req = { method?: string; body?: unknown; headers: Record<string, string | string[] | undefined> };
type Res = {
  status: (code: number) => Res;
  setHeader: (k: string, v: string) => void;
  json: (body: unknown) => void;
};

const json = (res: Res, code: number, body: unknown) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(code).json(body);
};

export default async function handler(req: Req, res: Res): Promise<void> {
  const config = resolveAuth();

  if (req.method === "GET") {
    // The reason is safe to return: it names a VARIABLE, never a value, and the
    // owner needs it to know why their own deployment will not let them in.
    json(res, 200, {
      ok: true,
      configured: config.ok,
      authenticated: config.ok && authenticate(req.headers),
      ...(config.ok ? {} : { reason: config.reason }),
    });
    return;
  }

  if (req.method === "POST") {
    if (!config.ok) { json(res, 503, { ok: false, configured: false, error: config.reason }); return; }
    const body = (typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body) as
      { passphrase?: unknown } | undefined;
    const supplied = typeof body?.passphrase === "string" ? body.passphrase : "";

    if (!constantTimeEqual(supplied, config.config.passphrase)) {
      // One message for every failure. Distinguishing "too short" from "wrong"
      // would tell an attacker something about the credential.
      json(res, 401, { ok: false, error: "that passphrase is not correct" });
      return;
    }

    res.setHeader("Set-Cookie", sessionCookie(mintSession(config.config.secret), SESSION_DAYS * 86_400));
    json(res, 200, { ok: true, authenticated: true });
    return;
  }

  if (req.method === "DELETE") {
    res.setHeader("Set-Cookie", clearedCookie());
    json(res, 200, { ok: true, authenticated: false });
    return;
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  json(res, 405, { ok: false, error: `method ${req.method} not allowed` });
}
