/**
 * One account, and the things that must stay true about it.
 *
 * The hole this closes was real: `/api/sync` trusted a `learnerId` the browser
 * sent, so anyone who guessed one could read, append to or delete that learner's
 * whole memory history. The tests that matter most here are therefore the
 * negative ones — a forged session, a tampered payload, an expired token, and a
 * client that tries to name someone else's log.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  COOKIE, MIN_PASSPHRASE, OWNER, SESSION_DAYS,
  authenticate, clearedCookie, constantTimeEqual, mintSession, readCookie,
  resolveAuth, sessionCookie, verifySession,
} from "./auth.ts";
import { handleSync, type EventStore } from "./sync.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, "auth.ts"), "utf8");
/**
 * Code only.
 *
 * These architectural checks look for concepts in the IMPLEMENTATION. Prose is
 * excluded because the comments necessarily name the things being ruled out —
 * "one account needs no users table" is the design being documented, not a users
 * table — and a test that cannot tell an explanation from an implementation
 * punishes writing the explanation down.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const SYNC = readFileSync(join(here, "sync.ts"), "utf8");

const PASS = "a-long-enough-passphrase";
const SECRET = "session-signing-secret";
const env = { DYR_ACCESS_PASSPHRASE: PASS, DYR_SESSION_SECRET: SECRET };
const cookieFor = (token: string) => ({ cookie: `${COOKIE}=${encodeURIComponent(token)}` });

// ---------------------------------------------------------------------------
// Configuration.

test("a short passphrase is REFUSED at configuration time", () => {
  // There is no rate limiting in a serverless function, so length is the entire
  // defence. A deployment that can be stood up with "hunter2" will be.
  for (const weak of ["", "short", "hunter2", "a".repeat(MIN_PASSPHRASE - 1)]) {
    const result = resolveAuth({ DYR_ACCESS_PASSPHRASE: weak });
    assert.equal(result.ok, false, `"${weak}" was accepted`);
  }
  assert.equal(resolveAuth({ DYR_ACCESS_PASSPHRASE: "a".repeat(MIN_PASSPHRASE) }).ok, true);
});

test("one variable is enough to stand the account up", () => {
  // The signing key is derived from the passphrase when none is set, so getting
  // started needs exactly one thing — but the two can be separated later.
  const derived = resolveAuth({ DYR_ACCESS_PASSPHRASE: PASS });
  assert.equal(derived.ok, true);
  const explicit = resolveAuth(env);
  assert.notEqual(
    derived.ok && derived.config.secret,
    explicit.ok && explicit.config.secret,
    "an explicit session secret must actually be used",
  );
});

test("missing configuration is reported by NAME, never by value", () => {
  const result = resolveAuth({});
  assert.equal(result.ok, false);
  const reason = (result as { reason: string }).reason;
  assert.match(reason, /DYR_ACCESS_PASSPHRASE/);
  assert.ok(!reason.includes(PASS));
  // A too-short passphrase must not be echoed back either.
  const short = resolveAuth({ DYR_ACCESS_PASSPHRASE: "secret-ish" }) as { reason: string };
  assert.ok(!short.reason.includes("secret-ish"));
});

// ---------------------------------------------------------------------------
// Sessions.

test("a freshly minted session verifies, and expires when it should", () => {
  const now = Date.UTC(2026, 7, 15);
  const token = mintSession(SECRET, now);
  assert.equal(verifySession(token, SECRET, now), true);
  assert.equal(verifySession(token, SECRET, now + (SESSION_DAYS - 1) * 86_400_000), true);
  assert.equal(verifySession(token, SECRET, now + (SESSION_DAYS + 1) * 86_400_000), false,
    "an expired session must not verify");
});

test("A FORGED OR TAMPERED SESSION IS REFUSED", () => {
  const now = Date.now();
  const token = mintSession(SECRET, now);
  const [payload, signature] = token.split(".");

  // Signed with the wrong key.
  assert.equal(verifySession(mintSession("attacker-key", now), SECRET, now), false);
  // Right signature, edited claims.
  const forged = Buffer.from(JSON.stringify({ sub: OWNER, iat: now, exp: now + 1e12 })).toString("base64url");
  assert.equal(verifySession(`${forged}.${signature}`, SECRET, now), false);
  // Unsigned "alg: none" shaped attempts.
  assert.equal(verifySession(payload, SECRET, now), false);
  assert.equal(verifySession(`${payload}.`, SECRET, now), false);
  // Someone else's subject, correctly signed for that subject.
  const other = Buffer.from(JSON.stringify({ sub: "someone-else", exp: now + 1e6 })).toString("base64url");
  const otherSigned = mintSession(SECRET, now).split(".")[1];
  assert.equal(verifySession(`${other}.${otherSigned}`, SECRET, now), false);

  for (const junk of [undefined, "", ".", "..", "not-a-token", "a.b.c"]) {
    assert.equal(verifySession(junk, SECRET, now), false, `${String(junk)} verified`);
  }
});

test("a malformed payload never reaches the parser unsigned", () => {
  // The signature is checked first, so nothing an attacker controls is
  // interpreted until it has been proved authentic.
  const bad = Buffer.from("{not json at all").toString("base64url");
  assert.equal(verifySession(`${bad}.${"x".repeat(43)}`, SECRET, Date.now()), false);
  // Even correctly signed garbage fails closed rather than throwing.
  const signed = mintSession(SECRET).split(".")[1];
  assert.doesNotThrow(() => verifySession(`${bad}.${signed}`, SECRET));
});

test("comparison is constant-time and does not branch on length", () => {
  assert.equal(constantTimeEqual("abc", "abc"), true);
  assert.equal(constantTimeEqual("abc", "abd"), false);
  // Different lengths must return false, not throw — throwing would leak length.
  assert.doesNotThrow(() => constantTimeEqual("a", "a much longer value"));
  assert.equal(constantTimeEqual("a", "a much longer value"), false);
  assert.equal(constantTimeEqual("", ""), true);
});

test("the cookie cannot be read by script, sent over HTTP, or attached cross-site", () => {
  const cookie = sessionCookie("token-value", 3600);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  // SameSite=Lax is what makes POST/DELETE safe from CSRF without a token.
  assert.match(clearedCookie(), /Max-Age=0/);
});

test("cookie parsing survives a realistic header", () => {
  const header = `other=1; ${COOKIE}=abc%2Fdef; trailing=2`;
  assert.equal(readCookie(header, COOKIE), "abc/def");
  assert.equal(readCookie(header, "missing"), undefined);
  assert.equal(readCookie(undefined, COOKIE), undefined);
  // A cookie whose name merely contains ours must not match.
  assert.equal(readCookie(`not_${COOKIE}=x`, COOKIE), undefined);
});

test("authenticate() reads the real request shape", () => {
  const token = mintSession(SECRET);
  assert.equal(authenticate(cookieFor(token), env), true);
  assert.equal(authenticate({ Cookie: `${COOKIE}=${token}` }, env), true);
  // Node may hand a header array; joining is what the browser meant.
  assert.equal(authenticate({ cookie: ["a=1", `${COOKIE}=${token}`] }, env), true);
  assert.equal(authenticate({}, env), false);
  // No configuration means nobody is authenticated, rather than everybody.
  assert.equal(authenticate(cookieFor(token), {}), false);
});

// ---------------------------------------------------------------------------
// The sync API now takes its identity from the session.

const store = (): EventStore & { seen: string[] } => {
  const seen: string[] = [];
  return {
    seen,
    async stats() { return { events: 0, learners: 0 }; },
    async read(l) { seen.push(l); return []; },
    async append(l) { seen.push(l); return 0; },
    async count(l) { seen.push(l); return 0; },
    async remove(l) { seen.push(l); return 0; },
  };
};

async function call(s: EventStore, req: { method: string; url: string; body?: unknown }, learner?: string) {
  const captured: { code: number; body: Record<string, unknown> } = { code: 0, body: {} };
  const res = {
    status(code: number) { captured.code = code; return res; },
    setHeader() {},
    json(body: unknown) { captured.body = body as Record<string, unknown>; },
  };
  await handleSync({ ...req, headers: {} }, res, s, learner);
  return captured;
}

test("A CLIENT CANNOT NAME SOMEONE ELSE'S LOG", async () => {
  const s = store();
  // Every shape the old API accepted an identity in, now ignored.
  await call(s, { method: "GET", url: "/api/sync?learner=victim&since=-1" }, OWNER);
  await call(s, { method: "POST", url: "/api/sync", body: { learnerId: "victim", events: [{ localSequence: 0 }] } }, OWNER);
  await call(s, { method: "DELETE", url: "/api/sync?learner=victim" }, OWNER);

  assert.ok(s.seen.length > 0, "the store was never reached");
  assert.deepEqual([...new Set(s.seen)], [OWNER],
    `a client-supplied identity reached the store: ${s.seen.join(", ")}`);
});

test("the session's learner is the only one touched, on every verb", async () => {
  const s = store();
  await call(s, { method: "GET", url: "/api/sync?since=-1" }, OWNER);
  await call(s, { method: "DELETE", url: "/api/sync" }, OWNER);
  assert.deepEqual([...new Set(s.seen)], [OWNER]);
});

// ---------------------------------------------------------------------------
// Architecture.

test("SIGN-UP DOES NOT EXIST — not disabled, absent", () => {
  for (const term of ["signup", "signUp", "register", "createUser", "sign_up"]) {
    assert.ok(!CODE.includes(term), `auth.ts contains a ${term} path; a second account must be impossible`);
  }
  // And no user store: one account needs no users table, and every table, reset
  // flow and email provider is attack surface bought for nothing.
  for (const term of ["users", "password_hash", "bcrypt", "argon2"]) {
    assert.ok(!CODE.includes(term), `auth.ts should not carry a ${term} concept`);
  }
});

test("THE BACKUP IS UNREACHABLE WITHOUT A SESSION", () => {
  // Health stays open (it identifies nobody); everything else is gated.
  assert.match(SYNC, /if \(!isHealth && !authenticate\(req\.headers\)\)/);
  assert.match(SYNC, /401/);
  assert.ok(SYNC.includes('import { OWNER, authenticate } from "./auth.ts"'));
});

test("no credential is committed alongside the code", () => {
  assert.ok(SOURCE.includes("process.env"), "the credential must come from the environment");
  assert.ok(!/DYR_ACCESS_PASSPHRASE\s*=\s*["'][^"']+["']/.test(SOURCE), "a passphrase is assigned in the source");
  assert.ok(!/\beyJ[A-Za-z0-9_-]{20,}\./.test(SOURCE), "a token is present in the source");
});

test("the browser is never handed the credential or the signing key", () => {
  const root = join(here, "..");
  for (const file of ["apps/web/src/auth.ts", "apps/web/src/sync.ts", "apps/web/src/app.tsx"]) {
    const text = readFileSync(join(root, file), "utf8");
    for (const secret of ["DYR_ACCESS_PASSPHRASE", "DYR_SESSION_SECRET"]) {
      assert.ok(!text.includes(secret), `${file} names ${secret}, which must stay server-side`);
    }
  }
});
