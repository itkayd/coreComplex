/**
 * The browser half of the single account.
 *
 * Deliberately thin. It holds no credential, no token and no identity: the
 * session lives in an HttpOnly cookie that this code cannot read by design, so
 * "am I signed in?" is a question only the server can answer. That is the point
 * — a client-side `isLoggedIn` boolean is a suggestion, and this one is a fact.
 *
 * WHAT SIGNING IN IS FOR, precisely. It unlocks the durable backup, which is the
 * only private thing here. Learning itself never requires it: the kernel runs on
 * the device, the pack is public, and a session that has expired must not be
 * able to stop someone studying. So the app treats a signed-out state as
 * "backup unavailable", exactly as it treats a deployment with no database.
 */

const ENDPOINT = `${import.meta.env.BASE_URL}api/auth`;

export interface AccountStatus {
  /** Does this deployment have an account configured at all? */
  configured: boolean;
  authenticated: boolean;
  /** Present only when unconfigured: names the missing variable, never a value. */
  reason?: string;
}

const OFFLINE: AccountStatus = { configured: false, authenticated: false };

/**
 * Ask the server who we are.
 *
 * Any failure answers "not configured" rather than throwing. A static preview
 * with no functions, an offline phone and a broken deployment are all the same
 * thing from here: no backup available, carry on locally.
 */
export async function accountStatus(): Promise<AccountStatus> {
  try {
    const res = await fetch(ENDPOINT, { credentials: "same-origin" });
    if (!res.ok) return OFFLINE;
    const body = await res.json() as Record<string, unknown>;
    return {
      configured: body.configured === true,
      authenticated: body.authenticated === true,
      reason: typeof body.reason === "string" ? body.reason : undefined,
    };
  } catch {
    return OFFLINE;
  }
}

export type SignInResult =
  | { ok: true }
  | { ok: false; reason: "wrong" | "unconfigured" | "offline"; detail: string };

export async function signIn(passphrase: string): Promise<SignInResult> {
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase }),
    });
    if (res.ok) return { ok: true };
    if (res.status === 503) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      return { ok: false, reason: "unconfigured", detail: body.error ?? "no account is configured for this deployment" };
    }
    // Everything else is "wrong passphrase". The server deliberately does not
    // distinguish failure modes, and neither should this.
    return { ok: false, reason: "wrong", detail: "That passphrase is not correct." };
  } catch {
    return { ok: false, reason: "offline", detail: "Could not reach the server. You can still study offline." };
  }
}

export async function signOut(): Promise<void> {
  await fetch(ENDPOINT, { method: "DELETE", credentials: "same-origin" }).catch(() => undefined);
}
