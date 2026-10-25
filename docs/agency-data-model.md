# Agency Data Model — Sprint 1 "Agency Foundation"

Owner: Product Owner (`product_owner_product_manager`) · Task: `task_50twkk` · Source of truth: `agency.js`

All claims below were read out of `agency.js` / `server.js`; where the stated rule and the code disagree, the code is called out explicitly.

## 1. Persistence envelope

`state/agency.json` — one JSON document, written atomically (tmp + rename).

```json
{ "projects": [], "sprints": [], "tasks": [], "escalations": [], "standups": [], "activity": [], "createdAt": 0 }
```

`agency.js` keeps an in-memory copy (`db`) and rewrites the whole file on every `save()`. There is no `schemaVersion`.

**Hazard:** if the file parses but `tasks` is not an array, `load()` reseeds and **overwrites the file** — silent total data loss. Fixed by the persistence task (`task_dv1hpc`).

## 2. Entities

### Project — `projects[]`
| field | type | notes |
|---|---|---|
| `id` | string | `proj_` + 6 base36 |
| `name` / `goal` / `client` | string | free text; `client` defaults to `internal` |
| `status` | string | only `active` is ever written — there is no transition |
| `budgetHours` | number | defaults to 480; **never read by metrics** |
| `createdAt` | ms | |

### Sprint — `sprints[]`
| field | type | notes |
|---|---|---|
| `id` | string | `sprint_` + 6 base36 |
| `projectId` | string | **not validated** against `projects[]` |
| `name` / `goal` | string | free text |
| `startDate` / `endDate` | ms | `endDate = start + days*86400000` |
| `status` | string | only `active` is written — **sprints are immortal, there is no close path** |
| `createdAt` | ms | |

### Task — `tasks[]`
| field | type | notes |
|---|---|---|
| `id` | string | `task_` + 6 base36 |
| `projectId` | string | **not validated** |
| `sprintId` | string \| null | **sprint→project binding is not enforced** |
| `title` | string | free text |
| `phase` | enum(7) | `Planning, Analysis, Design, Development, Review, Deployment, Operations`; invalid coerces to `Planning` |
| `role` | enum(17 matrixRole) | the matrixRole of the agent expected to execute |
| `estimateHours` | number | `Number(x) \|\| 8` → **`0` becomes `8`** |
| `points` | number | `max(1, round(estimateHours/4))` — 8h→2, 12h→3, 16h→4 |
| `ownerId` | string \| null | roster id; null = unstaffed |
| `status` | enum(6) | `backlog, ready, in_progress, review, blocked, done` — **not validated on write** |
| `gates` | object | `<gateId>: "approved"`, `<gateId>_by: role`, `<gateId>_at: ms` |
| `blockedReason` | string \| null | **stale after a successful re-assign** |
| `createdAt` / `startedAt` / `completedAt` / `dueAt` | ms \| null | `completedAt` is written **only** by `advanceTask` |
| `defect` | boolean | **no writer** — `metrics().defects.count` is therefore always 0 |

### Agent (roster) — **not persisted**, module constant `ROSTER` in `agency.js`
| field | type | notes |
|---|---|---|
| `id` | string | `orch, hermes, po, be, da, ux, se, de, aie, qa, ns, soc, dso, ce, iti, dba, sd` |
| `matrixRole` | string | 17 roles; a task's `role` field holds one of these |
| `subagent` | string \| null | the OpenCode subagent that performs the work; null for `orch` only |
| `capacityHours` | number | documented as *per sprint*, **implemented globally across sprints** |
| `phases` | string[] | phases the agent may serve |
| `manager` | — | **the field does not exist on any entry** → every `!a.manager` check is dead code; `workload().status` can never be `manager` |

**Duplication:** `server.js` re-declares the role→subagent map inside the `/api/orchestrate/goal` prompt; it is kept in sync by hand.

### Gate — constant `GATES` + per-task `task.gates`
| target phase | `gate.id` | approver roles |
|---|---|---|
| `Development` | `design_approval` | `ui_ux_designer`, `product_owner_product_manager` |
| `Deployment` | `security_signoff` | `network_and_security`, `security_operations_soc` |

`approveGate` does not check that the gate is relevant to the task's current phase — a `security_signoff` can be signed on a Planning task.

### Escalation — `escalations[]`, written only by `recordEscalation`
`id, taskId, taskTitle, reason, level (1..3), owner, matrixRole, blockedSince, createdAt, resolvedAt`.

- `level = min(3, 1 + floor((now - blockedSince)/24h))` — `blockedSince` is the level clock.
- **`resolvedAt` is never written by any code path** → escalations cannot be closed; `metrics().escalations.open` only grows.
- One escalation per task, forever; re-blocking overwrites the reason but keeps the original `blockedSince` (inflated level).

### Standup — `standups[]`, upserted by `standup()` (one record per day, cap 60)
`date` (YYYY-MM-DD), `createdAt`, `agents[]` (`agentId, name, title, matrixRole, done[], inProgress[], blockers[], loadHours, capacityHours`), `totals`.

**Two live defects:** (a) `date` uses `new Date().toISOString().slice(0,10)` — **UTC**, while `server.js` has a `localDate()` helper for exactly this; the standup rolls over at 08:00 local (live record is dated `2026-10-24` while the local date is `2026-10-25`). (b) `standup()` **mutates and saves**, and it is invoked by `state()`, so every `GET /api/agency/state` writes the state file.

### Activity — `activity[]`, written by `logActivity`
`{ time, who, text }`, cap 200; `state()` exposes the first 50.

## 3. Invariants

| # | rule | enforced today? | evidence / gap |
|---|---|---|---|
| B1 | `task.sprintId` must exist and `sprint.projectId === task.projectId` | **no** | `createTask` never compares them; `createSprint` never checks the project exists |
| B2 | one active sprint per project (creating one demotes the incumbent to `completed`) | **no** | `createSprint` always writes `active`; `metrics()` takes the **globally first** active sprint |
| B3 | status ∈ {backlog, ready, in_progress, review, blocked, done} | **no** | `setTaskStatus` assigns blindly; any string persists and is silently ignored by `OPEN_STATUSES`, `loadFor` and the UI pills |
| B4 | only legal transitions, with a defined actor | **no** | any status → any status via `POST /task/:id/status` |
| B5 | `committed(agent) = Σ estimateHours` over that agent's tasks with status ∈ {ready, in_progress, review}; reject if `committed + estimate > capacityHours`; on rejection set `blocked` + `blockedReason` + record escalation | **partial** | only in `assignTask`; see sub-issues below |
| B6 | a task may not **enter** Development without `design_approval`, nor Deployment without `security_signoff`, signed by a role in `approverRoles` | **yes** | `advanceTask` checks the gate before mutating the phase; `approveGate` checks `approverRoles`. Approval is not phase-scoped and never expires |
| B7 | advance: `phase += 1`; re-derive `role`; `status = ready`; `ownerId = null`; `blockedReason = null`; `startedAt ||= now` | **yes, but role derivation is broken** | `ROSTER.find(a => a.phases.includes(nextPhase) && !a.manager && a.subagent)` always returns `hermes_dispatcher`, because `hermes` is the first entry with a truthy `subagent` and all 7 phases. Live proof: `task_qmol73` sits in Development with `role: hermes_dispatcher` |
| B8 | `done` is terminal and stamps `completedAt` | **no** | `setTaskStatus(id,'done')` bypasses `advanceTask` and leaves `completedAt` null → lead-time and SLA under-report |
| B9 | escalations are resolvable | **no** | no writer of `resolvedAt`, no endpoint |

### B5 sub-issues (all reachable today)
1. **Self double-count** — `committed` is computed *before* `ownerId` changes, so re-assigning a task to its current owner counts that task's hours twice and can trip a false `insufficient_capacity`.
2. **Blocked tasks keep an owner but contribute 0 load** — `'blocked' ∉ OPEN_STATUSES`, so the workload panel under-reports the queue; and a later *successful* re-assign leaves the task `blocked` with a stale `blockedReason` and an open escalation.
3. **Capacity is sprint-agnostic** — `loadFor` sums tasks across **all** sprints; two active sprints double-charge the same agent.
4. **`setTaskStatus` bypasses capacity** — nothing re-checks capacity when a task goes `in_progress`.
5. **Default role derivation has the same ordering defect** — `createTask` uses `ROSTER.find(a => a.phases.includes(ph))` with **no** `subagent` filter → `orch` (all phases) wins → `role: orchestrator_lead`, and since `orch.subagent === null`, auto-assign then fails with `no_eligible_agent`. **Any task created without an explicit `role` is unassignable.**

## 4. HTTP contract

Base `http://127.0.0.1:9012`; CORS `*`; JSON. **No authentication, no authorization, no rate limit** on a state-mutating API bound to `0.0.0.0`.

### Reads
| endpoint | response | side effects |
|---|---|---|
| `GET /api/agency/state` | `{phases, gates, escalationPath, projects[], sprints[], tasks[], roster[], escalations[], activity[], metrics, standup}` | **writes** (standup upsert + save) |
| `GET /api/agency/metrics` | `{velocity[], currentSprint, leadTime, utilization, defects, sla, throughput, escalations}` | none |
| `GET /api/agency/standup` | today's standup record | **writes** |
| `GET /api/agency/workload` | `{roster:[{id,name,title,matrixRole,subagent,capacityHours,phases,loadHours,freeHours,utilization,status}]}` | none |

### Writes
| endpoint | body | success | error `reason` |
|---|---|---|---|
| `POST /api/agency/task` | `{title?, projectId?, sprintId?, phase?, role?, estimateHours?, ownerId?, assign?:false}` | always **200**, even when assignment failed (`assignment.ok === false`) | inside `assignment`: `task_not_found`, `agent_not_found`, `no_eligible_agent`, `insufficient_capacity` |
| `POST /api/agency/assign` | `{taskId, ownerId?}` | 200 `{ok, agentId, task}` | 409: `task_not_found`, `agent_not_found`, `no_eligible_agent`, `insufficient_capacity` |
| `POST /api/agency/advance` | `{taskId}` | 200 `{ok, task, phase}` | 409: `already_done`, `bad_phase`, `gate_pending` (+`gate`, `label`) |
| `POST /api/agency/approve` | `{taskId, gate, role}` | 200 `{ok, task}` | 409: `unknown_gate`, `role_not_approver` (+`approverRoles`) |
| `POST /api/agency/task/:id/status` | `{status, reason?}` | 200 `{ok, task}` | 404 `task_not_found` — the only error surfaced; no vocabulary or transition check |
| `POST /api/agency/sprint` | `{projectId?, name?, goal?, days?}` | 200 | — |
| `POST /api/agency/project` | `{name?, goal?, client?, budgetHours?}` | 200 | — |

Malformed JSON → `400 {ok:false, error}`.

### Target contract (sprint exit criteria)
Unify the error envelope to `{ok:false, error:{code, message, details?}}`; use **400 malformed / 403 forbidden role / 404 unknown entity / 409 rule violation**:

`insufficient_capacity`, `gate_pending`, `role_not_approver`, `already_done`, `no_eligible_agent`, `invalid_status`, `illegal_transition`, `unknown_gate`, `task_not_found`, `agent_not_found`, `bad_phase`, `sprint_project_mismatch`, `duplicate_active_sprint`.

Note `gate_pending` currently records **no escalation**, unlike the capacity path — align them.

### Missing endpoints
`GET /api/agency/task/:id` · `GET /api/agency/escalations?include=resolved` · `POST /api/agency/escalation/:id/resolve` · `POST /api/agency/sprint/:id/close` · `GET /api/agency/sprints?projectId=` · **auth** (at minimum a shared token on all `/api/agency/*` writes).

## 5. Open decisions (PO)

**D1 — Does `advance` clear the owner?** *Recommendation: keep the clear.* It is the only mechanism that lets the next phase's role get staffed, and keeping the owner would leave them committed for work they no longer own. Mitigate by returning `previousOwnerId` in the advance response.

**D2 — Do blocked tasks keep their owner?** *Recommendation: keep the owner, keep blocked tasks out of `loadHours`, and make the block self-healing.* On a successful re-assign of a capacity- or gate-blocked task: `status = ready`, clear `blockedReason`, resolve the escalation. Add `blockedHours` to the workload row so the queue stays visible.

**D3 — How is `review` used?** *Recommendation:* `review` = "work complete, awaiting acceptance"; it stays **open** (consumes capacity) because the reviewer still owes time. Transitions: `in_progress → review` (executor submits), `review → done` (acceptor), `review → in_progress` (changes requested). Today nothing in the engine ever sets `review`, so the board's review lane is unreachable in practice.

**D4 — Sprint lifecycle and binding.** *Recommendation:* `POST /sprint` becomes close-and-roll (demote the project's active sprint to `completed` + `completedAt`); enforce B1 in `createTask`; scope `metrics().currentSprint` to a project (today it takes the globally first active sprint).

**D5 — Role derivation on advance.** *Recommendation:* replace both ordering-based derivations with an explicit phase→role table (`Planning→product_owner_product_manager, Analysis→business_enablement, Design→ui_ux_designer, Development→software_engineer, Review→quality_assurance, Deployment→devops_sre, Operations→it_support_service_desk`), keep `phases[]` as *eligibility* not *ordering*, and preserve the current role when it already covers the target phase. Today every advanced task is silently re-routed to Hermes — a live defect, not a preference.

## 6. Execution plan for the sprint

| step | agent | complexity | depends on | verification |
|---|---|---|---|---|
| 1 Ratify this spec and D1–D5 | `plan` (PO) | trivial | — | no TBD left |
| 2 Phase→role table; fix both derivations | `general` (software_engineer) | simple | D5 | task created without `role` yields `product_owner_product_manager`; advanced Development task yields `software_engineer` |
| 3 Enforce B1/B3/B4/B5/B7/B8/B9 in `agency.js` | `general` (software_engineer) + `general` (database_engineer) | complex | D2/D4, 2 | each invariant has ≥1 negative test failing pre-fix |
| 4 Persistence hardening + migration (`schemaVersion`, non-destructive load, standup local date, migrate live `task_qmol73.role`) | `general` (database_engineer) | simple | 3 | corrupt file no longer destroys state; standup date matches local date |
| 5 HTTP hardening + new endpoints + error envelope | `general` (software_engineer) | simple | 3 | `curl` each endpoint for status codes; unauthenticated POST rejected |
| 6 Lifecycle + resource test suite (`node --test`, no deps) | `tester` (QA) | complex | 3, 4 | `node --test` green; B1–B9 covered |
| 7 Board + workload UI refresh (gate chips, blocked reason, review lane, utilization %) | `documenter` (UI/UX) | simple | 5 | every status renders; no unescaped interpolation |
| 8 Security review of the agency API | `security-auditor` (NetSec) | simple | 5 | findings list with severity and fix-or-accept per finding; no unresolved High |
| 9 Deploy the agency release (backup, restart, smoke) | `devops` (DevOps/SRE) | simple | 5, 6, 8 | `tools/agency_check.py summary` shows the expected board |
| 10 Runbook & SLA monitoring | `general` (IT Support) | simple | 9 | rollback dry-run restores the previous state |

**Parallelizable:** 6, 7, 8 once 3/5 land. **Critical path:** 1 → 2 → 3 → 5 → 6 → 9.

## 7. Risk assessment

- **High risk:** step 3 (touches every mutation path — capacity, gates, transitions, escalations) and step 4 (migrating the live state file).
- **Medium risk:** step 5 (the autopilot prompt consumes POST responses — keep the legacy `reason`/`ok` keys alongside the new `error.code` for one sprint) and step 2 (role re-derivation changes who owns in-flight tasks).
- **Rollback:** `cp state/agency.json state/agency.json.bak-<ts>` before any migration or deploy; `agency.js`/`server.js` are two dependency-free files, so rollback is a file restore + restart; the migration is additive (defaults + one corrected role). Kill switch for the autopilot: `touch /home/opencode/virtual-office/.autonomy_stop`.
- **Unresolved:** until step 2 lands, every advanced task keeps landing on Hermes, and the board's role column stays wrong.
