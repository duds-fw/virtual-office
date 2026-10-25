# Project Pipeline — Registration → Delivery

**Status:** design for review · **Author:** Office · **Date:** 2026-10-25

## 1. The problem

The office runs **one project at a time in practice** — `proj_office_build` — but the
model has no *pipeline* for a project's lifecycle. Today:

- A project is opened with `POST /api/agency/project` and immediately becomes
  `status: 'active'`. There is **no intake**: a project appears already underway.
- **There is no triage.** Every task created lands in `backlog` with a phase and a
  role guessed by `createTask` (`Planning` unless told otherwise).
- **There is no delivery boundary.** A task reaches `done` and nothing is attached —
  no deliverable, no acceptance criteria, no evidence. `done` means *someone stopped
  working on it*.
- **Metrics are not project-scoped.** `metrics()` takes the globally-first active
  sprint (`d.sprints.find(s => s.status === 'active')`), so with two projects open
  the second project's numbers are silently wrong.

The result: the owner cannot tell **what a project owes them**, and the office cannot
tell **whether a project is finished**.

## 2. The pipeline

Every project moves through six stages. Each stage has an entry condition and an
owner. A project may only advance when its stage's condition is met.

| # | Stage | Entry condition | Exit condition | Who owns it |
|---|---|---|---|---|
| 1 | **Registration** | An ask exists | Project created with goal + acceptance bar | Owner (you) |
| 2 | **Triage** | Project registered | Scoped: budget, deadline, acceptance criteria | Product Owner |
| 3 | **Planning** | Triaged | Sprints opened, tasks created with estimates + owners | PO + Orchestrator |
| 4 | **Delivery** | Planned | All sprint work done; acceptance criteria evidenced | Delivery roles |
| 5 | **Acceptance** | Delivered | Owner accepts or requests changes | Owner (you) |
| 6 | **Done** | Accepted | Project closed; lessons recorded | Orchestrator |

### Stage semantics

**Registration** — the intake boundary. Today `createProject` makes a project
`active` on creation. Under this pipeline a project is created as `registered` and
cannot be worked until triaged. This is the only new top-level status.

**Triage** — the Product Owner turns the ask into a scoped project: `goal`,
`budgetHours`, `dueAt`, and **`acceptanceCriteria`** (the bar for "delivered").
Without acceptance criteria a project cannot leave triage, because "delivered" would
otherwise be unfalsifiable. Triage also assigns the project's **delivery type**.

**Planning** — sprints and tasks. Existing machinery (`createSprint`,
`createTask`) already isolates tasks to a project and refuses cross-project
assignment (`sprint_project_mismatch`). Planning adds no new concepts; it adds the
requirement that every task carries an estimate and an owning role, which
`createTask` already enforces.

**Delivery** — the work. Gates apply as they do today (`design_approval` entering
Development, `security_signoff` entering Deployment). A task reaching `done` must
record **what it delivered**: a `deliverable` field — a path, a URL, or a short
description of the artefact.

**Acceptance** — the owner's turn. The project holds in `acceptance` while you
review the delivered artefacts against the acceptance criteria. You then either
**accept** (→ `done`) or **request changes** (→ back to `delivery`, with the gap
recorded). This is where `briefing.js`'s `decision`/`authority` tiers earn their
keep — acceptance requests are authority items, not digests.

**Done** — closed, with `lessons` recorded for the retrospective.

### Project statuses

```
registered → triaged → planning → delivering → acceptance → done
                 ↓          ↓            ↓           ↓
              cancelled  cancelled   cancelled   (back to delivering)
```

`cancelled` is reachable from any non-terminal stage. `done` is terminal.

## 3. Deliverable

The answer to "what did this project actually give me" is carried on **two** levels,
because projects deliver more than one thing and tasks deliver one thing each.

### On the task (smallest unit)

```js
task.deliverable = {
  summary:    'string, required before done',
  kind:       'code' | 'doc' | 'decision' | 'config' | 'analysis',
  ref:        'path or URL, optional',
  evidence:   'how acceptance was checked, optional'
}
```

Required when a task transitions `in_progress → done`. This is what makes `done`
mean something: the task names its artefact.

### On the project (what you receive)

```js
project.acceptanceCriteria = [
  { id: 'ac1', text: '...', metBy: ['task_abc', 'task_def'] }
]
project.delivery = {
  summary:  'the overall delivery write-up',
  items:    [{ ref: 'path/to/artefact', summary: '...', taskId: 'task_abc' }]
}
```

`delivery` is assembled from the tasks' deliverables when the project enters
acceptance. You read **one** thing, not 26 task records.

## 4. Data model changes

Additive only — no existing field changes meaning.

### `projects[]`

| Field | Type | Notes |
|---|---|---|
| `status` | `registered\|triaged\|planning\|delivering\|acceptance\|done\|cancelled` | replaces `active`; `active` is kept as a derived alias for `planning`/`delivering` to avoid breaking readers |
| `acceptanceCriteria[]` | `{id, text, metBy[]}` | required before leaving triage |
| `delivery` | `{summary, items[]}` | written on entering acceptance |
| `dueAt` | number | null = no deadline |
| `triagedAt` | number | |
| `acceptedAt` | number | |
| `closedAt` | number | |

### `tasks[]`

| Field | Type | Notes |
|---|---|---|
| `deliverable` | object above | required on `→ done` |
| `acceptanceStatus` | `pending\|accepted\|changes_requested` | per-task owner verdict |

### Invariants

- **P1** — A project in `registered`/`triaged` has no active sprint.
- **P2** — A project leaves `triaged` only if `acceptanceCriteria.length > 0`.
- **P3** — A task reaches `done` only if `deliverable.summary` is set.
- **P4** — A project reaches `done` only if every criterion has at least one `metBy`
  task and every referenced task is `done`.
- **P5** — Every task's `projectId` matches its sprint's `projectId` (already enforced).
- **P6** — `metrics()` is project-scoped: all metrics take an optional `projectId`
  and default to the active project.

## 5. API contract

New endpoints:

```
POST   /api/agency/project                  create (status: registered)
POST   /api/agency/project/:id/triage        scope: budget, deadline, acceptanceCriteria
POST   /api/agency/project/:id/plan          open a sprint (status → planning)
POST   /api/agency/project/:id/deliver       assemble delivery, move → acceptance
POST   /api/agency/project/:id/accept        accept or request changes
POST   /api/agency/project/:id/cancel        cancel
GET    /api/agency/project/:id               project detail incl. delivery + criteria
GET    /api/agency/projects                  list with per-project status + progress
```

Changed endpoints:

```
POST   /api/agency/task/:id/status           'done' now requires deliverable
GET    /api/agency/state                     projects[] carry status + acceptance
GET    /api/agency/metrics?projectId=        project-scoped metrics
```

Error codes added: `project_not_registered`, `no_acceptance_criteria`,
`missing_deliverable`, `illegal_project_transition`, `acceptance_not_met`.

## 6. Isolation between projects

A second project must not contaminate the first.

- **Board views** filter by `projectId`; the UI scopes to the selected project.
- **Metrics** take `projectId` (P6). Today's global-first-active-sprint bug is fixed.
- **Capacity** is per *role*, shared across projects — roles are the scarce
  resource. When two projects compete, the office allocates by priority and the
  owner decides which slips.
- **Autonomy** ticks operate on **one** project at a time (the active one). A tick
  that would work on a second project is deferred, not interleaved.
- **Escalations and decisions** carry `projectId` (they already do).

## 7. Agent responsibilities per stage

| Stage | Agent | Does |
|---|---|---|
| Registration | Owner | States the ask |
| Triage | Product Owner (`plan`) | Scopes goal, budget, deadline, acceptance criteria |
| Planning | PO + Orchestrator | Opens sprint, creates tasks with estimates + roles |
| Delivery | Phase-matched roles | Does the work; records the deliverable |
| Acceptance | Owner | Accepts or requests changes |
| Done | Orchestrator | Records lessons, closes the project |

The autopilot tick prompt needs one new step: *when a project enters `acceptance`,
raise an authority item for the owner via `POST /api/client/decision`.* The office
must not mark its own work accepted.

## 8. Client-facing surface

`briefing.js` gains a **project tier**:

```
DELIVERY READY — <project>
  3 criteria, all met
  2 artefacts:  docs/design-x.md, src/feature.js
  Accept or request changes: POST /api/client/decision
```

This is the one thing that interrupts the owner. Everything else stays a digest.

## 9. Implementation plan

**Board:** Sprint 2 (`sprint_qgngoo`), project `proj_office_build`. 17 tasks, **96h total**.
All are in `backlog` awaiting the autopilot; none are assigned yet.

### Phase A — model

| # | Task | Role | Est | Board ID |
|---|---|---|---|---|
| A1 | Project status vocabulary + legal transitions (P1–P6) | Product Owner | 8h | `task_m8f2gj` |
| A2 | `acceptanceCriteria` + `delivery` fields; validation (P2/P4) | Software Eng | 6h | `task_3xe3kt` |
| A3 | Project-scoped `metrics(projectId)`; fix global-sprint bug (P6) | Data Analyst | 6h | `task_u7q52l` |
| A4 | Deliverable on task; `→ done` refuses without it (P3) | Software Eng | 5h | `task_2xssq0` |

### Phase B — API

| # | Task | Role | Est | Board ID |
|---|---|---|---|---|
| B1 | `POST /project/:id/{triage,plan,deliver,accept,cancel}` | Software Eng | 8h | `task_fzzbz0` |
| B2 | `GET /project/:id`, `GET /projects` with progress | Software Eng | 4h | `task_p6g6sr` |
| B3 | `deliverable` required on task status write | Software Eng | 3h | `task_mq8mpz` |
| B4 | New error codes + unified error envelope | Software Eng | 4h | `task_z9qfzl` |

### Phase C — office behaviour

| # | Task | Role | Est | Board ID |
|---|---|---|---|---|
| C1 | Autopilot raises an authority item at `acceptance` | AI Eng | 6h | `task_rk49xd` |
| C2 | Autopilot works one project at a time | AI Eng | 4h | `task_g38j59` |
| C3 | Task creation requires estimate + owning role | AI Eng | 3h | `task_5az12e` |

### Phase D — client surface

| # | Task | Role | Est | Board ID |
|---|---|---|---|---|
| D1 | Briefing project tier + delivery-ready item | UI/UX | 5h | `task_9z0bzj` |
| D2 | Board UI: stage lane, criteria checklist, deliverables | UI/UX | 12h | `task_xozhd5` |
| D3 | Owner acceptance view (accept / request changes) | UI/UX | 8h | `task_ocngmo` |

### Phase E — hardening

| # | Task | Role | Est | Board ID |
|---|---|---|---|---|
| E1 | Cross-project isolation tests | QA | 6h | `task_7c5v86` |
| E2 | Illegal-transition and invariant tests | QA | 4h | `task_sqpiqa` |
| E3 | Security review of the new write endpoints | NetSec | 4h | `task_bw9c4t` |

**Total 96h.** The project has 80h budgeted — this is a scope decision for the owner:
either accept 96h, cut scope, or raise the budget.

### Sequencing note

Phase A must land before B, and B before C. Phase D can run parallel to B/C.
Phase E gates Deployment (`security_signoff`).

**Role-eligibility note:** `software_engineer` is eligible only for the `Development`
phase, so A2 and A4 sit in Development rather than Planning. The *phase* drives the
engineer's eligibility, not the logical ordering of the work — A2/A4 are still
foundations and must land before B1.

## 10. Open questions for the owner

1. **Budget.** 96h against an 80h project budget. Cut, or raise?
2. **Acceptance authority.** Can a role other than you accept a project's delivery,
   or is acceptance always yours?
3. **Delivery type.** Should `acceptanceCriteria` be free text, or a typed checklist
   (binary met/unmet) that gates the `done` transition? The typed form is stricter;
   free text is faster to author.
4. **Multi-project.** Do you intend to run more than one project through the office
   at once? If not, the isolation work (A3, C2, E1) is insurance rather than need.
