# Learning-log backup (Supabase Postgres durable event backup)

Optional and deliberately small. The app is local-first: the kernel runs on the
device, the event log is written locally before any UI success, and every session
works with no network. This adds one thing — a durable copy of that log, so a
cleared browser or a lost phone does not erase months of memory state.

## Why the event log, and nothing else

The log is append-only, ordered and immutable, and the kernel is already rebuilt
from it by replay (`kernel.hydrate`). A faithful copy of the log is therefore a
faithful copy of the learner's memory state, with no server-side interpretation
and no new category of data.

Not stored: audio, microphone input, content (the pack is public and
content-addressed), analytics, or anything derived. The server never schedules,
grades or computes a trace — `api/api.test.ts` asserts it imports no kernel or
domain code, contains no scheduling vocabulary, and that the storage interface
itself stays four dumb verbs (`stats`, `read`, `append`, `count`, `remove`). If
that ever changed there would be two things deciding what a learner knows, and
the kernel would stop being the authority the whole design rests on.

## Setting it up

The Vercel ↔ Supabase Marketplace integration injects everything needed. There is
**no password to copy by hand**, and nothing secret is ever committed — the
repository is public and the values live only in Vercel's encrypted environment.

The API reads:

| Variable | Role |
| --- | --- |
| `SUPABASE_URL` | project endpoint (not a credential; falls back to `NEXT_PUBLIC_SUPABASE_URL`) |
| `SUPABASE_SECRET_KEY` | server-side key, preferred |
| `SUPABASE_SERVICE_ROLE_KEY` | legacy name, accepted as a fallback |

The publishable/anon key is **refused**, not merely deprioritised. Row Level
Security is on with no public policy, so an anon key would give a deployment that
looks configured, answers `200`, and silently stores nothing. A clear refusal
beats a backup that is quietly a no-op.

Locally, put the two values in a git-ignored `.env` (see `.env.example`).

## Applying the migration

The schema is a migration now, not something the API creates on every request.
Runtime schema creation worked and was wrong: it cost a round trip on every call,
and it hid the shape of the table in application code.

`supabase/migrations/20260815000000_learning_events.sql`

Either:

```bash
# Supabase CLI, against the linked project
supabase link --project-ref <your-project-ref>
supabase db push
```

or paste the file into **Supabase → SQL Editor → Run**. It is idempotent
(`create table if not exists`, `create or replace function`), so re-running is
safe.

```sql
create table if not exists public.learning_events (
  learner_id     text        not null,
  local_sequence integer     not null,
  device_id      text        not null default '',
  event_type     text        not null default '',
  occurred_at    bigint      not null default 0,
  payload        jsonb       not null,
  received_at    timestamptz not null default now(),
  primary key (learner_id, local_sequence)
);
```

The primary key is what makes a re-send safe: writes use ignore-duplicates
resolution (`ON CONFLICT DO NOTHING`), so sending an overlapping range can never
duplicate a row **and never rewrites an event already stored**. "Upsert" here
means insert-or-skip, never insert-or-replace — an event is immutable. That
mirrors the kernel's own command-level idempotency rule (ADR-0007) and means the
client needs no cursor.

No secondary index is created. Every query is
`where learner_id = ? [and local_sequence > ?] order by local_sequence`, which the
primary key already serves as a leading-column prefix scan.

## Signing in

Every route except `?action=health` requires the account session — see
`docs/ACCOUNT.md`. Health stays open because it reports whether a backup exists
at all (which the app needs before it can offer to sign in) and returns two
integers that identify nobody.

The learner id is **derived from the session**, never from the request. A
`learnerId` in a body or query string is ignored on every route. Before this,
anyone who guessed one could read, append to or delete that learner's whole
memory history.

## Access control

Row Level Security is enabled with **no policy at all**, and `anon` and
`authenticated` have their grants revoked. That denies the table to every browser
holding the publishable key — including for another learner's log. The only path
in is the trusted server-side client in `api/sync.ts`, which holds the secret key
and bypasses RLS.

There is deliberately no per-learner policy. A policy would have to key on
`learner_id`, which Supabase has no way to tie to the app's own session — so it
would protect nothing. Access control lives where the identity is actually known:
in `api/sync.ts`, behind the account (`docs/ACCOUNT.md`).

The `learning_events_stats()` function that backs the health check is
`security invoker` with `EXECUTE` granted only to `service_role`. It returns two
integers and nothing that could identify anyone.

## API

Same-origin (`/api/sync`), so the deployment's `connect-src 'self'` CSP is
unchanged and no third party is reached from the browser. The browser never
receives a Supabase URL or key.

| Call | Result |
| --- | --- |
| `GET /api/sync?action=health` | `{ ok, configured, reachable, events, learners, backend: "supabase" }` |
| `GET /api/sync?since=<n>` | events after sequence `n`, oldest first, one page of ≤ 500 |
| `POST /api/sync` `{ events }` | `{ stored, skipped, total }` |
| `DELETE /api/sync` | `{ deleted }` |

All three act on the session's learner. There is no learner parameter any more,
because there was never a safe way to accept one.

Without a session every route except health returns **401**. Missing
configuration returns **503 with `configured: false`** and the reason
(which names the missing *variable*, never a value). That is a supported state,
not an error: the app hides the backup control and carries on entirely offline.

A database failure returns **502 with `reachable: false`** and a fixed message.
Host names, roles and SQL never reach the client; they go to the function log.

## What it does not do

**It is a backup, not multi-device sync.** Restore happens only into an *empty*
local log. Two devices both writing produce two histories that reuse the same
`localSequence` values, and interleaving them would invent a history neither
device lived. When both sides hold events the app reports `diverged` and changes
nothing. Real multi-device merge needs per-device sequence namespaces and a
defined ordering — worth doing, but it is a different piece of work and
pretending otherwise would risk corrupting a learner's history.

## Deletion

Deleting learner data deletes the backup too. The Settings screen promises the
log is theirs to delete, and a copy that outlived that promise would make it
false. The local delete always succeeds; if the remote one cannot be reached the
UI says so plainly rather than claiming success.

## Rotating the credential

Supabase → project → **Settings → API Keys**, roll the secret key. The Vercel
integration re-injects it; redeploy to pick it up. Do this if the key has ever
been pasted somewhere it could be read — a chat log, an issue, a screenshot.
