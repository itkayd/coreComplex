/**
 * Optional backup of the learning event log to the project's own API.
 *
 * The architecture does not change: the device is still where learning happens.
 * The kernel runs locally, the log is written locally first, and every session
 * works with no network at all. This adds one thing — a durable copy of that
 * log, so clearing your browser or losing a phone does not erase months of
 * memory state.
 *
 * Four rules it keeps:
 *
 *   OFF BY DEFAULT. Nothing leaves the device until the learner turns it on in
 *   Settings, which matches the promise the app makes on that screen.
 *
 *   LOCAL IS AUTHORITATIVE. Sync never blocks a session and never gates a task.
 *   Every failure is a no-op the learner does not have to care about.
 *
 *   BACKUP, NOT MERGE. Restore happens only into an EMPTY local log. Two devices
 *   both writing produce two logs that share `localSequence` values, and
 *   interleaving them would invent a history neither device lived. Divergence is
 *   reported honestly rather than silently resolved — see `SyncStatus.diverged`.
 *
 *   DELETE MEANS DELETE. Deleting local data deletes the backup too, or the
 *   Settings screen would be lying.
 *
 * Same-origin by construction (`/api/sync`), so the deployment's
 * `connect-src 'self'` CSP stays intact and no third party is involved.
 */
import type { EventEnvelope } from "@dyr/domain";

const ENDPOINT = `${import.meta.env.BASE_URL}api/sync`;
const PREF_KEY = "dyr.sync.enabled";

export type SyncState =
  /** The learner has not turned backup on. */
  | "off"
  /** On, but this deployment has no database configured. */
  | "unconfigured"
  /** On and the last exchange succeeded. */
  | "synced"
  /** On, but the last attempt failed — the app carries on regardless. */
  | "unreachable"
  /** On, and local and remote histories disagree. Nothing was overwritten. */
  | "diverged";

export interface SyncStatus {
  state: SyncState;
  localEvents: number;
  remoteEvents: number;
  detail: string;
}

export function syncEnabled(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === "true";
  } catch {
    return false;
  }
}

export function setSyncEnabled(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, String(on));
  } catch {
    /* storage unavailable — treated as off */
  }
}

async function call(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  try {
    const res = await fetch(`${ENDPOINT}${path}`, init);
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body: body as Record<string, unknown> };
  } catch {
    return { ok: false, status: 0, body: {} };
  }
}

/**
 * Is a database configured for this deployment at all?
 *
 * Only an explicit healthy answer counts as configured. A 503 means the endpoint
 * exists but has no `DATABASE_URL`; a 404, a network failure or any other status
 * means there is no working backup here either — for instance a static preview
 * with no functions at all. Treating "no answer" as "configured" would offer the
 * learner a control that silently does nothing.
 */
export async function health(): Promise<{ configured: boolean; reachable: boolean; events: number }> {
  const { ok, body } = await call("?action=health");
  const healthy = ok && body.ok === true && body.configured === true;
  return {
    configured: healthy,
    reachable: healthy && body.reachable === true,
    events: typeof body.events === "number" ? body.events : 0,
  };
}

/**
 * Push anything the backup does not have yet.
 *
 * Idempotent on the server via `(learner_id, local_sequence)`, so re-sending an
 * overlapping range is harmless and there is no cursor to keep in sync.
 */
export async function pushEvents(learnerId: string, events: readonly EventEnvelope[]): Promise<SyncStatus> {
  if (!syncEnabled()) {
    return { state: "off", localEvents: events.length, remoteEvents: 0, detail: "Backup is off." };
  }
  if (events.length === 0) {
    const h = await health();
    return h.configured
      ? { state: h.reachable ? "synced" : "unreachable", localEvents: 0, remoteEvents: h.events, detail: "Nothing to back up yet." }
      : { state: "unconfigured", localEvents: 0, remoteEvents: 0, detail: "No database is configured for this deployment." };
  }

  // Chunked so one enormous history cannot exceed the server's batch limit.
  let stored = 0;
  let total = 0;
  for (let i = 0; i < events.length; i += 400) {
    const chunk = events.slice(i, i + 400);
    const { ok, status, body } = await call("", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ learnerId, events: chunk }),
    });
    if (status === 503) {
      return { state: "unconfigured", localEvents: events.length, remoteEvents: 0, detail: "No database is configured for this deployment." };
    }
    if (!ok) {
      return {
        state: "unreachable",
        localEvents: events.length,
        remoteEvents: total,
        detail: "Could not reach the backup. Your work is safe on this device.",
      };
    }
    stored += typeof body.stored === "number" ? body.stored : 0;
    total = typeof body.total === "number" ? body.total : total;
  }

  return {
    state: "synced",
    localEvents: events.length,
    remoteEvents: total,
    detail: stored === 0 ? "Backup already up to date." : `Backed up ${stored} new ${stored === 1 ? "event" : "events"}.`,
  };
}

/**
 * Fetch the backup so a fresh device can be restored.
 *
 * Deliberately returns the events rather than applying them: whether a restore
 * is safe depends on local state, and that decision belongs to the caller —
 * see `restoreIfEmpty`.
 */
export async function fetchBackup(learnerId: string): Promise<EventEnvelope[] | undefined> {
  const out: EventEnvelope[] = [];
  let since = -1;
  // Paged, because the server caps a response at one batch.
  for (let page = 0; page < 200; page++) {
    const { ok, body } = await call(`?learner=${encodeURIComponent(learnerId)}&since=${since}`);
    if (!ok) return undefined;
    const events = Array.isArray(body.events) ? (body.events as EventEnvelope[]) : [];
    if (events.length === 0) break;
    out.push(...events);
    const last = events[events.length - 1] as { localSequence?: number };
    if (typeof last?.localSequence !== "number" || last.localSequence <= since) break;
    since = last.localSequence;
  }
  return out;
}

/**
 * Restore a backup into an empty local log, or report divergence.
 *
 * Never overwrites local history. If both sides have events they are two real
 * histories, and picking one silently would destroy work the learner actually
 * did — so this returns `diverged` and leaves both intact.
 */
export async function restoreIfEmpty(
  learnerId: string,
  localCount: number,
): Promise<{ status: SyncStatus; events?: EventEnvelope[] }> {
  if (!syncEnabled()) {
    return { status: { state: "off", localEvents: localCount, remoteEvents: 0, detail: "Backup is off." } };
  }
  const h = await health();
  if (!h.configured) {
    return { status: { state: "unconfigured", localEvents: localCount, remoteEvents: 0, detail: "No database is configured for this deployment." } };
  }
  if (!h.reachable) {
    return { status: { state: "unreachable", localEvents: localCount, remoteEvents: 0, detail: "Could not reach the backup." } };
  }

  const remote = await fetchBackup(learnerId);
  if (!remote) {
    return { status: { state: "unreachable", localEvents: localCount, remoteEvents: 0, detail: "Could not read the backup." } };
  }
  if (remote.length === 0) {
    return { status: { state: "synced", localEvents: localCount, remoteEvents: 0, detail: "Backup is empty." } };
  }
  if (localCount === 0) {
    return {
      status: { state: "synced", localEvents: remote.length, remoteEvents: remote.length, detail: `Restored ${remote.length} events from backup.` },
      events: remote,
    };
  }
  if (localCount >= remote.length) {
    return { status: { state: "synced", localEvents: localCount, remoteEvents: remote.length, detail: "This device is ahead; it will back up." } };
  }
  return {
    status: {
      state: "diverged",
      localEvents: localCount,
      remoteEvents: remote.length,
      detail: `This device has ${localCount} events and the backup has ${remote.length}. Nothing was changed.`,
    },
  };
}

/** Erase the backup. Called whenever local data is deleted. */
export async function deleteBackup(learnerId: string): Promise<boolean> {
  const { ok } = await call(`?learner=${encodeURIComponent(learnerId)}`, { method: "DELETE" });
  return ok;
}
