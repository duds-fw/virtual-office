'use strict';
/**
 * daily-watch.js — one standing daily check: has anything new appeared that
 * would let the office do the same work for fewer tokens?
 *
 * The office already measures what its optimisation layer saves (see
 * token-savings.js). Measurement alone cannot tell you that a better way
 * exists now: the tools improve between releases, and a technique that was
 * noise last month can be the cheapest context cut available this month.
 *
 * So the office books itself one small task a day to look. The task is
 * ordinary board work — the same kind an owner or a manager would create —
 * so it goes through the same create, assign, budget and reporting path as
 * everything else. Nothing here reaches into the ticker, the queue or the
 * step counters: the watch must not be able to disturb the workflow it
 * watches.
 *
 * Three properties matter and are tested:
 *   AC1  once per day, never twice — a restart or a slow clock must not
 *        stack duplicates on the board
 *   AC2  it books work, it does not do work — no provider call, no session,
 *        no token spend of its own
 *   AC3  it cannot change the office — the task asks for findings, and the
 *        brief forbids the agent from touching configuration
 */

const fs = require('fs');
const path = require('path');

const STATE_DIR = process.env.AGENCY_STATE_DIR || path.join(__dirname, 'state');
const MARKER_FILE = path.join(STATE_DIR, 'daily-watch.json');

/** The hour (local, office time) the day's watch is allowed to be booked. */
const WATCH_HOUR = Number(process.env.DAILY_WATCH_HOUR || 8);

/** Who owns it: IT Infrastructure runs the optimisation layer itself. */
const WATCH_ROLE = 'it_infrastructure';
const WATCH_OWNER = 'iti';
const WATCH_PHASE = 'Operations';
const WATCH_HOURS = 1;

/**
 * The brief. It has to say what a finding is, because the cheapest way to
 * waste this task is to let it quietly edit the office's own configuration.
 */
const BRIEF = [
  'Daily check: has anything new appeared that would let the office do the same work for fewer tokens?',
  '',
  'Look for:',
  '- new OpenCode features that cut context (caching, compaction, tool-result truncation, subagent scoping);',
  '- new routing, batching or prompt-caching techniques;',
  '- new compression or summarisation tooling that beats rtk or caveman on our workload;',
  '- provider pricing, quota or rate-limit changes that change the free-first routing policy;',
  '- release notes for the models and tools the office already depends on.',
  '',
  'Deliverable: a doc, one page — the claim, the source, the expected token effect, and the risk.',
  '',
  'Rules:',
  '- a finding is a proposal, not a change;',
  '- do not touch opencode.jsonc, the agent skill allow-lists, the autonomy budget, the router policy or any skill;',
  '- do not create follow-up tasks;',
  '- if nothing worth adopting appeared, say so in one line. That is a valid result.',
].join('\n');

/** The office's own day boundary — the same one its usage counters use. */
function localDate(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function localHour(ts = Date.now()) {
  return new Date(ts).getHours();
}

function readState() {
  try {
    if (!fs.existsSync(MARKER_FILE)) return { lastDate: null };
    const parsed = JSON.parse(fs.readFileSync(MARKER_FILE, 'utf8'));
    return { lastDate: parsed && typeof parsed.lastDate === 'string' ? parsed.lastDate : null };
  } catch (e) {
    console.error('[watch] state read failed:', e.message);
    return { lastDate: null };
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(MARKER_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[watch] state write failed:', e.message);
  }
}

/** The marker carries the date, so the board itself proves the daily work. */
function markerFor(date) {
  return `token-watch:${date}`;
}

/** Is this day's watch already on the board, whatever the state file says? */
function alreadyBooked(agency, date) {
  const marker = markerFor(date);
  const tasks = (agency.state && agency.state().tasks) || [];
  return tasks.some((t) => String(t.title || '').includes(marker));
}

/**
 * Book today's watch if it is not booked yet.
 *
 * Returns { ok, action, reason, taskId } and never throws: a watch that
 * breaks the office is worse than a watch that skips a day.
 */
function ensureDailyTokenWatch({ agency, now = Date.now(), autonomyStopped = false } = {}) {
  if (!agency || typeof agency.createTask !== 'function') {
    return { ok: false, action: 'skipped', reason: 'no_agency' };
  }
  const date = localDate(now);
  const marker = markerFor(date);

  // A stopped office would collect one unworked task per day. Wait for it.
  if (autonomyStopped) return { ok: true, action: 'skipped', reason: 'autonomy_stopped' };

  // Too early in the day — the check runs in office hours, not at midnight.
  if (localHour(now) < WATCH_HOUR) return { ok: true, action: 'skipped', reason: 'too_early' };

  const state = readState();
  if (state.lastDate === date) return { ok: true, action: 'skipped', reason: 'already_ran_today' };
  if (alreadyBooked(agency, date)) {
    writeState({ lastDate: date });
    return { ok: true, action: 'skipped', reason: 'already_on_board' };
  }

  try {
    const task = agency.createTask({
      title: `Token optimisation watch ${marker}`,
      phase: WATCH_PHASE,
      role: WATCH_ROLE,
      estimateHours: WATCH_HOURS,
      ownerId: WATCH_OWNER,
    });
    if (!task || !task.id) return { ok: false, action: 'skipped', reason: 'create_failed' };

    // The brief is what keeps the task a reading exercise.
    if (typeof agency.updateTask === 'function') agency.updateTask(task.id, { description: BRIEF });

    // Assignment goes through the office's own rule: a role at its token
    // budget is left with the task on the board rather than assigned.
    const assigned = typeof agency.assignTask === 'function' ? agency.assignTask(task.id, WATCH_OWNER) : { ok: false };
    writeState({ lastDate: date, taskId: task.id, at: now });
    console.log(`[watch] booked ${task.id} for ${date} (assigned: ${assigned && assigned.ok ? 'yes' : 'no'})`);
    return { ok: true, action: 'created', reason: 'booked', taskId: task.id, assigned: !!(assigned && assigned.ok) };
  } catch (e) {
    console.error('[watch] booking failed:', e.message);
    return { ok: false, action: 'skipped', reason: 'error', error: e.message };
  }
}

/**
 * Run the watch on a timer. The check is cheap and idempotent, so a
 * frequent poll costs nothing and a missed window still gets caught.
 */
function startDailyWatch({ agency, intervalMs = 15 * 60 * 1000, autonomyStopped = () => false } = {}) {
  const tick = () => {
    try {
      ensureDailyTokenWatch({ agency, autonomyStopped: autonomyStopped() });
    } catch (e) {
      console.error('[watch] tick failed:', e.message);
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  console.log(`[watch] token-optimisation watch: every ${Math.round(intervalMs / 60000)}min, from ${WATCH_HOUR}:00`);
  return () => clearInterval(timer);
}

module.exports = {
  ensureDailyTokenWatch,
  startDailyWatch,
  markerFor,
  localDate,
  localHour,
  readState,
  writeState,
  BRIEF,
  WATCH_HOUR,
  WATCH_ROLE,
  WATCH_OWNER,
  WATCH_PHASE,
  WATCH_HOURS,
};
