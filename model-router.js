'use strict';
/**
 * model-router.js — picks which model the office should use, and what to do
 * when a provider refuses.
 *
 * Policy (owner-set):
 *   1. Prefer the free OpenCode models (big-pickle, beam-free, ...).
 *   2. Fall back to MiniMax when the free provider is exhausted.
 *   3. If every candidate is exhausted, queue the work and resume when a
 *      provider comes back — never silently drop it, never spin.
 *
 * The router probes by creating a throwaway session on a candidate and asking
 * it for a fixed token. A candidate that answers is known-good.
 */

const { execFile } = require('child_process');

const OPENCODE_BIN = process.env.OPENCODE_BIN || '/root/.opencode/bin/opencode';

/** Free first, paid last. */
const MODEL_POLICY = {
  free: [
    'opencode/big-pickle',
    'opencode/beam-free',
    'opencode/glm-5.3-flash-free',
    'opencode/deepseek-v4.1-flash-free',
    'opencode/flint-40b-free',
    'opencode/mimo-v2.6-flash-free',
    'opencode/nemotron-3.5-lightning-free',
  ],
  paid: [
    'minimax-coding-plan/MiniMax-M3.1-Flash',
  ],
};

/** How long a failed candidate stays marked exhausted. */
const COOLDOWN_MS = 10 * 60 * 1000;

/** How long a candidate's health is trusted before it is probed again. */
const HEALTH_TTL_MS = 5 * 60 * 1000;

const state = {
  candidates: [],
  active: null,
  lastProbe: 0,
  lastError: null,
  consecutiveFailures: 0,
};

function now() { return Date.now(); }

function allCandidates() {
  return [...MODEL_POLICY.free, ...MODEL_POLICY.paid];
}

function ensureState() {
  if (state.candidates.length) return;
  state.candidates = allCandidates().map((key) => {
    const [providerID, modelID] = key.split('/');
    return {
      key, providerID, modelID,
      healthy: null,          // null = unknown
      lastChecked: 0,
      exhaustedUntil: 0,
      lastError: null,
      served: 0,
      failures: 0,
    };
  });
}

function candidate(key) {
  ensureState();
  return state.candidates.find((c) => c.key === key);
}

function runApi(args, timeoutMs = 90000) {
  return new Promise((resolve) => {
    execFile(OPENCODE_BIN, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message || '').slice(0, 240) });
      try { resolve({ ok: true, json: JSON.parse(stdout) }); }
      catch (e) { resolve({ ok: false, error: 'unparseable: ' + String(stdout).slice(0, 140) }); }
    });
  });
}

/** Does a failure look like a provider refusing to serve? */
function isQuotaError(message) {
  return /usage limit|quota|credits?|subscribe|insufficient|free usage/i.test(String(message || ''));
}

/** Probe one candidate end to end: create a session, ask, read the answer.
 *
 * The reply window used to be 20 seconds (8 polls of 2.5s). That is shorter
 * than a busy model takes to answer, so working models were declared dead
 * with "no response in time" and the office fell back to a paid provider it
 * did not need. The window is now a minute, and the whole ladder is probed
 * inside a total budget so one slow candidate cannot hold the tick.
 */
const PROBE_REPLY_WINDOW_MS = 60000;
const PROBE_POLL_MS = 2500;
const PROBE_TOTAL_BUDGET_MS = 120000;

async function probeCandidate(c, { deadline = 0 } = {}) {
  const created = await runApi(['api', 'session.create', '--data', JSON.stringify({
    title: 'router-probe', model: { providerID: c.providerID, id: c.modelID },
  })], 30000);
  if (!created.ok || !created.json || !created.json.data) {
    c.healthy = false;
    c.lastChecked = now();
    c.lastError = created.error || 'session create failed';
    c.failures++;
    return c;
  }
  const sessionID = created.json.data.id;
  await runApi(['api', 'session.prompt', '--param', `sessionID=${sessionID}`, '--data',
    JSON.stringify({ text: 'reply with exactly: ROUTER_OK' })], 60000);

  const polls = Math.max(1, Math.floor(PROBE_REPLY_WINDOW_MS / PROBE_POLL_MS));
  for (let i = 0; i < polls; i++) {
    if (deadline && Date.now() > deadline) {
      c.healthy = false;
      c.lastChecked = now();
      c.lastError = 'probe budget exhausted';
      c.failures++;
      return c;
    }
    await new Promise((r) => setTimeout(r, PROBE_POLL_MS));
    const msgs = await runApi(['api', 'session.message.list', '--param', `sessionID=${sessionID}`, '--param', 'limit=6'], 20000);
    const list = (msgs.json && (msgs.json.data || msgs.json.messages)) || [];
    const assistant = list.filter((m) => m.type === 'assistant').pop();
    if (!assistant) continue;
    if (assistant.error) {
      const msg = assistant.error.message || '';
      c.healthy = false;
      c.lastChecked = now();
      c.lastError = msg.slice(0, 200);
      c.failures++;
      if (isQuotaError(msg)) c.exhaustedUntil = now() + COOLDOWN_MS;
      return c;
    }
    const text = (assistant.content || []).filter((x) => x.type === 'text').map((x) => x.text).join(' ');
    if (text.includes('ROUTER_OK')) {
      c.healthy = true;
      c.lastChecked = now();
      c.lastError = null;
      c.served++;
      return c;
    }
  }
  c.healthy = false;
  c.lastChecked = now();
  c.lastError = 'no response in time';
  c.failures++;
  return c;
}

/**
 * Find a model that can serve right now.
 * Returns { model, key, providerID, modelID, degraded } or null when every
 * candidate is exhausted.
 */
async function selectModel({ probe = true, probeFn = null } = {}) {
  ensureState();
  const nowTs = now();

  // Candidates not in cooldown, free ones first.
  const ordered = state.candidates
    .filter((c) => c.exhaustedUntil <= nowTs)
    .sort((a, b) => {
      const freeA = MODEL_POLICY.free.includes(a.key) ? 0 : 1;
      const freeB = MODEL_POLICY.free.includes(b.key) ? 0 : 1;
      if (freeA !== freeB) return freeA - freeB;
      return a.failures - b.failures;
    });

  // One budget for the whole ladder. A tick must reach the paid fallback in
  // time to do anything, so probing cannot run away.
  const deadline = nowTs + PROBE_TOTAL_BUDGET_MS;

  for (const c of ordered) {
    if (c.healthy === false && nowTs - c.lastChecked < COOLDOWN_MS) continue;
    if (!probe && c.healthy === true) {
      state.active = c.key;
      return { ...c, degraded: !MODEL_POLICY.free.includes(c.key) };
    }
    // Health is trusted for a short window. Re-probing the whole ladder on
    // every tick is what turned one unlucky probe into a blind office.
    if (c.healthy === true && nowTs - c.lastChecked < HEALTH_TTL_MS) {
      state.active = c.key;
      return { ...c, degraded: !MODEL_POLICY.free.includes(c.key), trusted: true };
    }
    const r = await (probeFn || probeCandidate)(c, { deadline });
    if (r.healthy) {
      state.active = r.key;
      return { ...r, degraded: !MODEL_POLICY.free.includes(r.key) };
    }
    if (Date.now() > deadline) break;
  }

  // Last resort: the ladder could not be verified inside the budget. Rather
  // than blinding the office, try a candidate that has served before. If the
  // provider really is down the tick fails and is queued, so nothing is lost.
  const recent = state.candidates
    .filter((c) => c.served > 0 && nowTs - c.lastChecked < 60 * 60 * 1000)
    .sort((a, b) => {
      const freeA = MODEL_POLICY.free.includes(a.key) ? 0 : 1;
      const freeB = MODEL_POLICY.free.includes(b.key) ? 0 : 1;
      if (freeA !== freeB) return freeA - freeB;
      return a.failures - b.failures;
    })[0];
  if (recent) {
    state.active = recent.key;
    return { ...recent, degraded: !MODEL_POLICY.free.includes(recent.key), unverified: true };
  }

  state.active = null;
  return null;
}

/** The model the office should use right now, without probing. */
function currentModel() {
  ensureState();
  const c = state.active ? candidate(state.active) : null;
  if (c && c.healthy) return { ...c, degraded: !MODEL_POLICY.free.includes(c.key) };
  return null;
}

/** Snapshot for the office UI / API. */
function status() {
  ensureState();
  const nowTs = now();
  return {
    policy: { free: MODEL_POLICY.free, paid: MODEL_POLICY.paid },
    active: state.active,
    candidates: state.candidates.map((c) => ({
      key: c.key,
      providerID: c.providerID,
      modelID: c.modelID,
      free: MODEL_POLICY.free.includes(c.key),
      healthy: c.healthy,
      exhausted: c.exhaustedUntil > nowTs,
      exhaustedForMs: Math.max(0, c.exhaustedUntil - nowTs),
      lastChecked: c.lastChecked,
      lastError: c.lastError,
      served: c.served,
      failures: c.failures,
    })),
    lastError: state.lastError,
  };
}

/** Record that a model served (or failed) during real use. */
function recordOutcome(key, ok, error) {
  const c = candidate(key);
  if (!c) return;
  c.lastChecked = now();
  if (ok) {
    c.healthy = true;
    c.failures = 0;
    c.served++;
  } else {
    c.healthy = false;
    c.failures++;
    c.lastError = String(error || '').slice(0, 200);
    if (isQuotaError(error)) c.exhaustedUntil = now() + COOLDOWN_MS;
  }
}

/**
 * Create a session pinned to a model. The model must be passed at creation —
 * per-prompt model overrides are ignored by the server.
 */
async function createSession({ title, modelKey, cwd = '/home/opencode' }) {
  const c = candidate(modelKey);
  const model = c ? { providerID: c.providerID, id: c.modelID } : { providerID: 'opencode', id: 'big-pickle' };
  const r = await runApi(['api', 'session.create', '--data', JSON.stringify({ title, model })]);
  if (!r.ok || !r.json || !r.json.data) {
    return { ok: false, error: r.error || 'session create failed' };
  }
  return { ok: true, sessionID: r.json.data.id, model: r.json.data.model };
}

/** Force a candidate into an exhausted state — used to verify the queue path. */
function simulateExhausted(key, ms = COOLDOWN_MS) {
  const c = candidate(key);
  if (!c) return false;
  c.healthy = false;
  c.exhaustedUntil = now() + ms;
  c.lastChecked = now();
  c.lastError = 'simulated exhaustion (test)';
  state.active = null;
  return true;
}

/**
 * Record a candidate's state without talking to a provider.
 * Used to verify the selection rules — the trust window, the cooldown, the
 * fallback — without waiting on a live model.
 */
function simulateOutcome(key, patch = {}) {
  const c = candidate(key);
  if (!c) return false;
  Object.assign(c, patch);
  return true;
}

/** Forget what the router has learned. Used between test cases. */
function resetState() {
  state.candidates = [];
  state.active = null;
  state.lastError = null;
  ensureState();
}

/** Clear a simulated exhaustion so the recovery path can be verified. */
function clearExhaustion(key) {  const c = candidate(key);
  if (!c) return false;
  c.exhaustedUntil = 0;
  c.healthy = null;       // unknown again — the next probe decides
  c.lastError = null;
  return true;
}

module.exports = {
  MODEL_POLICY,
  COOLDOWN_MS,
  HEALTH_TTL_MS,
  PROBE_TOTAL_BUDGET_MS,
  selectModel,
  currentModel,
  status,
  recordOutcome,
  createSession,
  probeCandidate,
  isQuotaError,
  simulateExhausted,
  clearExhaustion,
  simulateOutcome,
  resetState,
};
