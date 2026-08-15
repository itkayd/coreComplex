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
import { SKILLS, type Skill, type TaskContract } from "@dyr/domain";
import type { Plan, SubmitResult } from "@dyr/kernel";
import { SyntheticAudioButton } from "./SyntheticAudioButton.tsx";
import {
  MODE_MINUTES,
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

type Screen = "home" | "task" | "result" | "progress" | "settings";

export function App() {
  const [state, setState] = useState<SessionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>("home");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [index, setIndex] = useState(0);
  const [result, setResult] = useState<{ res: SubmitResult; task: TaskContract; expected: string } | null>(null);
  const [cursor, setCursor] = useState(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    openSession()
      .then((s) => { setState(s); setCursor(s.kernel.log.length); })
      .catch((e) => setError(String(e?.message ?? e)));
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

  const onAnswer = useCallback(async (answer: string, meta: { hintsUsed: number; revealed: boolean; replays: number; latencyMs: number }) => {
    if (!state || !plan) return;
    const task = plan.tasks[index];
    const res = submit(state, task, answer, meta.latencyMs, meta);
    setResult({ res, task, expected: plan.answers.get(task.id) ?? "" });
    setScreen("result");
    await save(state);
    setTick((t) => t + 1);
  }, [state, plan, index, save]);

  const next = useCallback(() => {
    if (!plan) return;
    const n = index + 1;
    if (n >= plan.tasks.length) { setScreen("home"); setPlan(null); setIndex(0); return; }
    setIndex(n);
    setResult(null);
    setScreen("task");
  }, [plan, index]);

  if (error) {
    return <main className="app"><h1>Dyr Mandarin Lab</h1><div className="card"><p className="warn">{error}</p><p className="muted small">Run <code>npm run build:pack</code> so the content pack is available.</p></div></main>;
  }
  if (!state) {
    return <main className="app"><h1>Dyr Mandarin Lab</h1><p className="muted">Loading your content pack…</p></main>;
  }

  return (
    <>
      <main className="app">
        {screen === "home" && <Home state={state} onStart={start} key={`h${tick}`} />}
        {screen === "task" && plan && plan.tasks[index] && (
          <Task task={plan.tasks[index]} position={index + 1} total={plan.tasks.length} onAnswer={onAnswer} />
        )}
        {screen === "result" && result && (
          <Result result={result.res} task={result.task} expected={result.expected} onNext={next} />
        )}
        {screen === "progress" && <Progress state={state} key={`p${tick}`} />}
        {screen === "settings" && <Settings state={state} />}
      </main>
      {screen !== "task" && screen !== "result" && (
        <nav className="nav" aria-label="Sections">
          {(["home", "progress", "settings"] as Screen[]).map((s) => (
            <button key={s} onClick={() => setScreen(s)} aria-current={screen === s ? "page" : undefined}>
              {s[0].toUpperCase() + s.slice(1)}
            </button>
          ))}
        </nav>
      )}
    </>
  );
}

/** HOME — one primary Start button, time remaining, no overdue mountain (p.14). */
function Home({ state, onStart }: { state: SessionState; onStart: (m: SessionMode) => void }) {
  const workload = useMemo(() => state.kernel.workload(), [state]);
  const profile = useMemo(() => state.kernel.frontier.profile(), [state]);
  const weakest = state.kernel.frontier.weakestSkill();
  const forecast = workload.forecasts.find((f) => f.horizonDays === 7 && f.scenario === "expected");
  const started = SKILLS.some((s) => profile[s].retained > 0);

  return (
    <div className="fade">
      <h1>Dyr Mandarin Lab</h1>
      <p className="muted">{started ? "Ready when you are." : "Start with a short, useful session."}</p>

      {workload.freezeIntroductions && (
        <div className="banner"><strong>No new items today.</strong>{" "}
          <span className="muted small">{workload.reasons[0] ?? "Repair comes first."}</span></div>
      )}

      <button className="primary" onClick={() => onStart("default")}>Start 7 minutes</button>
      <div className="row" style={{ marginTop: 10 }}>
        <button onClick={() => onStart("rescue")}>3 min rescue</button>
        <button onClick={() => onStart("core")}>15 min core</button>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Next 7 days</h2>
        <p className="muted small" style={{ margin: 0 }}>
          About {Math.round(forecast?.dueMinutes ?? 0)} minutes of review expected.
          {" "}{SKILL_LABEL[weakest]} needs repair.
        </p>
      </div>
    </div>
  );
}

/** TASK — one cue, one action, no answer leakage (p.27). */
function Task({ task, position, total, onAnswer }: {
  task: TaskContract; position: number; total: number;
  onAnswer: (answer: string, meta: { hintsUsed: number; revealed: boolean; replays: number; latencyMs: number }) => void;
}) {
  const [value, setValue] = useState("");
  const [hints, setHints] = useState(0);
  const [startedAt] = useState(() => Date.now());

  useEffect(() => { setValue(""); setHints(0); }, [task.id]);

  const audio = task.requiresHumanAudio;
  return (
    <form
      className="fade"
      onSubmit={(e) => { e.preventDefault(); onAnswer(value, { hintsUsed: hints, revealed: false, replays: 1, latencyMs: Date.now() - startedAt }); }}
    >
      <p className="muted small">Task {position} of {total}</p>
      <SkillChip skill={task.skill} />
      <div className="card">
        <p className="muted small" style={{ marginTop: 0 }}>
          {audio ? "What did you hear?" : "What does this mean?"}
        </p>
        <div className="cue" lang="zh-CN">{audio ? "🔊" : task.cue}</div>
      </div>

      <label htmlFor="answer" className="muted small">Your answer</label>
      <input id="answer" type="text" autoFocus autoComplete="off" value={value}
        onChange={(e) => setValue(e.target.value)} placeholder="Answer before revealing" />

      <div className="row" style={{ marginTop: 10 }}>
        <button type="submit" className="primary" disabled={value.trim().length === 0}>Answer</button>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button type="button" onClick={() => setHints((h) => h + 1)}>
          Hint{hints > 0 ? ` (${hints})` : ""}
        </button>
      </div>
      <p className="muted small">Answering from memory counts for more than a hint.</p>
    </form>
  );
}

/** RESULT — the kernel's answer and ONE useful explanation (p.27). */
function Result({ result, task, expected, onNext }: {
  result: SubmitResult; task: TaskContract; expected: string; onNext: () => void;
}) {
  const [details, setDetails] = useState(false);
  const rating = result.envelope.ratingProposal;
  const passed = rating !== "again";
  const asked = result.decision === "ask_self_grade";

  return (
    <div className="fade">
      <SkillChip skill={task.skill} />
      <div className="card">
        <h2 className={passed ? "ok" : "warn"}>
          {asked ? "Not counted yet" : passed ? "Correct" : "Not yet"}
        </h2>
        <p style={{ marginBottom: 6 }}>
          <span lang="zh-CN" style={{ fontSize: 24 }}>{task.cue}</span>
        </p>
        <p className="muted" style={{ margin: 0 }}>{expected}</p>
      </div>

      {/* Synthetic playback lives here, AFTER the answer, so it can never
          become a listening cue or count as canonical pronunciation. */}
      <div className="card">
        <SyntheticAudioButton text={task.cue} />
      </div>

      <div className="card">
        <p style={{ margin: 0 }} className="small">
          {asked
            ? "That one needs your own judgement before it changes memory."
            : passed
              ? "Recorded. This trace will come back when it is about to fade."
              : `Recorded. ${SKILL_LABEL[task.skill]} for this word will come back shortly to repair.`}
        </p>
        <button type="button" style={{ marginTop: 10 }} onClick={() => setDetails((d) => !d)} aria-expanded={details}>
          {details ? "Hide details" : "Why?"}
        </button>
        {details && (
          <ul className="muted small" style={{ marginBottom: 0 }}>
            <li>Skill trained: {SKILL_LABEL[task.skill]} (this word's other skills are unchanged)</li>
            <li>Evidence strength: {result.envelope.evidenceStrength.toFixed(2)}</li>
            <li>Confidence: {result.envelope.confidence}</li>
            {result.envelope.reasonCodes.map((r) => <li key={r.code}>{r.code}: {r.detail}</li>)}
            {result.repair && <li>Repair scheduled for this trace</li>}
          </ul>
        )}
      </div>

      <button className="primary" onClick={onNext}>Next</button>
    </div>
  );
}

/** PROGRESS — four independent skill profiles. Never one mastery number (p.6). */
function Progress({ state }: { state: SessionState }) {
  const profile = state.kernel.frontier.profile();
  const weakest = state.kernel.frontier.weakestSkill();
  const workload = state.kernel.workload();

  return (
    <div className="fade">
      <h1>Progress</h1>
      <p className="muted small">
        Listening, reading, speaking and writing are tracked separately. There is no single score.
      </p>
      <div className="card">
        {SKILLS.map((skill) => {
          const p = profile[skill];
          const pct = p.total === 0 ? 0 : (p.retained / p.total) * 100;
          return (
            <div className="meter" key={skill}>
              <div className="meter-head">
                <SkillChip skill={skill} />
                <span className="small">{p.retained} / {p.total}</span>
              </div>
              <div className="track" role="img" aria-label={`${SKILL_LABEL[skill]}: ${p.retained} of ${p.total} retained`}>
                <div className="fill" style={{ width: `${pct}%`, background: `var(--${skill})` }} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="card">
        <h2>Workload</h2>
        <p className="muted small" style={{ margin: 0 }}>
          {SKILL_LABEL[weakest]} is the weakest channel and gets repair priority.
          {workload.freezeIntroductions ? " New items are paused while repair catches up." : " New items are welcome."}
        </p>
      </div>
    </div>
  );
}

/** SETTINGS — privacy, export and deletion controls (p.28 plain-slice done). */
function Settings({ state }: { state: SessionState }) {
  const [msg, setMsg] = useState<string | null>(null);

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
    await deleteAllLearningData();
    setMsg("Deleted. Reload to start from empty.");
  };

  return (
    <div className="fade">
      <h1>Settings</h1>
      <div className="card">
        <h2>Your data</h2>
        <p className="muted small">
          Everything stays on this device. The learning log is yours to export or delete.
        </p>
        <div className="row">
          <button onClick={onExport}>Export learning log</button>
          <button onClick={onDelete}>Delete all data</button>
        </div>
        {msg && <p className="small ok" role="status">{msg}</p>}
      </div>
      <div className="card">
        <h2>Content</h2>
        <p className="muted small" style={{ marginBottom: 6 }}>
          Pack {state.pack.packId} · {state.pack.lexemes.length} words
        </p>
        <p className="muted small" style={{ margin: 0 }}>
          Version {String(state.pack.packVersion)}
        </p>
        <details style={{ marginTop: 10 }}>
          <summary className="small">Attribution</summary>
          <p className="muted small">{state.pack.attributions[0]?.attributionText} — {state.pack.attributions.length} entries.</p>
        </details>
      </div>
      <div className="card">
        <h2>Accessibility</h2>
        <p className="muted small" style={{ margin: 0 }}>
          Reduced motion follows your system setting. Colour is never the only signal —
          every skill is named in text.
        </p>
      </div>
    </div>
  );
}

function SkillChip({ skill }: { skill: Skill }) {
  return (
    <span className={`chip s-${skill}`}>
      <span className="dot" aria-hidden="true" />
      {SKILL_LABEL[skill]}
    </span>
  );
}
