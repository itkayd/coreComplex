/**
 * The plain body (spec p.27 "One tap to learn; depth appears only when
 * requested"). Home / Task / Result / Progress / Settings.
 *
 * This surface is deliberately plain: no points, streaks, missions, city or
 * narrative. It must be fully useful with every optional layer absent
 * (spec p.8 Stage 2 exit; p.20 removal test).
 *
 * The screen never decides anything about memory. It issues the kernel's
 * TaskContracts, collects an attempt, and displays the kernel's own answer and
 * reason. No scheduler control appears inside the ordinary review flow (p.27).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { SKILLS, type Lexeme, type Skill, type TaskContract } from "@dyr/domain";
import type { Plan, SubmitResult } from "@dyr/kernel";
import { audioUrl, resolveCanonicalAudio, type AudioAsset } from "@dyr/content/runtime";
import { PronounceButton } from "./PronounceButton.tsx";
import { audioReadiness, resetAudioReadiness, type AudioReadiness } from "./pronounce.ts";
import { health, setSyncEnabled, syncEnabled, type SyncStatus } from "./sync.ts";
import { CanonicalAudioCue, type CueStatus } from "./CanonicalAudioCue.tsx";
import { Words } from "./Words.tsx";
import { SignIn } from "./SignIn.tsx";
import { Icon, type IconName } from "./Icons.tsx";
import { accountStatus, signOut, type AccountStatus } from "./auth.ts";
import {
  MODE_MINUTES,
  PACK_BASE_URL,
  backupNow,
  SKILL_LABEL,
  deleteAllLearningData,
  exportLearningData,
  openSession,
  persistNewEvents,
  planSession,
  submit,
  type SessionMode,
  type SessionState,
} from "./session.ts";

type Screen = "home" | "task" | "result" | "words" | "progress" | "settings";

/** Accepted answers arrive "|"-separated; never show the raw key to a learner. */
function splitAnswers(expected: string): string[] {
  return expected.split("|").map((s) => s.trim()).filter((s) => s.length > 0);
}

export function App() {
  const [state, setState] = useState<SessionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>("home");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [index, setIndex] = useState(0);
  const [result, setResult] = useState<{ res: SubmitResult; task: TaskContract; expected: string } | null>(null);
  const [cursor, setCursor] = useState(0);
  const [tick, setTick] = useState(0);
  const [account, setAccount] = useState<AccountStatus | null>(null);
  const [skippedSignIn, setSkippedSignIn] = useState(false);

  useEffect(() => {
    openSession()
      .then((s) => { setState(s); setCursor(s.kernel.log.length); })
      .catch((e) => setError(String(e?.message ?? e)));
    // Asked once, in parallel with the pack: the answer gates the backup, never
    // the session, so nothing here waits on it.
    accountStatus().then(setAccount);
  }, []);

  const save = useCallback(async (s: SessionState) => {
    setCursor(await persistNewEvents(s.kernel, cursor));
  }, [cursor]);

  const start = useCallback(async (mode: SessionMode) => {
    if (!state) return;
    const p = planSession(state, mode);
    setPlan(p);
    setIndex(0);
    setScreen(p.tasks.length > 0 ? "task" : "home");
    await save(state);
    setTick((t) => t + 1);
  }, [state, save]);

  const next = useCallback(() => {
    if (!plan) return;
    const n = index + 1;
    if (n >= plan.tasks.length) { setScreen("home"); setPlan(null); setIndex(0); setResult(null); return; }
    setIndex(n);
    setResult(null);
    setScreen("task");
  }, [plan, index]);

  const onAnswer = useCallback(async (answer: string, meta: { hintsUsed: number; revealed: boolean; audioPlays: number; latencyMs: number }) => {
    if (!state || !plan) return;
    const task = plan.tasks[index];
    const res = submit(state, task, answer, meta.latencyMs, meta);
    setResult({ res, task, expected: plan.answers.get(task.id) ?? "" });
    setScreen("result");
    await save(state);
    setTick((t) => t + 1);
    // Best-effort, deliberately not awaited: a slow or dead backup must never
    // sit between the learner and their next task.
    if (syncEnabled()) void backupNow(state.kernel).catch(() => undefined);
  }, [state, plan, index, save]);

  if (error) {
    return (
      <main className="app">
        <h1>Dyr Mandarin Lab</h1>
        <div className="card">
          <p className="warn">{error}</p>
          <p className="muted small">The content pack could not be loaded or failed its integrity check.</p>
        </div>
      </main>
    );
  }
  if (!state) {
    return (
      <main className="app">
        <h1>Dyr Mandarin Lab</h1>
        <p className="muted">Loading your content pack…</p>
      </main>
    );
  }

  // The gate is shown only when there is genuinely something to sign in to, and
  // only before any studying has happened. A returning learner with history is
  // never asked again — their session cookie or their local log is enough, and
  // interrupting a daily habit to ask for a passphrase would be its own bug.
  const needsSignIn = account !== null
    && account.configured
    && !account.authenticated
    && !skippedSignIn
    && state.kernel.log.length === 0;

  if (needsSignIn) {
    return (
      <main className="app">
        <SignIn
          status={account}
          onSignedIn={() => { setAccount({ ...account, authenticated: true }); }}
          onSkip={() => setSkippedSignIn(true)}
        />
      </main>
    );
  }

  const inSession = screen === "task" || screen === "result";

  return (
    <>
      <main className={`app${inSession ? " is-session" : ""}`}>
        {screen === "home" && <Home state={state} onStart={start} key={`h${tick}`} />}
        {screen === "task" && plan && plan.tasks[index] && (
          <Task task={plan.tasks[index]} position={index} total={plan.tasks.length}
            pack={state.pack} onAnswer={onAnswer} onSkip={next} />
        )}
        {screen === "result" && result && plan && (
          <Result result={result.res} task={result.task} expected={result.expected}
            pack={state.pack} position={index} total={plan.tasks.length} onNext={next} />
        )}
        {screen === "words" && <Words state={state} key={`w${tick}`} />}
        {screen === "progress" && <Progress state={state} key={`p${tick}`} />}
        {screen === "settings" && (
          <Settings state={state} account={account}
            onAccountChange={(next) => setAccount(next)} />
        )}
      </main>
      {!inSession && (
        <nav className="nav" aria-label="Sections">
          {(["home", "words", "progress", "settings"] as Screen[]).map((s) => (
            <button key={s} onClick={() => setScreen(s)} aria-current={screen === s ? "page" : undefined}>
              <Icon name={NAV_ICON[s]} />
              {s[0].toUpperCase() + s.slice(1)}
            </button>
          ))}
        </nav>
      )}
    </>
  );
}

/** HOME — one primary Start button, no overdue mountain (spec p.14). */
function Home({ state, onStart }: { state: SessionState; onStart: (m: SessionMode) => void }) {
  const workload = useMemo(() => state.kernel.workload(), [state]);
  const profile = useMemo(() => state.kernel.frontier.profile(), [state]);
  const weakest = state.kernel.frontier.weakestSkill();
  const forecast = workload.forecasts.find((f) => f.horizonDays === 7 && f.scenario === "expected");
  const started = SKILLS.some((s) => profile[s].retained > 0 || profile[s].total > 0);
  const minutes = Math.round(forecast?.dueMinutes ?? 0);

  return (
    <div className="fade stack">
      <header>
        <p className="eyebrow">Mandarin</p>
        <h1>Dyr Mandarin Lab</h1>
        <p className="muted" style={{ marginBottom: 0 }}>
          {started ? "Ready when you are." : "Start with a short, useful session."}
        </p>
      </header>

      {workload.freezeIntroductions && (
        <div className="banner">
          <span className="mark" aria-hidden="true">!</span>
          <span className="small">
            <strong>No new words today.</strong>{" "}
            <span className="muted">{workload.reasons[0] ?? "Repair comes first."}</span>
          </span>
        </div>
      )}

      <button className="primary" onClick={() => onStart("default")}>Start 7 minutes</button>
      <div className="row">
        <button onClick={() => onStart("rescue")}>3 min</button>
        <button onClick={() => onStart("core")}>15 min</button>
      </div>

      <div className="card">
        <h2>Four channels</h2>
        <p className="muted small">Tracked separately. There is no single score.</p>
        <ul className="channels">
          {SKILLS.map((skill) => (
            <li key={skill} className={`s-${skill}`}>
              <span className="dot" aria-hidden="true" />
              <span className="name">{SKILL_LABEL[skill]}</span>
              <span className="count">{profile[skill].retained}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h2>The week ahead</h2>
        <p className="muted small" style={{ marginBottom: 0 }}>
          {minutes > 0
            ? `About ${minutes} ${minutes === 1 ? "minute" : "minutes"} of review is due over the next seven days.`
            : "Nothing is due yet. A first session will set your schedule."}
          {" "}{SKILL_LABEL[weakest]} is your weakest channel and gets repair priority.
        </p>
      </div>
    </div>
  );
}

/**
 * TASK — one cue, one action, no answer leakage (spec p.27).
 *
 * For an audio-primary task the cue is a real recording. The UI does not choose
 * it: the planner issued the contract, the contract names its assetRefs, and the
 * content layer resolves exactly those. Nothing about the target word — hanzi,
 * pinyin, gloss or transcript — enters the DOM before the learner answers.
 *
 * If the recording cannot be loaded or fails its hash check the task becomes
 * unanswerable. Skipping writes no event, so a learner who never heard the audio
 * never produces retrieval evidence about it.
 */
function Task({ task, position, total, pack, onAnswer, onSkip }: {
  task: TaskContract; position: number; total: number; pack: SessionState["pack"];
  onAnswer: (answer: string, meta: { hintsUsed: number; revealed: boolean; audioPlays: number; latencyMs: number }) => void;
  onSkip: () => void;
}) {
  const [value, setValue] = useState("");
  const [hints, setHints] = useState(0);
  const [plays, setPlays] = useState(0);
  const [cueStatus, setCueStatus] = useState<CueStatus>("loading");
  const [startedAt, setStartedAt] = useState(() => Date.now());

  useEffect(() => {
    setValue(""); setHints(0); setPlays(0); setCueStatus("loading"); setStartedAt(Date.now());
  }, [task.id]);

  const audio = task.requiresHumanAudio;
  const asset: AudioAsset | undefined = useMemo(
    () => (audio ? resolveCanonicalAudio(pack, task.assetRefs) : undefined),
    [audio, pack, task.assetRefs],
  );
  const lexeme = pack.lexemes.find((l) => String(l.id) === String(task.lexeme));

  // The planner's asset gate should already have refused an audio task without
  // canonical audio; if one arrives anyway, refuse it here too rather than
  // rendering a cue that plays nothing.
  const cueBroken = audio && (!asset || cueStatus === "failed");
  const canAnswer = value.trim().length > 0 && !cueBroken;
  const wantsHanzi = task.family === "meaning_to_typed_word" || task.family === "audio_to_hanzi";
  const wantsPinyin = task.family === "hanzi_to_sound";

  return (
    <form
      className="fade grow"
      style={{ display: "flex", flexDirection: "column" }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!canAnswer) return;
        onAnswer(value, { hintsUsed: hints, revealed: false, audioPlays: plays, latencyMs: Date.now() - startedAt });
      }}
    >
      <div className="session-head">
        <div className="pips" role="img" aria-label={`Task ${position + 1} of ${total}`}>
          {Array.from({ length: total }, (_, i) => (
            <span key={i} className={`pip${i < position ? " done" : i === position ? " now" : ""}`} />
          ))}
        </div>
        <SkillChip skill={task.skill} />
      </div>

      <div className="cue-wrap">
        <p className="eyebrow">{audio ? "What did you hear?" : wantsHanzi ? "Write this word" : wantsPinyin ? "How does this sound?" : "What does this mean?"}</p>
        {audio ? (
          asset
            ? <CanonicalAudioCue
                key={task.id}
                asset={asset}
                url={audioUrl(PACK_BASE_URL, asset)}
                onPlaybackChange={setPlays}
                onStatusChange={setCueStatus}
              />
            : <p className="warn" role="alert">
                This listening task has no recording in the installed pack.
              </p>
        ) : wantsHanzi ? (
          <p className="cue-en">{task.cue}</p>
        ) : (
          <p className="cue" lang="zh-Hans">{task.cue}</p>
        )}
        {hints > 0 && lexeme && (
          <p className="muted small" role="status">
            {wantsHanzi
              ? `${lexeme.pinyin} · ${lexeme.simplified.length} character${lexeme.simplified.length === 1 ? "" : "s"}`
              : `Starts with “${(lexeme.senses[0] ?? "")[0] ?? ""}” · ${lexeme.pos}`}
          </p>
        )}
      </div>

      <div className="answer-zone">
        <label htmlFor="answer" className="muted small">
          {wantsHanzi ? "Type the characters" : wantsPinyin ? "Pinyin, with tone marks or numbers (wo3)" : "Your answer in English"}
        </label>
        <input
          id="answer" type="text" value={value} disabled={cueBroken}
          onChange={(e) => setValue(e.target.value)}
          placeholder={cueBroken ? "Unavailable" : "Answer from memory"}
          autoFocus
          autoComplete="off"
          /* iOS would otherwise capitalise and "correct" pinyin into English. */
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          lang={wantsHanzi ? "zh-Hans" : "en"}
        />
        <button type="submit" className="primary" disabled={!canAnswer}>Answer</button>
        <div className="row">
          <button type="button" onClick={onSkip}>Skip</button>
          {!cueBroken && (
            <button type="button" onClick={() => setHints((h) => h + 1)} disabled={hints > 0}>
              {hints > 0 ? "Hint shown" : "Hint"}
            </button>
          )}
        </div>
        <p className="muted small" style={{ textAlign: "center", margin: 0 }}>
          {cueBroken
            ? "Nothing is recorded for a task you could not hear."
            : "Answering from memory counts for more than a hint."}
        </p>
      </div>
    </form>
  );
}

/** RESULT — the kernel's answer and ONE useful explanation (spec p.27). */
function Result({ result, task, expected, pack, position, total, onNext }: {
  result: SubmitResult; task: TaskContract; expected: string; pack: SessionState["pack"];
  position: number; total: number; onNext: () => void;
}) {
  const [details, setDetails] = useState(false);
  const rating = result.envelope.ratingProposal;
  const passed = rating !== "again";
  const asked = result.decision === "ask_self_grade";
  const lexeme: Lexeme | undefined = pack.lexemes.find((l) => String(l.id) === String(task.lexeme));
  const accepted = splitAnswers(expected);
  const last = position + 1 >= total;

  return (
    <div className="fade grow stack">
      <div className="session-head">
        <div className="pips" role="img" aria-label={`Task ${position + 1} of ${total}`}>
          {Array.from({ length: total }, (_, i) => (
            <span key={i} className={`pip${i <= position ? " done" : ""}`} />
          ))}
        </div>
        <SkillChip skill={task.skill} />
      </div>

      <div className="grow stack" style={{ justifyContent: "center" }}>
        <div className="card">
          <div className="verdict">
            <span className={`badge ${asked ? "ask" : passed ? "yes" : "no"}`} aria-hidden="true">
              {asked ? "?" : passed ? "✓" : "✕"}
            </span>
            <h2 className={asked ? "" : passed ? "ok" : "warn"}>
              {asked ? "Not counted yet" : passed ? "Correct" : "Not yet"}
            </h2>
          </div>

          {lexeme && (
            <>
              <p className="answer-reveal" lang="zh-Hans" style={{ marginBottom: 2 }}>{lexeme.simplified}</p>
              <p className="pinyin" style={{ marginBottom: 10 }}>{lexeme.pinyin}</p>
            </>
          )}
          <p className="gloss">{accepted[0]}</p>
          {accepted.length > 1 && (
            <p className="muted small" style={{ marginTop: 4, marginBottom: 0 }}>
              Also accepted: {accepted.slice(1).join(", ")}
            </p>
          )}
        </div>

        {/* Synthetic playback lives here, AFTER the answer, so it can never
            become a listening cue or count as canonical pronunciation. */}
        {lexeme && (
          <div className="card">
            {/* Half speed is a study aid for a word already on screen — the same
                word, given time, not a different one. */}
            <PronounceButton text={lexeme.simplified} label={lexeme.pinyin} offerSlow />
          </div>
        )}

        <div className="card">
          <p className="small" style={{ marginBottom: 10 }}>
            {asked
              ? "That one needs your own judgement before it changes memory."
              : passed
                ? "Recorded. This trace will come back just before it fades."
                : `Recorded. ${SKILL_LABEL[task.skill]} for this word will come back shortly to repair.`}
          </p>
          <button type="button" onClick={() => setDetails((d) => !d)} aria-expanded={details}>
            {details ? "Hide details" : "Why?"}
          </button>
          {details && (
            <dl className="facts" style={{ marginTop: 12 }}>
              <dt>Skill trained</dt>
              <dd>{SKILL_LABEL[task.skill]} only</dd>
              <dt>Evidence</dt>
              <dd>{result.envelope.evidenceStrength.toFixed(2)}</dd>
              <dt>Confidence</dt>
              <dd>{result.envelope.confidence}</dd>
              {result.envelope.reasonCodes.map((r) => (
                <div key={r.code} style={{ display: "contents" }}>
                  <dt>{r.code.replace(/_/g, " ")}</dt>
                  <dd>{r.detail}</dd>
                </div>
              ))}
              {result.repair && (<><dt>Repair</dt><dd>scheduled for this trace</dd></>)}
            </dl>
          )}
        </div>
      </div>

      <button className="primary" onClick={onNext} autoFocus>
        {last ? "Finish session" : "Next"}
      </button>
    </div>
  );
}

/** PROGRESS — four independent skill profiles. Never one mastery number (p.6). */
function Progress({ state }: { state: SessionState }) {
  const profile = state.kernel.frontier.profile();
  const weakest = state.kernel.frontier.weakestSkill();
  const workload = state.kernel.workload();
  const anything = SKILLS.some((s) => profile[s].total > 0);

  return (
    <div className="fade stack">
      <header>
        <p className="eyebrow">Four channels</p>
        <h1>Progress</h1>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Listening, reading, speaking and writing are tracked separately. There is no single score,
          because knowing a word by sight does not mean you can hear it.
        </p>
      </header>

      <div className="card">
        {SKILLS.map((skill) => {
          const p = profile[skill];
          const pct = p.total === 0 ? 0 : (p.retained / p.total) * 100;
          return (
            <div className="meter" key={skill}>
              <div className="meter-head">
                <SkillChip skill={skill} />
                <span className="count">{p.retained} / {p.total || 60}</span>
              </div>
              <div className="track" role="img"
                aria-label={`${SKILL_LABEL[skill]}: ${p.retained} of ${p.total || 60} retained`}>
                <div className="fill" style={{ width: `${pct}%`, background: `var(--${skill})` }} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="card">
        <h2>Workload</h2>
        <p className="muted small" style={{ marginBottom: 0 }}>
          {anything
            ? `${SKILL_LABEL[weakest]} is the weakest channel and gets repair priority.`
            : "Nothing tracked yet — your first session opens the reading channel."}
          {workload.freezeIntroductions ? " New words are paused while repair catches up." : " New words are welcome."}
        </p>
      </div>
    </div>
  );
}

/** SETTINGS — privacy, export and deletion controls (spec p.28 plain-slice done). */
function Settings({ state, account, onAccountChange }: {
  state: SessionState;
  account: AccountStatus | null;
  onAccountChange: (next: AccountStatus) => void;
}) {
  const [msg, setMsg] = useState<string | null>(null);
  const [backup, setBackup] = useState(() => syncEnabled());
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [audio, setAudio] = useState<AudioReadiness | null>(null);
  const [signInOpen, setSignInOpen] = useState(false);

  useEffect(() => {
    let live = true;
    health().then((h) => { if (live) setAvailable(h.configured); }).catch(() => { if (live) setAvailable(false); });
    audioReadiness().then((a) => { if (live) setAudio(a); });
    return () => { live = false; };
  }, []);
  const canonical = state.pack.lexemes.filter((l) => {
    const a = state.pack.audio.get(String(l.id));
    return a?.state === "verified";
  }).length;

  const onExport = async () => {
    const json = await exportLearningData(state.kernel);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "dyr-learning-export.json"; a.click();
    URL.revokeObjectURL(url);
    setMsg("Exported your learning log.");
  };

  const onDelete = async () => {
    const result = await deleteAllLearningData();
    setMsg(
      result.backup === "deleted" ? "Deleted here and in the backup. Reload to start from empty."
        : result.backup === "failed" ? "Deleted on this device. The backup could not be reached — try again while online."
          : "Deleted. Reload to start from empty.",
    );
  };

  const onToggleBackup = async () => {
    const next = !backup;
    setSyncEnabled(next);
    setBackup(next);
    if (!next) { setStatus(null); setMsg("Backup off. Nothing more will leave this device."); return; }
    setBusy(true);
    const result = await backupNow(state.kernel);
    setStatus(result);
    setBusy(false);
  };

  const onBackupNow = async () => {
    setBusy(true);
    setStatus(await backupNow(state.kernel));
    setBusy(false);
  };

  if (signInOpen && account) {
    return (
      <SignIn
        status={account}
        onSignedIn={() => { onAccountChange({ ...account, authenticated: true }); setSignInOpen(false); }}
        onSkip={() => setSignInOpen(false)}
      />
    );
  }

  return (
    <div className="fade stack">
      <header>
        <p className="eyebrow">Yours</p>
        <h1>Settings</h1>
      </header>

      <div className="card">
        <h2><Icon name="shield" size={18} /> Your data</h2>
        <p className="muted small">
          {backup
            ? "Your learning log is stored on this device and copied to the backup below. Nothing else leaves it."
            : "Everything stays on this device. Nothing is uploaded."}
          {" "}The learning log is yours to export or delete at any time.
        </p>
        <div className="row">
          <button onClick={onExport}><Icon name="download" size={17} /> Export log</button>
          <button onClick={onDelete}><Icon name="trash" size={17} /> Delete all</button>
        </div>
        {msg && <p className="small ok" role="status" style={{ marginTop: 10, marginBottom: 0 }}>{msg}</p>}
      </div>

      {/* Account first: whether you are signed in determines whether the card
          below can do anything at all, so it belongs above it. */}
      {account?.configured && (
        <div className="card">
          <h2><Icon name="shield" size={18} /> Account</h2>
          <p className="muted small">
            {account.authenticated
              ? "Signed in. Your learning history syncs to this app\u2019s own database and nowhere else."
              : "Not signed in on this device, so nothing is being backed up. Studying works regardless \u2014 everything is written here first."}
          </p>
          {account.authenticated ? (
            <button onClick={async () => {
              await signOut();
              onAccountChange({ ...account, authenticated: false });
              setMsg("Signed out. Your work stays on this device.");
            }}>Sign out</button>
          ) : (
            <button onClick={() => { setSignInOpen(true); }}>Sign in</button>
          )}
        </div>
      )}

      <div className="card">
        <h2><Icon name="cloud" size={18} /> Backup</h2>
        <p className="muted small">
          Off by default. When on, your learning log is copied to this app&rsquo;s own database so a
          cleared browser or a lost phone does not erase it. Nothing else is sent — no recordings, no
          analytics — and deleting your data deletes the backup too.
        </p>
        {available === false ? (
          <p className="small muted" style={{ marginBottom: 0 }}>
            No database is configured for this deployment, so backup is unavailable. The app works
            fully without it.
          </p>
        ) : (
          <>
            <div className="row">
              <button onClick={onToggleBackup} aria-pressed={backup} disabled={busy}>
                {backup ? "Turn backup off" : "Turn backup on"}
              </button>
              <button onClick={onBackupNow} disabled={!backup || busy}>
                {busy ? "Working…" : "Back up now"}
              </button>
            </div>
            {status && (
              <p className={`small ${status.state === "synced" ? "ok" : status.state === "diverged" ? "warn" : "muted"}`}
                role="status" style={{ marginTop: 10, marginBottom: 0 }}>
                {status.detail}
                {status.state === "synced" && status.remoteEvents > 0 && ` (${status.remoteEvents} stored)`}
              </p>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2><Icon name="words" size={18} /> Content</h2>
        <dl className="facts">
          <dt>Pack</dt><dd>{state.pack.packId}</dd>
          <dt>Words</dt><dd>{state.pack.lexemes.length}</dd>
          <dt>Version</dt><dd style={{ wordBreak: "break-all" }}>{String(state.pack.packVersion)}</dd>
          <dt>Recordings</dt><dd>{canonical} / {state.pack.lexemes.length}</dd>
        </dl>
        {canonical < state.pack.lexemes.length && (
          <p className="muted small" style={{ marginTop: 12, marginBottom: 0 }}>
            Listening needs human-recorded Mandarin, which cannot be synthesised. Until a licensed
            recording is verified for a word, listening tasks for it are not issued — you will not be
            taught pronunciation from audio that does not exist. Reading and writing work fully.
          </p>
        )}
        <details style={{ marginTop: 12 }}>
          <summary className="small">Attribution</summary>
          <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>
            {state.pack.attributions[0]?.attributionText} — {state.pack.attributions.length} entries,
            each with its licence and content hash.
          </p>
        </details>
      </div>

      {/* Sound is explained rather than merely offered: a learner has to know
          which of the two very different things they are hearing. */}
      <div className="card">
        <h2><Icon name="sound" size={18} /> Sound</h2>
        <p className="muted small">
          Dyr uses audio two ways, and they are not interchangeable. <strong>Listening tasks</strong> play
          verified human recordings only — never a generated voice — which is why a word with no
          recording is never used for listening. <strong>Hear it</strong>, on a word you are already
          looking at, uses a generated voice: handy for a rough shape, not something to imitate.
        </p>
        <dl className="facts">
          <dt>Human recordings</dt><dd>{canonical} / {state.pack.lexemes.length}</dd>
          <dt>Generated voice</dt>
          <dd>{audio === null ? "checking…" : audio.available ? audio.description : "none on this device"}</dd>
        </dl>
        {audio?.available && (
          <div style={{ marginTop: 12 }}>
            <PronounceButton text="你好" label="ni hao" offerSlow />
          </div>
        )}
        {audio && !audio.available && (
          <p className="small muted" style={{ marginTop: 10, marginBottom: 0 }}>
            Nothing on this device or this deployment can speak Mandarin, so &ldquo;Hear it&rdquo; is
            unavailable. On Android add a Chinese voice under Settings &rarr; Language &amp; input
            &rarr; Text-to-speech; on desktop Linux, install a zh-CN speech-dispatcher voice.
            Everything else works without it.
          </p>
        )}
        <button type="button" style={{ marginTop: 12 }}
          onClick={() => { resetAudioReadiness(); setAudio(null); audioReadiness().then(setAudio); }}>
          Re-check voices
        </button>
      </div>

      <div className="card">
        <h2><Icon name="spark" size={18} /> Accessibility</h2>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Reduced motion follows your system setting, and so does light or dark. Colour is never the
          only signal — every skill is named in text beside its dot.
        </p>
      </div>
    </div>
  );
}

/**
 * A skill chip: icon + dot + name.
 *
 * Three signals for one fact, deliberately. Colour alone fails for a colourblind
 * learner and in high-contrast modes; the silhouette and the word do not.
 */
function SkillChip({ skill }: { skill: Skill }) {
  return (
    <span className={`chip s-${skill}`}>
      <Icon name={skill as IconName} size={15} />
      {SKILL_LABEL[skill]}
    </span>
  );
}

/** Which icon stands for each section. Names, not markup — see Icons.tsx. */
const NAV_ICON: Record<Screen, IconName> = {
  home: "home", words: "words", progress: "progress", settings: "settings",
  // Never rendered (the nav is hidden mid-session) but the map must be total.
  task: "spark", result: "check",
};
