# ADR 0013 — Synthetic pronunciation routing

Status: accepted
Date: 2026-08-15
Extends ADR 0010 (CosyVoice) and ADR 0012 (device voice). Supersedes nothing.

## The chain

```
user taps 🔊
     │
     ▼
1. local CosyVoice running?  ── yes ──▶  CosyVoice          best, needs a machine
     │ no
2. device Mandarin voice?    ── yes ──▶  speechSynthesis    free, offline, everywhere
     │ no
3. Cloudflare MeloTTS?       ── yes ──▶  POST /api/tts      natural, needs network once
     │ no
     ▼
PronounceError — the control is not rendered, and Settings says why
```

**ALL THREE ARE SYNTHETIC.** None of them can become canonical audio. See below.

Listening tasks are a separate path entirely:

```
CanonicalAudioCue ──▶ verified HUMAN recording, hash-checked before playback
                      or the task is refused as unanswerable
```

## Why this order, having genuinely considered CosyVoice → Cloudflare → device

The brief invited the cloud tier to sit second, on the grounds that MeloTTS
sounds better than a stock system voice. It usually does. It is still the wrong
place for it, for four reasons that outrank quality here — and the stated
priority order (reliability, naturalness, latency, cost, offline) puts three of
them above it:

**Reliability.** The device voice depends on nothing: no network, no account, no
upstream quota, no third party's uptime. Cloudflare depends on all of them.
Putting a networked provider ahead of a local one makes the common case fragile
in order to improve the rare one.

**Latency.** `speechSynthesis` speaks in tens of milliseconds. A Workers AI round
trip plus MP3 transfer is hundreds at best — on a control a learner taps
repeatedly while reading down a word list.

**Offline.** On a phone in a tunnel the device voice works and the cloud does
not. Cloud-first would mean a first-time word is silent offline even though the
phone could have said it.

**Cost.** Every cloud clip is a Workers AI request. Spending one on a device that
already has a perfectly good voice idle buys nothing.

So the cloud tier goes where it does the most good: the devices that genuinely
cannot speak. For those, the choice was silence and is now natural Mandarin.

The order lives in one array (`PROVIDERS` in `pronounce.ts`). Changing it is a
one-line edit and needs no UI change — which is the point of the provider
abstraction, and lets this decision be revisited on evidence.

## Readiness is not configuration, and readiness is not enough

**Configured ≠ available.** A dev machine serving the app from localhost has a
speech-service URL by default and usually nothing behind it. Treating the two as
the same is what once made the Words screen render several hundred play buttons
that all failed. Every `probe()` reaches the thing it describes or asks the
platform directly.

**Available ≠ working.** A provider can probe true, prepare successfully, and
then throw when actually asked to make a sound. So `play()` itself resumes the
walk at the next provider: a device voice that refuses to speak falls through to
Cloudflare rather than leaving a dead button. The walk is a forward-only index
into a fixed array, so it cannot loop and attempts each provider at most once.

## The endpoint

`POST /api/tts` — the browser's only route to Cloudflare.

Two independent reasons it must be server-side. The CSP is `connect-src 'self'`,
so the browser cannot reach `api.cloudflare.com` and that is not being relaxed to
decorate a button. And the token is a bearer credential for an account-wide AI
endpoint — in a client bundle it would be published, since this repository is
public.

| | |
| --- | --- |
| Model | `@cf/myshell-ai/melotts`, `lang: "zh"` |
| Request | `{ text, speed }` — POST only |
| Response | `audio/mpeg` |
| Limits | 500 characters, speed clamped to 0.5–2.0, 12 s upstream timeout |
| Errors | 502 (upstream), 504 (timeout), 503 (unconfigured), 400/413 (request) |

Workers AI answers with base64 MP3 inside JSON; the function decodes it so the
browser gets bytes an `<audio>` element plays directly. Raw audio is accepted
too, defensively.

**Speed is not sent upstream.** MeloTTS on Workers AI exposes no rate parameter,
and inventing one would silently do nothing. It is validated server-side (so a
bad request is still rejected) and applied in the browser with `playbackRate`,
which preserves pitch — and means one cached clip serves every speed.

## Caching

Key: `SHA-256(NFC(text) + model + lang + adapterVersion)`.

Everything that changes the bytes is in it; nothing that does not. **Speed is
deliberately excluded** — it is a `playbackRate`, so one clip serves every rate.
Including it would multiply identical downloads by however many speeds a learner
happens to press.

Stored in the **Cache API**, the same store the shell and pack recordings use,
rather than a parallel system. The wrinkle: the endpoint is a POST and the Cache
API can only key on GET, so the key is a *synthetic* GET URL — `/__tts/<hash>` —
that is never actually fetched. It exists solely as a stable identity for the
bytes, which is exactly what a content address is.

The service worker preserves `dyr-tts-v1` across activation. Without that it
would be deleted on every worker update and the cache would quietly do nothing.

**Failures are never cached.** A stored 502 would outlive the outage that caused
it and make a transient problem permanent.

The word never appears in a header either: the ETag is the hash, so a CDN on the
path logs an opaque id rather than what someone is studying.

## iOS / Safari

Safari only lets an `<audio>` element play while a user activation is in effect.
Activation survives synchronous code and microtasks but **not** real network
I/O — and this chain does exactly that: probe the service, probe the device
voice, POST, wait for MP3 bytes. By then the activation is gone and Safari
rejects playback with `NotAllowedError`. The learner taps, nothing happens, and
nothing explains it.

`audio-unlock.ts` claims the permission at the only moment it exists:
synchronously, first thing inside the tap, by creating **one** `<audio>` element
and playing 0.05 s of inline silence. That call is inside the gesture, so it is
allowed; the element stays unlocked and its `src` is swapped for the real audio
later. So the element is created *before* the audio exists, which is the reverse
of the obvious order and the reason the file exists.

One element is reused for the page: a fresh element created outside a gesture is
not unlocked on iOS, and reuse also means a new word implicitly stops the
previous one — which is what a learner expects anyway.

The device-voice tier keeps its own iOS handling: nothing is spoken until
`play()`, so `speechSynthesis.speak()` also originates in the tap.

## Synthetic can never become canonical

Unchanged, and now asserted per provider:

- `canSatisfyCanonicalAudio()` accepts only `sourceType: "human"` — and
  `sourceType` is the literal `"synthetic"` on every provider here, not a boolean
  a caller could flip;
- `isCanonical()` additionally refuses any asset flagged `synthetic`;
- `runAudioQa()` returns `synthetic_cannot_be_canonical` even when every other
  declaration claims the clip is human-recorded and clean;
- generated audio is never a task cue, never evidence, and never moves a trace.

`fixtures/sim/melotts-canonical.test.ts` asserts all of this for MeloTTS
specifically, including that a pack filled entirely with generated clips still
reports **zero** canonical recordings and leaves Stage 2 blocked.
`synthetic-audio.test.ts` does the same for CosyVoice. Both exist because the
rule is about the category, not one vendor — a new provider should arrive with a
new copy.

**Stage 2 remains blocked on 0/60 human recordings, and that is correct.** This
is a content-pipeline problem and pronunciation convenience is not its solution.

## Deployment

Vercel → Settings → Environment Variables, all environments:

| Variable | Required | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | for tier 3 | Workers AI account |
| `CLOUDFLARE_API_TOKEN` | for tier 3 | Workers AI token, server-side only |

Both unset is a supported state: the chain ends at the device voice, and Settings
says what this device can do.

Never set these through `NEXT_PUBLIC_*` or `VITE_*` — those are exposed to client
bundles by definition. A test scans the built bundle for both names, for
`api.cloudflare.com`, for `Bearer `, and for the live token value when present.
