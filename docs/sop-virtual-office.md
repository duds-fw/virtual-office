# Standard Operating Procedure — duDDev Virtual Office

> **Status: RATIFIED — in force from 2026-10-26.**
> The owner ratified this procedure on 2026-10-26. It is the office's
> standing procedure. It does not outrank `AGENTS.md` or the owner decisions
> in `docs/agency-decisions.md`, which remain the operative authority.
>
> **Applies to roster version:** `agency.js` @ `09fb94d` (2026-10-26)
> **Last synced:** 2026-10-26
> **Companion document:** `docs/role-guidelines.md`

---

## 0. How to read this document

### 0.1 Normative language

The vocabulary follows RFC 9110 §9.3 (RFC 9110, *HTTP Semantics*, §9.3
"Status Codes" conventions and §9.1 "Requirements Language"):

| Term | Meaning |
|---|---|
| **MUST** / **MUST NOT** | An absolute requirement. Non-compliance is a defect. |
| **SHOULD** / **SHOULD NOT** | A strong recommendation. Deviation requires a recorded reason. |
| **MAY** | Genuinely optional. No justification needed. |

Where this document says a role **MUST**, an agent that cannot comply **MUST**
raise an escalation rather than silently skip the step.

### 0.2 Clause identifiers

Every normative clause carries a stable identifier — `SOP-6.3`. Role guidelines
cite these identifiers. A changed clause with an unchanged citation is a
documentation defect, caught mechanically by `tools/sop-consistency-check.js`.

### 0.3 Status markers

| Marker | Meaning |
|---|---|
| `[shipped]` | Enforced by running code today. `Source:` names the symbol. |
| `[designed]` | Specified but **not yet implemented**. `Source:` names the design doc. |
| `[proposed]` | New in this SOP; not yet code and not yet an owner decision. |

**This document does not assert that designed behaviour exists.** Where the
office's code and this document disagree, the code wins until the owner
ratifies a change — see §16.4 (precedence).

---

## 1. Purpose and applicability

### 1.1 Purpose

This SOP defines how the Virtual Office operates: how work enters, who decides
what, how it is executed, what must be true before it is released, how
failures are handled, and what the office reports to its client.

It exists because the office is a **company**, and a company needs written
procedure or it re-litigates the same judgment on every task. A missing
standard is not a judgement failure — it is a gap in the standard
(`docs/agency-decisions.md` D6).

### 1.2 Applicability

This SOP binds **every role in `agency.js` ROSTER** (17 roles). It binds the
autonomy loop, the office's API surface, and the board's own state machine.

### 1.3 What the office is

The Virtual Office is an **AI-agent agency simulator**. It has:

- **17 roles** across 7 departments
- **7 phases**: Planning, Analysis, Design, Development, Review, Deployment, Operations
- **7 task statuses**: backlog, ready, in_progress, review, blocked, done, cancelled
- **2 approval gates**: `design_approval`, `security_signoff`
- **3 escalation levels**: Product Owner → Orchestrator → Client
- A **client** (the owner) who sets strategy, scope, budget and risk tolerance

It has no employees, no physical assets, no payroll, and no customers other
than its client. Several international frameworks assume those things exist.
This document uses the frameworks **for the practices that transfer** and
declines the parts that do not (§17).

### 1.4 What this SOP is not

It is **not** a certification. The office is **not** ISO 9001, ISO/IEC 27001,
ISO/IEC 42001, SOC 2, ITIL or COBIT certified, and no clause here may be cited
as evidence of such. See §17.

---

## 2. Governance model

### 2.1 Governance cycle

The office follows **COBIT 2019's EDM model** (Evaluate, Direct and Monitor)
as its top-level governance loop, scaled to a single-client agency:

| COBIT 2019 EDM | This office |
|---|---|
| **Evaluate** (EDM 01) | Triage — the Product Owner assesses the ask: scope, budget, deadline, acceptance criteria |
| **Direct** (EDM 02) | Plan and Deliver — roles execute under the RACI (§3) |
| **Monitor** (EDM 03) | Review and Acceptance — QA verifies, the PO accepts, metrics and gates report status |

*Source: COBIT 2019 Framework, EDM01–EDM03.*

### 2.2 Authority tiers

Three tiers, borrowed from **ISO 9001:2015 §5.3** ("Organizational roles,
responsibilities and authorities") and **RFC 2119** keyword semantics:

| Tier | Decides | Examples | Raised via |
|---|---|---|---|
| **Execution** | The agent, alone | Implementation approach, library choice, internal architecture, task breakdown, retry ordering, code structure | Resolved silently; recorded in the task |
| **Delivery** | The Product Owner | Scope within an agreed envelope, sequencing within a project, acceptance of a met checklist, task estimation | Board action |
| **Strategic** | The Client (owner) | Goal, scope beyond the envelope, budget, risk tolerance, committed dates, priority between projects | `POST /api/client/decision` |

**SOP-2.1** — A role **MUST NOT** escalate a question that has a defensible
answer at a lower tier. The escape hatch is for genuine forks — choices with
different business outcomes — not for decisions with a correct engineering
answer.

**SOP-2.2** — When a role escalates, it **MUST** supply the question, the
context, and at least two concrete options. An escalation without options
re-stages the decision on the client.

### 2.3 Decision classes and the correct tier

| Question | Tier | Who answers |
|---|---|---|
| Which library to use? | Execution | The engineer |
| How to split this task? | Execution | The engineer |
| Should this task be estimated at 6h or 10h? | Delivery | The PO |
| Two projects need the same scarce role this sprint | Delivery | The Orchestrator (P9) |
| Do we cut a criterion to fit the budget? | Strategic | The Client |
| Do we accept this delivery with one criterion unmet? | Strategic | The Client (the PO cannot) |
| Is the system secure enough to release? | Delivery | NetSec/SOC (gate) |

---

## 3. Roles, responsibilities and authority

### 3.1 Roster

`[shipped]` — mirrors `agency.js` ROSTER verbatim. Source: `agency.js`
symbol `ROSTER`.

| ID | Role | matrixRole | Subagent | Capacity (h/sprint) | Eligible phases |
|---|---|---|---|---|---|
| `orch` | Orchestrator | `orchestrator_lead` | — | 40 | All 7 |
| `hermes` | Hermes (Dispatcher) | `hermes_dispatcher` | `hermes` | 20 | All 7 |
| `po` | Product Owner | `product_owner_product_manager` | `plan` | 24 | Planning, Analysis |
| `be` | Business Enablement | `business_enablement` | `general` | 16 | Planning, Analysis, Operations |
| `da` | Data Analyst | `data_analyst` | `explore` | 24 | Analysis, Planning |
| `ux` | UI/UX Designer | `ui_ux_designer` | `documenter` | 32 | Design |
| `se` | Software Engineer | `software_engineer` | `build` | 40 | Development |
| `de` | Database Engineer | `database_engineer` | `general` | 32 | Design, Development |
| `aie` | AI Engineer | `ai_engineer` | `general` | 32 | Design, Development |
| `qa` | Quality Assurance | `quality_assurance` | `tester` | 32 | Review |
| `ns` | Network & Security | `network_and_security` | `security-auditor` | 24 | Review, Operations |
| `soc` | Security Operations | `security_operations_soc` | `security-auditor` | 20 | Review, Operations |
| `dso` | DevOps / SRE | `devops_sre` | `devops` | 32 | Deployment, Operations |
| `ce` | Cloud Engineer | `cloud_engineer` | `devops` | 24 | Deployment, Operations |
| `iti` | IT Infrastructure | `it_infrastructure` | `devops` | 24 | Deployment, Operations |
| `dba` | Database Administrator | `database_administrator` | `devops` | 20 | Deployment, Operations |
| `sd` | Service Desk | `it_support_service_desk` | `general` | 24 | Operations |

### 3.2 Department model

| # | Department | Roles | Department head |
|---|---|---|---|
| 1 | Leadership & Governance | Orchestrator, Hermes | Orchestrator |
| 2 | Product & Client Strategy | Product Owner, Business Enablement, Data Analyst | Product Owner |
| 3 | Design | UI/UX Designer | UI/UX Designer |
| 4 | Engineering & Data | Software Engineer, Database Engineer, AI Engineer | Software Engineer |
| 5 | Quality & Assurance | Quality Assurance | Quality Assurance |
| 6 | Security | Network & Security, Security Operations | Network & Security |
| 7 | Platform, Operations & Service | DevOps/SRE, Cloud Engineer, IT Infrastructure, DBA, Service Desk | DevOps/SRE |

Departments 6 and 7 are **shared-subagent departments**: NetSec and SOC run the
same `security-auditor`; DevOps, Cloud, IT Infra and DBA run the same `devops`.
They are documented as one procedure with role-specific overlays, not four
independent controls — see `docs/role-guidelines.md` §2.

### 3.3 RACI

`[designed]` — Source: `docs/design-project-pipeline.md` §2, ratified by the
owner as `docs/agency-decisions.md` D7.2.

**SOP-3.1** — Exactly one role is **Accountable** per pipeline stage. A stage
with two accountable roles is a stage where nobody is.

| Stage | Responsible | Accountable | Consulted | Informed |
|---|---|---|---|---|
| Registration | Client | Client | Product Owner | Orchestrator |
| Triage | Product Owner | Product Owner | Orchestrator, QA | Client |
| Planning | Orchestrator | Product Owner | Delivery roles | Client |
| Delivery | Phase-matched role | Product Owner | QA, NetSec, DevOps/SRE | Orchestrator |
| Acceptance — verification | Quality Assurance | Product Owner | NetSec, DevOps/SRE | Orchestrator, Client |
| Acceptance — decision | Product Owner | Product Owner | — | Orchestrator |
| Acceptance — ratification | Product Owner | Client | — | Orchestrator |
| Done | Orchestrator | Orchestrator | Product Owner | Client |
| Cross-project delivery timeline | Orchestrator | Orchestrator | Product Owners | Client |

**SOP-3.2** — The role that performed a delivery **MUST NOT** accept that
delivery. The verifying role and the accepting role are always different roles.
*(Invariant P7.)*

**SOP-3.3** — Only `product_owner_product_manager` or `client` **MAY** accept
a project. *(Invariant P8.)*

### 3.4 The nine pipeline invariants

`[designed]` — Source: `docs/design-project-pipeline.md` §4, ratified by the
owner as `docs/agency-decisions.md` D7.2–D7.4. These are the rules the
pipeline **MUST** enforce. They are reproduced here so this SOP is
self-contained: a role reading only this document knows the whole rule set.

| ID | Invariant | Enforced by |
|---|---|---|
| **P1** | A project in `registered`/`triaged` has no active sprint. | `createSprint()` |
| **P2** | A project leaves `triaged` only if `acceptanceCriteria.length > 0` and every criterion has non-empty, falsifiable `text`. | Triage validation |
| **P3** | A task reaches `done` only if `deliverable.summary` is set. | `setTaskStatus()` `[designed]` |
| **P4** | A project reaches `done` only if every criterion has `met === true`, at least one `metBy` task, and every referenced task is `done`. | `accept` validation `[designed]` |
| **P5** | Every task's `projectId` matches its sprint's `projectId`. | `createTask()` — **shipped** |
| **P6** | `metrics()` is project-scoped: all metrics take an optional `projectId` and default to the active project. | `metrics()` `[designed]` |
| **P7** | The role that performed a delivery may not accept that delivery. The accepting role must differ from every role that produced a `metBy` task. | `accept` validation `[designed]` |
| **P8** | Only `product_owner_product_manager` or `client` may accept a project. | `accept` validation `[designed]` |
| **P9** | The Orchestrator owns the cross-project delivery timeline; a project may not be advanced ahead of another contending for the same role's capacity unless the Orchestrator has sequenced them explicitly. | Sequencing `[designed]` |

**SOP-3.4** — An invariant **MUST** be enforced in code, not only written
down. A rule that lives only in prose is a reminder; a rule in code is a
control. *(Reference: ISO 9001:2015 §8.5.1, "Control of production and service
provision" — planned conditions, controlled execution and documented results.)*

**SOP-3.5** — Every invariant **MUST** have a test that fails when it is
violated. The pipeline's invariant tests are `tools/sop-consistency-check.js`
and the office's rule harness `tools/agency_rules_test.js`.

### 3.5 The project stage machine

`[designed]` — Source: `docs/design-project-pipeline.md` §2–§4, ratified as
`docs/agency-decisions.md` D7.1–D7.4.

This clause set is what makes the pipeline *controlled* rather than merely
described. §3.3 says who decides; §3.4 says what must hold; **§3.5 says how a
project legally moves.**

#### 3.5.1 Project status vocabulary

A project is in exactly one of these seven states:

| Status | Meaning |
|---|---|
| `registered` | Created from an ask. Not yet scoped. Cannot be worked. |
| `triaged` | Scoped: goal, budget, deadline, acceptance checklist. Cannot be worked. |
| `planning` | A sprint is open and tasks are being sized. |
| `delivering` | Sprint work is in flight. |
| `acceptance` | Work is done; the checklist is being verified and decided. |
| `done` | Accepted and closed. Terminal. |
| `cancelled` | Abandoned. Reachable from any non-terminal state. Terminal. |

`active` is **not** a project status. It survives only as a derived alias for
`planning` and `delivering`, so existing readers do not break. New code
**MUST NOT** write `active`.

#### 3.5.2 Legal transitions

```
registered ──▶ triaged ──▶ planning ──▶ delivering ──▶ acceptance ──▶ done
     │            │            │             │              │
     └────────────┴────────────┴─────────────┴──────────────┴──▶ cancelled
                                    ▲             │
                                    └─────────────┘
                              (acceptance → delivering:
                               changes requested)
```

**SOP-3.6** — A project **MUST NOT** move to any status other than the
transitions above. An attempt to do so **MUST** be refused with
`illegal_project_transition`, and the refusal **MUST** name the attempted
transition and the legal ones.

**SOP-3.7** — `done` and `cancelled` are **terminal**. A project in either
state **MUST NOT** be reopened. Reopening is a new project.

#### 3.5.3 Transition table

Each transition has one trigger, one initiator, and one precondition. All three
**MUST** hold for the transition to succeed.

| # | From → To | Trigger | Initiator | Precondition | Enforced by |
|---|---|---|---|---|---|
| T1 | `registered` → `triaged` | The ask is scoped | Product Owner | `acceptanceCriteria.length > 0` and every criterion has falsifiable `text` (P2) | `triage()` |
| T2 | `triaged` → `planning` | Work is to be planned | Orchestrator | A sprint is opened for the project (P1) | `plan()` |
| T3 | `planning` → `delivering` | The sprint is live | Orchestrator | Every task has an estimate and an eligible role | `deliver()` |
| T4 | `delivering` → `acceptance` | Work is complete | Orchestrator | Every sprint task is `done` and carries a `deliverable` (P3) | `deliver()` |
| T5 | `acceptance` → `delivering` | Changes requested | Product Owner | The specific unmet criteria are recorded | `accept()` |
| T6 | `acceptance` → `done` | Delivery accepted | Product Owner, or the Client by ratification | Every criterion is `met === true`, every `metBy` task is `done` (P4); the acceptor is authorised (P8); the acceptor did not perform the delivery (P7) | `accept()` |
| T7 | `any` → `cancelled` | Abandoned | Product Owner | The reason is recorded | `cancel()` |

**SOP-3.8** — A transition whose precondition is not met **MUST** be refused,
and the refusal **MUST** name the unmet precondition and the invariant it
belongs to. A refusal that says only "failed" is not actionable and is a
defect.

#### 3.5.4 The `verify` step inside Acceptance

The `acceptance` stage is not a single transition — it contains two acts that
**MUST** happen in order, and both are within the stage:

1. **Verification** — QA marks each criterion `met` / `unmet` against the
   recorded evidence, and records what is missing for every `unmet` one.
   *(SOP-11.3.)*
2. **Decision** — the Product Owner accepts (T6) or requests changes (T5).

**SOP-3.9** — A project **MUST NOT** leave `acceptance` for `done` until
verification has been performed by a role other than the one that produced the
delivery (P7). Acceptance without verification is not acceptance; it is a
guess.

**SOP-3.10** — Verification **MUST** be complete before the decision. A
Product Owner **MUST NOT** accept a project whose criteria are unverified.

#### 3.5.5 Transition error codes

| Code | Meaning |
|---|---|
| `project_not_registered` | The project is not in a state that admits the requested transition. |
| `no_acceptance_criteria` | T1 attempted with an empty checklist. |
| `criterion_not_falsifiable` | T1 attempted with a criterion that is not a single true-or-false claim. |
| `illegal_project_transition` | The requested transition is not in §3.5.2. |
| `acceptance_not_met` | T6 attempted with an unmet criterion. |
| `criterion_unverified` | T6 attempted before verification. |
| `self_acceptance` | T6 attempted by a role that performed the delivery (P7). |
| `acceptor_not_authorised` | T6 attempted by a role other than PO or Client (P8). |
| `missing_deliverable` | T4 attempted with a task lacking a `deliverable` (P3). |

**SOP-3.11** — These codes **MUST** be returned in the office's unified error
envelope and **MUST** be distinguishable by the caller. A caller **MUST NOT**
have to parse prose to learn which precondition failed.

#### 3.5.6 Isolation

**SOP-3.12** — A transition **MUST** affect only the project named. A second
project's state, tasks, metrics, or capacity **MUST NOT** change as a
consequence. *(P5, P6, and isolation test E1.)*

**SOP-3.13** — When two projects contend for the same role's capacity, the
Orchestrator sequences them (P9). A transition that advances one project past
another contending for the same role **MUST** be preceded by an explicit
sequencing decision.

---

## 4. The operating cycle

### 4.1 Phase flow

`[shipped]` — Source: `agency.js` symbol `PHASES`.

```
Planning → Analysis → Design → Development → Review → Deployment → Operations
```

**SOP-4.1** — A task's phase determines which roles may own it. The mapping is
`ROSTER[].phases`, enforced by `agency.js` `roleEligibleForPhase()`. A role
**MUST NOT** be assigned to a task in a phase it is not eligible for.

**SOP-4.2** — The **phase** drives eligibility, not the logical order of the
work. A foundational task created in Development because its only eligible
role is Development-only is correct, not anomalous.

### 4.2 Task status vocabulary

`[shipped]` — Source: `agency.js` symbol `STATUSES`.

| Status | Meaning | Who sets it |
|---|---|---|
| `backlog` | Sized and placed, not started | PO / Orchestrator |
| `ready` | Unblocked, waiting for an owner | Orchestrator |
| `in_progress` | Assigned and being worked | The owner role |
| `review` | Work done, awaiting review | The owner role |
| `blocked` | Cannot proceed; `blockedReason` **MUST** be set | `advanceTask()` |
| `done` | Complete, with a `deliverable` `[designed]` | The owner role |
| `cancelled` | Removed from scope | PO |

**SOP-4.3** — A task **MUST NOT** reach `done` while its phase gate is
unsigned. `agency.js` `setTaskStatus()` enforces this and returns
`gate_pending`. *(This is the shipped control for finding F-03.)*

### 4.3 Gates

`[shipped]` — Source: `agency.js` symbol `GATES`.

| Gate id | Label | Phase | Approver roles | What it certifies |
|---|---|---|---|---|
| `design_approval` | Design approval | Development | `ui_ux_designer`, `product_owner_product_manager` | The design is fit to build: scope, intent and acceptance are settled |
| `security_signoff` | Security sign-off | Deployment | `network_and_security`, `security_operations_soc` | The change is safe to release against the open findings |

**SOP-4.4** — `approveGate()` checks the caller's role is in the gate's
`approverRoles` and refuses otherwise (`role_not_approver`). *(Shipped
control for F-02.)*

**SOP-4.5** — A gate is approved by the **accountable approver role** for that
gate, not by whoever is available. NetSec and SOC both hold
`security_signoff`; the gate is satisfied by either, and the other is
**consulted**, not a second mandatory signature.

**SOP-4.6 — Current gate state.** At the time of writing, `security_signoff`
has **never been approved** and the Deployment gate is **closed**. Findings
F-01 (no authentication on state-mutating routes), F-06 (owner-channel
takeover) and F-07 (owner-decision forgery) remain open
(`docs/agency-security-review.md`). No Deployment-phase task may be signed off
until those land and a re-review passes. The office **MUST NOT** describe a
Deployment path as available while this gate is closed.

### 4.4 Entry and exit conditions by phase

| Phase | Entry | Exit | Gate on exit |
|---|---|---|---|
| Planning | Project scoped | Sprint open, tasks sized and owned | — |
| Analysis | Inputs available | Findings recorded | — |
| Design | Design intent agreed | Design artifacts produced | — |
| Development | `design_approval` approved | Code + unit tests + `deliverable` | `design_approval` |
| Review | Build complete | QA verdict, NetSec/SOC verdict | — |
| Deployment | `security_signoff` approved | Released, rollback plan known | `security_signoff` |
| Operations | Released | Runbook, monitoring, SLA | — |

---

## 5. Planning and backlog control

### 5.1 Sprints and backlog

`[shipped]` — Scrum Guide 2020 is the reference model for sprint mechanics.
**Adaptation noted:** Scrum assumes one team and one backlog; this office runs
**multiple projects concurrently** (§10). The *events* are retained; the
single-backlog assumption is not.

**SOP-5.1** — A project has **one** active sprint. Opening a sprint closes the
previous one. `[shipped]` — `agency.js` `createSprint()`.

**SOP-5.2** — Every task **MUST** carry an estimate and an owning role before
it may leave `backlog`. `[shipped]` — `createTask()` rejects an invalid
estimate (`MIN_ESTIMATE_HOURS = 0.25`, `MAX_ESTIMATE_HOURS = 200`) and an
ineligible role (`role_not_eligible`).

**SOP-5.3** — Estimates are **hours of work**, not story points. Points are
derived (`pointsFor()`), never authored.

### 5.2 Definition of Ready

A task may enter `ready` only when all are true:

1. It has a title naming a verifiable outcome.
2. It has an estimate within bounds and a role eligible for its phase.
3. Its dependencies are identified.
4. Its phase's gate prerequisites are satisfiable.
5. The deliverable it will produce is known (kind, not just text). `[designed]`

*Reference: Scrum Guide 2020, "Definition of Ready" (informative); ISO/IEC
25010:2023 §5 (product quality model) for the quality bar the deliverable must
meet.*

### 5.3 Definition of Done

A task **MUST NOT** be marked `done` until:

1. The work is complete against its description.
2. The phase gate is approved (`SOP-4.3`).
3. A `deliverable` is recorded — summary, kind, and a reference where the kind
   is `code`. `[designed]`
4. The code, if any, is committed. `[shipped]` — standing rule,
   `AGENTS.md` §"Version control".
5. Evidence exists that the work was checked. `[designed]`

**SOP-5.4** — "Done" **MUST NOT** mean "the agent stopped." It means a named
artefact exists and was verified. *Reference: Scrum Guide 2020, "Definition of
Done" (informative); ISO 9001:2015 §8.6 "Release of outputs and services."*

### 5.4 Budget control

`[shipped]` — Source: `briefing.js` `budgetReport()`.

**SOP-5.5** — The office **MUST NOT** exceed a project's `budgetHours`. When
committed work plus completed work would exceed the budget, the office
**MUST** report it in the daily digest as a **budget report item** — overrun,
reason, and options — and **MUST NOT** spend the hours.

**SOP-5.6** — A budget report item is a **digest** item, not an authority
interrupt. It reports; it does not block. The Client raises the budget; the
office does not.

*Reference: ISO 9001:2015 §8.1.2 (determination of requirements) and
§8.2.3 (review of requirements) for the practice of surfacing a requirement
conflict before execution, rather than absorbing it silently.*

---

## 6. Delivery execution

### 6.1 Assignment

`[shipped]` — Source: `agency.js` `agentEligibleForTask()`.

**SOP-6.1** — An agent may own a task only when **all** hold:

1. `agent.matrixRole === task.role`
2. The task's phase is in `agent.phases`
3. The agent is not a manager
4. The agent has a subagent

**SOP-6.2** — Assignment **MUST** preserve least privilege. The role that
builds a component is not thereby the role that approves it. *Reference:
NIST SP 800-53 Rev. 5, AC-6 "Least Privilege."*

### 6.2 Execution

**SOP-6.3** — A role **MUST** work within the task's stated deliverable. Work
outside it is either a new task or an escalation, never silent scope growth.

**SOP-6.4** — A role **MUST** record a `blockedReason` on every task it blocks.
The reason is a **cause**, not a feeling. Permitted causes: `awaiting gate`,
`awaiting dependency`, `no capacity`, `token budget exhausted`, `blocked`
(gate named), `awaiting owner`. *Reference: ITIL 4, service request and
incident management practice (cause categories).*

**SOP-6.5** — When work is blocked, the role **MUST** first attempt
self-healing within its own authority: reassign to an eligible role with
capacity, split the task if it exceeds a single role's capacity, or reduce
scope to what is already done and record the remainder as a new task. It
**MUST NOT** escalate a problem it can solve itself.

### 6.3 Token discipline

`[shipped]` — Source: `agency.js` `ROLE_TOKEN_BUDGET` (2,000,000 tokens per
role per local day).

**SOP-6.6** — Token spend is a **capacity** resource, not merely a cost. A
role that has exhausted its daily budget is **ineligible** for further work
until the next local day. A task **MAY** therefore be blocked by budget, not
only by a gate.

**SOP-6.7** — A role **MUST** read only what it needs: filter at the source
(`jq`, `grep -m`, `head`), never load a whole document to read one field, and
never re-read what it has already read. *Reference: AGENTS.md §"Token
discipline (strict)"; ISO/IEC 25010:2023 §5 (maintainability) for the
cost-of-change principle that drives it.*

---

## 7. Review, security and quality gates

### 7.1 Review separation

`[shipped]` — Source: `agency.js` `ROSTER`.

**SOP-7.1** — The role that performs a review **MUST NOT** be the role that
produced the work under review. QA (`quality_assurance`) is the independent
verifier; the delivery role does not sign off its own output.

**SOP-7.2** — NetSec and SOC share the `security_signoff` gate because they
share the `security-auditor` subagent and the same control set. They are one
control with two eligible approvers (see `SOP-4.5`), not two independent
controls.

### 7.2 Security gate

**SOP-7.3** — The `security_signoff` gate **MUST NOT** be approved while any
**Critical** finding against the surface being released is open and
unverified. *Reference: OWASP ASVS V4 §V4 (Access Control), §V5 (Validation,
Sanitization and Encoding), §V7 (Error Handling and Logging); NIST SP 800-53
Rev. 5 SA-11 "Developer Testing."*

**SOP-7.4** — The open-finding tracker is
`docs/agency-security-review.md` (F-01 … F-20). A finding is closed only when
the fix is **shipped** and **verified** — a fix that exists only in a branch or
a description does not close a finding.

**SOP-7.5** — The office **MUST NOT** weaken or delete a security control to
pass a gate. If a control cannot be met, that is a strategic decision for the
Client (`SOP-2.2`).

### 7.3 Quality assurance

`[shipped]` — Source: `agency.js` `ROLE_TOKEN_BUDGET`, `agency_rules_test.js`.

**SOP-7.6** — A change to a rule-enforcing module **MUST** ship with or be
accompanied by a test that fails without the change. The office's own harness
(`tools/agency_rules_test.js`, `tools/briefing_test.js`) is the regression
gate.

**SOP-7.7** — Quality is assessed against **ISO/IEC 25010:2023 §5**, the
product quality model. The office **MUST** consider, at minimum:
functional suitability, performance efficiency, compatibility, usability,
reliability, security, maintainability, portability and safety. The office
**MUST NOT** claim a numeric non-functional target it cannot measure.

---

## 8. Deployment and release

`[shipped]` — Source: `agency.js` `GATES`, `approveGate()`.

**SOP-8.1** — A release **MUST** have, at minimum: an approved
`security_signoff`, a named rollback path, and a recorded change description.
*Reference: ITIL 4, Service Request and Change Management (change enablement
practice); NIST SP 800-53 Rev. 5 CM-3 "Change Control," CM-5 "Access
Restrictions for Change," CM-7 "Least Functionality."*

**SOP-8.2** — The office **MUST NOT** simulate a change advisory board. There
is one accountable approver role per gate and one Client; a quorum that does
not exist must not be invented to make the process look formal.

**SOP-8.3** — Rollback **MUST** be known before release, and a release to a
live surface **MUST** be revertible in one step. *Reference: NIST SP 800-53
Rev. 5 CP-9 "System Backup" and CP-10 "Recovery and Reconstitution."*

**SOP-8.4** — Secrets **MUST NOT** enter version control, logs, or the board.
*Reference: ISO/IEC 27001:2022 Annex A, A.8.24 "Use of cryptography" and
A.5.17 "Authentication information."*

---

## 9. Operations, run and service management

`[shipped]` — Source: `agency.js` `ROSTER` (Operations-phase roles), `server.js`.

### 9.1 First-line and second-line

| Line | Roles | Owns |
|---|---|---|
| **First line** | Service Desk (`it_support_service_desk`) | Intake, triage, user communication, known-error lookup |
| **Second line** | DevOps/SRE, Cloud, IT Infrastructure, DBA, NetSec, SOC | Diagnosis, correction, runbook changes, escalation to third line |
| **Third line** | Product Owner / specialist engineering | Change to the product itself |

*Reference: ITIL 4, Incident Management (incident handling model) and Service
Request Management.*

### 9.2 Service management obligations

**SOP-9.1** — Every service the office runs **MUST** have a runbook that names:
its owner, how to confirm it is healthy, its failure modes, and the first
diagnostic step. *Reference: ITIL 4, Service Design and Service Operation
management practices.*

**SOP-9.2** — The office **MUST** measure against the metrics the board
actually records — cycle time, utilisation, SLA compliance, blocked count,
velocity — and **MUST NOT** publish an availability or MTTR target it cannot
derive. Where the Client wants a target, it is set by the Client as a strategic
decision (`SOP-2.2`).

**SOP-9.3** — An incident **MUST** produce a recorded cause and, where the
cause is not understood, an open problem record. A restart is a mitigation, not
a closure. *Reference: ITIL 4, Problem Management (known error and known
problem records).*

---

## 10. Multi-project operation and the cross-project timeline

`[designed]` — Source: `docs/design-project-pipeline.md` §6–§7, ratified as
`docs/agency-decisions.md` D7.4.

**SOP-10.1** — The office **MAY** run multiple projects concurrently. The
**Orchestrator** owns the cross-project delivery timeline: sequencing work
against shared role capacity, forecasting slips before they become breaches,
and deciding which project advances first when two contend for the same scarce
role. *(Invariant P9.)*

**SOP-10.2** — The Product Owner owns the timeline **within** one project. The
Orchestrator owns the timeline **across** projects. When contention changes
scope, budget or a committed date, the Orchestrator escalates to the Client;
otherwise it decides and informs.

**SOP-10.3** — Role capacity is **shared** across projects. Capacity is a
property of the role, not the project.

**SOP-10.4** — An autonomy tick **MUST** work on one project at a time. The
office may have several projects in flight; a tick picks the one the
Orchestrator's sequencing names. Ticks **MUST NOT** interleave work across
projects within a tick.

---

## 11. Acceptance and the client relationship

`[designed]` — Source: `docs/design-project-pipeline.md` §2–§4, ratified as
`docs/agency-decisions.md` D7.2, D7.3.

### 11.1 Acceptance criteria

**SOP-11.1** — Acceptance criteria are a **typed binary checklist**. Each
criterion is one falsifiable claim with `met: boolean`, `metBy[]`, and optional
`evidence`. Free-text criteria **MUST NOT** be used to gate a transition.

**SOP-11.2** — A claim that cannot be written as a single sentence that is
true or false is a **goal**, not an acceptance criterion, and **MUST** be
placed in the project goal. Falsifiability **MUST** be enforced when the
project leaves triage. *(Invariant P2.)*

### 11.2 The three acts

**SOP-11.3** — Acceptance comprises:

1. **Verification** — QA marks each criterion `met`/`unmet` against the
   recorded evidence. QA produces a verdict; QA does not decide.
2. **Acceptance** — the Product Owner accepts or requests changes.
3. **Ratification** — the Client, **only** where acceptance would change
   scope, budget, or accepted risk.

**SOP-11.4** — A delivery meeting its checklist, unchanged in scope and
budget, **MUST** be accepted by the Product Owner and reported to the Client as
a **digest** item. It **MUST NOT** be escalated as an authority interrupt.

**SOP-11.5** — The office **MUST NOT** mark its own work accepted
(`SOP-3.2`, `SOP-3.3`).

**SOP-11.8** — The acts of §11.3 map onto the stage machine as follows:
verification happens **within** the `acceptance` stage (SOP-3.9), the Product
Owner's decision is transition **T6** or **T5**, and the Client's ratification
is the same transition **T6** performed by the Client rather than the PO. The
transition table in §3.5.3 governs all three.

### 11.3 The Client's attention budget

**SOP-11.6** — An authority interrupt **MUST** carry: the question, the
context, and at least two concrete options with their consequences. A matter
that can be resolved with a defensible answer **MUST NOT** be raised.

**SOP-11.7** — If a delivery cannot be accepted without a scope, budget or
risk change, that **MUST** be raised as an authority item with the specific
unmet criteria, the options, and the office's recommendation. *Reference:
RFC 2119 §3.1 for the distinction between an instruction and a
recommendation.*

---

## 11A. The pipeline's API surface

`[designed]` — Source: `docs/design-project-pipeline.md` §5. Each endpoint is
one transition from §3.5.3. This is the interface that enforces §3.5; a stage
that has no endpoint cannot be entered, because the only way to change a
project's status is through the endpoint that governs its transition.

| Method | Path | Transition | Initiator role | Refused with |
|---|---|---|---|---|
| `POST` | `/api/agency/project` | — (creates `registered`) | Client / PO | — |
| `POST` | `/api/agency/project/:id/triage` | T1 | Product Owner | `no_acceptance_criteria`, `criterion_not_falsifiable` |
| `POST` | `/api/agency/project/:id/plan` | T2 | Orchestrator | `project_not_registered` |
| `POST` | `/api/agency/project/:id/deliver` | T3, T4 | Orchestrator | `missing_deliverable` |
| `POST` | `/api/agency/project/:id/verify` | (within `acceptance`) | QA | `criterion_unverified` |
| `POST` | `/api/agency/project/:id/accept` | T5, T6 | PO or Client | `acceptance_not_met`, `criterion_unverified`, `self_acceptance`, `acceptor_not_authorised` |
| `POST` | `/api/agency/project/:id/ratify` | T6 by Client | Client | `acceptor_not_authorised` |
| `POST` | `/api/agency/project/:id/cancel` | T7 | Product Owner | — |
| `GET` | `/api/agency/project/:id` | — | any | — |
| `GET` | `/api/agency/projects` | — | any | — |
| `GET` | `/api/agency/timeline` | — | any | — |

**SOP-11A.1** — A project status **MUST** change only through the endpoint
that governs its transition. No other route, no direct state write, and no
read-modify-write of `state/` may set a project's status. `state/` is
server-owned and is never the source of truth.

**SOP-11A.2** — `GET /api/agency/metrics` **MUST** accept an optional
`projectId` and default to the active project, so one project's numbers cannot
be attributed to another (P6).

**SOP-11A.3** — `GET /api/agency/timeline` **MUST** return the
cross-project sequence: which project is next, which projects contend for a
shared role, and the forecast slip for each. It is the Orchestrator's
instrument, and it is what makes P9 observable rather than asserted.

**SOP-11A.4** — A transition endpoint **MUST** return the project in its new
state, including its updated criteria, delivery, and acceptance fields. A
caller that cannot see the resulting state cannot verify the control worked.

---

## 12. Escalation and decision-making

`[shipped]` — Source: `agency.js` symbol `ESCALATION_PATH`.

| Level | Owner | matrixRole | Auto-escalates after |
|---|---|---|---|
| L1 | Product Owner | `product_owner_product_manager` | 24 h (`BLOCK_ESCALATION_MS`) |
| L2 | Orchestrator | `orchestrator_lead` | 24 h |
| L3 | Client | `client` | 24 h |

**SOP-12.1** — An escalation **MUST** record the blocked task, the cause, and
the level. It **MUST** age automatically: a task blocked for more than 24 h
**MUST** advance one level without a human action, up to L3.

**SOP-12.2** — Escalation is a **last** resort at each tier. A role **MUST**
first exhaust self-healing (`SOP-6.5`) and delivery-tier options.

**SOP-12.3** — The office **MUST NOT** escalate to the Client a decision with
a defensible engineering answer (`SOP-2.1`).

*Reference: COBIT 2019, DSS05 "Managed IT Services" — escalation and
supporting-service practice; ITIL 4, escalation management practice. No
international standard prescribes exactly three tiers; this ladder is a local
design decision.*

---

## 13. Resource, capacity and token governance

`[shipped]` — Source: `agency.js` `capacityHours`, `ROLE_TOKEN_BUDGET`,
`freeHours()`, `workload()`.

**SOP-13.1** — `capacityHours` is a per-role ceiling per sprint (14 days). A
role **MUST NOT** be assigned work exceeding its remaining capacity.

**SOP-13.2** — The daily token budget is a **spend ceiling**. Exhausting it
makes the role ineligible for further work until the next local day, which
**MAY** block a task that is otherwise unblocked.

**SOP-13.3** — No international standard governs LLM token budgets. This is a
bespoke local control and **MUST** be described as such, not as compliance with
any framework's cost-management clause.

**SOP-13.4** — The office **MUST** report capacity and spend to the Client in
the daily digest, and **MUST** forecast the point at which a role's remaining
capacity is insufficient for its committed work. *Reference: COBIT 2019 DSS06
"IT Operations" — capacity and asset management practice.*

---

## 14. Security management

`[shipped]` — Source: `docs/agency-security-review.md` (F-01 … F-20).

### 14.1 Control families

The office's controls are organised by family, mapping to **ISO/IEC
27001:2022 Annex A** and **NIST SP 800-53 Rev. 5**:

| Family | ISO/IEC 27001:2022 | NIST SP 800-53 | Office controls |
|---|---|---|---|
| Identity & access | A.5.15–A.5.18 | AC-2, AC-3, AC-6 | Role identity; `approveGate` role check (F-02); client channel auth (F-06/F-07) |
| Cryptography | A.8.24 | SC-12, SC-13 | Secret exclusion from git and logs (F-12) |
| Application security | A.8.25–A.8.29 | SA-11, SI-10 | Prompt sanitisation (F-04/F-05); input validation (F-13) |
| Logging & monitoring | A.8.15, A.8.16 | AU-2, AU-12, SI-4 | Activity log; request audit (F-18) |
| Secure development | A.8.25–A.8.29 | SA-10, SA-11 | `security_signoff` gate; QA independence |
| Business continuity | A.5.29–A.5.31 | CP-9, CP-10 | Rollback path (SOP-8.3) |
| Compliance | A.5.31, A.5.34 | CA-7 | Open-finding tracker (SOP-7.4) |

**SOP-14.1** — **Annex A is a normative requirement list for a certified ISMS.**
The office uses it as a **self-assessment reference**. No clause in this SOP
**MAY** be presented as ISO/IEC 27001 compliance.

### 14.2 AI-specific governance

**SOP-14.2** — The office's agent behaviour **MUST** be governed on the
**NIST AI RMF 1.0** functions: *Govern* (ownership, policy), *Map* (context,
intended use), *Measure* (evaluation of outputs), *Manage* (risk treatment).
*Reference: NIST AI RMF 1.0, §2.1; ISO/IEC 42001:2021 §6.1 (AI management
system); ISO/IEC 23894:2023 §5 (AI risk taxonomy).*

| NIST AI RMF function | Office practice |
|---|---|
| **Govern** | `AGENTS.md` standing rules; `docs/agency-decisions.md` records owner authority |
| **Map** | Phase and role model; task scoping; acceptance checklist |
| **Measure** | QA verification of criteria; `tools/*_test.js` regression gates |
| **Manage** | Approval gates; token ceilings; escalation ladder; kill switch (`.autonomy_stop`) |

**SOP-14.3** — Prompt-injection defences **MUST** treat all external content
as untrusted input, including user-controlled text that reaches a subagent.
*Reference: OWASP Top 10 2021 A03 "Injection"; the shipped sanitisation
controls for F-04 and F-05.*

**SOP-14.4** — The office **MUST** maintain a kill switch for autonomous
execution and **MUST** honour it immediately. *Reference: NIST SP 800-53
Rev. 5 AC-6 and CP-10.*

---

## 15. Records, documentation and change control

`[shipped]` — Source: `AGENTS.md` §"Version control (standing rule)"; repo
`duds-fw/virtual-office`.

### 15.1 Record types

| Record | Where it lives | Retained because |
|---|---|---|
| Deliverable | `task.deliverable` `[designed]`; code in git | The artefact itself |
| Decision | `docs/agency-decisions.md` | The reasoning, so it is not re-litigated |
| Escalation | Board `escalations[]` + activity log | Audit of what was blocked and who owned it |
| Lesson | `lessons[]` + retrospective | What changed as a result |
| Finding | `docs/agency-security-review.md` | Security posture over time |
| Owner decision | `decisions[]` via `POST /api/client/decision` | The owner's authority record |

*Reference: ISO 9001:2015 §7.5 "Documented information"; RFC 9110 §9 for
API method and status conventions.*

### 15.2 Version control

**SOP-15.1** — Every code change **MUST** be committed locally before its task
leaves `in_progress`. Committing is inside every role's authority and **MUST
NOT** be requested from the Client.

**SOP-15.2** — Pushing, opening a pull request, tagging a release and writing
to a remote are **client-visible** actions and **MUST NOT** be performed
without the Client's explicit go-ahead.

**SOP-15.3** — Live state **MUST NOT** be committed. `state/` is excluded, and
`state/client.json` holds the owner bot token and **MUST** never enter
history.

### 15.3 Document control

**SOP-15.4** — This SOP and `docs/role-guidelines.md` carry a roster-version
header. When `agency.js` ROSTER, PHASES, GATES, STATUSES or
ESCALATION_PATH change, the sync check **MUST** fail until the documents are
updated. *Reference: ISO 9001:2015 §7.5.2 "Creating and updating" — documents
are controlled, versioned and reviewed.*

### 15.4 Precedence

Where documents conflict:

1. **`agency.js`** — the mechanism. What actually happens.
2. **`docs/agency-decisions.md`** — the authority. The owner's ratified decisions.
3. **`docs/sop-virtual-office.md`** — the procedure.
4. **`docs/role-guidelines.md`** — role detail.
5. **`AGENTS.md`** — working rules for agents.

**SOP-15.5** — A lower-ranked document **MUST NOT** override a higher-ranked
one. A conflict **MUST** be escalated at L2 (Orchestrator); a structural
conflict that changes an owner decision **MUST** be escalated to the Client.

---

## 16. Quality assurance and continual improvement

### 16.1 Nonconformance

**SOP-16.1** — A nonconformance (work that does not meet its criteria, a
gate approved in error, a control bypassed) **MUST** be recorded, and its
disposition **MUST** be one of: corrected, reworked, or accepted by the
accountable role with a recorded reason. It **MUST NOT** be silently closed.
*Reference: ISO 9001:2015 §10.2 "Nonconformity and corrective action."*

### 16.2 The improvement loop

`[shipped]` — Source: `agency.js` `recordLesson()`, `listLessons()`.

**SOP-16.2** — Every retrospective **MUST** produce at least one lesson, and
every lesson **MUST** record: the observation, the change made, and the scope
it applies to. A lesson **MUST** be applied — marked applied — or it is not a
lesson, it is a note.

**SOP-16.3** — A lesson **MUST** change a standing rule, a gate, a template,
or a test. A lesson that changes none of those has not been implemented.

### 16.3 Review cadence

| Document | Reviewed when |
|---|---|
| This SOP | Every sprint boundary |
| Role guidelines | When a role's roster entry changes, or a gate moves |
| `docs/agency-decisions.md` | When the owner ratifies a decision |
| Security review | After any change to a security-relevant surface |

---

## 17. Audit and compliance statement

### 17.1 Non-claims

**This office is not certified to any standard.** Specifically, it is **not**
ISO 9001, ISO/IEC 27001, ISO/IEC 42001, ISO/IEC 20000, SOC 2, ITIL or COBIT
certified, and it **MUST NOT** be described as such.

### 17.2 How the frameworks were used

The frameworks named in this SOP were used as **design references** — for
their *structure*, their *control themes*, and their *practice definitions*.
They were **not** adopted as a compliance programme, and no clause here
asserts conformity.

| Framework | Used for | Deliberately **not** used for |
|---|---|---|
| ISO 9001:2015 | Process structure; documented information; §8.6 release control; §10.2 nonconformity | A QMS with internal audit and management review |
| ISO/IEC 27001:2022 Annex A | Control-family taxonomy for the security programme | Certification or conformity claim |
| ISO/IEC 42001:2021 | AI management structure | AIMS certification |
| ISO/IEC 25010:2023 | The product quality model | Non-functional targets the office cannot measure |
| NIST SP 800-53 Rev. 5 | Control specifics (AC, CM, SA, AU, SI, CP) | A complete control baseline |
| NIST AI RMF 1.0 | Govern/Map/Measure/Manage for agent behaviour | A formal AI risk register |
| OWASP ASVS V4 | Verification requirements for the API surface | Web-app scope beyond the office's API |
| ITIL 4 | Incident, problem, change, service-request practice | A service catalogue or CMDB |
| COBIT 2019 | EDM governance loop; DSS practices | A full governance-and-management framework with an audit function |
| Scrum Guide 2020 | Sprint events; Definition of Ready/Done | Single-team, single-backlog scaling |
| PMBOK 7 | Principles (value, complexity, uncertainty) | A process-compliance claim |
| RFC 2119 / RFC 9110 | Normative keywords; API conventions | — |

### 17.3 Frameworks deliberately excluded

Excluded because their subject matter does not exist here, and naming them
would imply coverage that is not there: ISO 13485 (medical devices), HIPAA and
PCI DSS (regulated data), IEC 62443 (operational technology), ISO/IEC 27017
and 27018 (cloud/PII), and TOGAF (enterprise architecture).

### 17.4 What a real audit would find

Stated plainly so the owner is not surprised:

1. **No independent audit has been performed.** No auditor has reviewed this
   office.
2. **No conformity assessment evidence exists** — there is no QMS record set,
   no ISMS scope statement, no internal audit programme.
3. **The security programme is open.** Critical findings remain; the
   Deployment gate is closed (§4.6).
4. **The project pipeline is designed, not shipped.** §11 and §10 describe
   intended behaviour; the code does not yet implement it.
5. **Non-functional targets are unmeasured.** The office reports board-derived
   metrics only.

**SOP-17.1** — An audit of this office **MUST** follow **ISO 19011**
principles: independence, evidence-based approach, risk-based sampling,
fair presentation, and confidentiality of client information.

---

## 18. Role interaction matrix

`[shipped]` / `[designed]` — derived from `agency.js` ROSTER and §3.3.

| From \ To | PO | UX | SE/DE/AIE | QA | NetSec/SOC | DevOps family | Orchestrator |
|---|---|---|---|---|---|---|---|
| **PO** | — | consult | plan | consult criteria | consult | consult | escalate L1 |
| **UX** | approve design | — | hand off | — | — | — | consult |
| **SE/DE/AIE** | report scope | consult | — | hand to | hand to | hand to | escalate L1 |
| **QA** | verdict | — | defects | — | consult | — | escalate L2 |
| **NetSec/SOC** | gate verdict | — | findings | — | — | findings | escalate L2 |
| **DevOps family** | status | — | deploy | sign-off | consult | — | escalate L1 |
| **Orchestrator** | sequence | sequence | assign | sequence | sequence | sequence | — |

---

## 19. Approval

This SOP takes effect when the owner ratifies it. Ratification records the
owner decision in `docs/agency-decisions.md` as the next D-entry, and the
approval sheet below is completed.

| Item | Status |
|---|---|
| Standards references verified against the office's actual implementation | ✅ done |
| Design-vs-shipped markers applied to every clause | ✅ done |
| RACI reproduced verbatim from D7.2 | ✅ done |
| Security gate state stated honestly (§4.6) | ✅ done |
| Consistency checker written (`tools/sop-consistency-check.js`) | ✅ done |
| **Owner approval** | ✅ ratified 2026-10-26 |

| Role | Name | Date | Signature |
|---|---|---|---|
| Client (owner) | owner | 2026-10-26 | ratified in session — task `task_ybbvwd` |
| Orchestrator | duDDev Virtual Office | 2026-10-26 | recorded in `docs/agency-decisions.md` |

**Ratified on:** 2026-10-26  **Effective from:** 2026-10-26

**Next review:** sprint boundary, or on change to `agency.js` ROSTER / PHASES /
GATES / STATUSES / ESCALATION_PATH.
