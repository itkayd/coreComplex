/**
 * Writing a release: the JSON artefact plus its content-addressed audio.
 *
 * Node-only (it copies bytes); the browser never imports this. Every recording is
 * re-hashed as it is written, so a source file that changed between certification
 * and build fails the release rather than shipping under a hash that no longer
 * describes it.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BuildReport } from "./pipeline.ts";
import { serialisePack } from "./export.ts";

export interface WrittenPack {
  packFile: string;
  audioFiles: string[];
  bytesWritten: number;
}

export class AudioIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioIntegrityError";
  }
}

/**
 * Write the pack artefact and its runtime audio into `outDir`.
 *
 * Audio lands at `<outDir>/audio/<sha256>.<ext>`, exactly the pack-relative path
 * each asset declares, so the runtime resolves a recording from the pack alone —
 * no machine-local path is ever exposed to the browser.
 */
export function writePack(report: BuildReport, outDir: string): WrittenPack {
  mkdirSync(outDir, { recursive: true });

  const audioFiles: string[] = [];
  let bytesWritten = 0;
  for (const file of report.audioFiles) {
    const bytes = readFileSync(file.absolutePath);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== file.sha256) {
      throw new AudioIntegrityError(
        `audio changed since certification: ${file.absolutePath} now hashes to ${actual.slice(0, 12)}…, `
        + `pack expects ${file.sha256.slice(0, 12)}…. Re-run the review and certify the new bytes.`,
      );
    }
    const target = join(outDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    audioFiles.push(target);
    bytesWritten += bytes.byteLength;
  }

  const packFile = join(outDir, `${report.pack.packId}.json`);
  writeFileSync(packFile, serialisePack(report.pack), "utf8");
  return { packFile, audioFiles, bytesWritten };
}
