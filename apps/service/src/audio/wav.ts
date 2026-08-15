/**
 * WAV framing for CosyVoice output.
 *
 * CosyVoice's FastAPI server streams HEADERLESS PCM: its `generate_data()`
 * yields `(tts_speech.numpy() * 2**15).astype(np.int16).tobytes()`. Those bytes
 * are unplayable in a browser until they are framed, so the service wraps them
 * in a RIFF/WAVE header (and may then transcode to OGG/Opus).
 */

export interface PcmSpec {
  sampleRate: number;
  channels: number;
  bitsPerSample: 16;
}

export const COSYVOICE_PCM: Omit<PcmSpec, "sampleRate"> = { channels: 1, bitsPerSample: 16 };

/** Wrap raw little-endian PCM16 in a RIFF/WAVE container. */
export function pcm16ToWav(pcm: Uint8Array, spec: PcmSpec): Uint8Array {
  const { sampleRate, channels, bitsPerSample } = spec;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, "data");
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/** Duration of raw PCM16, in milliseconds. */
export function pcm16DurationMs(pcm: Uint8Array, sampleRate: number, channels = 1): number {
  const frames = pcm.length / 2 / channels;
  return Math.round((frames / sampleRate) * 1000);
}
