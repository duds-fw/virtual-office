# Sprint 2 Retrospective — Velocity, Throughput & Trend

Source: `state/agency.json` (read 2026-10-25) plus the live `GET /api/agency/metrics`; the state file persists no `velocity`/`metrics` block — metrics are computed per request, so this snapshot is point-in-time.

## Velocity per sprint (from `metrics.velocity`)

Sprint 2 "Client Loop & Observability" (`sprint_qgngoo`): committed 19 pts / 72 h; completed 0 pts / 0 h.
Sprint 1 "Agency Foundation" (`sprint_1`): committed 17 pts / 68 h; completed 16 pts / 64 h.
Sprint 1's shortfall is exactly `task_hkq6yi` (1 pt / 4 h), its only blocked task; `velocity` carries no `committedHours` field, so hours are derived from `tasks[].estimateHours`.
Closed in Sprint 1 (7 tasks, 16 pts, 64 h):
- `task_50twkk` Define project & sprint data model — 2 pts / 8 h
- `task_qmol73` Design office board & workload panels — 3 pts / 12 h
- `task_x448o6` Implement project/sprint/task engine — 4 pts / 16 h
- `task_dv1hpc` Persist agency state to disk — 2 pts / 8 h
- `task_u0zy75` Wire autonomy to agency API — 2 pts / 8 h
- `task_fvmqxd` Test task lifecycle & resource rules — 2 pts / 8 h
- `task_40n1sd` Deploy agency release — 1 pt / 4 h
Six of the seven closed at 2026-10-24T19:14:38Z (the exact instant `sprint_qgngoo` started); `task_50twkk` closed at 18:42:15Z — all inside 2.6 h of `sprint_1.startDate` (16:41:54Z).
Sprint 1's peak scope was 80 h / 20 pts; two mid-sprint cancellations ("Map agency workflow & requirements", "Security review of agency API") removed 12 h / 3 pts and are not visible in `velocity`.

## Throughput and utilization trend

Tasks closed per day (derived from `completedAt`): 2026-10-24 → 7; 2026-10-25 → 0; every other day → 0.
`metrics.throughput` = {completed: 7, open: 11} — a global count with no per-day or per-sprint rate.
Sprint 1 spanned 14 days (2026-10-24 → 2026-11-07) but closed 7 tasks in its first 2.6 h; Sprint 2 is 26 h old with 0 closed, 6 in_progress, 3 ready, 1 backlog.
`utilization` = {totalCapacityHours 460, totalLoadHours 68, percent 0.148} — one global figure, no sprint dimension, so no cross-sprint utilization trend exists.
Blocked hours are invisible to load: `task_hkq6yi` (4 h) is `blocked`, so `se`'s 20 h = `task_52utwt` 8 h + `task_xqcia2` 12 h only.
`se` (40 h) and `ux` (32 h) are the only agents above 40% load (50% and 44%); 10 of 17 roster agents are at 0 h.

## Escalations opened/resolved and blocked-task history

Escalations opened: 1 (`esc_3x4l80`). Resolved: 0 — `escalations[].resolvedAt` has no writer, so `metrics().escalations.open` can only grow.
`esc_3x4l80` — task `task_hkq6yi` "Integrate with upstream sprint-board API", reason "upstream dependency not ready", level 1, owner Product Owner, matrixRole `product_owner_product_manager`.
Age at block: createdAt 2026-10-24T19:12:40.336Z, blockedSince 19:12:40.365Z → blocked 29 ms after creation, never started (`startedAt` null).
Still open ~2.5 h later; level stays 1 because level = min(3, 1 + floor(age/24h)).
Blocked tasks (1 of 18): `task_hkq6yi`, status `blocked`, owner `se`, 4 h / 1 pt, sprint `sprint_1`.
`activity[]` records its creation as "Live escalation probe" (4 h) — the task's current title has no matching creation event.

## Lead time, SLA and defect counters as they exist today

`leadTime`: {avgHours: 2, samples: 7} — mean of `startedAt`→`completedAt` over the 7 done tasks.
`sla`: {completedOnTime: 7, completedTotal: 7, compliance: 1} — 100% because every closure landed 14 d before `dueAt` 2026-11-07.
`defects`: {count: 0, rate: 0} — structurally always 0: no code path writes `task.defect`, so the counter cannot move until `task_52utwt` lands.
`throughput`: {completed: 7, open: 11} — no rate field, so tasks-closed-per-day is not a metric today.
`escalations`: {open: 1, byLevel: L1 1 / L2 0 / L3 0} — "resolved" is structurally always 0 (no `resolvedAt` writer, no resolve endpoint).

## Findings

1. `velocity[].committedPoints` sums every task's points in a sprint regardless of status, so Sprint 1's 17 pts/68 h still carries blocked `task_hkq6yi` and its baseline was rewritten downward by two cancellations — the commitment is never snapshotted.
2. `sprint_1.endDate` 2026-11-07 is later than `sprint_qgngoo.startDate` 2026-10-24, so the two sprints overlap by 13.9 d and Sprint 2's 0/19 is a 26-hour-old sprint, not a velocity drop.
3. `metrics().utilization` (68/460 = 14.8%) is one global number summed across all sprints, so no sprint-over-sprint utilization trend can be derived from it at all.
4. `leadTime.avgHours` 2 and `sla.compliance` 1 are artifacts of the seed minute: all 7 closures share the timestamp 2026-10-24T19:14:38Z against a `dueAt` 14 d out, so neither counter can discriminate yet.
5. `task_hkq6yi` is titled "Integrate with upstream sprint-board API" in `tasks[]` but was created as "Live escalation probe" in `activity[]`, and its escalation `esc_3x4l80` can never resolve because `escalations[].resolvedAt` is never written.

## Recommended changes

1. `task_52utwt` "Defect reporting path and defect-rate metric" (Development, 8 h, software_engineer): write `task.defect` at review rejection and expose defect count/rate per sprint, so `metrics().defects` stops being structurally 0.
2. `task_x00arw` "Escalation panel showing level, owner and age in the office UI" (Design, 6 h, ui_ux_designer): add `POST /api/agency/escalation/:id/resolve` plus a `resolvedAt` writer, so `esc_3x4l80`/`task_hkq6yi` can close and `escalations.open` can fall.
3. `task_497t8b` "Budget tracking: project budget vs hours consumed" (Development, 8 h, database_engineer): snapshot `committedHours`/`completedHours` per sprint at close and scope utilization to one sprint, with `task_x4x4ds` "Runbook & SLA monitoring" (Operations, 4 h) owning an on-time % that is not trivially 100%.
