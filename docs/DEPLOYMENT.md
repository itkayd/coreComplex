# Deploying the plain body

The app is local-first: a static bundle plus an immutable content pack. There is
no server, no database and no API — learner data lives in IndexedDB on the device
and is never uploaded. Hosting it is therefore just static hosting.

```
npm ci
npm run build:web      # builds the content pack, then the PWA
# → apps/web/dist
```

`vercel.json` at the repository root configures exactly that: build with
`npm run build:web`, serve `apps/web/dist`, no framework preset. `vercel.json`
is strict JSON with no comment support, so the reasoning lives here.

## Caching

Each rule matches what the URL actually promises.

| Path | Policy | Why |
| --- | --- | --- |
| `/assets/*` | `immutable`, 1 year | Vite fingerprints the filename, so the bytes behind a URL never change. |
| `/packs/audio/*` | `immutable`, 1 year | Canonical audio is addressed by its own sha256; a URL is immutable by construction. |
| `/packs/*.json` | `no-cache` | The pack sits at a stable URL whose contents change with each release. Serving a stale copy would not be a silent bug — the browser verifies the pack's `contentHash` and would refuse it — but it would present the learner with a rejected pack instead of the current one. |
| `/sw.js` | `no-store` | A cached service worker pins an old app indefinitely. The worker decides what is cached; it must never be cached itself. |

## Content-Security-Policy

`default-src 'self'` with nothing off-origin, which is not a hardening exercise
so much as a statement of the architecture: no analytics, no font CDN, no
third-party calls, nowhere for learner data to go. `media-src` additionally
allows `blob:` because canonical audio is fetched, hash-verified and only then
turned into a blob URL for playback. `style-src` allows `'unsafe-inline'` for the
handful of inline styles React renders; there is no inline script.

If a synthetic-speech service is ever configured for a deployment
(`VITE_DYR_SPEECH_URL`), its origin has to be added to `connect-src` and
`media-src`. Without that variable the control is not rendered at all — see
`apps/web/src/speech.ts`.

## Branches

Vercel builds every pushed branch. `main` is the production branch; any other
branch gets a preview URL. The GitHub integration is set to `silent`, so Vercel
does not comment on commits and pull requests.

## What a deployed build contains

Only what the release pack contains. Fixture audio is flagged in its provenance
and refused by `buildCore60Pack`, so the generated recordings used by the browser
gate cannot reach a deployed site — `npm run build:web` writes the release pack,
never the fixture pack.
