/**
 * The browser half of the cloud tier.
 *
 * It talks to `/api/speech` and nothing else: same-origin, so the deployment's
 * `connect-src 'self'` CSP is untouched and the upstream provider is invisible
 * from here. This file does not know, and must not know, which service (if any)
 * generates the audio.
 *
 * CACHED ON THE DEVICE. The bytes are deterministic for a given word, so once a
 * word has been heard it replays with no network at all — which matters most
 * for exactly the devices this tier serves, since they are the ones with no
 * offline voice of their own. The Cache API entry is keyed by the request URL,
 * and the response already carries `immutable`.
 */

const ENDPOINT = `${import.meta.env.BASE_URL}api/speech`;
const CACHE = "dyr-cloud-speech-v1";

export interface CloudVoiceStatus {
  available: boolean;
  mediaType?: string;
  reason?: string;
}

let probed: Promise<CloudVoiceStatus> | undefined;

/**
 * Is a cloud tier configured for this deployment?
 *
 * Cached, because the Words screen asks for hundreds of rows and the answer
 * cannot change between them. Any failure answers "no" rather than throwing:
 * an unconfigured deployment, a static preview with no functions and an offline
 * phone are the same thing from here.
 */
export function cloudVoiceStatus(): Promise<CloudVoiceStatus> {
  probed ??= (async () => {
    try {
      const res = await fetch(`${ENDPOINT}?action=health`, { credentials: "same-origin" });
      if (!res.ok) return { available: false };
      const body = await res.json() as Record<string, unknown>;
      return {
        available: body.configured === true,
        mediaType: typeof body.mediaType === "string" ? body.mediaType : undefined,
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

export interface CloudClip {
  objectUrl: string;
  mediaType: string;
  fromCache: boolean;
}

/** Fetch (or replay) a generated clip for some Mandarin text. */
export async function fetchCloudClip(text: string): Promise<CloudClip> {
  const url = `${ENDPOINT}?text=${encodeURIComponent(text)}`;

  let store: Cache | undefined;
  try {
    store = typeof caches === "undefined" ? undefined : await caches.open(CACHE);
  } catch {
    store = undefined;
  }

  const cached = await store?.match(url).catch(() => undefined);
  if (cached) {
    return {
      objectUrl: URL.createObjectURL(await cached.blob()),
      mediaType: cached.headers.get("content-type") ?? "audio/mpeg",
      fromCache: true,
    };
  }

  let res: Response;
  try {
    res = await fetch(url, { credentials: "same-origin" });
  } catch {
    throw new CloudVoiceUnavailable("could not reach the speech service");
  }
  if (!res.ok) {
    throw new CloudVoiceUnavailable(
      res.status === 503 ? "no cloud voice is configured for this deployment" : "speech could not be generated",
    );
  }

  // Store before consuming: a clone is cheap and the offline replay is the point.
  await store?.put(url, res.clone()).catch(() => undefined);
  const blob = await res.blob();
  if (blob.size === 0) throw new CloudVoiceUnavailable("the generated clip was empty");

  return {
    objectUrl: URL.createObjectURL(blob),
    mediaType: res.headers.get("content-type") ?? "audio/mpeg",
    fromCache: false,
  };
}
