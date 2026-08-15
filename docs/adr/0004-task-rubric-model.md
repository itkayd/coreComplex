# ADR-0004: Versioned task rubric

## Context
A TaskContract was cue+target+answer. Spec Correction 5 requires exercises to be
evidence instruments with explicit, versioned rubrics; private answers must not
sit in learner-facing contracts.

## Decision
Introduce `TaskRubric` (versioned) per task family: matching policy, accepted
variants, latency band, hint penalties, replay/reveal rules, and — for
production — separate evidence components (transcript, initials/finals, tone,
rhythm, fluency, automation confidence). The learner-facing `TaskContract`
carries a `rubricRef` + `rubricVersion`; the private answer key lives only in the
kernel. Accepted evidence stores the rubric version used.

## Alternatives
- One generic validator → rejected (cannot represent speaking/writing).

## Consequences
Evidence validation dispatches on rubric. Copy-typing and ASR-match are
explicitly non-authoritative.

## Spec impact
Satisfies Correction 5; supports evidence-gate done criteria (p.28).
