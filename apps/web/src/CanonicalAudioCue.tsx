/**
 * The listening cue: a verified human recording, actually played.
 *
 * Three rules this component exists to enforce.
 *
 * NO ANSWER LEAKAGE. A listening task asks what the learner heard, so the DOM
 * must not contain the transcript, the hanzi, the pinyin or the gloss — including
 * in the accessible name, which a screen-reader user hears before answering. The
 * control is called "Play listening prompt". The URL is content-addressed, so
 * even the network panel shows only a hash.
 *
 * NO SILENT FAILURE. If the bytes are missing, unreachable or fail their hash
 * check, the task is unanswerable and says so. It must never fall through to a
 * text cue or to synthetic speech: CosyVoice is a labelled aid on the RESULT
 * screen, never a stand-in for canonical audio (spec p.21).
 *
 * HONEST PLAY COUNTING. `audioReplays` on RawAttempt is a play count with the
 * first play free (rubric `freeAudioReplays: 1`). It is reported from real
 * playback events, so a learner who could not hear the clip is not recorded as
 * having heard it, and one who listened four times is.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AudioAsset } from "@dyr/content/runtime";
import { loadCanonicalAudio, type AudioLoadFailure } from "@dyr/content/runtime";

export type CueStatus = "loading" | "ready" | "failed";

export interface CanonicalAudioCueProps {
  asset: AudioAsset;
  url: string;
  /** Reports (plays, status) upward so the attempt records real behaviour. */
  onPlaybackChange: (plays: number) => void;
  onStatusChange: (status: CueStatus, detail?: string) => void;
}

const FAILURE_COPY: Record<AudioLoadFailure, string> = {
  unavailable: "This recording could not be loaded.",
  hash_mismatch: "This recording does not match the content pack and was refused.",
  no_runtime_reference: "This recording is not available in the installed pack.",
};

export function CanonicalAudioCue({ asset, url, onPlaybackChange, onStatusChange }: CanonicalAudioCueProps) {
  const [status, setStatus] = useState<CueStatus>("loading");
  const [detail, setDetail] = useState<string>("");
  const [plays, setPlays] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [needsGesture, setNeedsGesture] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Load + verify, then attempt autoplay once. Autoplay is a nicety: browsers and
  // iOS routinely refuse it without a user gesture, and that refusal must leave a
  // perfectly usable task rather than a broken one.
  useEffect(() => {
    let cancelled = false;
    let revoke: (() => void) | undefined;
    setStatus("loading");
    setPlays(0);
    setNeedsGesture(false);
    onPlaybackChange(0);

    loadCanonicalAudio(url, asset).then((result) => {
      if (cancelled) { if (result.ok) result.revoke(); return; }
      if (!result.ok) {
        setStatus("failed");
        setDetail(FAILURE_COPY[result.failure]);
        onStatusChange("failed", `${result.failure}: ${result.detail}`);
        return;
      }
      revoke = result.revoke;
      const element = new Audio(result.blobUrl);
      element.preload = "auto";
      audioRef.current = element;
      setStatus("ready");
      onStatusChange("ready");
      element.play().then(() => {
        if (cancelled) return;
        setPlaying(true);
        setPlays((n) => { const next = n + 1; onPlaybackChange(next); return next; });
      }).catch(() => {
        // Autoplay blocked — expected on mobile. Offer the button instead.
        if (!cancelled) setNeedsGesture(true);
      });
    });

    return () => {
      cancelled = true;
      audioRef.current?.pause();
      audioRef.current = null;
      revoke?.();
    };
    // Re-load only when the recording itself changes.
  }, [url, asset.id]);

  useEffect(() => {
    const element = audioRef.current;
    if (!element) return;
    const onEnded = () => setPlaying(false);
    element.addEventListener("ended", onEnded);
    return () => element.removeEventListener("ended", onEnded);
  }, [status]);

  const play = useCallback(() => {
    const element = audioRef.current;
    if (!element) return;
    element.currentTime = 0;
    element.play().then(() => {
      setPlaying(true);
      setNeedsGesture(false);
      setPlays((n) => { const next = n + 1; onPlaybackChange(next); return next; });
    }).catch(() => setNeedsGesture(true));
  }, [onPlaybackChange]);

  if (status === "failed") {
    return (
      <div className="cue-audio" data-cue-state="failed">
        <p className="warn small" role="alert" style={{ margin: 0 }}>{detail}</p>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Listening needs the real recording, so this one cannot be scored.
        </p>
      </div>
    );
  }

  return (
    <div className="cue-audio" data-cue-state={status} data-plays={plays}>
      <button
        type="button"
        className="audio-play"
        onClick={play}
        disabled={status !== "ready"}
        /* Generic by design: naming the word here would read the answer aloud. */
        aria-label={plays === 0 ? "Play listening prompt" : "Play listening prompt again"}
      >
        <span aria-hidden="true">{playing ? "◼" : "▶"}</span>
        <span>{plays === 0 ? "Play" : "Play again"}</span>
      </button>
      <p className="muted small" style={{ marginBottom: 0 }} role="status">
        {status === "loading"
          ? "Loading the recording…"
          : needsGesture && plays === 0
            ? "Tap play to hear the prompt."
            : plays === 0
              ? "Listen, then answer."
              : `Played ${plays} ${plays === 1 ? "time" : "times"}. Answering after fewer replays counts for more.`}
      </p>
    </div>
  );
}
