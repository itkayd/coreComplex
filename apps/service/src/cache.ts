/**
 * Deterministic, version-aware speech cache.
 *
 * The cache key is a content address over everything that can change the audio:
 * normalised text, language, voice, speed, provider, adapter version, model
 * version and output format. Two consequences follow, both required:
 *
 *   - identical requests reuse the cached clip instead of re-synthesising;
 *   - changing the MODEL, VOICE, SPEED or ADAPTER produces a different key, so
 *     stale audio can never be served for new settings.
 *
 * Entries are content-addressed, so `audioId` is safe to hand to a browser: it
 * reveals no filesystem path and cannot be used for traversal.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { SyntheticProvenance } from "@dyr/senses";

export interface CacheKeyInput {
  text: string;
  language: string;
  voice: string;
  speed: number;
  provider: string;
  providerVersion: string;
  modelVersion: string;
  format: string;
}

export interface CacheEntryMeta {
  audioId: string;
  mimeType: string;
  durationMs?: number;
  speedApplied: boolean;
  provenance: SyntheticProvenance;
  /** Byte length of the stored audio. */
  bytes: number;
  storedAt: number;
}

/**
 * Normalise text so that trivially-different requests share a cache entry, while
 * anything that changes pronunciation or prosody (including punctuation) still
 * produces a distinct key.
 */
export function normaliseText(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/g, " ");
}

/** Content address over every parameter that can change the generated audio. */
export function cacheKey(input: CacheKeyInput): string {
  const canonical = JSON.stringify([
    normaliseText(input.text),
    input.language,
    input.voice,
    // Fixed precision so 1.0 and 1.00 are the same key, 1.0 and 1.1 are not.
    Number(input.speed).toFixed(3),
    input.provider,
    input.providerVersion,
    input.modelVersion,
    input.format,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export class SpeechCache {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private audioPath(audioId: string, ext: string): string {
    return join(this.dir, `${audioId}.${ext}`);
  }
  private metaPath(audioId: string): string {
    return join(this.dir, `${audioId}.json`);
  }

  /** Ids are hex sha256 — reject anything else before touching the filesystem. */
  static isValidId(audioId: string): boolean {
    return /^[a-f0-9]{64}$/.test(audioId);
  }

  read(audioId: string): { meta: CacheEntryMeta; audio: Uint8Array } | undefined {
    if (!SpeechCache.isValidId(audioId)) return undefined;
    const metaFile = this.metaPath(audioId);
    if (!existsSync(metaFile)) return undefined;
    const meta = JSON.parse(readFileSync(metaFile, "utf8")) as CacheEntryMeta;
    const ext = meta.mimeType === "audio/ogg" ? "ogg" : "wav";
    const audioFile = this.audioPath(audioId, ext);
    if (!existsSync(audioFile)) return undefined;
    return { meta, audio: new Uint8Array(readFileSync(audioFile)) };
  }

  has(audioId: string): boolean {
    return this.read(audioId) !== undefined;
  }

  write(audioId: string, audio: Uint8Array, meta: Omit<CacheEntryMeta, "audioId" | "bytes" | "storedAt">, storedAt: number): CacheEntryMeta {
    const ext = meta.mimeType === "audio/ogg" ? "ogg" : "wav";
    const full: CacheEntryMeta = { ...meta, audioId, bytes: audio.length, storedAt };
    writeFileSync(this.audioPath(audioId, ext), audio);
    writeFileSync(this.metaPath(audioId), JSON.stringify(full, null, 2), "utf8");
    return full;
  }

  /**
   * Drop entries older than `maxAgeMs` (privacy: generated learner text is not
   * kept indefinitely — spec's voice-privacy posture applied to generated audio).
   */
  prune(maxAgeMs: number, now: number): number {
    let removed = 0;
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".json")) continue;
      const path = join(this.dir, file);
      const age = now - statSync(path).mtimeMs;
      if (age <= maxAgeMs) continue;
      const audioId = file.replace(/\.json$/, "");
      try {
        const meta = JSON.parse(readFileSync(path, "utf8")) as CacheEntryMeta;
        const ext = meta.mimeType === "audio/ogg" ? "ogg" : "wav";
        if (existsSync(this.audioPath(audioId, ext))) unlinkSync(this.audioPath(audioId, ext));
      } catch {
        /* metadata unreadable; still drop the descriptor below */
      }
      unlinkSync(path);
      removed++;
    }
    return removed;
  }
}
