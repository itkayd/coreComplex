/**
 * The sign-in screen — and what it deliberately does not do.
 *
 * IT NEVER BLOCKS LEARNING. This app is local-first: the kernel runs on the
 * device, the pack is public, and every session works with no network at all. A
 * lock screen in front of that would be a lie about where the value lives, and
 * would break the one promise that matters most — that a phone in a tunnel with
 * an expired session can still study. So this screen has a way past it, and the
 * copy says so plainly rather than burying it.
 *
 * WHAT SIGNING IN ACTUALLY BUYS is the durable backup, which is the only private
 * thing here. That is what the screen offers, in those words.
 *
 * ONE ACCOUNT, NO SIGN-UP. There is no "create account" affordance because there
 * is no code path that could create one (`api/auth.ts`). Offering a link that
 * cannot work would be worse than offering nothing.
 */
import { useState } from "react";
import { Icon } from "./Icons.tsx";
import { signIn, type AccountStatus } from "./auth.ts";

export interface SignInProps {
  status: AccountStatus;
  onSignedIn: () => void;
  /** Continue without the backup. Always available — see the note above. */
  onSkip: () => void;
}

export function SignIn({ status, onSignedIn, onSkip }: SignInProps) {
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (submitEvent: React.FormEvent) => {
    submitEvent.preventDefault();
    if (passphrase.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    const result = await signIn(passphrase);
    setBusy(false);
    if (result.ok) { setPassphrase(""); onSignedIn(); return; }
    setError(result.detail);
  };

  return (
    <div className="fade stack gate">
      <header className="gate-head">
        <span className="gate-mark" aria-hidden="true"><Icon name="lock" size={26} /></span>
        <p className="eyebrow">Dyr Mandarin Lab</p>
        <h1>Sign in to sync</h1>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Your learning history is private, so backing it up needs the account passphrase.
          Studying does not — you can start straight away and sign in later.
        </p>
      </header>

      {status.configured ? (
        <form className="card" onSubmit={submit}>
          <label className="field-label" htmlFor="passphrase">Passphrase</label>
          <input
            id="passphrase"
            type="password"
            className="field"
            value={passphrase}
            onChange={(changeEvent) => setPassphrase(changeEvent.target.value)}
            autoComplete="current-password"
            /* The single account has no username; naming it lets a password
               manager store and refill this the way it would any other login. */
            name="dyr-passphrase"
            autoFocus
            disabled={busy}
          />
          <button className="primary" type="submit" disabled={busy || passphrase.length === 0} style={{ marginTop: 12 }}>
            {busy ? "Checking…" : "Sign in"}
          </button>
          {error && (
            <p className="small warn" role="alert" style={{ marginTop: 10, marginBottom: 0 }}>{error}</p>
          )}
        </form>
      ) : (
        <div className="card">
          <h2>No account is set up yet</h2>
          <p className="muted small" style={{ marginBottom: 0 }}>
            This deployment has no passphrase configured, so there is nothing to sign in to and no
            backup available. Everything else works: the app runs entirely on this device.
            {status.reason ? ` (${status.reason})` : ""}
          </p>
        </div>
      )}

      <button type="button" onClick={onSkip}>
        {status.configured ? "Skip — study on this device" : "Continue"}
      </button>

      <p className="muted small" style={{ marginBottom: 0 }}>
        Signed in or not, sessions run offline and your work is written to this device first.
      </p>
    </div>
  );
}
