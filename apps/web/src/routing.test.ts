/**
 * Pronunciation routing: which provider speaks, and what happens when one lies.
 *
 * These are the scenarios that decide whether a learner hears anything. The
 * negative ones matter most — a provider that probes true and then fails, an
 * upstream that times out, a device whose only Chinese voice is the wrong
 * language — because each of those is a silent button rather than an error
 * anyone would notice.
 *
 * Fakes rather than mocks of the real providers: the point is to pin the CHAIN's
 * behaviour, and a fake that records what it was asked is a sharper instrument
 * than a stubbed `speechSynthesis`. The real providers are exercised in the
 * browser gate, which is where their platform quirks actually live.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  PronounceError, firstReady, prepareFrom,
  type Playable, type PronounceOptions, type PronunciationProvider, type PronunciationSourceId,
} from "./routing.ts";

interface Fake extends PronunciationProvider {
  probes: number;
  prepares: string[];
  plays: number;
}

/** A provider whose behaviour at each stage is chosen by the test. */
function fake(
  id: PronunciationSourceId,
  behaviour: { ready?: boolean; prepareFails?: boolean; playFails?: boolean; probeThrows?: boolean } = {},
): Fake {
  const provider: Fake = {
    id,
    source: { sourceType: "synthetic", provider: id, modelVersion: `${id}-model` },
    probes: 0,
    prepares: [],
    plays: 0,
    probe: async () => {
      provider.probes++;
      if (behaviour.probeThrows) throw new Error("probe exploded");
      return behaviour.ready ?? true;
    },
    prepare: async (text: string, opts: PronounceOptions): Promise<Playable> => {
      provider.prepares.push(text);
      if (behaviour.prepareFails) throw new Error(`${id} could not prepare`);
      return {
        description: `${id} (${opts.speed}x)`,
        play: async () => {
          provider.plays++;
          if (behaviour.playFails) throw new Error(`${id} failed at playback`);
        },
        stop: () => {},
        release: () => {},
      };
    },
  };
  return provider;
}

const OPTS: PronounceOptions = { speed: 1 };

// ---------------------------------------------------------------------------

test("SCENARIO A — CosyVoice available: nothing below it is even consulted", async () => {
  const cosy = fake("local-service");
  const device = fake("device-voice");
  const cloud = fake("cloud-voice");

  const result = await prepareFrom([cosy, device, cloud], "你好", OPTS);
  await result.play();

  assert.equal(result.source, "local-service");
  assert.equal(cosy.plays, 1);
  // The point of the order: a working local service costs no probe of the
  // device, and above all no Workers AI request.
  assert.equal(device.probes, 0, "the device voice must not be probed");
  assert.equal(cloud.probes, 0, "Cloudflare must not be probed");
  assert.deepEqual(cloud.prepares, [], "Cloudflare must not be requested");
});

test("SCENARIO B — no CosyVoice, device voice present: the cloud is not touched", async () => {
  const cosy = fake("local-service", { ready: false });
  const device = fake("device-voice");
  const cloud = fake("cloud-voice");

  const result = await prepareFrom([cosy, device, cloud], "你好", OPTS);
  await result.play();

  assert.equal(result.source, "device-voice");
  assert.equal(device.plays, 1);
  assert.equal(cloud.probes, 0, "a working device voice must not cost a cloud request");
  assert.deepEqual(cosy.prepares, [], "an unready provider must not be prepared");
});

test("SCENARIO C — no CosyVoice, no device voice: MeloTTS speaks", async () => {
  const cosy = fake("local-service", { ready: false });
  const device = fake("device-voice", { ready: false });
  const cloud = fake("cloud-voice");

  const result = await prepareFrom([cosy, device, cloud], "银行", OPTS);
  await result.play();

  assert.equal(result.source, "cloud-voice");
  assert.deepEqual(cloud.prepares, ["银行"], "the cloud must be asked for the right text");
  assert.equal(cloud.plays, 1);
  assert.equal(result.provenance.sourceType, "synthetic");
  assert.equal(result.provenance.provider, "cloud-voice");
});

test("SCENARIO D — a Cantonese-only device falls through to the cloud", async () => {
  // The device provider reports unready because `selectMandarinVoice` refuses
  // zh-HK outright: a Cantonese reading of a Mandarin word is a wrong answer
  // delivered with the same confidence as a right one. See voice-select.test.ts.
  const cosy = fake("local-service", { ready: false });
  const cantoneseOnly = fake("device-voice", { ready: false });
  const cloud = fake("cloud-voice");

  const result = await prepareFrom([cosy, cantoneseOnly, cloud], "谢谢", OPTS);
  await result.play();

  assert.equal(result.source, "cloud-voice");
  assert.deepEqual(cantoneseOnly.prepares, [], "a rejected voice must never be prepared");
  assert.deepEqual(cloud.prepares, ["谢谢"]);
});

test("SCENARIO E — every provider unavailable: a graceful, typed refusal", async () => {
  const providers = [
    fake("local-service", { ready: false }),
    fake("device-voice", { ready: false }),
    fake("cloud-voice", { ready: false }),
  ];

  await assert.rejects(
    () => prepareFrom(providers, "你好", OPTS),
    (error: unknown) => {
      assert.ok(error instanceof PronounceError);
      assert.equal(error.reason, "no_source");
      // The UI keys off `no_source` to explain rather than to show a dead button.
      assert.match(error.message, /no pronunciation source/);
      return true;
    },
  );

  const readiness = await firstReady(providers);
  assert.deepEqual(readiness, { available: false });
});

test("SCENARIO F — device voice probes true, then FAILS at playback: the cloud rescues it", async () => {
  // The failure mode a readiness-only chain cannot survive: everything looks
  // fine until the learner actually taps, and then nothing happens.
  const cosy = fake("local-service", { ready: false });
  const device = fake("device-voice", { playFails: true });
  const cloud = fake("cloud-voice");

  const result = await prepareFrom([cosy, device, cloud], "你好", OPTS);
  assert.equal(result.source, "device-voice", "it starts on the device voice, as it should");

  await result.play();

  assert.equal(device.plays, 1, "the device voice was genuinely attempted");
  assert.equal(cloud.plays, 1, "and the cloud finished the job");
  assert.equal(result.source, "cloud-voice", "the handle reports where the sound came from");
  assert.equal(result.provenance.modelVersion, "cloud-voice-model");
});

test("a provider that cannot PREPARE is passed over, not fatal", async () => {
  const device = fake("device-voice", { prepareFails: true });
  const cloud = fake("cloud-voice");
  const result = await prepareFrom([device, cloud], "你好", OPTS);
  assert.equal(result.source, "cloud-voice");
  assert.deepEqual(device.prepares, ["你好"], "it was tried");
});

test("a probe that THROWS is treated as unavailable, not as a crash", async () => {
  const broken = fake("device-voice", { probeThrows: true });
  const cloud = fake("cloud-voice");
  assert.equal((await firstReady([broken, cloud])).source, "cloud-voice");
  const result = await prepareFrom([broken, cloud], "你好", OPTS);
  assert.equal(result.source, "cloud-voice");
});

test("THE FALLBACK CANNOT LOOP — the last provider failing is the end", async () => {
  const device = fake("device-voice", { playFails: true });
  const cloud = fake("cloud-voice", { playFails: true });

  const result = await prepareFrom([device, cloud], "你好", OPTS);
  await assert.rejects(() => result.play(), (error: unknown) => {
    assert.ok(error instanceof PronounceError);
    assert.equal(error.reason, "failed");
    return true;
  });

  // Each provider attempted exactly once. A chain that could revisit a failed
  // provider would spin here instead of returning.
  assert.equal(device.plays, 1);
  assert.equal(cloud.plays, 1);
});

test("fallback walks FORWARD only, never back to a provider that already failed", async () => {
  const first = fake("local-service", { playFails: true });
  const second = fake("device-voice", { playFails: true });
  const third = fake("cloud-voice");

  const result = await prepareFrom([first, second, third], "你好", OPTS);
  await result.play();

  assert.equal(first.plays, 1);
  assert.equal(second.plays, 1);
  assert.equal(third.plays, 1);
  assert.equal(result.source, "cloud-voice");
});

test("stop() and release() follow the clip that is actually live after a fallback", async () => {
  let deviceReleased = 0;
  let cloudStopped = 0;
  const device: PronunciationProvider = {
    id: "device-voice",
    source: { sourceType: "synthetic", provider: "d", modelVersion: "d" },
    probe: async () => true,
    prepare: async () => ({
      description: "device",
      play: async () => { throw new Error("no"); },
      stop: () => {},
      release: () => { deviceReleased++; },
    }),
  };
  const cloud: PronunciationProvider = {
    id: "cloud-voice",
    source: { sourceType: "synthetic", provider: "c", modelVersion: "c" },
    probe: async () => true,
    prepare: async () => ({
      description: "cloud",
      play: async () => {},
      stop: () => { cloudStopped++; },
      release: () => {},
    }),
  };

  const result = await prepareFrom([device, cloud], "你好", OPTS);
  await result.play();
  result.stop();

  assert.equal(deviceReleased, 1, "the abandoned clip must be released, not leaked");
  assert.equal(cloudStopped, 1, "stop must act on the clip that is playing now");
  assert.equal(result.description, "cloud", "and the description follows too");
});

test("speed reaches the provider that ends up speaking", async () => {
  const device = fake("device-voice", { ready: false });
  const cloud = fake("cloud-voice");
  const result = await prepareFrom([device, cloud], "你好", { speed: 0.6 });
  assert.equal(result.description, "cloud-voice (0.6x)");
});

test("readiness reports the FIRST usable provider, and probes no further", async () => {
  const cosy = fake("local-service", { ready: false });
  const device = fake("device-voice");
  const cloud = fake("cloud-voice");

  assert.deepEqual(await firstReady([cosy, device, cloud]), { available: true, source: "device-voice" });
  assert.equal(cloud.probes, 0);
});

test("every provider is synthetic, and says so in its provenance", async () => {
  // The type makes this unrepresentable, but the value is what ships.
  for (const id of ["local-service", "device-voice", "cloud-voice"] as const) {
    const provider = fake(id);
    assert.equal(provider.source.sourceType, "synthetic");
  }
});
