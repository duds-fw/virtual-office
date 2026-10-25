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
