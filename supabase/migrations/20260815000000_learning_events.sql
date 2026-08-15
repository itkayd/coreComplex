-- Durable backup of the learning event log.
--
-- ONE TABLE, DELIBERATELY DUMB. Dyr's kernel runs on the device and is the only
-- thing that decides anything about memory. This schema stores opaque, immutable
-- events and hands them back in order. There is no trigger, no computed column
-- and no view that interprets an event, because interpretation is the kernel's
-- job and a second interpreter would mean two things deciding what a learner
-- knows.
--
-- Previously the API issued CREATE TABLE IF NOT EXISTS on every request. That
-- worked and was wrong: schema is not a runtime concern, it cost a round trip on
-- every call, and it meant the shape of the table was defined in application
-- code where nobody would look for it.

create table if not exists public.learning_events (
  learner_id     text        not null,
  local_sequence integer     not null,
  device_id      text        not null default '',
  event_type     text        not null default '',
  occurred_at    bigint      not null default 0,
  payload        jsonb       not null,
  received_at    timestamptz not null default now(),

  -- THE IDEMPOTENCY BOUNDARY. A re-sent batch conflicts here and is skipped
  -- (ON CONFLICT DO NOTHING), so uploading an overlapping range can never
  -- duplicate a row and never rewrites an event already stored. This mirrors the
  -- kernel's own command-level idempotency rule (ADR-0007) and is why the client
  -- needs no cursor.
  primary key (learner_id, local_sequence)
);

-- No secondary index is created. Every query this API makes is
-- `where learner_id = ? [and local_sequence > ?] order by local_sequence`, which
-- the primary key already serves as a leading-column prefix scan. An index that
-- duplicates the primary key would cost writes and buy nothing; adding one
-- "just in case" is how a small table acquires unexplained overhead.

-- ---------------------------------------------------------------------------
-- Access.

alter table public.learning_events enable row level security;

-- NO POLICY IS CREATED, ON PURPOSE.
--
-- RLS with zero policies denies everything to `anon` and `authenticated`, which
-- is exactly right: a browser holding the publishable key must not be able to
-- read, write or delete any row — least of all another learner's log. The only
-- path to this table is the trusted server-side client in `api/sync.ts`, which
-- holds the secret/service-role key and bypasses RLS.
--
-- If per-learner browser access is ever wanted, it needs real authentication and
-- a policy keyed on the authenticated user — not a policy on an unauthenticated
-- `learner_id` string, which anyone could simply guess.

revoke all on public.learning_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Health.

-- Deployment-wide totals for GET /api/sync?action=health.
--
-- A distinct-learner count cannot be expressed through PostgREST's query
-- interface, so it lives here. It returns two integers and nothing else: no
-- learner ids, no payloads, nothing that could identify anyone.
create or replace function public.learning_events_stats()
returns table (events bigint, learners bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select count(*)::bigint, count(distinct learner_id)::bigint
    from public.learning_events;
$$;

-- `security invoker` plus a service-role-only grant: the function has no
-- privileges of its own to borrow, and cannot be called by a browser at all.
revoke all on function public.learning_events_stats() from public, anon, authenticated;
grant execute on function public.learning_events_stats() to service_role;
