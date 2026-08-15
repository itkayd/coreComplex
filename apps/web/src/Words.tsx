/**
 * WORDS — what you know, what is next, and how far HSK still goes.
 *
 * This is a report. HSK never decides readiness (spec p.9) and HSK reporting is
 * kept separate from scheduling (p.28): the planner has never heard of these
 * bands, and nothing here changes what comes next in a session.
 *
 * Four states, and the fourth is the honest one. Dyr can only teach what the
 * installed content pack contains — 60 words against HSK 3.0's 10,969 — so most
 * of every band is "not in the pack yet". Hiding that would turn a 60-word app
 * into a fake 100% HSK 1 badge.
 */
import { useEffect, useMemo, useState } from "react";
import type { SessionState } from "./session.ts";
import { PACK_BASE_URL } from "./session.ts";
import {
  computeHskProgress, currentBand, loadHskBands,
  type BandProgress, type HskBandData, type HskScheme, type WordState,
} from "./hsk.ts";
import { PronounceButton } from "./PronounceButton.tsx";
import { audioReadiness, type AudioReadiness } from "./pronounce.ts";

const STATE_LABEL: Record<WordState, string> = {
  known: "Known",
  learning: "Learning",
  available: "Ready to learn",
  unavailable: "Not in the pack yet",
};

export function Words({ state }: { state: SessionState }) {
  const [data, setData] = useState<HskBandData | undefined>();
  const [failed, setFailed] = useState(false);
  const [scheme, setScheme] = useState<HskScheme>("new");
  const [openBand, setOpenBand] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadHskBands(PACK_BASE_URL).then((d) => {
      if (!live) return;
      if (d) setData(d); else setFailed(true);
    });
    return () => { live = false; };
  }, []);

  const progress = useMemo(
    () => (data ? computeHskProgress(data, state.pack, state.kernel, scheme) : undefined),
    [data, state, scheme],
  );
  const current = progress ? currentBand(progress) : undefined;

  // Open the band being worked on, once, rather than making the learner hunt.
  useEffect(() => {
    if (current && openBand === null) setOpenBand(current.band);
  }, [current, openBand]);

  return (
    <div className="fade stack">
      <header>
        <p className="eyebrow">Vocabulary</p>
        <h1>Words</h1>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Your reading channel, measured against the official HSK word lists. These lists are a
          yardstick, not a syllabus — they never decide what you are shown next.
        </p>
      </header>

      {failed && (
        <div className="card">
          <p className="muted small" style={{ marginBottom: 0 }}>
            The HSK word lists could not be loaded. Everything else still works.
          </p>
        </div>
      )}

      {!data && !failed && <p className="muted">Loading the HSK word lists…</p>}

      {progress && (
        <>
          <div className="row" role="group" aria-label="HSK standard">
            {(["new", "old"] as HskScheme[]).map((s) => (
              <button key={s} onClick={() => { setScheme(s); setOpenBand(null); }}
                aria-pressed={scheme === s}
                className={scheme === s ? "selected" : undefined}>
                {data!.schemes[s].label}
              </button>
            ))}
          </div>

          <div className="card">
            <h2>{progress.schemeLabel}</h2>
            <p className="muted small">{data!.schemes[scheme].note}</p>
            <Bar band={{ ...progress, band: "all", label: "all", words: [] } as unknown as BandProgress} />
            <dl className="facts" style={{ marginTop: 12 }}>
              <dt>Known</dt><dd>{progress.known.toLocaleString()}</dd>
              <dt>Learning</dt><dd>{progress.learning.toLocaleString()}</dd>
              <dt>Ready to learn</dt><dd>{progress.available.toLocaleString()}</dd>
              <dt>Not in the pack yet</dt><dd>{progress.unavailable.toLocaleString()}</dd>
              <dt>Remaining</dt>
              <dd>{(progress.total - progress.known).toLocaleString()} of {progress.total.toLocaleString()}</dd>
            </dl>
            {progress.offList > 0 && (
              <p className="muted small" style={{ marginTop: 10, marginBottom: 0 }}>
                Plus {progress.offList} word{progress.offList === 1 ? "" : "s"} you know that {progress.schemeLabel} does not list.
              </p>
            )}
          </div>

          {current && (
            <div className="card">
              <h2>Working on {current.label}</h2>
              <p className="muted small" style={{ marginBottom: 0 }}>
                {current.available > 0
                  ? `${current.available} word${current.available === 1 ? "" : "s"} in this band are ready to learn now, and ${current.learning} are still settling.`
                  : current.learning > 0
                    ? `${current.learning} word${current.learning === 1 ? "" : "s"} in this band are still settling. Nothing new here until the pack grows.`
                    : "Every word this pack teaches in this band is known."}
              </p>
            </div>
          )}

          {progress.bands.map((band) => (
            <Band key={band.band} band={band}
              open={openBand === band.band}
              onToggle={() => setOpenBand(openBand === band.band ? null : band.band)} />
          ))}

          <div className="card">
            <h2>Where these lists come from</h2>
            <ul className="muted small" style={{ margin: 0, paddingLeft: "1.1rem" }}>
              {data!.attribution.map((a) => (
                <li key={a.source} style={{ marginBottom: 6 }}>
                  {a.what}: <strong>{a.source}</strong> — {a.licence}, © {a.holder}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

/** A four-segment bar. Colour is supported by the numbers beside it, never alone. */
function Bar({ band }: { band: BandProgress }) {
  const pct = (n: number) => (band.total === 0 ? 0 : (n / band.total) * 100);
  return (
    <div className="hsk-bar" role="img"
      aria-label={`${band.known} known, ${band.learning} learning, ${band.available} ready to learn, ${band.unavailable} not in the pack, of ${band.total}`}>
      <span className={`seg known${band.known === 0 ? " empty" : ""}`} style={{ width: `${pct(band.known)}%` }} />
      <span className={`seg learning${band.learning === 0 ? " empty" : ""}`} style={{ width: `${pct(band.learning)}%` }} />
      <span className={`seg available${band.available === 0 ? " empty" : ""}`} style={{ width: `${pct(band.available)}%` }} />
    </div>
  );
}

function Band({ band, open, onToggle }: { band: BandProgress; open: boolean; onToggle: () => void }) {
  // Only words the pack can actually teach are worth listing individually; the
  // rest is a count, because 5,000 unteachable words is not a useful list.
  const teachable = band.words.filter((w) => w.state !== "unavailable");
  const [audio, setAudio] = useState<AudioReadiness | null>(null);

  // Probed once per band, and cached globally underneath, so opening a list of
  // several hundred words does not ask the platform several hundred times.
  useEffect(() => {
    let live = true;
    audioReadiness().then((a) => { if (live) setAudio(a); });
    return () => { live = false; };
  }, []);

  return (
    <div className="card">
      <div className="meter-head">
        <strong>{band.label}</strong>
        <span className="count">{band.known} / {band.total.toLocaleString()}</span>
      </div>
      <Bar band={band} />
      <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>
        {teachable.length === 0
          ? `None of these ${band.total.toLocaleString()} words are in the pack yet.`
          : `${teachable.length} of ${band.total.toLocaleString()} are in the pack.`}
      </p>
      {teachable.length > 0 && (
        <>
          <button type="button" onClick={onToggle} aria-expanded={open} style={{ marginTop: 10 }}>
            {open ? "Hide words" : `Show ${teachable.length} word${teachable.length === 1 ? "" : "s"}`}
          </button>
          {open && audio?.available && (
            <p className="muted small" style={{ marginTop: 10, marginBottom: 0 }}>
              🔊 plays a generated voice — a rough guide, not a recording to imitate.
            </p>
          )}
          {open && (
            <ul className="wordlist">
              {(["known", "learning", "available"] as WordState[]).flatMap((groupState) => {
                const group = teachable.filter((w) => w.state === groupState);
                if (group.length === 0) return [];
                return [
                  <li key={`h-${groupState}`} className="wordlist-head">
                    {STATE_LABEL[groupState]} · {group.length}
                  </li>,
                  ...group.map((w) => (
                    <li key={w.word} className={`word ${w.state}`}>
                      <span className="hanzi" lang="zh-Hans">{w.word}</span>
                      <span className="reading">{w.pinyin}</span>
                      <span className="meaning muted">{w.gloss}</span>
                      {/* Safe here: the word, its reading and its meaning are all
                          already on screen, so playback reveals nothing. Omitted
                          entirely where nothing can speak, rather than offering a
                          button that could only ever fail. */}
                      {audio?.available && <PronounceButton text={w.word} label={w.pinyin} variant="compact" />}
                    </li>
                  )),
                ];
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
