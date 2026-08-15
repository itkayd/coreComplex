# The account

One account. No sign-up, no user table, no password reset, no email provider.

## What it protects, precisely

**The learning log, which is the only private thing here.** Until this existed,
`/api/sync` trusted a `learnerId` the browser supplied — so anyone who guessed or
read one could read, append to, or delete that learner's entire memory history.
The learner id is now derived from a verified session, and anything the client
says about identity is ignored on every route.

**Not the app itself.** The PWA is a static bundle on a public URL and the content
pack is deliberately public — CC0 and CC BY-SA, content-addressed, verifiable by
anyone. A lock screen in front of public JavaScript would be theatre. The session
is enforced on the server, in front of a personal history, which is not.

## Setting it up

One environment variable in Vercel → Settings → Environment Variables, enabled for
**all** environments (Production, Preview, Development):

| Variable | Required | Purpose |
| --- | --- | --- |
| `DYR_ACCESS_PASSPHRASE` | yes | The single credential. Minimum 12 characters, enforced. |
| `DYR_SESSION_SECRET` | no | Cookie signing key. Derived from the passphrase when unset. |

Then redeploy.

Setting `DYR_SESSION_SECRET` separately is better once things are settled — it
lets the passphrase change without logging every device out, and vice versa — but
requiring two variables to get started would be friction for no security gain.

With no passphrase set there is simply no account: the app never shows a lock
screen, the backup reports itself unconfigured, and everything runs locally.

## Signing in never blocks studying

This is the property most worth protecting, and the easiest to break by accident.
The kernel runs on the device, the log is written locally first, and every session
works with no network. So:

- the sign-in screen always has a **Skip** button;
- it appears only before any studying has happened — a returning learner is never
  re-interrupted;
- an expired session degrades the backup to `signed-out`, never the session;
- `apps/web/e2e/stage2.mjs` asserts all of this in a real browser, including that
  a skipped learner can still be issued a task.

## How the session works

A signed, self-contained token in an HttpOnly cookie. No server-side session
store, because there is nothing to store: one account, and the only claim is
"the owner proved they know the passphrase at time T".

- **HttpOnly** — no script can read it, including any that ever runs on this origin.
- **Secure** — never crosses plain HTTP.
- **SameSite=Lax** — not attached to cross-site requests, which is what makes the
  state-changing routes safe from CSRF without a separate token.
- **90 days** — long enough that a phone stays signed in, short enough to expire.

The signature is verified *before* the payload is parsed, so nothing an attacker
controls is interpreted until it has been proved authentic.

## What this is not strong against

**Online guessing.** A serverless function has no shared state, so there is no
rate limiting: an attacker can guess as fast as they can send requests. The
mitigation is length, enforced rather than advised — under 12 characters the
deployment refuses to authenticate at all, so it cannot be stood up with a
guessable credential.

If this ever needs to resist a determined attacker, it needs a real identity
provider. Supabase Auth is already a dependency away, and the boundary
(`authenticate()`) is one function. That is a deliberate next step, not an
oversight.

**A stolen passphrase.** There is no second factor. Rotating is instant: change
`DYR_ACCESS_PASSPHRASE` in Vercel and redeploy — every existing session is
invalidated at the same moment, because the signing key derives from it.

## Routes

| Call | Result |
| --- | --- |
| `GET /api/auth` | `{ configured, authenticated }` — and, when unconfigured, the missing variable's **name** |
| `POST /api/auth` `{ passphrase }` | sets the session cookie, or `401` |
| `DELETE /api/auth` | clears it |

Failure is deliberately undifferentiated: a wrong passphrase and a too-short one
return the same message, because distinguishing them would tell an attacker
something about the credential.
