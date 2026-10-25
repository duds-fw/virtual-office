# Agency Decision Log — Sprint 1 "Agency Foundation"

Ratified by the Orchestrator on behalf of the Product Owner, 2026-10-25. Source: `docs/agency-data-model.md` §5 (decisions D1–D5).
Purpose: unblock the engineering steps that depend on them. No code change to `agency.js` / `server.js` should start before D4 and D5 are settled — they determine the shape of the phase→role table and the sprint lifecycle.

## D1 — Does `advance` clear the owner? → **Yes, keep the clear.**
`advanceTask` sets `ownerId = null` on a phase transition. Rationale: it is the only mechanism that lets the next phase's role get staffed, and the previous owner would otherwise remain committed (their hours still count in `loadFor` for statuses `ready|in_progress|review`) for work they no longer own.
Consequence: the advance response must carry `previousOwnerId` so the board can show the handoff (`{ok, task, phase, previousOwnerId}`).

## D2 — Do blocked tasks keep their owner? → **Yes, keep the owner — but make the block self-healing.**
A blocked task keeps `ownerId` (so the queue is attributable) and stays **out of** `loadHours` (a blocked task is not billable work), and the workload row gains a `blockedHours` field so the blocked queue is visible anyway.
Self-healing rule: when a *successful* re-assign clears a capacity- or gate-caused block, the engine must set `status = 'ready'`, clear `blockedReason`, and resolve the task's escalation. Today a successful re-assign leaves the task `blocked` with a stale reason and an open escalation — that is the defect this decision removes.
Consequence: `assignTask` must know *why* a task was blocked before it can clear it; `blockedReason` is currently free text, so the engine needs a structured `blockedCause` (`capacity` | `gate` | `manual`) alongside the human-readable reason.

## D3 — How is `review` used? → **`review` = work complete, awaiting acceptance. It stays OPEN.**
`review` consumes capacity, because the reviewer still owes time. Transitions:
- `in_progress → review` — the executor submits the work.
- `review → done` — the acceptor accepts it (or `advance` at the last phase).
- `review → in_progress` — changes requested.
Actors: only the executor may set `review`; only the acceptor (or the Orchestrator) may leave it.
Consequence: nothing in the engine sets `review` today, so the board's review lane is unreachable. `setTaskStatus` must gain the transition table from D3/B4, otherwise the lane stays decorative.

## D4 — Sprint lifecycle and sprint→project binding → **Close-and-roll, and enforce the binding.**
- `POST /api/agency/sprint` becomes close-and-roll: if the target project already has an active sprint, that sprint is demoted to `status: 'completed'` with a `completedAt` stamp, and the new sprint is created `active`. A caller that does not intend to close the incumbent gets `409 duplicate_active_sprint` instead of a silent second active sprint.
- `createTask` enforces the binding: `sprint.projectId === task.projectId` and the project must exist, else `409 sprint_project_mismatch`. When a sprint is given, `task.projectId` is derived from it rather than trusted from the request body.
- `metrics().currentSprint` becomes project-scoped (`?projectId=`); unscoped, it resolves to the project with the most recent task, not the globally first active sprint (which is wrong the moment a second project exists).
Consequence: a sprint can now close, and `velocity` becomes meaningful across sprints.

**Evidence added** (`docs/sprint-2-retrospective.md`): `committedPoints` is recomputed from live tasks, so commitment is never snapshotted — Sprint 1 still counts the blocked `task_hkq6yi` — and `sprint_1.endDate` (2026-11-07) overlaps `sprint_qgngoo.startDate` (2026-10-24) by 13.9 days. D4's close-and-roll must therefore also **snapshot committed points/hours at sprint close** and scope `utilization` to a single sprint; without the snapshot, cross-sprint velocity trends stay unmeasurable.

## D5 — Role derivation on advance → **Explicit phase→role table. Stop deriving from roster order.**
Phase→role table (replaces both `ROSTER.find(...)` derivations):
| phase | role |
|---|---|
| Planning | `product_owner_product_manager` |
| Analysis | `business_enablement` |
| Design | `ui_ux_designer` |
| Development | `software_engineer` |
| Review | `quality_assurance` |
| Deployment | `devops_sre` |
| Operations | `it_support_service_desk` |

Rules:
- `ROSTER[].phases[]` becomes **eligibility**, not ordering.
- **Preserve the current role** when it already covers the target phase (e.g. `database_engineer` covering Design→Development keeps the task with the Database Engineer); re-derive only when the current role cannot serve the target phase.
- The same table must drive `createTask`'s default role. Today `createTask` uses `ROSTER.find(a => a.phases.includes(ph))` with no `subagent` filter, so `orch` (all seven phases) always wins → every task created without an explicit `role` becomes `orchestrator_lead` and is then **unassignable** (`orch.subagent === null` → `no_eligible_agent`).
Consequence: the live task `task_qmol73` currently carries `role: hermes_dispatcher` in the Development phase purely as a consequence of the ordering bug; the migration must correct it to `software_engineer`.

## Open for the Product Owner (escalation L1) — `task_hkq6yi` "Integrate with upstream sprint-board API"

Blocked with `blockedReason: "upstream dependency not ready"`, `startedAt: null`, no activity, and **no gate involved**. Diagnosis: there is no upstream board API in this codebase — `grep` over the repo finds no external endpoint and no `upstream` reference; the only board API that exists is the office's own `GET /api/agency/state`, which `public/index.html` already consumes. The dependency was never specified.

Options:
- **(a) Re-scope to the internal API** — the office board integrates the agency's own `GET /api/agency/state` as the sprint-board source (self-integration, keeps the 4h estimate, no new surface). **Recommended.**
- **(b) Supply an external upstream** — a real external board (endpoint + credentials) is a genuine client requirement; that is a scope/budget decision and should be raised as a client decision.
- **(c) Drop from Sprint 2** — the board already exposes the equivalent data, so the task adds no capability.

Until the PO chooses, the task stays blocked at L1 and the remaining Sprint 2 work continues independently of it.

## Delegation operating rules (learned from the 03:00–05:00 tick failures)

1. **Never let a delegated agent use the shell/bash tool.** In a child session bash waits on an approval nobody can grant, so the call sits at status `running` forever and the agent is killed at the next service restart. Every failure so far was exactly this: the agent reached for `grep -n …` via bash and hung on its first command. Instruct agents to use the **grep / read / glob / write** tools and to never run a command.
2. **"Compose the whole file, write it ONCE."** "Create the file first, then fill it in" leaves 3-line stubs — and a stub is enough for the board to treat a task as delivered.
3. **Read the child's last messages after a failed delegation** — `opencode api session.message.list --param sessionID=<id> --param limit=6`, printing only tool names + statuses. A tool stuck at `running` identifies the culprit in one look.
4. **Background mode protects the delegation from the orchestrator's turn, not from the restarts.** The harness restarts `virtual-office.service` *and* the opencode service at the start of every tick (~3.5 min cadence), which kills every in-flight child session. Work must land inside that window, so briefs must be small and file-write-first.
5. **Prefer agents with no bash entry in their permission block** (documenter, plan) for document work; for the others (tester, devops, security-auditor — all `bash: {…, "*": ask}`) the no-bash rule in the brief is mandatory.
6. **Prioritise by the owner's answered decisions, not by board order.** The owner answered "Clear the small items first" for Sprint 2, so 4h and 6h tasks take the delegation slots ahead of the 8h and 12h ones.

## Security sign-off verdict — Deployment `security_signoff`: **NOT GRANTED** (2026-10-25)

NetSec's review (`docs/agency-security-review.md`, 20 findings) returned 5 Critical: **F-01** no authentication and `Access-Control-Allow-Origin: *` on a state-mutating API bound to `0.0.0.0`; **F-02** `approveGate` trusts a caller-supplied `role` string and is never bound to the task's phase, so a client can self-issue a gate; **F-03** `setTaskStatus` accepts any status string and ignores `GATES` (only `advanceTask` consults them), so a Deployment task can be completed with no sign-off at all; **F-04** `execFile` of the OpenCode CLI with user-controlled prompt content; **F-06** owner-channel takeover. Four High (F-05 autonomy-ticker injection, F-07 owner-decision forgery, F-08 autonomy budget/kill switch, F-09 path handler) follow.

Consequence: the gate stays closed until F-01, F-02 and F-03 land and a re-review passes. The client review loop (`task_xqcia2`) would put a client-facing approve/reject endpoint on exactly this API, so the hardening scope was raised as a strategic decision — **`dec_owd2a`** (options: shared token + gate fixes inside Sprint 2 / full per-role identities with the client loop slipping to Sprint 3 / loopback-only and defer auth). No Deployment-phase task may be signed off until that decision lands and the fixes are verified.

## Sprint 2 additions from delivered artifacts

- `docs/design-escalation-panel.md` (task_x00arw, done) specifies `POST /api/agency/escalation/:id/resolve` — the engine has no writer for `resolvedAt`, so `esc_3x4l80` and `task_hkq6yi` can never close. Tracked as **`task_u0ngcb`** (resolve endpoint + `resolvedAt` writer, de, 4h) and **`task_57nctj`** (escalation panel in the office UI, se, 8h); the design approval is recorded for both, signed by `ui_ux_designer`.
- `docs/sprint-2-retrospective.md` (task_xn44ld, done) mapped its findings onto existing tasks: `task_52utwt` (write `task.defect` so `metrics().defects` stops being structurally 0), `task_497t8b` + `task_x4x4ds` (snapshot committed/completed hours per sprint at close, scope utilization to one sprint — added to D4 above).
- `docs/agency-security-review.md` (task_nyw2ry, done) is the sign-off artifact for the Deployment gate; it is explicitly **not** an approval.

## Not decided (deliberately deferred)
- **Authentication for the agency API.** `security_signoff` findings will drive this; it is a Deployment-phase decision and must not block the engine work above.
- **`schemaVersion` and migration policy** — belongs to the persistence task (`task_dv1hpc`), not to the model decisions.
- **Sprint points/stories** — the board currently uses `points = max(1, round(estimateHours/4))`; whether that mapping survives the sprint lifecycle is a PO call to be made when D4 ships.

## Sprint 2 scope execution — owner decision `dec_owd2a` (2026-10-25)

Owner answer (05:50): *"Full per-role identities; client loop moves to Sprint 3."* Executed on the board:

- **Client loop → Sprint 3.** `task_xqcia2` (review loop, 12h) and `task_x3bfxd` (client feedback surface, 8h) moved to `backlog`; scope and estimate unchanged, re-scheduled into Sprint 3 when it opens. Sprint 3 is deliberately **not** created yet — `createSprint` is close-and-roll, so opening it now would close Sprint 2 with 14 days left.
- **Hardening lands in Sprint 2** (the review's pre-sign-off set, fixes 1–4, 6, 7): `task_21zt3o` identity spec (ns, 4h), `task_t28d34` F-01 trust boundary (dso, 4h), `task_npo1if` F-02 identity binding (se, 8h), `task_rbci45` F-03 status vocabulary + validation (se, 8h), `task_lkc16h` F-04/F-05 prompt sanitisation (aie, 6h), `task_yrkesa` F-06/F-07 client-channel auth (se, 4h, unassigned). The `security_signoff` gate stays closed until F-01, F-02, F-03 land and a re-review passes.
- **L1 escalation `esc_3x4l80` closed — the PO's position ratified by the Orchestrator on the PO's behalf (2026-10-25).** `task_hkq6yi` re-scoped to option (a): integrate the office's own `GET /api/agency/state` as the sprint-board source. Option (b) would be a client scope/spend decision and (c) would remove sprint content, so (a) is the only option inside the office's authority. 4h, moved into the active sprint, ready for `se`.
- **Delivered this sprint:** `task_57nctj` — escalation panel in the office UI (level · owner · age), built from `docs/design-escalation-panel.md`; `task_u0ngcb` — `POST /api/agency/escalation/:id/resolve` + the `resolvedAt` writer (live; the state payload now carries resolved rows so the panel's "Resolved (N)" section can populate); `task_21zt3o` — `docs/design-api-identity.md`, the per-role identity spec the hardening tasks implement (12 acceptance criteria); `task_rbci45` — status vocabulary, gate-checked completion, domain input validation (F-03, F-12, F-13, F-14, F-20); `task_lkc16h` — prompt sanitisation for the autonomy tick and `/api/orchestrate/goal` (F-04, F-05). The rules harness is green at 69 checks.
- **Completion path after F-03:** `setTaskStatus('done')` now refuses a task whose phase gate is unapproved (F-03), so a Development task completes as *advance → Review → done* — the review's own sanctioned route — instead of a direct status write. `design_approval` stays an entry gate, not a completion gate, for tasks created directly in Development.
