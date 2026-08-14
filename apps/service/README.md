# apps/service — self-hosted API + speech/content jobs (later stages)

Stage 4+ (spec p.24, p.25). A FastAPI service exposing the versioned commands
and queries (spec p.24):

- Commands (write events): POST /sessions/plan, /attempts, /attempts/{id}/self-grade,
  /voice/analyse, /imports/private; DELETE /voice, /voice/{id}
- Queries (return projections): GET /sessions/{id}, /traces/{id},
  /progression/frontier, /workload/forecast, /facts?cursor=, /observatory/frame,
  /attributions

**Not yet built.** Store separation (spec p.24): learning.db holds events,
traces, graph state and facts; game.db holds cosmetics and projection cursors
only; voice blobs use short-lived encrypted storage. The event envelope and
offline/reconnect rules are already defined in `packages/domain`.
