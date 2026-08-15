/**
 * A synthesised WAV that exercises the audio plumbing without pretending to be
 * speech.
 *
 * Its ONLY purpose is to prove the byte path: ingest → hash → certify → bundle →
 * fetch → verify → decode → play. It is generated, not recorded, so every asset
 * built from it carries `provenance.fixture: true` and the production pack build
 * refuses it outright (`AudioRefused`). It cannot become canonical audio, and the
 * 60/60 canonical gate is not affected by its existence.
 *
 * The waveform is shaped only enough to pass objective signal screening — that
 * screening measures technical usability, and a file that failed it would test
 * the rejection path instead of the delivery path. Passing it still says nothing
 * about being human, which is exactly the distinction the review step enforces.
 */

export interface FixtureWavOptions {
  sampleRate?: number;
  /** Number of syllable-like bursts. */
  syllables?: number;
  /** Duration of each burst, ms. */
  syllableMs?: number;
  /** Base frequency, Hz. */
  baseHz?: number;
}

/**
 * Build a PCM16 mono WAV: `syllables` amplitude-enveloped harmonic bursts with
 * short gaps, at a level that leaves headroom (no clipping) and a noise floor
 * far enough below the signal to clear the SNR threshold.
 */
export function makeFixtureWav(opts: FixtureWavOptions = {}): Uint8Array {
  const sampleRate = opts.sampleRate ?? 16000;
  const syllables = opts.syllables ?? 2;
  const syllableMs = opts.syllableMs ?? 320;
  const baseHz = opts.baseHz ?? 180;
  const gapMs = 60;

  const perSyllable = Math.round((syllableMs / 1000) * sampleRate);
  const perGap = Math.round((gapMs / 1000) * sampleRate);
  const total = syllables * perSyllable + (syllables - 1) * perGap;
  const samples = new Float32Array(total);

  // A deterministic low-level dither stands in for a real room floor; a
  // mathematically silent background would make the SNR meaningless.
  let seed = 0x2545f491;
  const noise = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) / 0xffffffff - 0.5) * 0.0009;
  };

  let cursor = 0;
  for (let s = 0; s < syllables; s++) {
    const f0 = baseHz * (1 + 0.12 * s);
    for (let i = 0; i < perSyllable; i++) {
      const t = i / sampleRate;
      const progress = i / perSyllable;
      // Raised-cosine envelope: no click at the edges, no full-scale plateau.
      const envelope = 0.5 - 0.5 * Math.cos(2 * Math.PI * Math.min(progress, 1));
      const harmonics =
        Math.sin(2 * Math.PI * f0 * t)
        + 0.5 * Math.sin(2 * Math.PI * f0 * 2 * t)
        + 0.25 * Math.sin(2 * Math.PI * f0 * 3 * t);
      samples[cursor++] = 0.42 * envelope * (harmonics / 1.75) + noise();
    }
    if (s < syllables - 1) for (let i = 0; i < perGap; i++) samples[cursor++] = noise();
  }

  return encodePcm16Wav(samples, sampleRate);
}

/** Minimal canonical PCM16 mono WAV encoder — deterministic byte-for-byte. */
export function encodePcm16Wav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);      // PCM fmt chunk size
  view.setUint16(20, 1, true);       // format: PCM integer
  view.setUint16(22, 1, true);       // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);       // block align
  view.setUint16(34, 16, true);      // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return new Uint8Array(buffer);
}
