/**
 * Durable backup of the learning event log (Supabase Postgres).
 *
 * WHAT THIS IS NOT: a brain. Dyr's kernel is the only thing that decides
 * anything about memory (spec p.3 "TaskContracts in; AttemptEnvelopes back;
 * LearningFacts out"), and it runs on the device. This endpoint stores opaque
 * rows and hands them back. It never schedules, never grades, never derives a
 * trace, and never inspects an event beyond the few columns it indexes on. A
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
 * ignore-duplicates resolution — PostgREST's `ON CONFLICT DO NOTHING` — matching
 * the kernel's own command-level idempotency rule (ADR-0007): re-sending a batch
 * can never double-write, and never overwrites an event already stored. An event
 * is immutable; "upsert" here means insert-or-skip, never insert-or-replace.
 *
 * THE STORE IS AN INTERFACE, and deliberately a boring one. `EventStore` can
 * append, read, count and delete. There is no verb in it that could schedule
 * anything, which is the architectural rule expressed as a type. It also makes
 * the routing testable without a live database — see `api/api.test.ts`.
 *
 * The app stays local-first. Sync is best-effort; every failure here is a no-op
 * for the learner, who keeps working offline.
 *
 * Routes (one file, so Vercel's builder has no cross-module resolution to do):
 *   GET    /api/sync?action=health
 *   GET    /api/sync?learner=<id>&since=<n>
 *   POST   /api/sync            { learnerId, events: [...] }
 *   DELETE /api/sync?learner=<id>
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** The table the migration creates. See supabase/migrations/. */
export const TABLE = "learning_events";

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
// The storage contract.

/**
 * Everything this API is allowed to do to stored events.
 *
 * Four verbs, none of which can decide anything. Widening this interface is how
 * a "backup" quietly turns into a second learning brain, so it is meant to stay
 * this shape.
 */
export interface EventStore {
  /** Deployment-wide totals, for the health check. */
  stats(): Promise<{ events: number; learners: number }>;
  /** One page of a learner's log, oldest first, for replay. */
  read(learnerId: string, since: number, limit: number): Promise<unknown[]>;
  /** Append, skipping anything already stored. Returns how many were new. */
  append(learnerId: string, rows: readonly EventRow[]): Promise<number>;
  /** How many events this learner has stored. */
  count(learnerId: string): Promise<number>;
  /** Erase this learner's log entirely. Returns how many rows went. */
  remove(learnerId: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Configuration.

export interface SupabaseConfig {
  url: string;
  key: string;
  /** Which environment variable the key came from, for diagnostics only. */
  keySource: string;
}

export type ConfigResult =
  | { ok: true; config: SupabaseConfig }
  | { ok: false; reason: string };

/**
 * Resolve the server-side Supabase credentials.
 *
 * The Vercel ↔ Supabase Marketplace integration injects these, so there is
 * normally nothing to set by hand. Two rules are enforced rather than assumed:
 *
 * A PRIVILEGED KEY, OR NOTHING. The publishable/anon key is designed to be seen
 * by browsers and is subject to Row Level Security, which the migration turns on
 * with no public policy. Accepting one here would produce a deployment that
 * looks configured, returns success, and silently stores nothing. Refusing it
 * with a clear reason is far better than a backup that is quietly a no-op.
 *
 * NOTHING PUBLIC CARRIES THE KEY. `NEXT_PUBLIC_*` variables are, by definition,
 * exposed to client bundles, so none is ever read as a credential. The project
 * URL is not a credential — it appears in every request — so it may fall back to
 * the public variable when the integration only set that one.
 */
export function resolveConfig(env: Record<string, string | undefined> = process.env): ConfigResult {
  const url = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
  // Modern secret key first; the legacy service-role key is a compatibility
  // fallback for projects the integration provisioned earlier.
  const keySource = env.SUPABASE_SECRET_KEY ? "SUPABASE_SECRET_KEY"
    : env.SUPABASE_SERVICE_ROLE_KEY ? "SUPABASE_SERVICE_ROLE_KEY"
      : undefined;
  const key = keySource ? env[keySource] : undefined;

  if (!url) return { ok: false, reason: "SUPABASE_URL is not set for this deployment" };
  if (!key || !keySource) {
    return { ok: false, reason: "no server-side Supabase key is set (SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY)" };
  }
  return { ok: true, config: { url, key, keySource } };
}

/**
 * A server-side client: no session, no token refresh, no storage.
 *
 * `persistSession` and `autoRefreshToken` are off because this runs in a
 * stateless function — a client that tried to persist a session would be writing
 * to nothing and refreshing a token nobody holds.
 */
export function supabaseStore(config: SupabaseConfig): EventStore {
  const client = createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "x-application-name": "dyr-sync" } },
  });
  return storeFor(client);
}

/** Split out so tests can drive it with a stub client if they ever need to. */
export function storeFor(client: SupabaseClient): EventStore {
  const fail = (error: { message?: string } | null, what: string): void => {
    // The message is logged, never returned: it can name columns, roles and
    // policies, none of which is the client's business.
    if (error) throw new Error(`${what} failed: ${error.message ?? "unknown"}`);
  };

  return {
    async stats() {
      // A distinct-learner count is not expressible in PostgREST, so it comes
      // from the read-only function the migration defines. Its EXECUTE grant is
      // service-role only, so it cannot be called from a browser.
      const { data, error } = await client.rpc("learning_events_stats");
      fail(error, "stats");
      const row = (Array.isArray(data) ? data[0] : data) as { events?: number; learners?: number } | null;
      return { events: Number(row?.events ?? 0), learners: Number(row?.learners ?? 0) };
    },

    async read(learnerId, since, limit) {
      const { data, error } = await client
        .from(TABLE)
        .select("payload")
        .eq("learner_id", learnerId)
        .gt("local_sequence", since)
        // Replay depends on this order. It is asserted, not assumed.
        .order("local_sequence", { ascending: true })
        .limit(limit);
      fail(error, "read");
      return (data ?? []).map((r) => (r as { payload: unknown }).payload);
    },

    async append(learnerId, rows) {
      // `ignoreDuplicates` sends Prefer: resolution=ignore-duplicates, which is
      // ON CONFLICT DO NOTHING. Not merge-duplicates: a stored event is
      // immutable and a re-send must never rewrite it.
      const { data, error } = await client
        .from(TABLE)
        .upsert(
          rows.map((r) => ({
            learner_id: learnerId,
            local_sequence: r.localSequence,
            device_id: r.deviceId,
            event_type: r.eventType,
            occurred_at: r.occurredAt,
            payload: r.payload,
          })),
          { onConflict: "learner_id,local_sequence", ignoreDuplicates: true },
        )
        .select("local_sequence");
      fail(error, "append");
      // Only genuinely new rows come back, so this IS the stored count.
      return (data ?? []).length;
    },

    async count(learnerId) {
      const { count, error } = await client
        .from(TABLE)
        .select("local_sequence", { count: "exact", head: true })
        .eq("learner_id", learnerId);
      fail(error, "count");
      return count ?? 0;
    },

    async remove(learnerId) {
      const { data, error } = await client
        .from(TABLE)
        .delete()
        .eq("learner_id", learnerId)
        .select("local_sequence");
      fail(error, "delete");
      return (data ?? []).length;
    },
  };
}

// ---------------------------------------------------------------------------
// Routing.

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

export const BACKEND = "supabase";

/**
 * The whole API, given a store.
 *
 * Separated from `handler` so the contract can be tested end to end against an
 * in-memory store: idempotency, ordering, validation and the local-first
 * behaviour on a database failure are all properties of THIS function, and none
 * of them should need a live Postgres to verify.
 */
export async function handleSync(req: Req, res: Res, store: EventStore): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  try {
    if (req.method === "GET" && url.searchParams.get("action") === "health") {
      const { events, learners } = await store.stats();
      json(res, 200, { ok: true, configured: true, reachable: true, events, learners, backend: BACKEND });
      return;
    }

    const learnerParam = url.searchParams.get("learner");

    if (req.method === "GET") {
      if (!validLearnerId(learnerParam)) { json(res, 400, { ok: false, error: "invalid learner" }); return; }
      const sinceRaw = Number(url.searchParams.get("since") ?? "-1");
      const since = Number.isFinite(sinceRaw) ? Math.trunc(sinceRaw) : -1;
      const events = await store.read(learnerParam, since, MAX_BATCH);
      json(res, 200, { ok: true, events, count: events.length });
      return;
    }

    if (req.method === "POST") {
      const body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as
        { learnerId?: unknown; events?: unknown } | undefined;
      if (!validLearnerId(body?.learnerId)) { json(res, 400, { ok: false, error: "invalid learnerId" }); return; }
      const learnerId = body!.learnerId as string;

      const batch = validateBatch(body?.events);
      if (!batch.ok) { json(res, 400, { ok: false, error: "invalid events", rejected: batch.rejected }); return; }
      if (batch.rows.length === 0) {
        json(res, 200, { ok: true, stored: 0, skipped: 0, total: await store.count(learnerId) });
        return;
      }

      const stored = await store.append(learnerId, batch.rows);
      json(res, 200, {
        ok: true,
        stored,
        skipped: batch.rows.length - stored,
        total: await store.count(learnerId),
      });
      return;
    }

    if (req.method === "DELETE") {
      if (!validLearnerId(learnerParam)) { json(res, 400, { ok: false, error: "invalid learner" }); return; }
      // Deletion is real and immediate — the spec requires learner data to be
      // deletable, and a backup that outlived the delete would break that.
      json(res, 200, { ok: true, deleted: await store.remove(learnerParam) });
      return;
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    json(res, 405, { ok: false, error: `method ${req.method} not allowed` });
  } catch (error) {
    // Never leak keys, SQL, or driver internals to the client. The learner is
    // local-first: a failure here costs them nothing they can see.
    console.error("sync failed:", error instanceof Error ? error.message : error);
    json(res, 502, {
      ok: false, configured: true, reachable: false, backend: BACKEND,
      error: "the sync database could not be reached",
    });
  }
}

export default async function handler(req: Req, res: Res): Promise<void> {
  const config = resolveConfig();
  if (!config.ok) {
    // Missing configuration is a supported state, not a crash: the app hides the
    // backup control and carries on entirely offline.
    json(res, 503, { ok: false, configured: false, backend: BACKEND, error: config.reason });
    return;
  }
  await handleSync(req, res, supabaseStore(config.config));
}
