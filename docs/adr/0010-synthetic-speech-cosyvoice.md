# ADR-0010: Self-hosted synthetic speech (CosyVoice) behind a provider boundary

## Context

Most of the Core 60 has no canonical human recording, and Stage 3+ needs spoken
example sentences, dialogues and explanations that no fixed recording can cover.
The spec allows exactly one answer to this (p.21 SYNTHETIC FALLBACK): a locally
licensed model may read novel text, must be labelled synthetic, and **cannot
satisfy the canonical-audio prerequisite**.

The system must also stay free to operate: no paid API, no metered SaaS, no
account. That rules out Google/Azure/ElevenLabs/OpenAI TTS and points at a
self-hosted engine on the user's own hardware.

## Decision

Use **CosyVoice** (`github.com/QwenAudio/CosyVoice`, model
`FunAudioLLM/Fun-CosyVoice3-0.5B-2512`) as a synthetic speech engine, run by the
user via CosyVoice's own FastAPI runtime, and reach it through a provider
boundary:

```
apps/web  →  apps/service  →  SyntheticSpeechProvider  →  CosyVoice (FastAPI)
```

- **`packages/senses`** declares `SyntheticSpeechProvider` and
  `SyntheticProvenance`. It is a pure contract: no engine, no HTTP, no process
  spawning. `sourceType` is the **literal** `"synthetic"`, not a boolean a caller
  could flip, so a result claiming to be a human recording cannot be constructed
  through this path at all.
- **`apps/service`** owns the CosyVoice adapter, the cache and the HTTP API. It
  imports contracts only — never `@dyr/kernel`, never `@dyr/layers`.
- **`apps/web`** talks only to `apps/service`. It never reaches CosyVoice, never
  receives a filesystem path, and plays generated audio only on the Result
  screen, after an answer.

The adapter is written against the upstream wire contract as read from
`runtime/python/fastapi/server.py`: `POST /inference_sft` with form fields
`tts_text` and `spk_id`, responding with **headerless little-endian PCM int16**
(`(tts_speech.numpy() * 2**15).astype(np.int16).tobytes()`). The service frames
that PCM into WAV and optionally transcodes to OGG/Opus.

### Why a TypeScript service rather than a Python one

The spec sketches `apps/service` as FastAPI (p.25). CosyVoice already ships a
FastAPI server, and that is the FastAPI process we use. Adding a *second* Python
service purely to proxy it would introduce a Python toolchain into a repository
whose kernel, tests and typecheck are all Node — for no architectural gain. The
service is therefore TypeScript with zero runtime dependencies (`node:http`),
and CosyVoice keeps its own FastAPI deployment.

### Caching

Content-addressed and version-aware. The key is
`sha256(normalisedText, language, voice, speed, provider, providerVersion,
modelVersion, format)`. Changing the model, voice, speed, adapter or output
format therefore produces a different entry — stale audio can never be served
for new settings. The key doubles as the public `audioId`, so the browser is
handed a content address rather than a path.

Lookup is **cache-first**, which is precisely what makes previously generated
speech work when the engine (or the network) is gone.

## Alternatives considered

- **A paid TTS API** — rejected outright: violates the free/self-hosted
  requirement and would send learner text to a third party.
- **Browser `SpeechSynthesis`** — free, but voice quality and availability vary
  per device, it cannot be cached or version-pinned, and it gives no provenance
  to record. Kept as a possible last-resort fallback, not the design.
- **Letting the PWA call CosyVoice directly** — rejected: it would expose the
  engine to the browser, prevent server-side caching and provenance stamping,
  and put an engine-shaped dependency in the client.
- **Treating high-quality synthetic audio as canonical** — rejected. It is the
  one thing the spec never permits, and it would corrupt every listening and
  pronunciation judgement downstream.

## Consequences

- Generated speech is available for arbitrary text, offline once cached, at zero
  operating cost.
- The canonical-audio gate is untouched: `isCanonical()` still requires a
  non-synthetic, QA-verified clip, and `runAudioQa` rejects any synthetic asset
  outright, however good its measured signal.
- **Stage 2 is not advanced by this work.** The plain receptive gate still
  requires real licensed human recordings; CosyVoice is an additional provider,
  not a substitute.
- Swapping engines (MeloTTS, Piper, a future CosyVoice) means writing another
  adapter behind `SyntheticSpeechProvider` and changing no learning code.

## Specification impact

Implements the SYNTHETIC FALLBACK clause (p.21) and the replaceable provider
interfaces (p.23, p.25) without weakening the AUDIO RULE (p.7), the canonical
audio gate (p.6 gate 5, p.21) or Rule 6 (human audio is canonical).
