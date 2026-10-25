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

## D6 — Is the office's own code under version control? → **Yes. It was not, and that was a gap in the standard.**

Recorded 2026-10-25. The Virtual Office — 3,879 lines across 8 modules, 15 tasks
done across Sprints 1 and 2 — existed only on disk. No git repository, no history,
no way to revert a bad edit, no way to see what changed between two states of the
board. A `.gitignore` containing `.database-mcp/` was present, carried over from an
unrelated repo, which shows the omission was inherited rather than deliberate.

**Why the office did not catch it.** Not a judgement failure — a missing standard.
The board's definition of done was estimate + role + phase + gate. `task.deliverable`
did not exist, so "what did you produce" had no field to answer with. Nothing in
`AGENTS.md` required code to be recoverable. The security review (`docs/agency-security-review.md`)
examined path traversal, authentication and prompt injection — the *quality* of the
artefact — and no review examined the *durability* of the artefact. There was also no
incident to make the risk visible: nothing had been lost yet, and the absence of an
incident felt like the absence of a risk.

**Resolution — three changes, in the place that makes them standing rules rather
than reminders:**

1. **The project is now under git**, with `state/` and `state/client.json` (the owner
   bot token) excluded. First commit `c2ff93c`; remote `duds-fw/virtual-office`.
2. **`AGENTS.md` gains a "Version control (standing rule)" section.** Committing
   locally is inside any role's authority and must not be asked for. Pushing, opening
   a pull request and tagging a release are client-visible and stay with the owner.
3. **Two board tasks make it structural, not documentary:**
   - *Standards: add a `deliverable.ref` check for code tasks* (se, 3h) — a `code`
     deliverable must carry a commit SHA; `setTaskStatus('done')` refuses without it
     (invariant P3).
   - *Gate: a code deliverable must be recoverable before Deployment opens*
     (dso, 4h) — the Deployment gate also checks that `deliverable.ref` resolves to a
     real commit and that the delivered files have no uncommitted changes.

**The escape hatch is not the answer.** A missing engineering standard must not be
resolved by asking the owner to make the call each time — that builds a company
which needs its founder for every judgement. The owner is consulted for strategic
forks (scope, budget, risk, priority); recoverability is an engineering standard,
and DevOps/SRE owns it. The office now has the standard and the enforcement.

## D7 — Owner decisions on the project pipeline (budget, acceptance authority, criteria type, multi-project)

Recorded 2026-10-25. Four strategic questions were open on the pipeline design
(`docs/design-project-pipeline.md` §10). The owner answered all four. These are
strategic forks — scope, budget, risk, and client relationship — so they are the
owner's to decide, and the office records them here so the employees act on the
answers rather than re-deriving them.

### D7.1 — Budget: strict to 80h

> *"Strict to the budget. I will evaluate if needed to raise. Make it on the
> report for my decision later."*

The pipeline is cut from 96h to **80h** — no budget increase requested. The cut
took the 16h from the client-facing surface (C2, D3, D1), because the backend,
the office behaviour and the hardening tests — 67h — are what make the stages
real and cannot be cut without producing an office that fails the same ways it
does today.

**Standing rule:** the office does not exceed the project budget. If the work
genuinely needs more hours, that becomes a **report item** in the owner's digest,
carrying the specific overrun, the reason, and the options. It does not become
an overrun. The owner raises the budget; the office does not.

### D7.2 — Acceptance authority: RACI; the PO accepts, the owner ratifies

> *"Pick the role of how to deliver and what is responsible. Make it in RACI."*

Acceptance splits into two acts:

- **Verification** — QA marks each criterion in the checklist `met`/`unmet`
  against the recorded evidence. QA produces the verdict; it does not decide.
- **Acceptance** — the **Product Owner** accepts or requests changes, because the
  PO wrote the criteria and owns scope.
- **Ratification** — the owner, and only when acceptance would change scope,
  budget, or accepted risk. A delivery that meets its checklist unchanged is
  accepted by the PO and reported as a digest item.

**Invariants P7** (no self-acceptance) and **P8** (only PO or client may accept)
make this enforceable rather than aspirational.

**Why this is not a weakened standard.** The office does not accept its own
work — the verifying role and the accepting role are always different roles.
What changes is *whose attention* is spent, not *whether* anyone checks. If every
routine delivery required the owner's turn, the owner's attention becomes the
throughput limit and every employee learns to escalate instead of judge. The
owner is interrupted only for genuine forks.

### D7.3 — Acceptance criteria: typed binary checklist

> *"Checklist."*

Each criterion is one falsifiable claim with `met: boolean`, `metBy[]`, and
optional `evidence`. Free text cannot gate a transition; binary can. A criterion
that cannot be written as a single falsifiable sentence is not an acceptance
criterion — it is a goal, and belongs in `project.goal`. **P2** enforces
falsifiability at triage.

### D7.4 — Multi-project: yes; the Orchestrator owns the cross-project timeline

> *"Multiproject. Pick the role for managing the project delivery timeline."*

The office runs **multiple projects concurrently**. The **Orchestrator** owns the
cross-project delivery timeline: sequencing work against shared role capacity,
forecasting slips before they become breaches, and deciding which project moves
first when two contend for the same scarce role. The Product Owner owns the
timeline *within* one project.

This inverted C2, which assumed a single active project. C2 is cut; its
sequencing duty now lives in C1 and P9 makes the Orchestrator's sequencing
explicit. The owner is consulted only when contention changes scope, budget, or
a committed date.

### Standing rule for the office

These four answers are now the office's standard, not a pending question. Any
role implementing pipeline work must follow §2 (RACI), §3 (typed checklist), and
§4 (P1–P9) of `docs/design-project-pipeline.md` without asking whether those
were the intended answers. If the implementation hits a genuine fork — one where
the choices have different business outcomes — it escalates through
`POST /api/client/decision` with the question, the context, and concrete
options.

## D8 — Proposal: the Virtual Office SOP and role guidelines (awaiting owner review)

Recorded 2026-10-25. The owner asked for a Standard Operating Procedure for the
Virtual Company and a guideline for each role/department, on international
best-practice footing, to review and apply on approval. Two drafts are on disk:

- `docs/sop-virtual-office.md` — the company SOP. 19 sections, every normative
  clause carrying a stable id (`SOP-x.y`), a `[shipped]` / `[designed]` /
  `[proposed]` marker on each area, and an explicit standards-mapping table.
- `docs/role-guidelines.md` — the per-role guidelines. 17 roles in 7
  departments, each on the same 13-heading template: purpose, scope, phase
  eligibility, accountabilities, standard operating procedure, inputs/outputs,
  decision rights, gates, KPIs, escalation triggers, standard of work,
  standards reference, conflict-of-interest rule.

**These are drafts. They are not in force.** The SOP says so in its header and
in §19, the guidelines say so in their header and in §11, and the owner has not
signed either. Until ratification, `AGENTS.md` and the owner decisions in this
file remain the operative authority.

### D8.1 — Standards used as design references, not as a compliance claim

The owner asked for "the best practice based on international licensed". The
honest reading is *international standards and licensed frameworks*, and the
office uses them that way — for structure, control themes and practice
definitions — **not** as a compliance programme.

Anchored to: ISO 9001:2015, ISO/IEC 27001:2022 Annex A, ISO/IEC 42001:2021,
ISO/IEC 25010:2023, ISO/IEC 20000-1, NIST SP 800-53 Rev. 5, NIST SP 800-61
Rev. 3, NIST AI RMF 1.0, OWASP ASVS V4, OWASP Top 10, ITIL 4, COBIT 2019,
Scrum Guide 2020, PMBOK 7, RFC 2119, RFC 9110, WCAG 2.2, CIS Controls v8.

**The office is not certified to any standard** and no clause may be presented
as evidence of conformity. SOP §17 states this explicitly, names the standards
that are *not* claimed, and lists what a real audit would find — including that
no independent audit has been performed and that no conformity evidence exists.
Frameworks whose subject matter does not exist here (ISO 13485, HIPAA, PCI DSS,
IEC 62443, ISO/IEC 27017/27018, TOGAF) were deliberately excluded, and the
exclusion is stated so the reader knows the selection was deliberate.

### D8.2 — The largest hazard: designed vs shipped

The 6-stage project pipeline ratified in D7 is **designed, not implemented**.
`agency.js` still creates projects with `status: 'active'`; there is no
`acceptanceCriteria`, no `task.deliverable`, no `verify`/`ratify` endpoint. An
SOP that described the pipeline as live would contradict the running code, and
an agent following it would look for controls that do not exist.

Every affected clause therefore carries a status marker:
`[shipped]` (enforced by code today, with the symbol named), `[designed]`
(spec'd but unimplemented, with the design doc named), `[proposed]` (new in the
SOP, neither code nor owner decision yet).

The same honesty applies to security. The `security_signoff` gate has **never
been approved** and the Deployment gate is **closed** — F-01 (no authentication
on state-mutating routes), F-06 (owner-channel takeover) and F-07
(owner-decision forgery) remain open. SOP §4.6 states this, and forbids the
office from describing a Deployment path as available while it holds.

### D8.3 — Precedence, and a mechanical guard against drift

Two documents describing a moving system will drift. SOP §15.4 fixes the
precedence order: `agency.js` (mechanism) > `docs/agency-decisions.md`
(authority) > the SOP (procedure) > the role guidelines (role detail) >
`AGENTS.md` (working rules). A lower-ranked document must not override a
higher-ranked one.

`tools/sop-consistency-check.js` makes that enforceable rather than aspirational.
It reads the real values out of `agency.js` and asserts the documents match —
145 checks covering the roster, phase eligibility, status vocabulary, gate ids
and approvers, escalation levels, per-role capacity, the token budget, clause
cross-references, invariant definitions, and a scan for false compliance claims.
It was validated by mutation: eight deliberate corruptions (a role claiming a
phase the code forbids, a false compliance claim, a bogus gate id, a wrong
capacity, a broken clause citation, a deleted role section, an invented
escalation level, a removed invariant) were each caught.

The check is a **draft-time control**. Wiring it into the office's regression
gate is part of the ratification task on the board.

### D8.4 — What the SOP deliberately does not do

- It does not write the employees' reasoning. It prescribes **outputs and
  evidence**, not how a role should think — consistent with D7.2's rule that a
  defensible engineering answer belongs to the employee.
- It does not invent targets. Every KPI names the board field it reads, and no
  numeric target is published that the board cannot derive (SOP-9.2).
- It does not invent a governance apparatus the office does not have — no
  change advisory board, no CMDB, no conformity assessment.
- It does not restate shared procedures 17 times. Departments 6 and 7 are
  shared-subagent departments: one procedure, role-specific overlays.

### Standing rule

Until the owner ratifies, nothing in either document overrides `AGENTS.md` or
the decisions in this file. On ratification, the SOP and the guidelines become
the office's procedure, the owner decision is recorded here as the ratification
entry, and the signature sheets are completed.

---

## D8.1 — Closing the pipeline-control gap in the SOP and guidelines

Recorded 2026-10-25, extending D8. The owner asked a precise question: *is the
SOP and guideline already designed to control the pipeline?* The honest answer
at the time D8 was written was **partial** — and the gap was worth recording
because it is the same shape as D6.

### The gap

The first draft of the SOP controlled **who decides** (RACI in §3.3) and
**what must hold** (invariants P1–P9 in §3.4). It did not control **the state
machine that enforces it**. Specifically it lacked:

1. The **project status vocabulary** — the seven legal states
   (`registered|triaged|planning|delivering|acceptance|done|cancelled`) appeared
   only inside invariant P1/P2. SOP §4.2 listed the *task* statuses. A reader
   could not look up what a project's legal states were, or what `active` meant.
2. The **legal transition set** — no section stated which transitions exist, so
   no rule could forbid an illegal one.
3. The **transition table** — no statement of each transition's trigger,
   initiator, precondition and enforcer. Without a precondition per transition,
   "controlled" is a claim rather than a control.
4. The **transition error codes** — the design doc defined nine; the SOP
   defined none, so a refusal had no agreed vocabulary.
5. The **API surface** — nothing tied the state machine to the endpoints that
   enforce it, which left open the possibility of a status changing by some
   route other than the governing one.
6. The **role procedures** — the Orchestrator and Product Owner had general
   procedures but none for moving a project between stages.

The office's own standard is D6's lesson: a written standard without
enforcement is a reminder. A procedure that describes the pipeline without
specifying the transitions is the same defect one layer up.

### What was added

**SOP §3.5 — the project stage machine** (clauses SOP-3.6 … SOP-3.13):

- §3.5.1 — the seven-state project status vocabulary, with `active` demoted
  to a derived alias for `planning`/`delivering`.
- §3.5.2 — the legal transition diagram; `done` and `cancelled` terminal.
- §3.5.3 — the transition table T1–T7, each with trigger, initiator,
  precondition and enforcer. T1 triage (PO), T2 plan (Orchestrator), T3/T4
  deliver (Orchestrator), T5 request changes (PO), T6 accept (PO or Client),
  T7 cancel (PO).
- §3.5.4 — the `verify` step inside Acceptance: QA verifies before the PO
  decides, and the verifier is never the role that produced the delivery.
- §3.5.5 — the nine transition error codes, each naming the transition and
  invariant it belongs to.
- §3.5.6 — isolation and cross-project sequencing (P5, P6, P9).

**SOP §11A — the pipeline's API surface** (clauses SOP-11A.1 … SOP-11A.4): an
endpoint-to-transition table, plus the rule that a project status may change
*only* through the endpoint governing its transition. `GET /timeline` is named
as the instrument that makes P9 observable rather than asserted.

**Role guidelines** — two new procedures:

- **R-01 Orchestrator, §5b** — drives T2, T3, T4, T7; refuses any transition
  outside the legal set with `illegal_project_transition`; refuses a transition
  whose precondition is not met, naming the unmet precondition and its
  invariant; uses the governing endpoint, never a direct status write; confirms
  the sequencing decision before advancing a project that contends with
  another for the same role.
- **R-03 Product Owner, §5b** — drives T1, T5, T6, T7. Triage requires a
  non-empty falsifiable checklist. Request-changes names *what is missing* per
  criterion. Acceptance checks the two authorisation preconditions (P7, P8)
  before attempting the transition, and routes a scope/budget/risk change to
  the Client as an authority item rather than accepting unilaterally or
  escalating a clean delivery. Cancellation requires a recorded reason.

The PO's accountabilities, decision rights and standard-of-work were extended
to match, and the "Not the PO's" line now names T2/T3/T4 and the `verify`
step explicitly so the boundary is stated rather than implied.

### The guard

`tools/sop-consistency-check.js` grew from 145 checks to **262**, adding
assertions for: the seven project statuses as *table rows* in §3.5.1; the T1–T7
transition table with a row per transition and a trigger/initiator/precondition/
enforcer per row; the nine error codes as table rows; the verify-step ordering
rules; the endpoint-to-transition mapping and the seven stage endpoints; the
two role procedures and the transitions each role claims; the invariant table
as table rows rather than prose mentions; and section-style (`SOP §3.5.3`)
references resolving to real headings.

Validated by mutation: **17 deliberate corruptions, all 17 caught** — the
original eight (forbidden phase claim, false compliance claim, bogus gate id,
wrong capacity, broken clause citation, deleted role section, invented
escalation level, removed invariant) plus nine aimed at the new content
(removed project status, removed transition row, removed error code, removed
endpoint, a role claiming another's transition, lost transition procedure,
permitted direct status write, invented error code, renamed invariant).

Two defects in the checker itself were found and fixed while doing this — both
were check bugs that would have made a control look stronger than it was:
a template-literal escaping fault that made three new regexes match nothing
(`\s` in a template literal collapses to `s`), and an invariant check that
accepted a prose mention as a definition. A control that cannot fail is not a
control, so each was fixed and re-tested rather than left.

### What this does not change

The pipeline remains **designed, not shipped**. §3.5 and §11A are marked
`[designed]` and name `docs/design-project-pipeline.md` as their source. The
code still creates projects with `status: 'active'`, still has no
`acceptanceCriteria`, no `deliverable`, and no stage endpoints. The board's 15
pipeline tasks (80h) remain the structural fix; the SOP now specifies precisely
what those tasks must produce.

### Standing rule (extended)

The procedure and the code must agree. When the pipeline is implemented, §3.5
and §11A change from `[designed]` to `[shipped]` with the implementing symbols
named, and the consistency checker's assertions move from *document-shape* to
*code-and-document agreement*. A procedure clause that no code enforces stays
`[designed]`.

---

## D9 — Separation of the Office Engine and the Office UI → **The engine is the actor. The UI is the observer and the owner.**

Owner direction, 2026-10-25: the office UI is a monitoring console over the
office engine, and the engine is an autonomous agent working on the owner's
behalf. The Orchestrator's execution-level decisions inside that direction are
recorded here and carry without further escalation.

### D9.1 — The UI observes everything and acts on a named, small set of owner acts

The UI is not a read-only mirror. The owner must be able to act from it —
answer a decision, grant acceptance or ratification, resolve an escalation. An
office you can only watch is not runnable.

What the UI must **not** do is drive the engine's *work*. Task lifecycle,
gate approval, assignment and delegation stay on the engine's internal command
channel. The owner's browser is a privileged surface, not an operator's console
for the internals.

### D9.2 — Three channels, not two

| Channel | Direction | Carries |
|---|---|---|
| **Telemetry** | engine → UI | activity journal, read-model snapshot, live stream |
| **Engine command** | engine internals → engine | task lifecycle, gates, assignment, delegation |
| **Owner decision** | UI → engine | the named owner acts from D9.1, plus a status/board nudge |

The owner UI and the engine's internal agents must not share a write API. Today
`public/index.html:660` calls `POST /api/agency/task/:id/status` — the same
route the agents use — so the console and any drive-by web page hold the same
trust level. That is the root of F-01, F-02 and F-07, not a side effect of it.

### D9.3 — The engine writes an authoritative activity journal; the UI reads it

The engine records what it did. The UI does not reconstruct it.

Today the activity feed is scraped: `server.js:523 fetchSessionMessages()` →
`server.js:493 extractDelegations()` → `server.js:469 mergeDelegations()` →
`public/index.html:444 liveDelegations`. That is a lossy projection of engine
activity, reconstructed after the fact from the agent's chat transcript. It is
also the live injection path: caller text reaches a prompt (F-04, F-05), the
agent's reply is scraped back, and it is interpolated raw into the console
(F-15, F-16). **The monitoring surface is the injection surface.**

The journal is append-only and on disk, separate from `state/agency.json`
(which the server owns and rewrites in memory). Every board change *and* every
agent lifecycle event — delegation opened and closed, subagent spawned and
reaped, provider unhealthy, budget exhausted — is written by the engine at the
moment it happens. The scraped-transcript path is retired, not supplemented.

### D9.4 — Both owner channels stay; the engine's decision record is the authority

There is no winner between the web console and the owner chat channel. Both
present the same decision objects and both post to the same engine method
(`agency.answerDecision`), so they cannot structurally disagree — and the
owner may answer from a phone or a desk.

The defect is not two channels, it is attribution: `answeredBy` is taken from
the request body (F-07). Identity comes from the authenticated session. The
engine records `answeredBy` = the authenticated owner identity and
`answeredVia` ∈ {`console`, `chat`} for audit.

### D9.5 — The UI stays served by the same process; the contract is written network-shaped

"Not static" means the UI needs a live connection, not a separate process. The
UI's static assets continue to be served by the office server.

The contract is nonetheless written as if it were a service — HTTP only, a
versioned read-model, a push channel — so that moving the UI behind nginx
later is a deployment change and not a code change.

This is the deliberate answer to the obvious counter-argument. Splitting the UI
onto its own origin would shrink the blast radius of the `0.0.0.0` bind and the
wildcard CORS (F-01). But it would also put the engine behind a network hop
that the owner's browser must reach, with CORS and a browser-held credential to
authenticate — a larger security surface today, for a benefit that only becomes
real once F-01 is closed on the engine's own boundary. Close F-01 at the engine
(bind `127.0.0.1`, shared-secret header, origin allowlist) and the UI can be
relocated later without touching the contract.

### D9.6 — The read path is pure

A monitor that writes is not a monitor. `GET /api/agency/state` currently
mutates and persists on every read: `agency.js:981 standup()` writes to
`d.standups` and saves, and `refreshEscalationLevels()` saves again (F-17).
Under D9 the read path computes and returns; persistence happens only from an
explicit write.

This also keeps the monitor off the same event loop as `runAutonomyTick` and the
OpenCode CLI spawn — a console that blocks behind the engine's own work cannot
report on it.

### What this does not change

The pipeline remains **designed, not shipped**. Nothing in D9 implements the
stage endpoints, the acceptance checklist or the pipeline UI; D9 fixes the
seam those land on, and D9's own scope is stated in the board tasks it
creates.

D9 does not close F-01, F-02, F-06 or F-07 either. It defines where each is
closed: F-01 and F-06 at the engine's boundary, F-02 and F-07 on the owner
decision channel.

### Standing rule (added)

The UI holds no domain vocabulary. The task-status list, the phase list, the
project stages, the gate ids and the roster roles are **served by the engine**
(`GET /api/agency/vocabulary`), never hardcoded in the client. The UI may map
semantic state to pixels — that is presentation — but it may not own the list.
`public/index.html` currently hardcodes the task-status map at line 717 and the
phase-to-room map at lines 260, 317 and 339, with lines 317 and 339 holding the
same map twice.
