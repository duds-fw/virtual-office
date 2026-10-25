# Virtual Office — working rules for agents

These rules apply to any agent working in this directory. The global
`AGENTS.md` applies too; this file adds what is specific to the office.

## What this project is
The office is an agency simulator. It runs projects, sprints and tasks through
roles (see `agency.js` ROSTER). Work here changes the office's own behaviour,
so the rules below are about not wasting the office's token budget.

## Token discipline (strict)
The office is billed per token and tracks spend per role against a 2M/day
budget. Every role that exceeds its budget is refused further work until the
next local day.

- **Read only what you need.** Use `rtk read`, `rtk grep`, `rtk ls`, `rtk find`,
  `rtk git`, `rtk diff`, `rtk json`, `rtk tree`, `rtk wc` instead of raw
  `cat`/`ls`/`grep`/`find`. They strip noise and summarise.
- **Filter at the source.** `jq`, `python3 -c`, `grep -m`, `head` — never
  download a whole document to read one field.
- **Anything bulky goes through caveman.** `caveman_compress` for text,
  `caveman_toon_encode` for tabular JSON. Recover with `caveman_retrieve`.
- **Never cat a large file into context.** Check size first
  (`rtk wc <file>`), then read the slice you need.
- **Bound your output.** Report findings, paths and verdicts — never paste file
  contents back.
- **Do not re-read what you already read.** Cache the conclusion.

## API contract
The office API is the source of truth; do not read the JSON state files
directly while the server is running — the server holds that state in memory
and will overwrite your edit.

- `GET /api/agency/state` — board, tasks, roster, metrics, standup
- `GET /api/agency/workload` — capacity and utilisation per role
- `GET /api/agency/metrics` — velocity, SLA, lead time, utilisation
- `GET /api/agency/savings` — what rtk + caveman have saved
- `GET /api/agency/lessons` — what the last retrospective changed
- `GET /api/agency/models` — model routing state and queued work
- `GET /api/agency/health` — provider health, stuck subagents
- `POST /api/agency/task/:id/status` — transition a task
- `POST /api/agency/task/:id` — `PATCH` edit, `DELETE` cancel
- `POST /api/client/decision` — raise a strategic decision for the owner

## Rules for the work itself
- **Do not restart OpenCode.** A restart aborts every running subagent and
  drops the caller's in-flight command. If a service must be restarted, say so
  first.
- **Do not route a provider through the caveman proxy unless caveman owns that
  route.** Check `caveman doctor opencode` for owned routes first. The proxy
  forwards `openai`/`anthropic`/`opencode-go` to their canonical upstreams;
  `minimax-coding-plan` must stay direct.
- **The provider may be quota-limited.** That is not a failure to retry — the
  work queues and resumes automatically. Do not spin.
- **When a task is blocked by a gate, request the correct approver.** Do not
  bypass a gate.
- **Own decisions are execution-level; the owner's are strategic.** Escalate
  scope, budget, risk and prioritisation to the owner. Implementation choices
  are yours.

## Project pipeline (standing rule)
The office runs projects through six stages: **Registration → Triage → Planning →
Delivery → Acceptance → Done**. The full design is `docs/design-project-pipeline.md`
and the owner's decisions on it are `docs/agency-decisions.md` §D7. Follow those
without asking whether they were the intended answers — they were.

- **Responsibility is assigned by RACI** (design doc §2). Exactly one accountable
  role per stage. The stage owners are: Registration — owner; Triage — Product
  Owner; Planning — PO + Orchestrator; Delivery — phase-matched roles;
  Acceptance — QA verifies, Product Owner accepts; Done — Orchestrator.
- **Acceptance is two acts.** QA marks each criterion `met`/`unmet` against
  evidence. The Product Owner accepts or requests changes. The owner ratifies
  only when acceptance would change scope, budget, or accepted risk. **You may
  not accept your own delivery** — the accepting role must differ from every
  role that produced the evidence (P7, P8).
- **Acceptance criteria are a typed binary checklist**, never free text. Each
  criterion is one falsifiable claim with `met: boolean` and `metBy[]`. If a
  claim cannot be written as a single sentence that is true or false, it is a
  goal, not an acceptance criterion — put it in `project.goal` (P2).
- **A task reaches `done` only with a `deliverable`** naming what it produced
  (P3). A project reaches `done` only when every criterion is met and every
  referenced task is done (P4).
- **The Orchestrator owns the cross-project delivery timeline.** Multiple
  projects run concurrently and role capacity is shared across them. Sequencing
  contending work is the Orchestrator's call (P9), not the owner's, unless the
  contention changes scope, budget, or a committed date.
- **Do not exceed the project budget.** If the work genuinely needs more hours,
  raise a report item in the owner's digest with the overrun, the reason and the
  options. Do not spend the hours.
- **A missing engineering judgment is yours to make.** The escape hatch is for
  genuine strategic forks — different business outcomes — not for a decision
  with a defensible answer. Decide, record the reasoning, and carry it.

## Version control (standing rule)
This project is under git. It was not, and that was a defect in the office's
own operating standard, not in anyone's judgement.

- **Every code change is committed locally before the task leaves
  `in_progress`.** Committing is inside your authority — do it without asking.
  A task whose deliverable is code but which has no commit is not finished.
- **A deliverable of kind `code` must carry the commit SHA in
  `deliverable.ref`.** The office's own standard will refuse to close such a
  task without it.
- **Never push, never open a pull request, never tag a release, and never
  write to a remote** without the owner's explicit go-ahead. Those are
  client-visible actions and belong to the owner.
- **Never commit `state/`.** The server owns it in memory and rewrites it on
  every tick. `state/client.json` holds the owner bot token — it is
  `.gitignore`d and must never enter history.
- **If you find yourself editing a file that is not under version control,
  that is the more urgent problem.** Fix the version control first, then do
  the feature work. Recoverability outranks features.
- **The DevOps/SRE role owns the Deployment gate's recoverability check.** A
  project that delivers code which cannot be restored does not pass
  `security_signoff`; it goes to DevOps/SRE, not to the owner.
