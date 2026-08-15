# ADR-0008: Correct causal graph

## Context
Chronological order is insufficient. Spec Correction 9 requires causationId to
point to the direct cause and correlationId to group the review.

## Decision
Chain: AttemptAccepted →(causation) EvidenceValidated →(causation) TraceUpdated
→(causation) ConsolidationRecorded →(causation) LearningFactPublished. All share
the session correlationId. Reject / self-grade-required attempts terminate at
EvidenceValidated with no TraceUpdated/Fact. Tests assert the exact edges.

## Alternatives
- Rely on order → rejected (observatory needs true causality).

## Consequences
Observatory replay can reconstruct the causal tree.

## Spec impact
Satisfies Correction 9.
