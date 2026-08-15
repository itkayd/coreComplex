/**
 * Service entry point. Starts the local speech API.
 *
 * Everything is self-hosted: this process talks to a CosyVoice server running
 * on the same machine and to nothing else. No API key, no account, no metering.
 */
import { loadConfig } from "./config.ts";
import { SpeechCache } from "./cache.ts";
import { CosyVoiceProvider } from "./providers/cosyvoice.ts";
import { SpeechService, createSpeechServer } from "./service.ts";

const config = loadConfig();
const provider = new CosyVoiceProvider({
  baseUrl: config.cosyvoiceUrl,
  modelVersion: config.modelVersion,
  defaultVoice: config.defaultVoice,
  sampleRate: config.sampleRate,
  maxTextLength: config.maxTextLength,
  requestTimeoutMs: config.requestTimeoutMs,
});
const service = new SpeechService({ config, provider, cache: new SpeechCache(config.cacheDir) });

createSpeechServer(service, config).listen(config.port, () => {
  console.log(`dyr speech service   http://127.0.0.1:${config.port}`);
  console.log(`  cosyvoice          ${config.cosyvoiceUrl}`);
  console.log(`  model              ${config.modelVersion}`);
  console.log(`  cache              ${config.cacheDir}`);
  console.log(`  format             ${config.outputFormat}`);
  console.log(`  synthetic only     generated speech can never be canonical audio`);
});
