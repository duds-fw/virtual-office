# Design Spec — Escalation Panel (level · owner · age)

**Task:** task_x00arw · Design phase (6h) · the implementer builds from this spec. No code, `state/` or service change is part of this deliverable.

## 1. Placement

The office UI has one agency surface: the `#menu-popup` Orchestrator menu (`public/index.html` L992–1015). Each agency panel = an `<h3>` + a `popup-*` div, filled by a `render*(liveAgency)` function called from `updatePopup()`. Insert a new section **after "Sprint Board"** (`<div id="popup-board">`, L1004), before **"Workload & Resources"**:

```html
<h3>Escalations <span id="popup-escalation-count" style="font-size:10px;color:var(--muted);"></span></h3>
<div id="popup-escalations" style="margin-bottom:8px;"></div>
```

Rationale: an escalation *is* a blocked task, so it reads right after the board that shows the blocked pill and `blockedReason`. The Delivery Metrics tile "Escalations / open" stays the one-number summary and must agree with the count badge.

## 2. Reuse (no new deps, no new colours)

- DOM: `el(tag,cls,text)` (L654) — API text via `textContent`, never `innerHTML`; `esc(s)` (L648) in template strings; `num(v,0)` (L660) guards timestamps.
- Layout: reuse `.wl-row`/`.wl-line` (L92–95) for the row, `.muted-note` (L73) for empty/loading copy.
- Colour: existing vars only — `--accent --ok --warn --danger --muted --text --border --panel`; new `.esc-row`, `.esc-chip`, `.esc-l1/.esc-l2/.esc-l3`, `.esc-resolved` are thin wrappers over them.
- Hook: add `renderEscalations(liveAgency)` to the `updatePopup()` chain (L976–979); `updatePopup()` runs on every `syncOpenCodeLive()` poll (7 s, L532), so the age ticks with no extra timer.

## 3. Fields read from `GET /api/agency/state` → `escalations[]`

Read `liveAgency.escalations` — the payload `GET /api/agency/state` returns, already delivered by `GET /api/opencode/live` (`data.agency`). Do **not** poll `/api/agency/state` from the panel: that endpoint writes the state file.

| field | render |
|---|---|
| `id` | DOM key + resolve target; not shown |
| `taskTitle` | line 1 headline, ellipsised |
| `owner` | line 1 right, `--text`; `—` when empty |
| `reason` | line 2, `--text` |
| `taskId`, `matrixRole` | line 2, `--muted` |
| `level` 1..3 | chip per §4; fallback when the clock is unusable |
| `blockedSince` | **age = `Date.now() − blockedSince`, computed client-side from the API value** |
| `createdAt`, `resolvedAt` | fallback clock when `blockedSince` is missing/0; truthy `resolvedAt` ⇒ resolved row (never written by the engine today) |

Age: `<1h` → `just now`; `<24h` → `Nh`; `≥24h` → `Nd Nh` (`3d 7h`). Negative delta (clock skew) clamps to `just now`; unusable clock → `age —`. Chip level is recomputed client-side with the engine's rule `min(3, 1 + floor(ageHours/24))` so a stale record keeps ageing; stored `level` is the fallback / write-time value. Row shape: `[L2] taskTitle  owner` over `reason · taskId · matrixRole · 31h old`.

## 4. States → CSS var

| state | colour var |
|---|---|
| none (no escalations) | `--ok` |
| L1 Product Owner | `--accent` |
| L2 Orchestrator | `--warn` |
| L3 Client | `--danger` |
| resolved | `--muted` (dimmed row, chip reads RESOLVED) |

Level labels are the fixed Product Owner / Orchestrator / Client names; `escalationPath` from the same payload may override them if it exposes one target per level. Empty = one `.muted-note` "No open escalations" in `--ok`. Not loaded yet (`liveAgency` null) = "Loading agency data…" in `--muted` (same wording as `renderBoard`/`renderWorkload`). Resolved rows sort last.

## 5. Resolving an escalation — **TO BE IMPLEMENTED**

The engine has **no** resolve endpoint and **no** writer of `resolvedAt` (agency-data-model §2, invariant B9) ⇒ `metrics().escalations.open` only grows. The panel is read-only until the endpoint below ships: no Resolve button, or a disabled one reading "resolve endpoint not implemented".

```
POST /api/agency/escalation/:id/resolve      body: { "reason": "<optional note>" }
```

- **200** `{ok:true, escalation:{id,taskId,taskTitle,reason,level,owner,matrixRole,blockedSince,createdAt,resolvedAt}}` — `resolvedAt` = epoch ms written server-side.
- **404** `{ok:false,error:{code:'escalation_not_found',message}}`
- **409** `{ok:false,error:{code:'already_resolved',message}}` (not idempotent)
- **409** `{ok:false,error:{code:'task_not_blocked',message}}` (stale escalation)
- **400** malformed JSON → `{ok:false,error:{code:'invalid_json'}}`
- **500** save failed → `{ok:false,error:{code:'internal_error'}}`; `resolvedAt` must not persist (write only after the state save succeeds).

Server side effects: set `resolvedAt = Date.now()`, append an `activity[]` entry, persist state, and make the open count exclude resolved records so the metrics tile and the panel badge agree. Resolving closes the escalation **only** — it must not touch `task.status`/`task.blockedReason` (PO decision D2 keeps self-healing on re-assign). Auth: same write auth as other `/api/agency/*` writes once HTTP hardening (execution-plan step 5) lands; no unauthenticated write.

Client flow: click → disable + "…" → POST → on 200 call `syncOpenCodeLive()` (existing refresh path) and re-render; on error show `error.message` in a `.muted-note` and re-enable.

## 6. Acceptance criteria

1. The panel renders from `escalations[]` and issues **no** request to `/api/agency/state` (the UI never writes state).
2. Every open row shows level, owner and age; age = `now − blockedSince` computed in the browser and growing between two renders without a reload.
3. Chip colour matches §4 exactly (L1 `--accent`, L2 `--warn`, L3 `--danger`, resolved `--muted`); no new hex values.
4. Empty state: `escalations: []` → exactly one "No open escalations" note, no rows; state not loaded → "Loading agency data…", never a blank box.
5. Oldest escalation: a 3-day-old record renders L3, age `3d Nh`, listed first, never dropped or hidden by a cap (a cap may apply to resolved rows only, and must state how many it hides).
6. `POST /api/agency/escalation/:id/resolve` → 200 with server-set `resolvedAt`, 404 unknown id, 409 already-resolved; afterwards the row moves to the resolved section and the open count drops by 1.
7. API strings (`taskTitle`, `reason`, `owner`, `matrixRole`, `taskId`) render as text via `el()`/`esc()`; a title containing `<script>` never executes.
8. Resolved rows are `--muted`, labelled RESOLVED, and sit in a collapsed section that states its count.
