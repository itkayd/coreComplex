/**
 * "Hear it" — synthetic pronunciation playback.
 *
 * Deliberately constrained (spec p.21 SYNTHETIC FALLBACK):
 *   - it is ALWAYS labelled as a generated voice, never presented as a model
 *     pronunciation or a reference recording;
 *   - it appears only AFTER an answer, on the Result screen, so it can never
 *     become the cue for a listening task;
 *   - it is never evidence: pressing it changes no trace and grades nothing;
 *   - if the local speech service is not running, it says so calmly and the
 *     session continues unaffected.
 */
import { useEffect, useRef, useState } from "react";
import { SpeechUnavailable, speak } from "./speech.ts";

type Status = "idle" | "loading" | "playing" | "unavailable" | "failed";

export function SyntheticAudioButton({ text, speed = 1 }: { text: string; speed?: number }) {
  const [status, setStatus] = useState<Status>("idle");
  const [model, setModel] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  // Release the object URL when the word changes or the screen unmounts.
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [text]);

  const play = async () => {
    setStatus("loading");
    try {
      const clip = await speak(text, { speed });
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = clip.objectUrl;
      setModel(clip.provenance.modelVersion);

      const audio = new Audio(clip.objectUrl);
      audioRef.current = audio;
      // If the service could not bake the speed in, apply it here — browsers
      // preserve pitch for playbackRate, which is what the spec asks for.
      audio.playbackRate = speed;
      audio.onended = () => setStatus("idle");
      audio.onerror = () => setStatus("failed");
      setStatus("playing");
      await audio.play();
    } catch (error) {
      setStatus(error instanceof SpeechUnavailable ? "unavailable" : "failed");
    }
  };

  return (
    <div>
      <button type="button" onClick={play} disabled={status === "loading" || status === "playing"}>
        {status === "loading" ? "Generating…" : status === "playing" ? "Playing…" : "Hear it (generated voice)"}
      </button>

      {/* Colour is never the only signal: the label always says it is generated. */}
      <p className="muted small" style={{ marginBottom: 0 }}>
        Generated voice — a convenience, not a pronunciation reference.
        {model ? ` ${model}.` : ""}
      </p>

      {status === "unavailable" && (
        <p className="small warn" role="status" style={{ marginBottom: 0 }}>
          Generated speech needs the local speech service. Your session is unaffected.
        </p>
      )}
      {status === "failed" && (
        <p className="small warn" role="status" style={{ marginBottom: 0 }}>
          Could not play that clip.
        </p>
      )}
    </div>
  );
}
