# Design Spec — Per-Role API Identity (agency API)

**Task:** task_21zt3o · Review phase (4h) · policy contract for the Sprint 2 hardening tasks. No code, `state/` or service change is part of this deliverable.

**Decision carried:** owner decision `dec_owd2a` (2026-10-25 05:50) — **full per-role identities** for the agency API, not one shared token; the client review loop moves to Sprint 3 until the hardening lands. This spec replaces the "shared-secret header" of fix-list item 1 with per-principal credentials and defines what fix-list items 3, 4 and 7 must implement.

**Review reference:** `docs/agency-security-review.md` — F-01 (no auth, wildcard CORS, `0.0.0.0` bind), F-02 (body-supplied role), F-03 (gate bypass), F-04/F-05 (prompt injection), F-06 (`/api/client/setup` takeover), F-07 (decision attribution). Verdict of that review stands: the Deployment `security_signoff` gate must not be marked approved before F-01, F-02, F-03, F-04 and F-06 are closed.

**Reading note:** `server.js` and `agency.js` moved while this spec was written (the review cites `/api/agency/approve` at `server.js:1045`; it was at `server.js:1167` when this spec was authored). Line anchors below are the ones **actually observed** during the Sprint 2 read; implement by symbol name and re-check the anchor before editing.

---

## 1. Credential shape and storage

### 1.1 Principals

A **principal** is one authenticated identity. Principals are exactly:

- every roster agent id in `agency.js` `ROSTER` (lines 83–101): `orch, hermes, po, be, da, ux, se, de, aie, qa, ns, soc, dso, ce, iti, dba, sd`;
- one special principal `owner` — the human client, who owns the owner channel (`/api/client/*`). `owner` is **not** a roster agent and has no roster id; its matrix role is `client` (the escalation ladder's L3 role, `agency.js:36–41`).

`owner` is deliberately **not** in any `GATES[*].approverRoles` (`agency.js:23–34`), so the owner can never approve a gate.

### 1.2 Secret shape

- A credential is presented as **`X-Agency-Token: <principalId>.<secret>`** (header name fixed; `principalId` is public, `<secret>` is not).
- `<secret>` = 32 bytes from `crypto.randomBytes(32)` rendered as **64 lowercase hex characters**.
- The server stores **only the SHA-256 digest** of the secret (`digest`, 64 hex chars). A leaked credential file therefore does not yield directly usable bearer material.
- The plaintext is shown **once**, at provisioning time, and never again.

### 1.3 Storage — file, not environment

| decision | value | why |
|---|---|---|
| source of truth | file `state/credentials.json` | 17+ principals cannot live in env vars; rotation/revocation need a mutator, and env vars need a restart |
| path override | env `AGENCY_CREDENTIALS_FILE` (default `state/credentials.json`) | relocation without code change |
| permissions | file `0600`, directory `0700` | mirrors the existing `state/client.json` precedent (`client.js:51–58`) |
| startup check | refuse to start if the file is group/world readable (`mode & 0o077`) or if the directory is not `0700` | a world-readable credential file is a silent full compromise |
| env vars | **rejected** for secret material | visible in `/proc/<pid>/environ` of every same-user process, needs a restart to change, and does not scale to a per-role fleet |

**No secret in `state/agency.json`.** `state/agency.json` (`agency.js:16–17`) is domain state and is returned verbatim by `GET /api/agency/state` (`server.js:1106`). The credential file is read **only** by the HTTP auth layer in `server.js`; `agency.js` never imports it, never sees a digest, and never writes one. The domain receives an *already resolved identity object* (§3), never a token.

`state/` is **not** covered by `.gitignore` today (it contains only `.database-mcp/`), so `state/client.json` — which holds the Telegram bot token — is currently committable. Required: add `state/credentials.json` **and** `state/client.json` to `.gitignore`.

### 1.4 File format

```json
{
  "version": 1,
  "createdAt": 1760000000000,
  "principals": {
    "owner": {
      "kind": "owner",
      "label": "Owner console + client channel",
      "digest": "<64 hex sha256 of the secret>",
      "createdAt": 1760000000000,
      "rotatedAt": null,
      "revoked": false
    },
    "ns": {
      "kind": "agent",
      "label": "Network & Security",
      "digest": "<64 hex sha256 of the secret>",
      "createdAt": 1760000000000,
      "rotatedAt": null,
      "revoked": false
    }
  }
}
```

Unknown keys are ignored; a missing `principals` object is a hard startup error (fail closed, never "no credentials ⇒ open").

### 1.5 Provisioning, rotation, revocation

A CLI is the only provisioning surface: `tools/agency_credentials.js` with subcommands (owner: `devops_sre`; the CLI is not part of the server.js/agency.js change list):

| command | effect |
|---|---|
| `list` | prints principal ids, `createdAt`, `rotatedAt`, `revoked` — **never** digests or secrets |
| `provision <id>` | creates the principal, prints the plaintext secret **once**, writes the digest |
| `rotate <id>` | new secret, digest replaced, `rotatedAt` set, old secret dies immediately |
| `revoke <id>` | `revoked: true`; every token for that principal is rejected from the next request |
| `unrevoke <id>` | clears `revoked` (audit trail keeps `revokedAt`) |

- **No grace period on rotation.** The old secret is invalid the instant the new one is written; there is exactly one valid digest per principal, so there is nothing to compare against.
- **Revocation is a tombstone**, not a delete: the record stays with `revoked: true` so the audit trail can show that a credential existed and when it died.
- **First start:** if `state/credentials.json` does not exist, the server creates it with **only** the `owner` principal and prints the owner secret once to stdout with a warning to move it into the password manager. Roster principals are provisioned explicitly by the CLI — an agent that needs to call the API asks for a credential, it does not get one automatically.
- **Rotation for a leaked credential:** `rotate <id>`; the old value is dead at once and the activity trail shows a gate/decision signed with the new one.

### 1.6 Verification — constant time

```
presented  = "<principalId>.<secret>"
id, secret = presented.split('.', 2)          // exactly one separator, both parts non-empty
record     = store.principals[id]             // undefined ⇒ reject
d1         = sha256(secret)                   // 32 bytes
d2         = Buffer.from(record.digest, 'hex')// 32 bytes
equal      = d1.length === d2.length && crypto.timingSafeEqual(d1, d2)
```

- Length is checked before the compare (fail closed), but both digests are fixed 32 bytes, so the compare itself is constant-time.
- `crypto.timingSafeEqual` throws on length mismatch — never let it throw into the request path.
- The **presented** value is never logged, never written to the state file, never echoed in an error body. Errors carry only the principal id and a code.
- A revoked principal short-circuits before the compare and answers `401 revoked`.

---

## 2. How the office UI authenticates

### 2.1 The shape of the answer

The static page is **exempt** from the credential check, and the server binds **127.0.0.1** by default (`server.js:8`, `const HOST = process.env.HOST || '0.0.0.0'` → `'127.0.0.1'`). The browser obtains a credential **from the server, at page load**, not from a secret embedded in the page.

`GET /` (and any non-`/api/` path) is exempt. On `GET /` the server issues a **console session**:

```
Set-Cookie: agency_console=<32-byte hex sid>; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200
```

The sid is held in an **in-memory** map in `server.js` (`sid -> { principalId:'owner', createdAt, expiresAt }`), never written to disk; a server restart invalidates all console sessions and the next page load mints a new one. `HttpOnly` keeps it out of `document.cookie`; `SameSite=Strict` keeps it out of any cross-site request the owner might trigger from a page they visit.

### 2.2 What the browser sends

The browser sends the cookie automatically on every same-origin `fetch('/api/...')` — **no change to `public/index.html` is required for reads or board writes**. The credential check accepts exactly two forms:

| form | principal | used by |
|---|---|---|
| header `X-Agency-Token: <principalId>.<secret>` | roster agent or `owner` token | agent runtimes (subagent sessions), CLI, automation |
| cookie `agency_console=<sid>` | console session → `owner` | the office UI in the browser |

Rules:

- If the `X-Agency-Token` header is **present**, it must validate — a bad header never falls back to the cookie (`401 invalid_token` / `401 revoked`).
- If the header is absent, the cookie is checked.
- If neither is present → **`401 {ok:false,error:{code:'unauthorized',message}}`** and **no route handler runs**.
- A `GET /` response always refreshes a missing/expired console cookie, so the UI never has to retry.

### 2.3 Where the guard sits — one place

**One guard, before the route table.** In `server.js` the request handler starts at line 952 (`const server = http.createServer(async (req, res) => {`); the CORS/OPTIONS block is lines 956–959; the first route match is line 961 (`/api/opencode/live`). The guard goes **between the OPTIONS block and the first route match**, so it covers every `/api/*` route in the file and nothing else:

```js
// 1. origin gate (see 2.5)
// 2. if (pathname.startsWith('/api/')) {
//      const auth = authenticateRequest(req);      // {ok:true, caller} | {ok:false, code, status}
//      if (!auth.ok) { res.writeHead(auth.status, {'Content-Type':'application/json; charset=utf-8'});
//                      return res.end(JSON.stringify({ok:false,error:{code:auth.code,message:auth.message}})); }
//      req.agencyCaller = auth.caller;             // {id, kind, matrixRole, name, scopes}
//    }
```

`req.agencyCaller` is the **only** identity input to the domain layer; no handler re-parses a token and no handler reads a body field for identity.

### 2.4 Routes that stay exempt

Exempt means: **no credential required**.

1. every path that does **not** start with `/api/` — the static page and its assets (the fall-through static handler at `server.js:1373–1381`);
2. `OPTIONS` preflight (answered at `server.js:959`) — but only for allow-listed origins, see §2.5;
3. nothing else. `GET /api/opencode/live`, `GET /api/agency/state`, `/metrics`, `/standup`, `/workload`, `/tokens`, `/models`, `/health`, `/decisions`, `/api/client/status`, `/api/autonomy/status` are **protected reads** — the console cookie covers them.

### 2.5 Origin and CORS — **TO BE IMPLEMENTED** (owner: `devops_sre`, fix-list item 2)

- `Access-Control-Allow-Origin: *` (`server.js:956`) is removed. Default allow-list = the server's own origins (`http://127.0.0.1:9012`, `http://localhost:9012`) plus anything in `AGENCY_CORS_ORIGINS`.
- `Access-Control-Allow-Headers` must include `X-Agency-Token` when an allow-listed origin is present, otherwise agent calls from a browser are impossible.
- **Origin rejection:** any request that carries an `Origin` header **not** in the allow-list is rejected with **`403 {ok:false,error:{code:'origin_not_allowed'}}`** — before the credential check. Non-browser callers (curl, agent runtimes) send no `Origin` and are unaffected. This is the hard stop for the drive-by page in F-01, independent of the cookie.
- A `OPTIONS` request from a non-allow-listed origin is answered **403** with no CORS headers (today it is a blanket `204`, `server.js:959`).

### 2.6 Residual risk of a local visitor seeing the credential

**Stated plainly:** any process on the host that can reach `127.0.0.1:9012` can `GET /` and receive a valid console session, i.e. `owner` authority over the board and the owner channel. The console session cannot approve gates, re-pair the client, or touch autonomy budgets (§4 scopes), but it can create/assign/advance tasks and answer owner decisions.

What bounds the risk today:

- the bind is loopback only (fix-list item 1), so the attacker must already have code execution on the host;
- the console cookie is `SameSite=Strict`, so **a web page the owner visits cannot use it** — a drive-by page cannot read the cookie and cannot send it cross-site;
- the origin gate (§2.5) rejects any cross-origin request outright, so the drive-by page is stopped even if it learns the URL;
- console sessions are in-memory: a restart drops them all.

What is **not** bounded: a local process (not a browser) with the owner's own uid, or anything running as root. If the office ever runs on a shared host, the console session must be replaced by an explicit owner credential (`X-Agency-Token: owner.<secret>`) — the same code path, no new mechanism. As a belt-and-braces rule: **the server issues console sessions only when `HOST` is a loopback address**; on a non-loopback bind it logs `console sessions disabled (non-loopback bind)` and the UI must present an agent token instead.

### 2.7 The one UI gap: re-pairing needs the owner secret

`POST /api/client/setup` (see §5) requires the **owner token**, not the console session, so the browser cannot re-pair on its own. The operator either runs the `curl` in §5.4 or types the owner secret into the UI's re-pair form, which then sends `X-Agency-Token: owner.<secret>` and keeps it in `sessionStorage` only. That is a `public/index.html` change owned by `ui_ux_designer`; it is **not** part of the server.js/agency.js change list in §7.

---

## 3. From an authenticated caller to a roster agent

### 3.1 Mapping

The credential store names the principal. The server resolves it to an identity object:

| credential principal | resolved identity | matrixRole | how the matrixRole is obtained |
|---|---|---|---|
| roster id, e.g. `ns` | `{id:'ns', kind:'agent', name:'NetSec', matrixRole:'network_and_security'}` | from `ROSTER` | `agency.js:83–101` — the roster is the single source of truth; the auth layer must not carry a second role table |
| `owner` | `{id:'owner', kind:'owner', name:'Owner', matrixRole:'client'}` | fixed | the owner is not a roster agent |
| console session | `{id:'owner', kind:'console', name:'Owner', matrixRole:'client'}` | fixed | §2.1 |

`kind` matters: `console` may not be used where `owner` (token) is required, and only `kind:'agent'` can approve a gate.

### 3.2 Scopes

A scope is a capability attached to the resolved identity. Scopes are derived from the matrix role by **one table** in the auth layer, so adding a role is a single edit:

| scope | matrix roles that hold it | routes |
|---|---|---|
| `board` | every roster agent; `owner`; console | all reads + task/sprint/project/assign/advance/status/escalation writes |
| `approve` | `ui_ux_designer`, `product_owner_product_manager`, `network_and_security`, `security_operations_soc` (exactly the union of `GATES[*].approverRoles`) | `POST /api/agency/approve` |
| `control` | `devops_sre` (autonomy budget/stop/start, model probe/simulate), `orchestrator_lead` (`/api/orchestrate/goal`, autonomy tick/start) | the autonomy and orchestration routes |
| `client` | `owner` **token** and console session | `/api/client/decision/answer`, `/api/client/report` |
| `re-pair` | `owner` **token only** (not the console session) | `POST /api/client/setup` |

A route that needs a scope the caller lacks answers **`403 {ok:false,error:{code:'scope_denied',message}}`** before the handler runs. A route that needs a *matrix role* the caller does not hold answers **`403 role_not_approver`** from the domain (§4).

### 3.3 How the identity reaches the agency layer — a context argument, not a module global

The identity travels as an **explicit argument**. A module-level `agency.setCaller(agentId)` is explicitly rejected: `server.js` awaits inside request handlers (`await readJsonBody(req)`, `await fetchTokenUsage()`), so a global set before an `await` can be read by an unrelated request after it resumes, and the autonomy tick runs in the same process. Identity that lives in a global is identity that leaks between callers.

The context object passed into the domain:

```js
// caller = { id, kind, matrixRole, name, scopes }
```

### 3.4 Exact signature changes in `agency.js`

Three functions change shape; every other mutating function gains an **optional** trailing `caller` argument used only for the activity trail.

```js
// current                                     ->  new
function approveGate(taskId, gateId, role)      ->  function approveGate(taskId, gateId, caller)
function setTaskStatus(taskId, status, reason)  ->  function setTaskStatus(taskId, status, reason, caller)
function updateTask(taskId, patch)              ->  function updateTask(taskId, patch, caller)
function answerDecision(id, optionId, answeredBy)  ->  unchanged signature, but answeredBy becomes REQUIRED
```

- `approveGate(taskId, gateId, caller)` — `caller` is **mandatory**. The old third parameter `role` (a caller-supplied string, `agency.js:555`) is gone; there is no longer any way to pass a role string into the function.
- `setTaskStatus(taskId, status, reason, caller)` — `caller` is mandatory (the activity entry records who moved the task). If `caller` is missing → `{ok:false, reason:'caller_required'}`.
- `updateTask(taskId, patch, caller)` — `caller` is mandatory; used for the phase rule in §4.4 and for the activity trail.
- `answerDecision(id, optionId, answeredBy)` — keep the parameter, but change the rule: `answeredBy` must be a non-empty string; a falsy value returns `{ok:false, reason:'attribution_required'}`. The server always passes the **derived** identity, never the body value.
- Optional-trailing `caller` on `createTask(body, caller)`, `assignTask(taskId, agentId, caller)`, `advanceTask(taskId, caller)`, `cancelTask(taskId, caller)`, `resolveEscalation(id, reason, caller)` — used only to write "… by <caller>" into `logActivity` (`agency.js:220`). `createTask` also stamps `t.createdBy = caller.id`.

Export list (`agency.js:945–977`) gains nothing new except, if desired, `ROSTER` is already exported (`agency.js:949`) — the auth layer reads `agency.ROSTER` to resolve the matrix role, so the roster table stays in one place.

---

## 4. Gate binding and the status rules

### 4.1 The rule

**`approveGate` derives the approver from the authenticated caller. It never reads a role from the body.** The body field `role` is not an input to the authorization decision — it is a client-side echo that the server ignores, and rejects when it contradicts the caller.

The gate must also be **the gate of the task's next phase** — the same rule `advanceTask` already enforces (`agency.js:443–451`: `const nextPhase = PHASES[idx + 1]; const gate = GATES[nextPhase];`). `GATES` is keyed by the phase being *entered* (`agency.js:23–34`): `GATES.Development = design_approval`, `GATES.Deployment = security_signoff`.

### 4.2 Check order and exact answers for `POST /api/agency/approve`

`nextPhase` = the phase after `task.phase` in `PHASES` (`agency.js:20`).

| # | check | failure |
|---|---|---|
| 1 | caller is `kind:'agent'` and holds scope `approve` | **`403 role_not_approver`** (with `approverRoles` listed) — checked **before** the task lookup, so an unauthorized caller learns nothing about tasks |
| 2 | task exists | **`404 task_not_found`** |
| 3 | `body.gate` present and matches a known gate id | **`400 missing_gate`** / **`404 unknown_gate`** |
| 4 | `task.phase` is a known phase | **`409 bad_phase`** |
| 5 | the task has a next phase (not already in `Operations`) | **`409 no_next_phase`** |
| 6 | **the next phase has a gate** | **`409 no_gate_for_phase`** |
| 7 | that gate's id equals `body.gate` | **`409 gate_not_next_phase`** |
| 8 | that gate is not already approved on this task | **`409 gate_already_approved`** |
| 9 | `caller.matrixRole` ∈ `GATES[nextPhase].approverRoles` | **`403 role_not_approver`** (with `approverRoles` listed) |
| 10 | `body.role` absent, or equal to `caller.matrixRole` | **`403 role_mismatch`** |
| 11 | approve | — |

On success (`200`):

```
t.gates[gate.id]          = 'approved'
t.gates[gate.id + '_by']  = caller.matrixRole      // e.g. 'network_and_security'
t.gates[gate.id + '_byAgent'] = caller.id          // e.g. 'ns'
t.gates[gate.id + '_at']  = Date.now()
logActivity(caller.name, `"${t.title}" — ${gate.label} approved by ${caller.name} (${caller.matrixRole})`)
```

### 4.3 The two edge cases the brief asks for

- **The target phase has no gate** (e.g. the task sits in `Operations`, or in `Review` where the next phase is `Deployment` but the gate id asked for is `design_approval`):
  - next phase has **no** gate at all → **`409 no_gate_for_phase`** — there is nothing to approve; the caller should be using `POST /api/agency/advance`.
  - the next phase **has** a gate, but the caller named a different one → **`409 gate_not_next_phase`**.
- **The task is already in the gated phase** (e.g. `task.phase === 'Deployment'`, gate `security_signoff`): the task's next phase is `Operations`, which has no gate → **`409 no_gate_for_phase`**. This is correct and intended: the `security_signoff` gate is consumed **on entry** into `Deployment` — it is approved while the task still sits in `Review`, and `advanceTask` is what lets it in. A task already in `Deployment` has, by construction, an approved `security_signoff`; re-approving it is refused with **`409 gate_already_approved`** if the caller names the Deployment gate while the task is still in `Review`.

### 4.4 `setTaskStatus` — closing the F-03 bypass

`setTaskStatus` (`agency.js:532–553`) today assigns any string and never consults `GATES`. New rules:

1. **Fixed vocabulary.** Accepted statuses: `backlog, ready, in_progress, review, blocked, cancelled`. Anything else → **`400 {ok:false,error:{code:'invalid_status'}}`** (F-13 / fix-list 11). The vocabulary replaces the current `OPEN_STATUSES` (`agency.js:103`) use, which was only load accounting.
2. **`done` is never accepted.** Completion is `advanceTask`'s job — it is the only path that walks phases and honours gates (`agency.js:423–462`). `POST /api/agency/task/:id/status {"status":"done"}` → **`409 {ok:false,error:{code:'completion_requires_advance'}}`** and the task is untouched. This is review remediation option (b) ("route completion through `advanceTask`") and it closes every variant of the bypass at once — including a task created directly in a later phase.
3. **`updateTask` may not move a task across a gate.** `PATCH /api/agency/task/:id` with `phase` (`agency.js:813–816`): the new phase must be the task's **next** phase, and that phase's gate (if any) must already be `approved` on the task; otherwise **`409 {ok:false,error:{code:'phase_change_requires_advance'}}`** (the UI should call `/api/agency/advance`).
4. `blocked` still records the escalation and `blockedReason` as today; every status change writes an activity entry naming `caller.name`.

### 4.5 Scope table for the mutating routes

| route (server.js line anchor) | scope | domain call |
|---|---|---|
| `POST /api/agency/task` (1126) | `board` | `agency.createTask(body, caller)` |
| `POST /api/agency/assign` (1140) | `board` | `agency.assignTask(body.taskId, body.ownerId, caller)` |
| `POST /api/agency/advance` (1155) | `board` | `agency.advanceTask(body.taskId, caller)` |
| `POST /api/agency/approve` (1167) | `approve` + role check | `agency.approveGate(body.taskId, body.gate, caller)` — `body.role` is **not** forwarded |
| `DELETE /api/agency/task/:id` (1179) | `board` | `agency.cancelTask(id, caller)` |
| `PATCH /api/agency/task/:id` (1185) | `board` | `agency.updateTask(id, body, caller)` — phase rule §4.4 |
| `POST /api/agency/task/:id/status` (1197) | `board` | `agency.setTaskStatus(id, body.status, body.reason, caller)` |
| `POST /api/agency/escalation/:id/resolve` (1211) | `board` | `agency.resolveEscalation(id, body.reason, caller)` |
| `POST /api/agency/sprint` (1229), `/project` (1241) | `board` | unchanged + caller |
| `POST /api/autonomy/budget` | `control` (`devops_sre`) | clamp to configured ceilings (fix-list 8) |
| `POST /api/autonomy/stop` / `start` | `control` | unchanged |
| `POST /api/autonomy/tick` | `control` | unchanged |
| `POST /api/orchestrate/goal` (967) | `control` (`orchestrator_lead`) | unchanged — see §6 for the injection boundary |
| `POST /api/agency/models/probe` (1261), `/simulate-exhausted` (1267) | `control` | unchanged |
| `POST /api/client/*` | see §5 | — |
| all `GET` routes | `board` | unchanged |

---

## 5. `/api/client/*` — the owner channel

### 5.1 Same guard, extra scopes

`/api/client/*` sits behind the **same** guard as everything else (`server.js:1301` status, `1310` setup, `1336` report, `1343` decision, `1356` decision/answer). No credential → `401`.

| route | required scope | who |
|---|---|---|
| `GET /api/client/status` (1301) | `board` | any authenticated caller |
| `POST /api/client/report` (1336) | `client` | owner token or console |
| `POST /api/client/decision` (1343) | `board` | any authenticated caller may raise a decision |
| `POST /api/client/decision/answer` (1356) | `client` | owner token or console only |
| `POST /api/client/setup` (1310) | `re-pair` | **owner token only** — the console session is refused with `403 owner_credential_required` |

### 5.2 Attribution is derived, never taken from the body (F-07)

`server.js:1359` today reads `agency.answerDecision(body.id, body.option, body.answeredBy || 'owner')`. New code:

```js
const caller = req.agencyCaller;                       // {id, kind, matrixRole, name, scopes}
const attribution = caller.id;                         // 'owner' for both the owner token and the console session
const result = agency.answerDecision(body.id, body.option, attribution);
```

- `body.answeredBy` is **ignored entirely**. A body that says `"answeredBy":"attacker"` must not change the record: the stored `decision.answeredBy` is `"owner"`.
- `answerDecision` rejects a missing attribution (`{ok:false, reason:'attribution_required'}`) so a future caller cannot silently fall back to a default.
- Only the `owner` principal may answer: `kind` in `{owner, console}` and scope `client`. A roster agent answering → **`403 scope_denied`**.
- The activity entry records the answering principal (`agency.js:927`).

### 5.3 Re-pairing semantics when the bot token changes (F-06)

`POST /api/client/setup` is the takeover route: today it is unauthenticated with wildcard CORS. New behaviour:

1. **Auth**: scope `re-pair` — the `owner` **token** (`X-Agency-Token: owner.<secret>`). A console session → **`403 owner_credential_required`**.
2. **Confirmation**: any change to `botToken` or `chatId` requires a **one-time confirmation code**. When such a request arrives without a valid code, the server prints an 8-hex-char code to **stdout** (`[client] re-pair confirmation: 3f9a2c71 — valid 120s`) and answers **`409 {ok:false,error:{code:'re_pair_confirmation_required'}}`**. The caller repeats the request with `{"confirmRePair":"3f9a2c71"}`; the code is single-use and expires after 120 s. The code is never written to a file — if stdout is redirected to a log file, that log must be `0600`.
3. **Token change invalidates the old pairing**: when `botToken` changes, the server writes the new token **and clears `chatId`** (`state/client.json`), so the office cannot keep reporting to a chat id that was bound to the previous token. The operator must re-supply `chatId`; until then `client.status().configured` is false and no report is sent. The new token is validated against Telegram's `getMe` before it is stored (existing behaviour in `client.js:66–83`).
4. **Non-sensitive fields** (`reportHour`, `reportsEnabled`) do not need the confirmation code, but still need the `re-pair` scope — they are part of the same owner channel.
5. Every setup call is logged as a mutation with the actor (`owner`) and the changed fields — **never** the token value.

### 5.4 Owner operations from the CLI

```sh
curl -sS -X POST http://127.0.0.1:9012/api/client/setup \
  -H 'Content-Type: application/json' \
  -H "X-Agency-Token: owner.$(cat ~/.config/virtual-office/owner.secret)" \
  -d '{"botToken":"123:ABC","chatId":"456"}'
# → 409 re_pair_confirmation_required (code on the server console) → repeat with "confirmRePair"
```

---

## 6. The prompt-injection boundary — **TO BE IMPLEMENTED** (owner: `ai_engineer`, `security_operations_soc`)

Identity reduces *who* can reach the prompt; it does not make the prompt safe. Every string that a caller can influence — the `goal` and `description` bodies of `POST /api/orchestrate/goal` (`server.js:967`, interpolated verbatim into the prompt at `server.js:974–989`), a task `title`/`description` (`agency.js:331–360`), a `blockedReason` (`agency.js:543–545`) and any `role` string — is **data, never instruction**: it is quoted, length-capped, stripped of control characters, and placed **outside the instruction position** of the prompt; the agent session that executes it is disposable and runs with a restricted tool allow-list; the same quoting applies to every board value interpolated into the autonomy tick prompt (fix-list items 5 and 6). An authenticated agent's own text is still upstream-attacker-influenceable — content the office fetches can carry an injection — so sanitisation is **not** replaced by authentication. This paragraph is the boundary contract only; the implementation belongs to fix-list items 5–6 and is a **dependency** of the Deployment gate sign-off, not of this identity spec.

---

## 7. Change list

### 7.1 `server.js` (owner: `devops_sre`, fix-list 1, 2, 7, 8)

| # | change | where |
|---|---|---|
| S1 | `const HOST = process.env.HOST || '0.0.0.0';` → `process.env.HOST \|\| '127.0.0.1'` | line 8 |
| S2 | new section: credential store loader/validator (mode check `& 0o077` → refuse start; unknown principal → reject; `revoked` → reject), `sha256` + `crypto.timingSafeEqual` compare, principal resolver (roster id → `agency.ROSTER` matrix role; `owner` → `client`), scope table, console-session map (`sid -> {principalId, createdAt, expiresAt}`, 12 h, in-memory) | new code, before the request handler |
| S3 | replace the wildcard CORS headers with the allow-list; `OPTIONS` answered **403** for a non-allow-listed `Origin`; `Access-Control-Allow-Headers: Content-Type, X-Agency-Token` | lines 956–959 |
| S4 | **origin gate**: request with an `Origin` header not in the allow-list → `403 origin_not_allowed` | in the handler, before S5 |
| S5 | **credential guard**: one block between the OPTIONS block and the first route match; sets `req.agencyCaller`; `401 unauthorized` / `401 invalid_token` / `401 revoked` | between lines 959 and 961 |
| S6 | console session: on `GET /` (and only a loopback bind), mint/refresh `agency_console` cookie (`HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`); `owner` principal; scopes `board` + `client` | in the static branch, lines 1373–1381 |
| S7 | `POST /api/agency/approve`: forward `req.agencyCaller` instead of `body.role`; map the domain reason to the status codes in §4.2 (today every failure is `409`) | line 1170 |
| S8 | `POST /api/agency/task/:id/status`: forward `req.agencyCaller`; map `invalid_status` → 400, `completion_requires_advance` → 409 | line 1201 |
| S9 | `PATCH /api/agency/task/:id`: forward `req.agencyCaller`; map `phase_change_requires_advance` → 409 | line 1188 |
| S10 | `POST /api/client/decision/answer`: `answeredBy` = `req.agencyCaller.id`; `body.answeredBy` not read; 403 for non-owner | line 1359 |
| S11 | `POST /api/client/setup`: require scope `re-pair` (owner **token**, not console); re-pair confirmation code (print to stdout, single use, 120 s); on a bot-token change clear `chatId`; never log the token | lines 1310–1334 |
| S12 | scope gate per route for the `control` routes (`/api/autonomy/*`, `/api/orchestrate/goal`, `/api/agency/models/probe|simulate-exhausted`) → `403 scope_denied` | the autonomy/orchestrate route branches |
| S13 | mutation logging: method, path, principal id, status for every mutating request (fix-list 14) | handler |

### 7.2 `agency.js` (owner: `software_engineer`, fix-list 3, 4, 11)

| # | change | where |
|---|---|---|
| A1 | `approveGate(taskId, gateId, caller)` — drop the `role` parameter; implement the §4.2 check order; write `_by` (matrix role), `_byAgent` (agent id), `_at`; activity entry names the agent | `agency.js:555–569` |
| A2 | `setTaskStatus(taskId, status, reason, caller)` — status vocabulary (`400 invalid_status`), reject `done` (`409 completion_requires_advance`), activity names the caller | `agency.js:532–553` |
| A3 | `updateTask(taskId, patch, caller)` — phase may only move to the next phase and only with that phase's gate already approved (`409 phase_change_requires_advance`) | `agency.js:813–816` |
| A4 | `answerDecision(id, optionId, answeredBy)` — `answeredBy` required (`attribution_required`); activity names the answering principal | `agency.js:906–930` |
| A5 | optional trailing `caller` on `createTask`, `assignTask`, `advanceTask`, `cancelTask`, `resolveEscalation` for the activity trail; `createTask` stamps `createdBy` | `agency.js:331`, `366`, `423`, `485`, `822` |
| A6 | export the status vocabulary constant (`STATUSES`) for reuse by the server | `agency.js:103` area, `module.exports` at `945–977` |

### 7.3 Not in this change list (other owners)

`.gitignore` (add `state/credentials.json`, `state/client.json`) — `devops_sre`; `tools/agency_credentials.js` CLI — `devops_sre`; `public/index.html` re-pair field + `esc()` work (F-15/F-16) — `ui_ux_designer`; prompt sanitisation (§6) — `ai_engineer`; CORS allow-list contents — `devops_sre`; static-handler hardening (F-09/F-10) — `software_engineer`.

---

## 8. Acceptance criteria

Testable by `quality_assurance` (fix-list 15). Suggested harness: a new `tools/agency_auth_test.js` in the style of `tools/agency_rules_test.js` (`AGENCY_STATE_DIR` override, `check(label, cond, detail)`, non-zero exit on failure). Each item states the request that must fail and the expected status.

1. **Unauthenticated write rejected** — `POST /api/agency/task {"title":"pwn"}` with no `X-Agency-Token` and no `agency_console` cookie → **401** `unauthorized`; `GET /api/agency/state` (with a valid credential) shows no task titled `pwn`.
2. **Bad or revoked credential rejected** — `POST /api/agency/task` with `X-Agency-Token: ns.<wrong-secret>` → **401** `invalid_token`; with a revoked principal → **401** `revoked`; neither creates a task.
3. **Reads are protected** — `GET /api/agency/state` with no credential → **401**; with the console cookie → **200**.
4. **Forged gate approval rejected** — `POST /api/agency/approve {"taskId":T,"gate":"security_signoff","role":"network_and_security"}` with the **software_engineer** token → **403** (`role_not_approver` / `role_mismatch`); `T.gates.security_signoff` is absent and no approval appears in the activity trail.
5. **Right role, wrong gate rejected** — the same request with the `ns` token against the `design_approval` gate → **403** `role_not_approver`; and the `ns` token approving `security_signoff` for a task whose next phase is not `Deployment` → **409** `gate_not_next_phase`.
6. **Gate binding behaves as specified** — `ns` token approving `security_signoff` for a task in `Review` → **200**, `gates.security_signoff === 'approved'`, `_by === 'network_and_security'`, `_byAgent === 'ns'`; for a task in `Operations` (next phase has no gate) → **409** `no_gate_for_phase`; re-approving an approved gate → **409** `gate_already_approved`.
7. **Status vocabulary and completion** — `POST /api/agency/task/T/status {"status":"done"}` → **409** `completion_requires_advance`, `T.status` unchanged; `{"status":"banana"}` → **400** `invalid_status`; `POST /api/agency/advance` on a task whose gate is unapproved → **409** `gate_pending`.
8. **Phase cannot be jumped** — `PATCH /api/agency/task/T {"phase":"Deployment"}` on a task in `Review` whose `security_signoff` is not approved → **409** `phase_change_requires_advance`; the task's phase is unchanged.
9. **Owner-channel takeover rejected** — `POST /api/client/setup {"botToken":"123:ATTACKER"}` with only a console cookie → **403** `owner_credential_required`; with the owner token but no `confirmRePair` → **409** `re_pair_confirmation_required`; with the printed code → **200** and `state/client.json.chatId` is **cleared** (the old pairing is dead).
10. **Decision attribution fixed** — `POST /api/client/decision/answer {"id":D,"option":"a","answeredBy":"attacker"}` with the owner credential → **200** and `D.answeredBy === "owner"`; the same request with no credential → **401**; with a roster-agent token → **403** `scope_denied`.
11. **Drive-by page blocked** — a page on `http://evil.example` running `fetch('http://127.0.0.1:9012/api/agency/task',{method:'POST',body:'{"title":"pwn"}'})` → the request is rejected **403** `origin_not_allowed`, no CORS allow header is returned, and no task is created.
12. **The office UI still reads its own data, and no secret leaks** — `GET /` → **200** with `Set-Cookie: agency_console=…; HttpOnly; SameSite=Strict`; the UI's `GET /api/opencode/live` with that cookie → **200** with `data.agency` present (the same request without the cookie → **401**); and `state/agency.json` contains no `digest`/`secret` material while `GET /api/agency/state` returns no credential material.

---

## 9. Residual risk, and what this spec deliberately does not close

- **Local-process authority** (§2.6): any same-host process can obtain a console session. Accepted for a single-user loopback office; on a shared host the console must be replaced by the owner token. Stated, not hidden.
- **Per-principal secrets do not expire.** A credential is valid until rotated or revoked; there is no TTL. Adding one means a session/expiry field and a refresh path — deliberately **not** in this spec, because it would add a lifecycle the office does not have.
- **The creation-phase hole is not closed here**: `createTask` accepts an arbitrary `phase`, so a task created directly in `Development` never has the `design_approval` gate. That belongs to fix-list 11 (`software_engineer`), together with the `estimateHours`, `projectId`/`sprintId` and `role` validation and the F-20 `ownerId` eligibility rule. Flagged, not silently absorbed.
- **`advanceTask` is still the only gate-aware transition**; `updateTask`'s phase rule (§4.4) mirrors it, but the phase/role rules for creation stay with fix-list 11.
- **Prompt injection is out of scope** (§6): identity limits the attacker set, it does not sanitise the prompt.
- **Read-time state mutation (F-17) and the static-handler hardening (F-09/F-10) are out of scope** — fix-list 9 and 13, `software_engineer`.
- **Rate limiting and mutation auditing** are fix-list 14 (`devops_sre`, `security_operations_soc`); §7.1 S13 only makes the actor available for that log.
