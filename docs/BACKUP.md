# Learning-log backup (Neon Postgres)

Optional, off by default, and deliberately small. The app is local-first: the
kernel runs on the device, the event log is written locally before any UI
success, and every session works with no network. This adds one thing — a
durable copy of that log, so a cleared browser or a lost phone does not erase
months of memory state.

## Why the event log, and nothing else

The log is append-only, ordered and immutable, and the kernel is already rebuilt
from it by replay (`kernel.hydrate`). A faithful copy of the log is therefore a
faithful copy of the learner's memory state, with no server-side interpretation
and no new category of data.

Not stored: audio, microphone input, content (the pack is public and
content-addressed), analytics, or anything derived. The server never schedules,
grades or computes a trace — `api/api.test.ts` asserts it imports no kernel or
domain code and contains no scheduling vocabulary. If that ever changed there
would be two things deciding what a learner knows, and the kernel would stop
being the authority the whole design rests on.

## Setting it up

The connection string is a secret and is never committed. The repository is
public; the value lives only in Vercel's encrypted environment variables.

1. Vercel → project → **Settings → Environment Variables**
2. Add `DATABASE_URL` with the Neon pooled connection string, for all
   environments (Production, Preview, Development)
3. Redeploy

Locally, put it in a git-ignored `.env` (see `.env.example`).

No migration step is needed: the endpoint issues `CREATE TABLE IF NOT EXISTS` on
every request, so the first call creates the schema.

```sql
create table learning_events (
  learner_id     text        not null,
  local_sequence integer     not null,
  device_id      text        not null,
  event_type     text        not null,
  occurred_at    bigint      not null,
  payload        jsonb       not null,
  received_at    timestamptz not null default now(),
  primary key (learner_id, local_sequence)
);
```

The primary key is what makes a re-send safe: writes use
`ON CONFLICT DO NOTHING`, so sending an overlapping range can never duplicate a
row. That mirrors the kernel's own command-level idempotency rule (ADR-0007) and
means the client needs no cursor.

## API

Same-origin (`/api/sync`), so the deployment's `connect-src 'self'` CSP is
unchanged and no third party is involved.

| Call | Result |
| --- | --- |
| `GET /api/sync?action=health` | `{ configured, reachable, events, learners }` |
| `GET /api/sync?learner=<id>&since=<n>` | events after sequence `n`, oldest first, one page |
| `POST /api/sync` `{ learnerId, events }` | `{ stored, skipped, total }` |
| `DELETE /api/sync?learner=<id>` | `{ deleted }` |

A missing `DATABASE_URL` returns **503 with `configured: false`**. That is a
supported state, not an error: the app hides the backup control and carries on
entirely offline.

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

Neon → project → **Roles → Reset password**, then update `DATABASE_URL` in
Vercel and redeploy. Do this if the connection string has ever been pasted
somewhere it could be read — a chat log, an issue, a screenshot.
