/**
 * Optional ffmpeg transcoding: WAV → OGG/Opus, plus pitch-preserving speed.
 *
 * ffmpeg is genuinely optional. When it is absent the service still works and
 * simply serves WAV at speed 1.0, reporting `speedApplied: false` so the client
 * can apply a pitch-preserving `playbackRate` instead. Degrading loudly beats
 * pretending a speed was baked in when it was not.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TranscodeResult {
  audio: Uint8Array;
  mimeType: string;
  speedApplied: boolean;
}

/** `atempo` accepts 0.5–2.0 per stage; chain stages to reach wider factors. */
export function atempoChain(speed: number): string[] {
  const stages: number[] = [];
  let remaining = speed;
  while (remaining > 2.0) { stages.push(2.0); remaining /= 2.0; }
  while (remaining < 0.5) { stages.push(0.5); remaining /= 0.5; }
  stages.push(Number(remaining.toFixed(6)));
  return stages.map((s) => `atempo=${s}`);
}

async function runFfmpeg(bin: string, args: string[], timeoutMs = 60000): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += String(d); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("ffmpeg timed out")); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

/** True when the configured ffmpeg can actually run. */
export async function ffmpegAvailable(bin: string | undefined): Promise<boolean> {
  if (!bin) return false;
  try {
    await runFfmpeg(bin, ["-hide_banner", "-version"], 8000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert WAV to the requested delivery format, baking in `speed` when possible.
 * Any failure falls back to the original WAV rather than failing the request.
 */
export async function transcode(
  wav: Uint8Array,
  opts: { ffmpegPath?: string; format: "ogg" | "wav"; speed: number },
): Promise<TranscodeResult> {
  const wantsSpeed = Math.abs(opts.speed - 1) > 0.001;
  const wantsOgg = opts.format === "ogg";
  if (!wantsSpeed && !wantsOgg) return { audio: wav, mimeType: "audio/wav", speedApplied: true };

  if (!(await ffmpegAvailable(opts.ffmpegPath))) {
    // No ffmpeg: serve WAV at natural pace and tell the truth about the speed.
    return { audio: wav, mimeType: "audio/wav", speedApplied: !wantsSpeed };
  }

  const dir = mkdtempSync(join(tmpdir(), "dyr-tts-"));
  try {
    const input = join(dir, "in.wav");
    const output = join(dir, wantsOgg ? "out.ogg" : "out.wav");
    writeFileSync(input, wav);
    const args = ["-hide_banner", "-loglevel", "error", "-i", input];
    if (wantsSpeed) args.push("-filter:a", atempoChain(opts.speed).join(","));
    if (wantsOgg) args.push("-c:a", "libopus", "-b:a", "32k");
    args.push("-y", output);
    await runFfmpeg(opts.ffmpegPath!, args);
    return {
      audio: new Uint8Array(readFileSync(output)),
      mimeType: wantsOgg ? "audio/ogg" : "audio/wav",
      speedApplied: true,
    };
  } catch {
    // Encoder missing (e.g. no libopus) — WAV is still a correct answer.
    return { audio: wav, mimeType: "audio/wav", speedApplied: !wantsSpeed };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
