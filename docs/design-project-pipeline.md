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
| 2 | **Triage** | Project registered | Scoped: budget, deadline, acceptance checklist | Product Owner |
| 3 | **Planning** | Triaged | Sprints opened, tasks created with estimates + owners | PO + Orchestrator |
| 4 | **Delivery** | Planned | All sprint work done; acceptance checklist evidenced | Delivery roles |
| 5 | **Acceptance** | Delivered | Product Owner accepts or requests changes | Product Owner (QA verifies) |
| 6 | **Done** | Accepted | Project closed; lessons recorded | Orchestrator |

### RACI

Responsibility is assigned per stage. **R** = does the work, **A** = accountable and
signs off, **C** = consulted, **I** = informed. Exactly one **A** per stage — that is
what makes acceptance non-vacuous, because a stage with two accountable roles is a
stage where nobody is.

| Stage | R | A | C | I |
|---|---|---|---|---|
| Registration | Owner | Owner | PO | Orchestrator |
| Triage | Product Owner | Product Owner | Orchestrator, QA | Owner |
| Planning | Orchestrator | Product Owner | Delivery roles | Owner |
| Delivery | Phase-matched delivery role | Product Owner | QA, NetSec, DevOps/SRE | Orchestrator |
| Acceptance (verification) | Quality Assurance | Product Owner | NetSec, DevOps/SRE | Orchestrator, Owner |
| Acceptance (ratification) | Product Owner | Owner | — | Orchestrator |
| Done | Orchestrator | Orchestrator | Product Owner | Owner |
| **Cross-project delivery timeline** | Orchestrator | Orchestrator | Product Owners | Owner |

**The acceptance split.** Acceptance is two acts, not one:

- **Verification** is the office's own work. QA checks each criterion in the
  acceptance checklist against the recorded evidence and marks it `met` or
  `unmet`. QA does not decide acceptance; it produces the verdict the decision
  rests on.
- **Acceptance** is the Product Owner's decision, because the PO owns scope and
  is the role that wrote the criteria. The PO accepts or requests changes.

**Why the owner is not the routine acceptor.** The owner ratifies when acceptance
*changes the agreed deal* — the scope was not met and accepting it anyway, the
budget moved, the risk is accepted. That is a strategic fork and it escalates to
the owner. A delivery that meets its checklist, unchanged in scope and budget, is
accepted by the Product Owner and merely **reported** to the owner as a digest
item. If every routine delivery required the owner's turn, the office would be a
queue of interruptions rather than a company — the owner's attention would become
the throughput limit, and every employee would learn to escalate rather than judge.

**The office must not accept its own work.** No role may both perform the
delivery and sign the acceptance for it. The delivery role and the accepting role
are always different roles.

**Cross-project delivery timeline.** The office runs multiple projects
concurrently. Capacity is shared across projects, so *which* project moves first
is a portfolio decision, not a per-project one. That is the Orchestrator's job:
maintain the cross-project timeline, sequence work against shared role capacity,
and surface a slip as a forecast before it becomes a breach. The Product Owner
owns the timeline *within* one project; the Orchestrator owns the timeline *across*
projects. When two projects contend for the same scarce role, the Orchestrator
sequences them and informs the owner — the owner decides only when the contention
changes scope, budget, or a committed date.

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
  { id: 'ac1', text: '...', met: false, metBy: ['task_abc'], evidence: '...' }
]
project.delivery = {
  summary:  'the overall delivery write-up',
  items:    [{ ref: 'path/to/artefact', summary: '...', taskId: 'task_abc' }]
}
```

`acceptanceCriteria` is a **typed checklist**, not free text. Each criterion is a
single binary, falsifiable claim with:

- `text` — the claim, phrased so it can be true or false
- `met` — `true` / `false`; no partial credit, no prose verdicts
- `metBy[]` — the `done` task(s) that evidence it
- `evidence` — how it was checked (optional, required when `met` is `false` to
  record what is missing)

**Why binary.** A checklist of free-text statements cannot gate anything — "the
API is fast" is satisfied or not, but a reader cannot verify *which* way from the
text. Binary criteria make `done` mechanically derivable: every criterion is
`met`, every `metBy` task is `done`, and the evidence is named. A criterion that
cannot be written as a single falsifiable sentence is not an acceptance criterion
— it is a goal, and belongs in `project.goal`.

**Falsifiability is a write-time rule.** The Product Owner authors the criteria at
triage; a criterion that is not falsifiable (`text` is empty, or names no
verification) is rejected when the project leaves triage. This is invariant **P2**.

`delivery` is assembled from the tasks' deliverables when the project enters
acceptance. You read **one** thing, not 26 task records.

## 4. Data model changes

Additive only — no existing field changes meaning.

### `projects[]`

| Field | Type | Notes |
|---|---|---|
| `status` | `registered\|triaged\|planning\|delivering\|acceptance\|done\|cancelled` | replaces `active`; `active` is kept as a derived alias for `planning`/`delivering` to avoid breaking readers |
| `acceptanceCriteria[]` | `{id, text, met, metBy[], evidence}` | typed checklist; required before leaving triage |
| `delivery` | `{summary, items[]}` | written on entering acceptance |
| `dueAt` | number | null = no deadline |
| `triagedAt` | number | |
| `acceptedAt` | number | |
| `closedAt` | number | |
| `acceptedBy` | matrixRole | the role that accepted — `product_owner_product_manager` normally, `client` when the owner ratified |
| `ratified` | boolean | true when the owner ratified rather than the PO accepting directly |

### `tasks[]`

| Field | Type | Notes |
|---|---|---|
| `deliverable` | object above | required on `→ done` |
| `acceptanceStatus` | `pending\|accepted\|changes_requested` | per-task owner verdict |

### Invariants

- **P1** — A project in `registered`/`triaged` has no active sprint.
- **P2** — A project leaves `triaged` only if `acceptanceCriteria.length > 0` and
  every criterion has non-empty falsifiable `text`.
- **P3** — A task reaches `done` only if `deliverable.summary` is set.
- **P4** — A project reaches `done` only if every criterion has `met === true`, at
  least one `metBy` task, and every referenced task is `done`.
- **P5** — Every task's `projectId` matches its sprint's `projectId` (already enforced).
- **P6** — `metrics()` is project-scoped: all metrics take an optional `projectId`
  and default to the active project.
- **P7** — The role that performed a delivery may not accept that delivery. The
  accepting role must differ from every role that produced a `metBy` task.
- **P8** — Only `product_owner_product_manager` or `client` may accept a project.
  The office cannot accept on the owner's behalf without ratification.
- **P9** — The Orchestrator owns the cross-project delivery timeline; a project
  may not be advanced ahead of another when they contend for the same role's
  capacity unless the Orchestrator has sequenced them explicitly.

## 5. API contract

New endpoints:

```
POST   /api/agency/project                  create (status: registered)
POST   /api/agency/project/:id/triage        scope: budget, deadline, acceptance checklist
POST   /api/agency/project/:id/plan          open a sprint (status → planning)
POST   /api/agency/project/:id/deliver       assemble delivery, move → acceptance
POST   /api/agency/project/:id/verify        QA marks each criterion met/unmet
POST   /api/agency/project/:id/accept        PO accepts or requests changes
POST   /api/agency/project/:id/ratify        owner ratifies a PO acceptance
POST   /api/agency/project/:id/cancel        cancel
GET    /api/agency/project/:id               project detail incl. delivery + checklist
GET    /api/agency/projects                  list with per-project status + progress
GET    /api/agency/timeline                  cross-project delivery timeline (Orchestrator)
```

Changed endpoints:

```
POST   /api/agency/task/:id/status           'done' now requires deliverable
GET    /api/agency/state                     projects[] carry status + checklist
GET    /api/agency/metrics?projectId=        project-scoped metrics
```

Error codes added: `project_not_registered`, `no_acceptance_criteria`,
`criterion_not_falsifiable`, `missing_deliverable`, `illegal_project_transition`,
`acceptance_not_met`, `criterion_unverified`, `self_acceptance`,
`acceptor_not_authorised`.

## 6. Isolation between projects

The office runs **multiple projects concurrently**. A second project must not
contaminate the first.

- **Board views** filter by `projectId`; the UI scopes to the selected project.
- **Metrics** take `projectId` (P6). Today's global-first-active-sprint bug is fixed.
- **Capacity** is per *role*, shared across projects — roles are the scarce
  resource. The Orchestrator sequences contending work against shared capacity
  and maintains the cross-project timeline (P9). When the contention changes
  scope, budget, or a committed date, the Orchestrator escalates to the owner;
  otherwise it decides and informs.
- **Autonomy** ticks operate on **one** project at a time *per tick*, but the
  office may have several projects in flight. A tick picks the project the
  Orchestrator's sequencing says is next; it does not interleave work inside a
  single tick across projects, which keeps each tick's context bounded.
- **Escalations and decisions** carry `projectId` (they already do).

## 7. Agent responsibilities per stage

| Stage | Agent | Does |
|---|---|---|
| Registration | Owner | States the ask |
| Triage | Product Owner (`plan`) | Scopes goal, budget, deadline, acceptance checklist |
| Planning | Orchestrator + PO | Opens sprint, creates tasks with estimates + roles |
| Delivery | Phase-matched roles | Does the work; records the deliverable |
| Acceptance — verify | Quality Assurance (`tester`) | Marks each criterion met/unmet against evidence |
| Acceptance — decide | Product Owner (`plan`) | Accepts or requests changes |
| Acceptance — ratify | Owner | Ratifies only when scope, budget or risk changed |
| Done | Orchestrator | Records lessons, closes the project |
| Cross-project timeline | Orchestrator | Sequences contending work; forecasts slips |

The autopilot tick prompt needs two new steps: *when a project enters
`acceptance`, delegate criterion verification to QA and the decision to the
Product Owner* — the office must not mark its own work accepted (P7, P8) — and
*maintain the cross-project timeline against shared role capacity* (P9).

An owner ratification item is raised only when the PO cannot accept without a
scope, budget, or risk change. A clean PO acceptance appears in the digest tier,
not the authority tier.

## 8. Client-facing surface

`briefing.js` gains a **project tier**:

```
DELIVERY READY — <project>
  3 criteria, all met (verified by QA)
  2 artefacts:  docs/design-x.md, src/feature.js
  Accepted by Product Owner — within agreed scope
```

This is a **digest** item, not an interrupt. The owner is pulled in only when the
PO could not accept without a change to scope, budget, or risk:

```
AUTHORITY — <project>
  2 of 3 criteria met. Unmet: "regression suite covers the new endpoints".
  PO cannot accept without either a scope reduction or a schedule slip.
  Options: reduce scope | extend deadline | accept the gap
```

That distinction is the difference between a company and a queue of
interruptions.

## 9. Implementation plan

**Board:** Sprint 2 (`sprint_qgngoo`), project `proj_office_build`.
**Total: 80h** — strictly within the 80h project budget. No increase is requested.

### Scope cut from the original 96h proposal (−16h)

The original plan was 96h against an 80h budget. The owner ruled: **stay inside the
budget; surface any need for more as a report item rather than exceeding it.**

Rebasing the plan against what is actually mandatory shows where the 16h must
come from. The pipeline's **backend and hardening** — model, API, office
behaviour, tests — is **67h** and is non-negotiable; it is the machinery that
makes the stages real. That leaves **13h** for the client-facing surface, against
**17h** originally budgeted for it. The 4h overage is where the cut must come
from, plus 12h more from the two tasks whose premises the owner's decisions
inverted.

| Change | Hours | Why |
|---|---|---|
| **C2** cut — autopilot works one project at a time | −4 | The premise was inverted. The office now runs **multiple** projects, so a single-project-only rule is wrong, not merely redundant. Its sequencing duty is absorbed by C1, which now sequences *across* projects under the Orchestrator's timeline. |
| **D3** cut — owner acceptance view | −8 | Acceptance moved from the owner to the Product Owner, so the owner-facing acceptance UI is no longer a core surface. The owner's view is now the **ratification** surface — a digest line plus one authority item — which D1 covers in a fraction of the work. |
| **D1** reduced — briefing project tier | −4 | D1 drops from 5h to **1h**. The PO-acceptance digest reuses the existing digest tier rather than building a new one; the only genuinely new surface is a single authority item for owner ratification. |
| **C1** unchanged | 0 | C1's original duty (raise an authority item at acceptance) is retained at 6h and additionally carries the cross-project sequencing inherited from C2. It absorbs C2's work without growing, because C2's original work — *deferring* cross-project work — is exactly what multiproject makes unnecessary. |
| **Total** | **−16** | **96 − 16 = 80h** |

**What was deliberately not cut.** The core guarantees stay intact: the typed
acceptance checklist (A2), the falsifiability rule (P2), the self-acceptance ban
(P7), the recoverability gate, and the isolation tests. A budget cut that removes
the guarantees is not a cut — it is a smaller office that still has the same
problems.

**What the cut costs, stated plainly.** The office loses a purpose-built owner
acceptance screen. Until D2 lands, a PO acceptance appears in the existing digest
and the owner reacts via the API rather than a dedicated view. That is a real
reduction in owner-facing polish, and it is the first thing to restore if the
owner raises the budget.

### Phase A — model

| # | Task | Role | Est | Board ID |
|---|---|---|---|---|
| A1 | Project status vocabulary + legal transitions (P1–P9) | Product Owner | 8h | `task_m8f2gj` |
| A2 | `acceptanceCriteria` typed checklist + `delivery` fields; validation (P2/P4/P7) | Software Eng | 6h | `task_3xe3kt` |
| A3 | Project-scoped `metrics(projectId)`; fix global-sprint bug (P6) | Data Analyst | 6h | `task_u7q52l` |
| A4 | Deliverable on task; `→ done` refuses without it (P3) | Software Eng | 5h | `task_2xssq0` |

### Phase B — API

| # | Task | Role | Est | Board ID |
|---|---|---|---|---|
| B1 | `POST /project/:id/{triage,plan,deliver,verify,accept,ratify,cancel}` | Software Eng | 8h | `task_fzzbz0` |
| B2 | `GET /project/:id`, `GET /projects` with progress, `GET /timeline` | Software Eng | 4h | `task_p6g6sr` |
| B3 | `deliverable` required on task status write | Software Eng | 3h | `task_mq8mpz` |
| B4 | New error codes + unified error envelope | Software Eng | 4h | `task_z9qfzl` |

### Phase C — office behaviour

| # | Task | Role | Est | Board ID |
|---|---|---|---|---|
| C1 | Autopilot: sequence across projects under the Orchestrator's timeline; delegate verify→QA and accept→PO; raise an authority item only when the PO cannot accept | AI Eng | 6h | `task_rk49xd` |
| C3 | Task creation requires estimate + owning role | AI Eng | 3h | `task_5az12e` |

### Phase D — client surface

| # | Task | Role | Est | Board ID |
|---|---|---|---|---|
| D1 | Briefing project tier — reuse the existing digest for PO acceptance; one authority item for owner ratification | UI/UX | 1h | `task_9z0bzj` |
| D2 | Board UI: stage lane, criteria checklist, deliverables | UI/UX | 12h | `task_xozhd5` |

### Phase E — hardening

| # | Task | Role | Est | Board ID |
|---|---|---|---|---|
| E1 | Cross-project isolation tests | QA | 6h | `task_7c5v86` |
| E2 | Illegal-transition and invariant tests (P1–P9) | QA | 4h | `task_sqpiqa` |
| E3 | Security review of the new write endpoints | NetSec | 4h | `task_bw9c4t` |

**Total 80h — within the 80h budget.**

### Sequencing note

Phase A must land before B, and B before C. Phase D can run parallel to B/C.
Phase E gates Deployment (`security_signoff`).

**Role-eligibility note:** `software_engineer` is eligible only for the `Development`
phase, so A2 and A4 sit in Development rather than Planning. The *phase* drives the
engineer's eligibility, not the logical ordering of the work — A2/A4 are still
foundations and must land before B1.

## 10. Owner decisions (resolved 2026-10-25)

All four open questions are answered. They are recorded here because the next
agent to read this design needs the *reasons*, not just the outcomes.

### D1 — Budget: strict to 80h

> *"Strict to the budget. I will evaluate if needed to raise. Make it on the
> report for my decision later."*

The pipeline is cut from 96h to **80h** — no budget increase requested. The cut
removed the two least load-bearing tasks (C2, D3) and re-scoped two others (C1,
D1), taking 16h out without touching the pipeline's core guarantees. §9 records
the arithmetic.

**Standing rule:** the office does not exceed the project budget. If the work
genuinely needs more hours, that becomes a **report item** in the owner's digest
with the specific overrun, the reason, and the options — it does not become an
overrun. The owner raises the budget; the office does not.

**Mechanism.** `briefing.js` gains a `budgetReport(state)` function and a
**📋 Budget report** section in the daily digest. A project is reported when its
*committed* work (the sum of its open tasks' estimates) plus what it has already
spent would exceed `budgetHours`. Committed work is counted, not just completed
work, because an overrun is visible **before** the hours are spent — the point
is to give the owner the decision while it is still cheap to make.

The section is a **digest** item, not an authority interrupt: it reports, it
does not block. A project inside its budget never appears in it. Cancelled tasks
and closed projects do not count. Covered by `tools/budget_report_test.js`
(14 assertions).

### D2 — Acceptance authority: RACI, PO accepts, owner ratifies

> *"Pick the role of how to deliver and what is responsible. Make it in RACI."*

Acceptance is split into **verification** (QA marks each criterion met/unmet
against evidence) and **acceptance** (the Product Owner accepts or requests
changes). The owner is the **A** for ratification only — the case where
acceptance would change scope, budget, or accepted risk. A delivery that meets
its checklist, unchanged, is accepted by the PO and reported as a digest item.

Invariants **P7** (no self-acceptance) and **P8** (only PO or client may accept)
make this enforceable rather than aspirational. The full RACI table is in §2.

### D3 — Acceptance criteria: typed binary checklist

> *"Checklist."*

`acceptanceCriteria` is a typed checklist: each criterion is one falsifiable
claim with `met: boolean`, `metBy[]`, and optional `evidence`. Free text cannot
gate a transition; binary can. A criterion that cannot be written as a single
falsifiable sentence is not an acceptance criterion — it is a goal, and belongs
in `project.goal`. **P2** enforces falsifiability at triage.

### D4 — Multi-project: yes; Orchestrator owns the cross-project timeline

> *"Multiproject. Pick the role for managing the project delivery timeline."*

The office runs **multiple projects concurrently**. The **Orchestrator** owns the
cross-project delivery timeline: sequencing work against shared role capacity,
forecasting slips before they become breaches, and deciding which project moves
first when two contend for the same scarce role. The Product Owner owns the
timeline *within* one project.

This inverts the original C2 task, which assumed a single active project; C2 is
cut and its sequencing work is folded into C1. **P9** makes the Orchestrator's
sequencing explicit.
