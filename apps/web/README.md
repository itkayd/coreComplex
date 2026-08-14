# apps/web — plain learner body + observatory (later stages)

Stage 2+ of the build order (spec p.8, p.25–27). An installable React/TypeScript
PWA: Home, Task, Result, Progress, Settings, Library and a read-only Observatory.

**Not yet built.** The spec HARD GATE (p.8) forbids building the body or any
game layer before Stages 0–4 pass with every optional layer absent and all four
skills working through the plain body. The proven headless brain lives in
`packages/kernel`; this app will consume it through the versioned contracts
(TaskContract in, AttemptEnvelope back, LearningFact out) with no scheduler
controls inside the ordinary review flow (spec p.25 PROGRESSIVE DISCLOSURE).
