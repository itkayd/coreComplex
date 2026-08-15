# ADR-0006: Due-based workload forecast via ts-fsrs simulation

## Context
v0.1 approximated reviews from stability×horizon. Spec Correction 4 requires
forecasts from real scheduling state under high/expected/low recall.

## Decision
The governor rolls each trace forward deterministically using the ts-fsrs
adapter from its actual current due/state, applying a versioned per-scenario
rating policy (high→Good, expected→mostly Good with periodic Hard, low→Again-
heavy). Only reviews that fall due inside the horizon count. Tracks reviews,
due-minutes, per-skill load, relearning/repair load, novelty, backlog and
overload reason codes for 7- and 30-day horizons.

## Alternatives
- Closed-form estimate → rejected (ignores real due timing).

## Consequences
Scenario policies are versioned (`WORKLOAD_SCENARIOS_VERSION`) for reproducible
forecasts.

## Spec impact
Satisfies Correction 4.
