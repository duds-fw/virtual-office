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
const QUEUE_FILE = path.join(STATE_DIR, 'work-queue.json');
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
  return queue;
}

function save() {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
  } catch (e) {
    console.error('[queue] save failed:', e.message);
  }
}

/**
 * Park a unit of work.
 * `kind` describes what to do when a model frees up, e.g. { kind:'autopilot_tick' }.
 */
function enqueue({ kind, payload, reason, sessionID }) {
  load();
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
async function drain(handler, { max = 1 } = {}) {
  load();
  const waiting = queue.filter((i) => i.status === 'waiting');
  if (!waiting.length) return { drained: 0, remaining: 0 };

  let drained = 0;
  for (const item of waiting.slice(0, max)) {
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
        item.status = 'waiting';
        item.reason = 'handler reported not-ready';
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

module.exports = { enqueue, pending, all, drain, clear };
