/**
 * Cloud text-to-speech — the last tier, and the one with the most rules on it.
 *
 * The pronunciation chain is:
 *
 *     local CosyVoice → device Mandarin voice → THIS → nothing
 *
 * It exists for the device that has neither: a locked-down Android with no
 * Chinese voice pack, a desktop Linux browser with no zh-CN speech-dispatcher
 * voice, a kiosk. On such a device the first two tiers genuinely cannot make a
 * sound, and the choice is this or silence.
 *
 * WHY THE BROWSER CANNOT DO THIS ITSELF. The deployment's CSP is
 * `connect-src 'self'`. That is not an accident to be relaxed for a feature: it
 * is what guarantees this app talks to nobody. So the browser asks THIS
 * endpoint, and the endpoint is the only thing that ever contacts an upstream.
 * The learner's text never reaches a third party from their own IP, and their
 * browser never learns the upstream exists.
 *
 * OFF UNLESS CONFIGURED, AND NO DEFAULT ENDPOINT. The brief for the speech stack
 * was explicit: no paid API, no hardcoded cloud endpoint, no API keys. So there
 * is no built-in provider. `DYR_CLOUD_TTS_URL` names one — a self-hosted
 * CosyVoice/Piper/MeloTTS on a public host, or any service that returns audio
 * bytes for a text query — and with it unset this tier reports itself
 * unavailable and the chain simply ends one step earlier.
 *
 * Picking a default would have meant either a metered service (banned) or an
 * undocumented free endpoint like Google Translate's TTS, which is not offered
 * as an API, is against its terms to use as one, and could be withdrawn without
 * notice. Shipping that as the silent default would have been a bad trade made
 * on someone else's behalf.
 *
 * AND IT IS STILL SYNTHETIC. Same constitutional position as the other two tiers
 * (spec p.21): never canonical, never the cue for an audio-primary task, never
 * evidence, always labelled. Nothing here can change that — the canonical gate
 * accepts only `sourceType: "human"`.
 */
import { createHash } from "node:crypto";

/** Longest text accepted, matching the local service's own bound. */
export const MAX_TEXT = 500;

/** How long a generated clip may be cached. It is deterministic, so: forever. */
export const CACHE_SECONDS = 31_536_000;

export interface CloudTtsConfig {
  /** Upstream endpoint. `{text}` and `{lang}` are substituted if present. */
  url: string;
  /** What the upstream returns, so the browser is told the truth. */
  mediaType: string;
}

export type CloudConfigResult =
  | { ok: true; config: CloudTtsConfig }
  | { ok: false; reason: string };

/**
 * Hostnames that would mean this tier had quietly become a metered service.
 *
 * The same list the local speech service refuses (`apps/service/src/config.ts`),
 * for the same reason: a misconfiguration should stop the feature rather than
 * start billing someone. Duplicated deliberately — that file is a Node service
 * the serverless function cannot import, and a security list is better copied
 * than weakened by a shared-module workaround.
 */
export const PAID_SPEECH_HOSTS = [
  "googleapis.com",
  "cognitiveservices.azure.com",
  "api.openai.com",
  "api.elevenlabs.io",
  "polly.amazonaws.com",
  "speech.platform.bing.com",
  "api.play.ht",
  "api.deepgram.com",
  "api.assemblyai.com",
];

export function resolveCloudTts(env: Record<string, string | undefined> = process.env): CloudConfigResult {
  const url = env.DYR_CLOUD_TTS_URL;
  if (!url) return { ok: false, reason: "DYR_CLOUD_TTS_URL is not set for this deployment" };

  let host: string;
  let protocol: string;
  try {
    const parsed = new URL(url.replace("{text}", "x").replace("{lang}", "zh-CN"));
    host = parsed.hostname.toLowerCase();
    protocol = parsed.protocol;
  } catch {
    return { ok: false, reason: "DYR_CLOUD_TTS_URL is not a valid URL" };
  }

  // http:// would send the learner's text in the clear.
  if (protocol !== "https:" && host !== "localhost" && host !== "127.0.0.1") {
    return { ok: false, reason: "DYR_CLOUD_TTS_URL must use https" };
  }
  for (const paid of PAID_SPEECH_HOSTS) {
    if (host === paid || host.endsWith(`.${paid}`)) {
      return { ok: false, reason: `refusing ${host}: this tier is self-hosted and free by design` };
    }
  }

  return { ok: true, config: { url, mediaType: env.DYR_CLOUD_TTS_MEDIA_TYPE ?? "audio/mpeg" } };
}

/** Build the upstream request URL for some text. */
export function upstreamUrl(config: CloudTtsConfig, text: string): string {
  const encoded = encodeURIComponent(text);
  if (config.url.includes("{text}")) {
    return config.url.replace("{text}", encoded).replace("{lang}", "zh-CN");
  }
  // No placeholder: append conventionally, so a plain endpoint works unmodified.
  const separator = config.url.includes("?") ? "&" : "?";
  return `${config.url}${separator}text=${encoded}&lang=zh-CN`;
}

/**
 * The clip's identity: the text and nothing else.
 *
 * Used as an ETag so a repeated request for the same word is answered from the
 * CDN rather than regenerated. Deliberately not the text itself in a header —
 * that would put what the learner is studying into every proxy log on the path.
 */
export const clipId = (text: string): string =>
  createHash("sha256").update(`dyr-cloud-tts:${text}`).digest("hex").slice(0, 32);

// ---------------------------------------------------------------------------

type Req = { method?: string; url?: string; headers: Record<string, string | string[] | undefined> };
type Res = {
  status: (code: number) => Res;
  setHeader: (k: string, v: string) => void;
  json: (body: unknown) => void;
  send: (body: unknown) => void;
};

export default async function handler(req: Req, res: Res): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const config = resolveCloudTts();

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.setHeader("Cache-Control", "no-store");
    res.status(405).json({ ok: false, error: `method ${req.method} not allowed` });
    return;
  }

  // The readiness probe. Answers without contacting the upstream, so the app can
  // decide whether to offer playback at all without paying for a round trip.
  if (url.searchParams.get("action") === "health") {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      ok: true,
      configured: config.ok,
      ...(config.ok ? { mediaType: config.config.mediaType } : { reason: config.reason }),
    });
    return;
  }

  if (!config.ok) {
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ ok: false, configured: false, error: config.reason });
    return;
  }

  const text = (url.searchParams.get("text") ?? "").trim();
  if (text.length === 0) {
    res.setHeader("Cache-Control", "no-store");
    res.status(400).json({ ok: false, error: "no text" });
    return;
  }
  if (text.length > MAX_TEXT) {
    res.setHeader("Cache-Control", "no-store");
    res.status(400).json({ ok: false, error: "text is too long" });
    return;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const upstream = await fetch(upstreamUrl(config.config, text), {
      signal: controller.signal,
      headers: { accept: "audio/*" },
    }).finally(() => clearTimeout(timer));

    if (!upstream.ok) throw new Error(`upstream returned ${upstream.status}`);
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (bytes.length === 0) throw new Error("upstream returned no audio");

    // Deterministic output, so it is cacheable forever and immutable. The
    // learner's word never appears in a URL a CDN logs — only its hash.
    res.setHeader("Content-Type", config.config.mediaType);
    res.setHeader("Cache-Control", `public, max-age=${CACHE_SECONDS}, immutable`);
    res.setHeader("ETag", `"${clipId(text)}"`);
    res.status(200).send(bytes);
  } catch (error) {
    // The upstream's host and error never reach the client; a failed tier means
    // the learner hears nothing, which the UI already handles calmly.
    console.error("cloud tts failed:", error instanceof Error ? error.message : error);
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ ok: false, configured: true, error: "speech could not be generated" });
  }
}
