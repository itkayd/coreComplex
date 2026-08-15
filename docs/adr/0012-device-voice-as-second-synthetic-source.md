# ADR 0012 — The device's own voice as a second synthetic source

Status: accepted
Date: 2026-08-15
Supersedes nothing. Extends ADR 0010 (synthetic speech via CosyVoice).

## Context

ADR 0010 put synthetic speech behind `SyntheticSpeechProvider` and implemented it
with a locally-run CosyVoice server. That decision still holds: CosyVoice sounds
far better than anything a browser ships, it returns content-addressed bytes that
cache under a version-aware id, and it costs nothing because it runs on the
learner's own hardware.

It also requires the learner to have hardware, model weights and a running
process. A phone opening the deployed PWA has none of those. `speech.ts` was
already honest about this — where no service is configured it sets
`SPEECH_AVAILABLE = false` and refuses to render a control that could only ever
fail — but the honest outcome was an app that could not make a sound. Every
screen showed hanzi and pinyin and nothing to listen to, on the one device most
people would actually use.

Meanwhile every mobile browser already ships Mandarin text-to-speech: free, with
no key, no account, no network, and no install. Not using it was leaving the
learner with silence out of tidiness.

## Decision

Add the platform's `speechSynthesis` as a **second synthetic source**, and route
between the two:

```
                  ┌── local service (CosyVoice)   better, needs a machine
  pronounce(text) ┤
                  └── device voice (Web Speech)   worse, always there, offline
```

The service is preferred when it is configured **and reachable**; otherwise the
device voice is used; if neither can speak, the control is not rendered and
Settings explains why.

A device voice occupies **exactly** the constitutional position CosyVoice
occupies (spec p.21). It is synthetic. It can never be canonical, never satisfies
the listening prerequisite, never cues an audio-primary task, is always labelled
as generated, and is never evidence. `canSatisfyCanonicalAudio` enforces this
structurally by accepting only `sourceType: "human"`, and nothing in this change
touches that.

## Consequences

**The deployed app can speak.** Every word in the pack — all 2,006 — has audio on
any device with a Chinese voice installed, with no setup, working offline, and
costing nothing. That is a large usability gain for zero infrastructure.

**"Reachable" is now checked, not assumed.** Treating a configured service URL as
proof of a running service is what made a dev machine on localhost render several
hundred play buttons that all failed: the default URL is present whenever the app
is served locally, and the service usually is not running behind it. The
readiness probe now asks.

**The voice is chosen, not left to the platform.** Left alone, `speechSynthesis`
will happily read hanzi with an English voice, which is unintelligible, or with a
Cantonese voice, which is a different language delivered with the same confidence
as a correct answer. So Cantonese (`zh-HK`, `yue`) is refused outright rather than
ranked last, mainland Mandarin is preferred over Taiwan, and on-device voices are
preferred over network ones because offline is the point of a PWA. The ranking is
pure and unit-tested (`voice-select.test.ts`); everything that touches the DOM is
in `device-voice.ts` and makes no decisions.

**Quality is worse, and is disclosed.** A stock system voice reads tones
adequately and prosody poorly. That is acceptable for its actual purpose — hearing
the rough shape of a word you are already looking at — and unacceptable as a model
to imitate, which is why the label says so every time and why listening tasks
still refuse anything but verified human bytes.

**Two quirks are handled because they look like bugs otherwise.** `getVoices()` is
empty on the first call in Chrome and on Android and fills in on `voiceschanged`,
so a single synchronous read concludes the device has no Chinese voice forever;
and iOS Safari discards utterances queued before a user gesture, so nothing is
spoken until a tap.

**This is not progress on Stage 2.** Stage 2 needs 60 licensed human recordings.
This change does not produce one, does not reduce the requirement, and does not
make a listening task issuable. It makes the app useful in the meantime.
