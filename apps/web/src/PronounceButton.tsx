/**
 * The one control that makes a sound outside a listening task.
 *
 * Two shapes, one behaviour:
 *   - `full`    the Result screen and Settings: a labelled button plus the
 *               standing disclosure that the voice is generated.
 *   - `compact` a word list, where a labelled paragraph per row would be noise.
 *               The disclosure moves to the list header and the button keeps an
 *               accessible name that still says "generated".
 *
 * WHERE THIS MAY APPEAR is a correctness question, not a layout one. It may
 * appear anywhere the hanzi is ALREADY VISIBLE — the Result screen after an
 * answer, the Words list, Settings. It may never appear on a task cue, because
 * hearing a word you have been asked to recall gives the answer away, and
 * because a generated voice must never stand in for canonical audio (spec p.21).
 * `CanonicalAudioCue` is the only component that speaks before an answer.
 */
import { useEffect, useRef, useState } from "react";
import { PronounceError, pronounce, type Pronunciation } from "./pronounce.ts";
import { Icon } from "./Icons.tsx";

type Status = "idle" | "loading" | "playing" | "unavailable" | "failed";

export interface PronounceButtonProps {
  text: string;
  /** Playback rate, 0.5–2.0. Slower is a study aid, not a different word. */
  speed?: number;
  variant?: "full" | "compact";
  /** Announced to screen readers in place of the raw text, where useful. */
  label?: string;
  /** Offer a half-speed replay beside the normal one (full variant only). */
  offerSlow?: boolean;
}

export function PronounceButton({ text, speed = 1, variant = "full", label, offerSlow = false }: PronounceButtonProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [detail, setDetail] = useState<string>("");
  const [rate, setRate] = useState(speed);
  const current = useRef<Pronunciation | null>(null);

  // A pronunciation holds an object URL when it came from the service, so it is
  // released when the word changes or the screen goes away.
  useEffect(() => {
    return () => {
      current.current?.stop();
      current.current?.release();
      current.current = null;
    };
  }, [text]);

  const play = async (at: number = speed) => {
    // A second tap while playing stops rather than stacking utterances.
    if (status === "playing") {
      current.current?.stop();
      setStatus("idle");
      return;
    }
    setStatus("loading");
    setRate(at);
    try {
      current.current?.release();
      const sound = await pronounce(text, { speed: at });
      current.current = sound;
      setDetail(sound.description);
      setStatus("playing");
      await sound.play();
      setStatus("idle");
    } catch (error) {
      if (error instanceof PronounceError && error.reason === "no_source") {
        setStatus("unavailable");
        setDetail(error.message);
      } else {
        setStatus("failed");
        setDetail(error instanceof Error ? error.message : "playback failed");
      }
    }
  };

  const accessibleName = `Hear ${label ?? text} — generated voice`;

  if (variant === "compact") {
    return (
      <button
        type="button"
        className="pronounce-compact"
        onClick={() => play()}
        aria-label={accessibleName}
        data-audio-state={status}
        disabled={status === "unavailable"}
      >
        <Icon name={status === "playing" ? "stop" : "sound"} size={18} />
      </button>
    );
  }

  return (
    <div data-audio-state={status} data-audio-rate={rate}>
      <div className="row">
        <button type="button" onClick={() => play()} aria-label={accessibleName} disabled={status === "loading"}>
          <Icon name={status === "playing" ? "stop" : "sound"} size={17} />
          {status === "loading" ? "Preparing…" : status === "playing" ? "Stop" : "Hear it"}
        </button>
        {offerSlow && (
          <button
            type="button"
            onClick={() => play(0.6)}
            aria-label={`Hear ${label ?? text} slowly — generated voice`}
            disabled={status === "loading"}
          >
            <Icon name="slower" size={17} /> Slower
          </button>
        )}
      </div>

      {/* The disclosure is permanent and textual: colour is never the only
          signal, and a learner must never mistake this for a recording. */}
      <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>
        Generated voice — a convenience, not a pronunciation reference.
        {status !== "unavailable" && detail ? ` ${detail}.` : ""}
      </p>

      {status === "unavailable" && (
        <p className="small warn" role="status" style={{ marginBottom: 0 }}>
          {detail}. Your session is unaffected.
        </p>
      )}
      {status === "failed" && (
        <p className="small warn" role="status" style={{ marginBottom: 0 }}>
          Could not play that. {detail}
        </p>
      )}
    </div>
  );
}
