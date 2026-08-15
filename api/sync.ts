/**
 * Durable backup of the learning event log (Neon Postgres).
 *
 * WHAT THIS IS NOT: a brain. Dyr's kernel is the only thing that decides
 * anything about memory (spec p.3 "TaskContracts in; AttemptEnvelopes back;
 * LearningFacts out"), and it runs on the device. This endpoint stores opaque
 * rows and hands them back. It never schedules, never grades, never derives a
 * trace, and never inspects an event beyond the few fields it indexes on. A
 * test asserts that: `api/api.test.ts`.
 *
 * WHY THE EVENT LOG IS THE RIGHT THING TO STORE. It is append-only, ordered and
 * immutable, and the kernel is already rebuilt from it by replay
 * (`kernel.hydrate`). So a faithful copy of the log is a faithful copy of the
 * learner's memory state, with no server-side interpretation and no new data
 * category. Nothing else is stored: no audio, no microphone data, no content
 * (the pack is public and content-addressed), no analytics.
 *
 * IDEMPOTENCY comes from the primary key `(learner_id, local_sequence)` plus
 * `ON CONFLICT DO NOTHING`, matching the kernel's own command-level idempotency
 * rule (ADR-0007): re-sending a batch can never double-write.
 *
 * The app stays local-first. Sync is best-effort and off by default; every
 * failure here is a no-op for the learner, who keeps working offline.
 *
 * Routes (one file, so Vercel's builder has no cross-module resolution to do):
 *   GET    /api/sync?action=health
 *   GET    /api/sync?learner=<id>&since=<n>
 *   POST   /api/sync            { learnerId, events: [...] }
 *   DELETE /api/sync?learner=<id>
 */
import { neon } from "@neondatabase/serverless";

/** Created on demand; `IF NOT EXISTS` makes every request safe to be the first. */
export const SCHEMA_SQL = `
  create table if not exists learning_events (
    learner_id     text        not null,
    local_sequence integer     not null,
    device_id      text        not null default '',
    event_type     text        not null default '',
    occurred_at    bigint      not null default 0,
    payload        jsonb       not null,
    received_at    timestamptz not null default now(),
    primary key (learner_id, local_sequence)
  )
`;

/** Guard rails on a client-supplied batch. Pure, so it is unit-tested. */
export interface EventRow {
  localSequence: number;
  deviceId: string;
  eventType: string;
  occurredAt: number;
  payload: unknown;
}

export interface BatchValidation {
  ok: boolean;
  rows: EventRow[];
  rejected: { index: number; reason: string }[];
}

/** One request may not be unbounded: a batch is a sync unit, not a bulk import. */
export const MAX_BATCH = 500;
export const MAX_PAYLOAD_BYTES = 64 * 1024;

export function validateBatch(input: unknown): BatchValidation {
  const rejected: BatchValidation["rejected"] = [];
  const rows: EventRow[] = [];
  if (!Array.isArray(input)) return { ok: false, rows, rejected: [{ index: -1, reason: "events must be an array" }] };
  if (input.length > MAX_BATCH) return { ok: false, rows, rejected: [{ index: -1, reason: `batch exceeds ${MAX_BATCH} events` }] };

  input.forEach((raw, index) => {
    if (typeof raw !== "object" || raw === null) { rejected.push({ index, reason: "not an object" }); return; }
    const e = raw as Record<string, unknown>;
    const seq = e.localSequence;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
      rejected.push({ index, reason: "localSequence must be a non-negative integer" });
      return;
    }
    let serialised: string;
    try {
      serialised = JSON.stringify(raw);
    } catch {
      rejected.push({ index, reason: "payload is not serialisable" });
      return;
    }
    if (serialised.length > MAX_PAYLOAD_BYTES) {
      rejected.push({ index, reason: "event exceeds the size limit" });
      return;
    }
    rows.push({
      localSequence: seq,
      deviceId: typeof e.deviceId === "string" ? e.deviceId.slice(0, 128) : "",
      eventType: typeof e.eventType === "string" ? e.eventType.slice(0, 128) : "",
      occurredAt: typeof e.occurredAt === "number" && Number.isFinite(e.occurredAt) ? Math.trunc(e.occurredAt) : 0,
      payload: raw,
    });
  });

  return { ok: rejected.length === 0, rows, rejected };
}

/** A learner id is an opaque key here; keep it bounded and printable. */
export function validLearnerId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[\w.:@-]+$/.test(value);
}

// ---------------------------------------------------------------------------

type Req = { method?: string; url?: string; body?: unknown; headers: Record<string, string | string[] | undefined> };
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
  const url = new URL(req.url ?? "/", "http://localhost");
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    // A missing database is a configuration state, not a crash. The app treats
    // it as "sync unavailable" and carries on entirely offline.
    json(res, 503, { ok: false, configured: false, error: "DATABASE_URL is not set for this deployment" });
    return;
  }

  const sql = neon(connectionString);

  try {
    await sql(SCHEMA_SQL);

    if (req.method === "GET" && url.searchParams.get("action") === "health") {
      const [{ count }] = (await sql("select count(*)::int as count from learning_events")) as { count: number }[];
      const [{ learners }] = (await sql(
        "select count(distinct learner_id)::int as learners from learning_events",
      )) as { learners: number }[];
      json(res, 200, { ok: true, configured: true, reachable: true, events: count, learners });
      return;
    }

    const learnerParam = url.searchParams.get("learner");

    if (req.method === "GET") {
      if (!validLearnerId(learnerParam)) { json(res, 400, { ok: false, error: "invalid learner" }); return; }
      const sinceRaw = Number(url.searchParams.get("since") ?? "-1");
      const since = Number.isFinite(sinceRaw) ? Math.trunc(sinceRaw) : -1;
      const rows = (await sql(
        `select payload from learning_events
          where learner_id = $1 and local_sequence > $2
          order by local_sequence asc
          limit $3`,
        [learnerParam, since, MAX_BATCH],
      )) as { payload: unknown }[];
      json(res, 200, { ok: true, events: rows.map((r) => r.payload), count: rows.length });
      return;
    }

    if (req.method === "POST") {
      const body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as
        { learnerId?: unknown; events?: unknown } | undefined;
      if (!validLearnerId(body?.learnerId)) { json(res, 400, { ok: false, error: "invalid learnerId" }); return; }

      const batch = validateBatch(body?.events);
      if (!batch.ok) { json(res, 400, { ok: false, error: "invalid events", rejected: batch.rejected }); return; }
      if (batch.rows.length === 0) { json(res, 200, { ok: true, stored: 0, total: await total(sql, body!.learnerId as string) }); return; }

      // One statement, unnested arrays: a batch is written atomically, and
      // ON CONFLICT DO NOTHING makes a re-send a no-op rather than a duplicate.
      const result = (await sql(
        `insert into learning_events (learner_id, local_sequence, device_id, event_type, occurred_at, payload)
         select $1, s, d, t, o, p
           from unnest($2::int[], $3::text[], $4::text[], $5::bigint[], $6::jsonb[]) as u(s, d, t, o, p)
         on conflict (learner_id, local_sequence) do nothing
         returning local_sequence`,
        [
          body!.learnerId as string,
          batch.rows.map((r) => r.localSequence),
          batch.rows.map((r) => r.deviceId),
          batch.rows.map((r) => r.eventType),
          batch.rows.map((r) => r.occurredAt),
          batch.rows.map((r) => JSON.stringify(r.payload)),
        ],
      )) as { local_sequence: number }[];

      json(res, 200, {
        ok: true,
        stored: result.length,
        skipped: batch.rows.length - result.length,
        total: await total(sql, body!.learnerId as string),
      });
      return;
    }

    if (req.method === "DELETE") {
      if (!validLearnerId(learnerParam)) { json(res, 400, { ok: false, error: "invalid learner" }); return; }
      // Deletion is real and immediate — the spec requires learner data to be
      // deletable, and a backup that outlives the delete would break that.
      const deleted = (await sql(
        "delete from learning_events where learner_id = $1 returning local_sequence",
        [learnerParam],
      )) as unknown[];
      json(res, 200, { ok: true, deleted: deleted.length });
      return;
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    json(res, 405, { ok: false, error: `method ${req.method} not allowed` });
  } catch (error) {
    // Never leak the connection string or driver internals to the client.
    console.error("sync failed:", error);
    json(res, 502, { ok: false, configured: true, reachable: false, error: "the sync database could not be reached" });
  }
}

async function total(sql: ReturnType<typeof neon>, learnerId: string): Promise<number> {
  const [{ count }] = (await sql(
    "select count(*)::int as count from learning_events where learner_id = $1",
    [learnerId],
  )) as { count: number }[];
  return count;
}
