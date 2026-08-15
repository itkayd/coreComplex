/**
 * Resolving and verifying canonical audio in the browser.
 *
 * Two jobs, both narrow:
 *
 *   1. Turn a TaskContract's asset reference into a URL. The pack stores a
 *      pack-relative, content-addressed path; the base URL is supplied by the
 *      app. No filesystem path from the build machine ever reaches the client,
 *      and the URL carries no lexeme id, so a cached request cannot leak which
 *      word a listening task is about.
 *
 *   2. Verify the bytes before they are played. The pack's JSON hash covers the
 *      audio hashes, so a correct pack proves what the recording SHOULD be — but
 *      a cache or CDN can still hand back different bytes. Re-hashing at the
 *      point of use is what turns that promise into a check.
 *
 * Browser-safe: Web Crypto only, no Node built-ins.
 */
import type { AudioAsset } from "./audio.ts";
import { webCryptoSha256Bytes } from "./validate.ts";
import type { RuntimePack } from "./runtime.ts";

/** `audio:<lexemeId>` → the lexeme id, or undefined if this is not an audio ref. */
export function lexemeFromAudioRef(ref: string): string | undefined {
  return ref.startsWith("audio:") ? ref.slice("audio:".length) : undefined;
}

/**
 * Resolve the canonical asset a task's assetRefs name.
 *
 * The UI never chooses a recording: the planner issues the contract, this
 * resolves exactly what the contract asked for, and only a verified,
 * non-synthetic asset with runtime bytes qualifies.
 */
export function resolveCanonicalAudio(pack: RuntimePack, assetRefs: readonly string[]): AudioAsset | undefined {
  for (const ref of assetRefs) {
    const lexeme = lexemeFromAudioRef(ref);
    if (!lexeme) continue;
    const asset = pack.audio.get(lexeme);
    if (asset && asset.state === "verified" && asset.synthetic !== true && asset.runtime) return asset;
  }
  return undefined;
}

/** Pack-relative runtime path → absolute URL, resolved against the pack's folder. */
export function audioUrl(packBaseUrl: string, asset: AudioAsset): string {
  if (!asset.runtime) throw new Error(`audio asset ${asset.id} has no runtime reference`);
  const base = packBaseUrl.endsWith("/") ? packBaseUrl : `${packBaseUrl}/`;
  return `${base}${asset.runtime.path}`;
}

export type AudioLoadFailure = "unavailable" | "hash_mismatch" | "no_runtime_reference";

export type AudioLoadResult =
  | { ok: true; blobUrl: string; bytes: number; revoke: () => void }
  | { ok: false; failure: AudioLoadFailure; detail: string };

/**
 * Fetch, verify and prepare a recording for playback.
 *
 * A failure here must NOT be smoothed over: an unplayable or tampered recording
 * means the listening task cannot be attempted, and the caller is expected to
 * refuse the task rather than collect an answer that would become retrieval
 * evidence about audio the learner never heard.
 */
export async function loadCanonicalAudio(
  url: string,
  asset: AudioAsset,
  fetchImpl: typeof fetch = fetch,
): Promise<AudioLoadResult> {
  if (!asset.runtime) return { ok: false, failure: "no_runtime_reference", detail: `${asset.id} declares no runtime bytes` };

  let bytes: ArrayBuffer;
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return { ok: false, failure: "unavailable", detail: `HTTP ${response.status}` };
    bytes = await response.arrayBuffer();
  } catch (error) {
    return { ok: false, failure: "unavailable", detail: (error as Error).message };
  }

  const actual = await webCryptoSha256Bytes(bytes);
  if (actual !== asset.runtime.sha256) {
    return {
      ok: false,
      failure: "hash_mismatch",
      detail: `expected ${asset.runtime.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…`,
    };
  }

  const blob = new Blob([bytes], { type: asset.runtime.mediaType });
  const blobUrl = URL.createObjectURL(blob);
  return { ok: true, blobUrl, bytes: bytes.byteLength, revoke: () => URL.revokeObjectURL(blobUrl) };
}

/** Every runtime audio URL in a pack — what the service worker is asked to cache. */
export function packAudioUrls(pack: RuntimePack, packBaseUrl: string): string[] {
  const urls = new Set<string>();
  for (const asset of pack.audio.values()) {
    if (asset.state === "verified" && asset.synthetic !== true && asset.runtime) urls.add(audioUrl(packBaseUrl, asset));
  }
  return [...urls].sort();
}
