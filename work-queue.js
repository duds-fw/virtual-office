'use strict';
/**
 * work-queue.js — parks work when no model provider can serve it, and
 * resumes it the moment one becomes available.
 *
 * The office must never silently drop work because a provider hit its
 * limit. Items sit in the queue, visible on the board, and drain
 * automatically.
 */

const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, 'state');
const QUEUE_FILE = process.env.WORK_QUEUE_FILE || path.join(STATE_DIR, 'work-queue.json');
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

let queue = [];

function load() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
      if (Array.isArray(parsed)) queue = parsed;
    }
  } catch (e) {
    console.error('[queue] load failed:', e.message);
  }
  collapseDuplicates();
  return queue;
}

/**
 * One waiting item per kind is enough — see enqueue(). A backlog of
 * duplicates is the symptom of an office that parked the same work over and
 * over; collapsing it keeps the queue honest about what is still owed.
 */
function collapseDuplicates() {
  const newest = new Map();
  for (const i of queue) {
    if (i.status !== 'waiting') continue;
    const seen = newest.get(i.kind);
    if (!seen || (i.queuedAt || 0) >= (seen.queuedAt || 0)) newest.set(i.kind, i);
  }
  let changed = false;
  for (const i of queue) {
    if (i.status !== 'waiting') continue;
    const keep = newest.get(i.kind);
    if (keep && keep.id !== i.id) {
      i.status = 'superseded';
      i.doneAt = Date.now();
      changed = true;
    }
  }
  if (changed) save();
}

function save() {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
  } catch (e) {
    console.error('[queue] save failed:', e.message);
  }
}

/**
 * Settle owed work of a kind.
 *
 * A waiting item of kind K is a debt: "a tick was due and could not run".
 * When a tick runs, the debt is paid — so the item is closed rather than left
 * to make the office look busy with work it is already doing.
 */
function settle(kind, note) {
  load();
  let settled = 0;
  for (const item of queue) {
    if (item.status !== 'waiting' || item.kind !== kind) continue;
    item.status = 'done';
    item.doneAt = Date.now();
    item.reason = note || 'settled';
    settled++;
  }
  if (settled) save();
  return settled;
}

/**
 * Park a unit of work.
 * `kind` describes what to do when a model frees up, e.g. { kind:'autopilot_tick' }.
 */
function enqueue({ kind, payload, reason, sessionID }) {
  load();
  // One waiting item of a kind is enough. The office retries the same kind of
  // work until it succeeds, so parking a second copy of the same work only
  // makes the queue grow and the office look busier than it is.
  const existing = queue.find((i) => i.status === 'waiting' && i.kind === kind);
  if (existing) {
    existing.reason = reason || existing.reason;
    existing.queuedAt = Date.now();
    save();
    console.log(`[queue] ${existing.id} already waiting (${existing.kind})`);
    return existing;
  }
  const item = {
    id: 'q_' + Math.random().toString(36).slice(2, 8),
    kind: kind || 'autopilot_tick',
    payload: payload || null,
    reason: reason || 'no model provider available',
    sessionID: sessionID || null,
    queuedAt: Date.now(),
    attempts: 0,
    lastAttemptAt: null,
    status: 'waiting',
  };
  queue.push(item);
  save();
  console.log(`[queue] queued ${item.id} (${item.kind}): ${item.reason}`);
  return item;
}

function pending() {
  return load().filter((i) => i.status === 'waiting');
}

function all() {
  return load();
}

/**
 * Try to drain the queue with the given handler.
 * The handler receives the item and returns true when it succeeded.
 */
async function drain(handler, { max = 1, minIntervalMs = 0 } = {}) {
  load();
  const waiting = queue.filter((i) => i.status === 'waiting');
  if (!waiting.length) return { drained: 0, remaining: 0 };

  let drained = 0;
  for (const item of waiting.slice(0, max)) {
    // A provider that says no must not be asked again every cycle — the
    // retries are what burn the quota it is short of.
    if (minIntervalMs && item.lastAttemptAt && Date.now() - item.lastAttemptAt < minIntervalMs) {
      continue;
    }
    item.attempts++;
    item.lastAttemptAt = Date.now();
    try {
      const ok = await handler(item);
      if (ok) {
        item.status = 'done';
        item.doneAt = Date.now();
        drained++;
        console.log(`[queue] drained ${item.id}`);
      } else {
        // Keep the reason the handler set: "why it is still waiting" is the
        // only useful thing the owner or the board can read here.
        item.status = 'waiting';
        if (!item.reason) item.reason = 'handler reported not-ready';
      }
    } catch (e) {
      item.status = 'waiting';
      item.reason = String(e.message || e).slice(0, 200);
    }
    save();
  }
  return { drained, remaining: pending().length };
}

function clear() {
  queue = [];
  save();
}

module.exports = { enqueue, pending, all, drain, clear, settle };
