# ADR-0005: Task-path eligibility replaces linear channel chain

## Context
v0.1 opened skills in a fixed per-word order. Spec Correction 6 / curriculum p.9
require overlapping phases: speaking begins early, writing early in small doses,
each skill independently ready.

## Decision
Replace the per-word channel chain with per-(task-family, skill, language-object)
eligibility rules. Each task family declares prerequisites as evidence
requirements (e.g. echo/shadow speaking needs only listening exposure, not
retained reading; independent speech needs stronger prerequisites). SkillTraces
stay independent; no cross-skill mastery propagation.

## Alternatives
- Keep chain with earlier speaking → rejected (still linear/coupled).

## Consequences
Planner eligibility is data-driven from task-family metadata (ADR-0009).

## Spec impact
Satisfies Correction 6.
