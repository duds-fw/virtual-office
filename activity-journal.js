'use strict';
/**
 * activity-journal.js — the office's append-only activity journal.
 *
 * The engine records what it did at the moment it did it (D9.3). Nothing is
 * reconstructed later from a chat transcript, and nothing is ever rewritten:
 * the file grows by exactly one line per event, and it survives a restart.
 *
 * The journal is deliberately separate from state/agency.json, which the
 * server owns and rewrites in memory. The journal is the office's record;
 * agency.json is the office's working state.
 */
const fs = require('fs');
const path = require('path');

const STATE_DIR = process.env.AGENCY_STATE_DIR || path.join(__dirname, 'state');
const FILE = path.join(STATE_DIR, 'activity.jsonl');

/** The events the office writes. */
const EVENT = {
  BOARD: 'board.change',
  TASK_STATUS: 'task.status',
  GATE_APPROVED: 'gate.approved',
  ESCALATION_RAISED: 'escalation.raised',
  ESCALATION_RESOLVED: 'escalation.resolved',
  DELEGATION_OPENED: 'delegation.opened',
  DELEGATION_CLOSED: 'delegation.closed',
  SUBAGENT_SPAWNED: 'subagent.spawned',
  SUBAGENT_REAPED: 'subagent.reaped',
  PROVIDER_UNHEALTHY: 'provider.unhealthy',
  PROVIDER_RECOVERED: 'provider.recovered',
  BUDGET_EXHAUSTED: 'budget.exhausted',
};

/**
 * Append one entry.
 *
 * The entry is a line of JSON and nothing else: caller-supplied text is
 * stored as inert data. A consumer that builds markup must set it as text,
 * never as markup.
 */
function append(type, payload = {}) {
  const entry = { at: Date.now(), type, ...payload };
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify(entry) + '\n');
  } catch (e) {
    // The journal must never take the office down with it.
  }
  return entry;
}

/** The whole journal, oldest first. */
function read() {
  let raw = '';
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (e) { /* a torn line is skipped */ }
  }
  return out;
}

/** The newest entries first, for the monitor. */
function tail(n = 50) {
  const all = read();
  return all.slice(Math.max(0, all.length - n)).reverse();
}

module.exports = { FILE, EVENT, append, read, tail };
