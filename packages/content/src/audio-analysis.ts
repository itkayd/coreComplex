/**
 * Objective audio signal analysis for the canonical-audio gate (spec p.21).
 *
 *   "Audio must be understandable, clean and transcript-aligned."
 *
 * The spec's audio gate mixes two very different kinds of claim:
 *
 *   MACHINE-CHECKABLE — clipping, severe noise, codec damage, usable duration
 *     and pace. These are measurements, and this module makes them, so the
 *     gate stops being an unverified checkbox.
 *
 *   HUMAN-VERIFIED — "this recording really says 银行", "this is Standard
 *     Mandarin", "the speaker consented". No measurement establishes these, so
 *     they stay explicit declarations (see runAudioQa) and are never inferred.
 *
 * Analysis is pure TypeScript over PCM: deterministic, dependency-free and
 * runnable in CI. Compressed sources (ogg/opus/mp3) are transcoded to WAV by an
 * external tool first — see `TRANSCODE_HINT`.
 */

export interface PcmAudio {
  sampleRate: number;
  channels: number;
  /** Interleaved samples normalised to [-1, 1]. */
  samples: Float32Array;
}

export interface SignalMetrics {
  sampleRate: number;
  channels: number;
  durationMs: number;
  /** Highest absolute sample, 0..1. */
  peak: number;
  /** Fraction of samples at or beyond full scale — the clipping signature. */
  clippedRatio: number;
  /** Overall loudness, dBFS. */
  rmsDbfs: number;
  /** Loudness of the quietest stretch, dBFS — the noise floor. */
  noiseFloorDbfs: number;
  /** rms − noiseFloor, dB. Low values mean speech is buried in noise. */
  signalToNoiseDb: number;
  leadingSilenceMs: number;
  trailingSilenceMs: number;
  /** Fraction of the clip that is above the silence threshold. */
  speechRatio: number;
}

/** Decode a PCM WAV (8/16/24/32-bit int or 32-bit float) into normalised samples. */
export function decodeWav(buffer: Uint8Array): PcmAudio {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const tag = (o: number) => String.fromCharCode(buffer[o], buffer[o + 1], buffer[o + 2], buffer[o + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a RIFF/WAVE file");

  let format = 1, channels = 1, sampleRate = 16000, bits = 16;
  let dataOffset = -1, dataLength = 0;

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === "data") {
      dataOffset = body;
      dataLength = size;
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  if (dataOffset < 0) throw new Error("WAV has no data chunk");

  const bytesPerSample = bits / 8;
  const count = Math.floor(dataLength / bytesPerSample);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const p = dataOffset + i * bytesPerSample;
    if (format === 3 && bits === 32) samples[i] = view.getFloat32(p, true);
    else if (bits === 8) samples[i] = (view.getUint8(p) - 128) / 128; // 8-bit WAV is unsigned
    else if (bits === 16) samples[i] = view.getInt16(p, true) / 32768;
    else if (bits === 24) {
      const v = (view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getInt8(p + 2) << 16));
      samples[i] = v / 8388608;
    } else if (bits === 32) samples[i] = view.getInt32(p, true) / 2147483648;
    else throw new Error(`unsupported WAV bit depth: ${bits}`);
  }
  return { sampleRate, channels, samples };
}

const dbfs = (amplitude: number): number =>
  amplitude <= 1e-9 ? -120 : Math.max(-120, 20 * Math.log10(amplitude));

function rms(samples: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i] * samples[i];
  const n = Math.max(1, to - from);
  return Math.sqrt(sum / n);
}

/** Measure a clip. Pure: identical input always yields identical metrics. */
export function analyseSignal(audio: PcmAudio): SignalMetrics {
  const { samples, sampleRate, channels } = audio;
  const frames = Math.floor(samples.length / channels);
  const durationMs = (frames / sampleRate) * 1000;

  let peak = 0;
  let clipped = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    if (a >= 0.999) clipped++;
  }

  // Window the clip and use the quietest windows as the noise floor.
  const windowLength = Math.max(1, Math.floor(sampleRate * 0.02) * channels); // 20 ms
  const windows: number[] = [];
  for (let start = 0; start + windowLength <= samples.length; start += windowLength) {
    windows.push(rms(samples, start, start + windowLength));
  }
  const overallRms = rms(samples, 0, samples.length);
  const sorted = [...windows].sort((a, b) => a - b);
  const quietCount = Math.max(1, Math.floor(sorted.length * 0.1));
  const noiseFloor = sorted.slice(0, quietCount).reduce((a, b) => a + b, 0) / quietCount;

  // Silence threshold relative to the clip's own peak, so quiet-but-clean
  // recordings are not mistaken for silence.
  const threshold = Math.max(peak * 0.06, 1e-4);
  let leadingWindows = 0;
  while (leadingWindows < windows.length && windows[leadingWindows] < threshold) leadingWindows++;
  let trailingWindows = 0;
  while (trailingWindows < windows.length - leadingWindows && windows[windows.length - 1 - trailingWindows] < threshold) trailingWindows++;
  const voiced = windows.filter((w) => w >= threshold).length;
  const windowMs = (windowLength / channels / sampleRate) * 1000;

  return {
    sampleRate,
    channels,
    durationMs: Number(durationMs.toFixed(2)),
    peak: Number(peak.toFixed(6)),
    clippedRatio: Number((clipped / Math.max(1, samples.length)).toFixed(6)),
    rmsDbfs: Number(dbfs(overallRms).toFixed(2)),
    noiseFloorDbfs: Number(dbfs(noiseFloor).toFixed(2)),
    signalToNoiseDb: Number((dbfs(overallRms) - dbfs(noiseFloor)).toFixed(2)),
    leadingSilenceMs: Number((leadingWindows * windowMs).toFixed(2)),
    trailingSilenceMs: Number((trailingWindows * windowMs).toFixed(2)),
    speechRatio: Number((voiced / Math.max(1, windows.length)).toFixed(4)),
  };
}

/** Thresholds for a single-word/short-phrase Mandarin pronunciation clip. */
export interface ScreeningThresholds {
  minSampleRate: number;
  maxClippedRatio: number;
  minSignalToNoiseDb: number;
  minSpeechRatio: number;
  /** Per-syllable duration band, ms — a screening proxy for natural pace. */
  msPerSyllable: { min: number; max: number };
  maxEdgeSilenceMs: number;
}

export const DEFAULT_THRESHOLDS: ScreeningThresholds = {
  minSampleRate: 16000,
  // Any full-scale samples at all indicate clipping on a single-word clip.
  maxClippedRatio: 0.0005,
  minSignalToNoiseDb: 15,
  minSpeechRatio: 0.15,
  msPerSyllable: { min: 120, max: 1200 },
  maxEdgeSilenceMs: 1500,
};

export type ScreeningCode =
  | "sample_rate_too_low"
  | "clipping_detected"
  | "noise_floor_too_high"
  | "mostly_silence"
  | "duration_implausible_for_transcript"
  | "excessive_edge_silence";

export interface ScreeningResult {
  passed: boolean;
  failures: ScreeningCode[];
  metrics: SignalMetrics;
}

/**
 * Objective screening. Passing means the recording is technically usable — it
 * does NOT mean the recording says the right word, which only a human (or a
 * separately-validated ASR with its own confidence policy) can establish.
 */
export function screenAudio(
  audio: PcmAudio,
  expected: { syllables: number },
  thresholds: ScreeningThresholds = DEFAULT_THRESHOLDS,
): ScreeningResult {
  const metrics = analyseSignal(audio);
  const failures: ScreeningCode[] = [];

  if (metrics.sampleRate < thresholds.minSampleRate) failures.push("sample_rate_too_low");
  if (metrics.clippedRatio > thresholds.maxClippedRatio) failures.push("clipping_detected");
  if (metrics.signalToNoiseDb < thresholds.minSignalToNoiseDb) failures.push("noise_floor_too_high");
  if (metrics.speechRatio < thresholds.minSpeechRatio) failures.push("mostly_silence");

  const syllables = Math.max(1, expected.syllables);
  const voicedMs = metrics.durationMs - metrics.leadingSilenceMs - metrics.trailingSilenceMs;
  const perSyllable = voicedMs / syllables;
  if (perSyllable < thresholds.msPerSyllable.min || perSyllable > thresholds.msPerSyllable.max) {
    failures.push("duration_implausible_for_transcript");
  }
  if (metrics.leadingSilenceMs > thresholds.maxEdgeSilenceMs || metrics.trailingSilenceMs > thresholds.maxEdgeSilenceMs) {
    failures.push("excessive_edge_silence");
  }

  return { passed: failures.length === 0, failures, metrics };
}

/**
 * Compressed sources must be transcoded to PCM WAV before screening. Kept as a
 * documented command rather than a hidden dependency, so the gate itself stays
 * pure and reproducible.
 */
export const TRANSCODE_HINT =
  "ffmpeg -i <clip.ogg> -ac 1 -ar 16000 -sample_fmt s16 <clip.wav>";
