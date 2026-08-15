import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_THRESHOLDS,
  analyseSignal,
  decodeWav,
  screenAudio,
  runAudioQa,
  declareAudio,
  isCanonical,
  type PcmAudio,
} from "./index.ts";

const RATE = 16000;

/** Build a 16-bit mono WAV so the decoder is exercised on real bytes. */
function wav(samples: Float32Array, sampleRate = RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (o: number, s: string) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
  ascii(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); ascii(8, "WAVE");
  ascii(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return bytes;
}

/** A speech-like burst: amplitude-modulated tone with a quiet noise floor. */
function utterance(opts: { ms: number; amplitude?: number; noise?: number; leadMs?: number; tailMs?: number }): Float32Array {
  const amp = opts.amplitude ?? 0.5;
  const noise = opts.noise ?? 0.0005;
  const lead = Math.floor((opts.leadMs ?? 40) * RATE / 1000);
  const tail = Math.floor((opts.tailMs ?? 40) * RATE / 1000);
  const body = Math.floor(opts.ms * RATE / 1000);
  const out = new Float32Array(lead + body + tail);
  // Deterministic pseudo-noise — no Math.random, so tests are reproducible.
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; };
  for (let i = 0; i < out.length; i++) out[i] = rnd() * noise;
  for (let i = 0; i < body; i++) {
    const t = i / RATE;
    const envelope = Math.sin((Math.PI * i) / body); // fade in/out like a syllable
    out[lead + i] += Math.sin(2 * Math.PI * 180 * t) * amp * envelope;
  }
  return out;
}

const pcm = (samples: Float32Array, rate = RATE): PcmAudio => decodeWav(wav(samples, rate));

test("decodeWav round-trips PCM16 samples", () => {
  const audio = pcm(utterance({ ms: 300 }));
  assert.equal(audio.sampleRate, RATE);
  assert.equal(audio.channels, 1);
  assert.ok(audio.samples.length > 0);
});

test("analysis measures duration, peak and a quiet noise floor", () => {
  const m = analyseSignal(pcm(utterance({ ms: 400, amplitude: 0.5 })));
  assert.ok(Math.abs(m.durationMs - 480) < 25, `duration ~480ms, got ${m.durationMs}`);
  assert.ok(m.peak > 0.4 && m.peak <= 1, `peak ${m.peak}`);
  assert.ok(m.signalToNoiseDb > 20, `SNR should be high for a clean clip, got ${m.signalToNoiseDb}`);
});

test("a clean single-syllable clip passes objective screening", () => {
  const r = screenAudio(pcm(utterance({ ms: 400 })), { syllables: 1 });
  assert.equal(r.passed, true, `unexpected failures: ${r.failures.join(",")}`);
});

test("CLIPPING is detected and rejected", () => {
  // Drive the signal well past full scale so samples pin at ±1.
  const r = screenAudio(pcm(utterance({ ms: 400, amplitude: 3 })), { syllables: 1 });
  assert.equal(r.passed, false);
  assert.ok(r.failures.includes("clipping_detected"), r.failures.join(","));
  assert.ok(r.metrics.clippedRatio > 0);
});

test("a buried, noisy recording is rejected on noise floor", () => {
  const r = screenAudio(pcm(utterance({ ms: 400, amplitude: 0.05, noise: 0.05 })), { syllables: 1 });
  assert.equal(r.passed, false);
  assert.ok(r.failures.includes("noise_floor_too_high"), r.failures.join(","));
});

test("a clip that is mostly silence is rejected", () => {
  const r = screenAudio(pcm(utterance({ ms: 40, leadMs: 1200, tailMs: 1200 })), { syllables: 1 });
  assert.equal(r.passed, false);
  assert.ok(r.failures.some((f) => f === "mostly_silence" || f === "excessive_edge_silence"), r.failures.join(","));
});

test("duration is screened against the transcript's syllable count (pace proxy)", () => {
  const clip = pcm(utterance({ ms: 400 })); // plausible for 1 syllable
  assert.equal(screenAudio(clip, { syllables: 1 }).passed, true);
  // The same 400ms cannot plausibly contain eight syllables.
  const many = screenAudio(clip, { syllables: 8 });
  assert.equal(many.passed, false);
  assert.ok(many.failures.includes("duration_implausible_for_transcript"));
});

test("a low sample rate is rejected", () => {
  const r = screenAudio(pcm(utterance({ ms: 400 }), 8000), { syllables: 1 }, DEFAULT_THRESHOLDS);
  assert.equal(r.passed, false);
  assert.ok(r.failures.includes("sample_rate_too_low"));
});

// ---- Gate integration -----------------------------------------------------

const declared = (o: Partial<Parameters<typeof runAudioQa>[0]> = {}) => ({
  asset: { ...declareAudio("bank.n.01", "银行"), sha256: "a".repeat(64) },
  humanRecorded: true,
  transcriptMatches: true,
  segmentationVerified: true,
  clean: true,
  naturalPace: true,
  licenceAndConsentClear: true,
  ...o,
});

test("an UNSCREENED clip cannot reach canonical, however good the claims", () => {
  const result = runAudioQa(declared());
  assert.equal(result.state, "unverified");
  assert.equal(result.screened, false);
  assert.ok(result.failures.includes("not_screened"));
  assert.equal(isCanonical({ ...declared().asset, state: result.state }), false);
});

test("measurement OVERRIDES a false 'clean' claim", () => {
  // The submitter asserts the clip is clean; the signal says it clips.
  const screening = screenAudio(pcm(utterance({ ms: 400, amplitude: 3 })), { syllables: 2 });
  const result = runAudioQa(declared({ clean: true, naturalPace: true, screening }));
  assert.equal(result.state, "rejected");
  assert.ok(result.failures.some((f) => f.startsWith("signal:clipping_detected")), result.failures.join(","));
});

test("a screened, human-verified clip becomes canonical", () => {
  const screening = screenAudio(pcm(utterance({ ms: 700 })), { syllables: 2 }); // 银行 = 2 syllables
  assert.equal(screening.passed, true, screening.failures.join(","));
  const result = runAudioQa(declared({ screening }));
  assert.equal(result.state, "verified");
  assert.deepEqual(result.failures, []);
  assert.equal(isCanonical({ ...declared().asset, state: result.state }), true);
});

test("screening can never rescue a synthetic clip (spec p.21)", () => {
  const screening = screenAudio(pcm(utterance({ ms: 700 })), { syllables: 2 });
  const result = runAudioQa(declared({ asset: { ...declared().asset, synthetic: true }, screening }));
  assert.equal(result.state, "rejected");
  assert.ok(result.failures.includes("synthetic_cannot_be_canonical"));
});

test("screening is deterministic", () => {
  const a = screenAudio(pcm(utterance({ ms: 400 })), { syllables: 1 });
  const b = screenAudio(pcm(utterance({ ms: 400 })), { syllables: 1 });
  assert.deepEqual(a, b);
});
