# ADR-0009: Expanded language graph (Pronunciation, GrammarAtom, TaskFamily)

## Context
Spec (p.15) models language as a graph. v0.1 had only Lexeme/Sentence/Character.

## Decision
Add `Pronunciation` (syllable, tone, region, sandhi metadata, speaker/audio
assoc.), `GrammarAtom` (form, function, prerequisites, contexts, examples) and
`TaskFamily` metadata (cue direction, target skill, evidence requirements,
rubric type, leakage rules). Task/skill logic reads this metadata instead of a
hard-coded switch. Released packs stay immutable; corrections mint a new pack
version + migration map. The four permanent SkillTraces are unchanged; lower-
level nodes are evidence/explanation only (no new scheduler dimensions).

## Alternatives
- Hard-code Mandarin rules in code → rejected (belongs in content metadata).

## Consequences
Content packs carry richer, versioned metadata; the kernel stays generic.

## Spec impact
Satisfies Correction 10; preserves Mandarin-specific memory model (spec §14).
