/**
 * Cloudflare Workers AI (MeloTTS), from the browser's side.
 *
 * It talks to same-origin `/api/tts` and nothing else. It does not know the
 * provider's name, its URL, or that a token exists — all of which live in the
 * serverless function. That is what keeps `connect-src 'self'` true and the
 * credential off every client bundle.
 *
 * CACHING, AND WHY IT IS NOT A PARALLEL SYSTEM. Generation costs a round trip
 * and a Workers AI request, and the bytes for a given word never change, so a
 * word should be generated once per device and then replayed locally. The app
 * already caches through the Cache API (the shell and the pack recordings both
 * live there), so this uses the same store rather than inventing another.
 *
 * The wrinkle: the endpoint is a POST, and the Cache API can only key on GET.
 * So the cache key is a SYNTHETIC GET URL — `/__tts/<sha256>` — that is never
 * actually fetched. It exists solely as a stable identity for the bytes, which
 * is precisely what a content-addressed key is. The hash covers text, model,
 * language and adapter version, so a model or adapter change cannot replay stale
 * audio; speed is excluded because it is applied with `playbackRate`, so one
 * clip serves every rate instead of one per rate.
 *
 * The service worker is told to preserve that cache across activation
 * (`apps/web/public/sw.js`); without that it would be deleted on every update
 * and the cache would quietly do nothing.
 *
 * Failures are never cached. A cached 502 would be indistinguishable from a
 * cached clip and would make a transient outage permanent.
 */

const ENDPOINT = `${import.meta.env.BASE_URL}api/tts`;

/** Bumping this invalidates every clip cached by an older client. */
export const CLIENT_ADAPTER_VERSION = "dyr-melotts-client@1.0.0";
export const CACHE_NAME = "dyr-tts-v1";
export const MODEL = "@cf/myshell-ai/melotts";
/** Must match `KEY_SEPARATOR` in api/tts.ts — see the note there. */
export const KEY_SEPARATOR = "\u0000";

export interface CloudVoiceStatus {
  available: boolean;
  model?: string;
  reason?: string;
}

let probed: Promise<CloudVoiceStatus> | undefined;

/**
 * Is this tier configured for the deployment?
 *
 * Cached: the Words screen asks for hundreds of rows and the answer cannot
 * change between them. Any failure answers "no" rather than throwing — an
 * unconfigured deployment, a preview with no functions and an offline phone are
 * all the same thing from here.
 */
export function cloudVoiceStatus(): Promise<CloudVoiceStatus> {
  probed ??= (async () => {
    try {
      const res = await fetch(`${ENDPOINT}?action=health`, { credentials: "same-origin" });
      if (!res.ok) return { available: false };
      const body = await res.json() as Record<string, unknown>;
      return {
        available: body.configured === true,
        model: typeof body.model === "string" ? body.model : undefined,
        reason: typeof body.reason === "string" ? body.reason : undefined,
      };
    } catch {
      return { available: false };
    }
  })();
  return probed;
}

export function resetCloudVoiceCache(): void {
  probed = undefined;
}

export class CloudVoiceUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudVoiceUnavailable";
  }
}

/**
 * The cache key for some text.
 *
 * Mirrors `clipKey` in `api/tts.ts` in what it covers, but is computed
 * independently here — the client cannot import a server module, and a shared
 * key that silently diverged would be worse than two that are each explicit
 * about their inputs. Web Crypto is used because it is the only digest a browser
 * has; it is async, which is why this returns a promise.
 */
export async function clipKey(text: string): Promise<string> {
  const material = [text.normalize("NFC"), MODEL, "zh", CLIENT_ADAPTER_VERSION].join(KEY_SEPARATOR);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const cacheUrl = (key: string): string => `${import.meta.env.BASE_URL}__tts/${key}`;

async function store(): Promise<Cache | undefined> {
  if (typeof caches === "undefined") return undefined;
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return undefined;
  }
}

export interface CloudClip {
  objectUrl: string;
  fromCache: boolean;
}

/**
 * Fetch (or replay) a generated clip.
 *
 * A cache hit costs no network at all, which is what makes this tier usable
 * offline for words already heard — and offline capability matters most on
 * exactly the devices this tier serves, since they are the ones with no local
 * voice of their own.
 */
export async function fetchCloudClip(text: string, speed: number): Promise<CloudClip> {
  const key = await clipKey(text);
  const url = cacheUrl(key);
  const cache = await store();

  const hit = await cache?.match(url).catch(() => undefined);
  if (hit) {
    return { objectUrl: URL.createObjectURL(await hit.blob()), fromCache: true };
  }

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, speed }),
    });
  } catch {
    throw new CloudVoiceUnavailable("could not reach the speech service");
  }

  if (!res.ok) {
    // Deliberately not cached: a stored failure would outlive the outage that
    // caused it and make a transient problem permanent.
    throw new CloudVoiceUnavailable(
      res.status === 503 ? "no cloud voice is configured for this deployment"
        : res.status === 504 ? "speech generation timed out"
          : "speech could not be generated",
    );
  }

  const blob = await res.blob();
  if (blob.size === 0) throw new CloudVoiceUnavailable("the generated clip was empty");

  // Stored under the synthetic key, not the POST, so it can be found again.
  await cache?.put(url, new Response(blob, {
    headers: { "content-type": blob.type || "audio/mpeg" },
  })).catch(() => undefined);

  return { objectUrl: URL.createObjectURL(blob), fromCache: false };
}
