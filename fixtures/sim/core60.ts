/**
 * Stage 2 harness: a kernel running on the REAL Core 60 licensed pack
 * (as opposed to the 8-lexeme unit-test fixture).
 */
import {
  DEFAULT_CONFIG,
  DeviceId,
  LearnerId,
  ManualClock,
  type AssetProvider,
  type KernelConfig,
} from "@dyr/domain";
import { createFsrsAdapter } from "@dyr/fsrs-adapter";
import { DyrKernel } from "@dyr/kernel";
import { buildCore60Pack, packToGraph, packAssetProvider, runAudioQa, type RuntimePack } from "@dyr/content";

export interface Core60Harness {
  kernel: DyrKernel;
  clock: ManualClock;
  pack: RuntimePack;
  lexemeIds: import("@dyr/domain").LexemeId[];
}

/**
 * Build a Core-60 kernel. `provisionAudio` simulates having completed the audio
 * provisioning path (QA-verified human recordings) so the listening channel can
 * be exercised; with it false the canonical-audio gate correctly blocks
 * audio-primary tasks.
 */
export function makeCore60Harness(opts: { provisionAudio?: boolean; startIso?: string; config?: KernelConfig } = {}): Core60Harness {
  const built = buildCore60Pack();
  const pack = built.pack;

  if (opts.provisionAudio) {
    for (const [lexeme, asset] of pack.audio) {
      const candidate = { ...asset, sha256: "0".repeat(64), upstream: "common-voice-zh-CN" as const, licenseSpdx: "CC0-1.0", speaker: `cv-${lexeme}`, region: "zh-CN" };
      const qa = runAudioQa({
        asset: candidate,
        humanRecorded: true,
        transcriptMatches: true,
        segmentationVerified: true,
        clean: true,
        naturalPace: true,
        licenceAndConsentClear: true,
      });
      pack.audio.set(lexeme, { ...candidate, state: qa.state });
    }
  }

  const clock = new ManualClock(opts.startIso ?? "2026-01-01T08:00:00Z");
  const assets: AssetProvider = packAssetProvider(pack);
  const kernel = new DyrKernel({
    learnerId: LearnerId("L-core60"),
    deviceId: DeviceId("D1"),
    clock,
    graph: packToGraph(pack),
    fsrs: createFsrsAdapter(),
    config: opts.config ?? DEFAULT_CONFIG,
    assets,
  });
  return { kernel, clock, pack, lexemeIds: pack.lexemes.map((l) => l.id) };
}
