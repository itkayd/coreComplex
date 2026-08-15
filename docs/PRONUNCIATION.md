# Word pronunciation

```
                    user taps 🔊
                         │
                         ▼
              Local CosyVoice running?
                    │           │
                   YES          NO
                    │           │
                    ▼           ▼
                CosyVoice   Device Mandarin voice?
                                │          │
                               YES         NO
                                │          │
                                ▼          ▼
                       speechSynthesis   Cloud TTS configured?
                                            │          │
                                           YES         NO
                                            │          │
                                            ▼          ▼
                                    generated MP3   no audio, said plainly
```

Implemented in `apps/web/src/pronounce.ts`. Each tier has its own module —
`speech.ts`, `device-voice.ts`, `cloud-voice.ts` — and the router is the only
thing that knows there is more than one.

## Why this order

**Quality, then offline, then cost.**

| Tier | Sounds like | Needs | Offline |
| --- | --- | --- | --- |
| 1. Local CosyVoice | very good | a machine running the service | yes, once cached |
| 2. Device `speechSynthesis` | adequate | a Chinese voice pack | yes, always |
| 3. Cloud TTS via `/api/speech` | depends on provider | a configured upstream | after first play |
| 4. — | silence, explained | — | — |

Putting the cloud tier higher would spend a network request on devices that
already had a perfectly good voice sitting idle. Putting the device voice first
would throw away the best audio on the machines that can produce it.

**Tier 1 checks reachability, not configuration.** A dev machine serving the app
from localhost has a service URL by default and usually nothing behind it.
Treating "configured" as "running" is what once made the Words screen render
several hundred play buttons that all failed.

## The cloud tier is off unless you configure it

There is deliberately **no default provider**. The brief for the speech stack was
explicit — no paid API, no hardcoded cloud endpoint, no API keys — and a default
would have to be one of:

- a metered service, which is banned outright (`PAID_SPEECH_HOSTS` refuses
  Google, Azure, OpenAI, ElevenLabs, Polly, Play.ht, Deepgram and AssemblyAI by
  hostname, subdomains included); or
- an undocumented free endpoint such as Google Translate's TTS, which is not
  offered as an API, is against its terms to use as one, and can be withdrawn
  without notice.

Shipping either as a silent default would be a bad trade made on the owner's
behalf. So:

```
DYR_CLOUD_TTS_URL=https://your-tts-host.example/api/tts?q={text}&lang={lang}
DYR_CLOUD_TTS_MEDIA_TYPE=audio/mpeg      # optional, defaults to audio/mpeg
```

`{text}` and `{lang}` are substituted; with no placeholder, `?text=…&lang=zh-CN`
is appended, so a plain endpoint works unmodified. `https` is required except on
localhost — otherwise the learner's text would cross the network in the clear.

Good candidates are things you host yourself: CosyVoice's FastAPI runtime on a
public box, Piper, MeloTTS. Anything that answers a GET with audio bytes works.

## The browser never learns the upstream exists

The CSP is `connect-src 'self'`. That is not an inconvenience to route around —
it is what guarantees this app talks to nobody. So the browser calls the
same-origin `/api/speech`, and that function is the only thing that contacts an
upstream. The learner's text never leaves their device toward a third party, and
the client bundle contains no provider URL. A test asserts both.

The word itself never appears in a header either: the ETag is a hash, so a CDN on
the path logs an opaque id rather than what someone is studying. Responses are
`immutable`, and the client keeps its own Cache API copy — so a device on the
cloud tier replays a heard word with no network, which matters most for exactly
the devices that tier serves.

## All three tiers are synthetic

Same constitutional position throughout (spec p.21). Generated audio is:

- **never canonical** — `canSatisfyCanonicalAudio` accepts only `"human"`;
- **never the cue for an audio-primary task** — `CanonicalAudioCue` is the only
  component that speaks before an answer, and it plays verified human bytes or
  refuses the task outright;
- **never evidence** — pressing play grades nothing and moves no trace;
- **always labelled** — "Generated voice — a convenience, not a pronunciation
  reference", plus which source produced it.

"Hear it" appears only where the hanzi is **already visible**: the Words list,
the Result screen after an answer, Settings. Never on a task cue, where hearing
the word would give the answer away.

## What is checked in a real browser

`apps/web/e2e/stage2.mjs`, with `speechSynthesis` and `/api/speech` stubbed —
headless Chromium ships no voices, so the unstubbed browser only ever exercises
the degraded path.

- a Mandarin voice: playback is offered, speaks the **right text** tagged
  **`zh-CN`** (not the page's English default, which reads hanzi as gibberish),
  and "Slower" really lowers the rate;
- a Cantonese-only device: offered **nothing** — a Cantonese reading of a
  Mandarin word is a wrong answer delivered with the same confidence as a right
  one, so `zh-HK`/`yue` is refused outright rather than ranked last;
- **no voice at all, cloud configured**: audio is still offered, and the tier is
  really asked for the word beside the button;
- no voice, no cloud: the UI says so, and shows no control that could only fail.
