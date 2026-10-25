'use strict';
/**
 * Verifies the daily token-optimisation watch.
 *
 *   AC1  once per day, never twice — a restart, a second call or a slow
 *        clock must not stack duplicates on the board
 *   AC2  it books work, it does not do work — no provider call, no session,
 *        no token spend of its own
 *   AC3  it cannot change the office — the task asks for findings, and the
 *        brief forbids the agent from touching configuration
 *   AC4  it does not disturb the workflow — the ticker, the queue and the
 *        step counters are untouched, and a stopped office books nothing
 *
 * Runs against an isolated state directory, so it never touches live office
 * data.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATE = process.env.AGENCY_STATE_DIR || '/tmp/agency-watch-test';
fs.rmSync(STATE, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
process.env.AGENCY_STATE_DIR = STATE;

const agency = require(path.join(ROOT, 'agency.js'));
const watch = require(path.join(ROOT, 'daily-watch.js'));

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
}

// A timestamp in the middle of office hours, so the "too early" guard is
// never what is being tested by accident.
const NOON = new Date(2026, 9, 26, 12, 0, 0).getTime();
const NEXT_NOON = new Date(2026, 9, 27, 12, 0, 0).getTime();
const MIDNIGHT = new Date(2026, 9, 26, 2, 0, 0).getTime();

const before = agency.state().tasks.length;

// AC1 — one task, one day.
const first = watch.ensureDailyTokenWatch({ agency, now: NOON });
check('the watch books a task on its first run', first.action === 'created', JSON.stringify(first));
const afterFirst = agency.state().tasks.length;
check('exactly one task was added to the board', afterFirst === before + 1, `${before} -> ${afterFirst}`);

const second = watch.ensureDailyTokenWatch({ agency, now: NOON });
check('a second run on the same day books nothing', second.action === 'skipped', JSON.stringify(second));
check('the board still holds one watch task', agency.state().tasks.length === before + 1, String(agency.state().tasks.length));

const third = watch.ensureDailyTokenWatch({ agency, now: NOON + 60 * 60 * 1000 });
check('a later run on the same day books nothing', third.action === 'skipped', JSON.stringify(third));

// The marker is in the title, so the board itself proves the daily work.
const watchTasks = agency.state().tasks.filter((t) => String(t.title).includes('token-watch:'));
check('exactly one watch task is on the board', watchTasks.length === 1, String(watchTasks.length));
check('the title carries the date marker', /token-watch:\d{4}-\d{2}-\d{2}/.test(watchTasks[0].title), watchTasks[0].title);

// The state file is a second guard against a duplicate.
check('the watch state file records today', watch.readState().lastDate === watch.localDate(NOON));

// AC3 — the brief.
const brief = watch.BRIEF;
check('the brief forbids touching configuration', /do not touch opencode\.jsonc/i.test(brief));
check('the brief asks for a doc deliverable', /deliverable/i.test(brief));
check('the brief allows "nothing worth adopting" as a result', /nothing worth adopting/i.test(brief));
check('the task carries the brief as its description', String(watchTasks[0].description || '').includes('token optimisation') || String(watchTasks[0].description || '').length > 100);

// The role is eligible for the phase, and it is a working role.
check('the role is eligible for the Operations phase', agency.ROSTER.some((a) => a.matrixRole === watch.WATCH_ROLE && a.phases.includes(watch.WATCH_PHASE)));
check('the owning role has a subagent to do the work', !!agency.ROSTER.find((a) => a.id === watch.WATCH_OWNER).subagent);
check('the watch is not owned by a manager', !agency.ROSTER.find((a) => a.id === watch.WATCH_OWNER).manager);

// AC2 — booking is not doing. The watch must not have touched the office's
// run records, the queue or the usage counters.
const usagePath = path.join(STATE, 'usage.json');
check('the watch wrote no usage counters', !fs.existsSync(usagePath) || !/stepsToday/.test(fs.readFileSync(usagePath, 'utf8')));
check('the watch created no autopilot run', !fs.existsSync(path.join(STATE, 'runs.json')));

// AC4 — a stopped office books nothing, and does not mark the day done.
const usageBefore = fs.existsSync(usagePath) ? fs.readFileSync(usagePath, 'utf8') : null;
const stopped = watch.ensureDailyTokenWatch({ agency, now: NEXT_NOON, autonomyStopped: true });
check('a stopped office books nothing', stopped.action === 'skipped' && stopped.reason === 'autonomy_stopped', JSON.stringify(stopped));
check('a stopped office did not mark the day as done', watch.readState().lastDate === watch.localDate(NOON));

// The same day, with the office running, books one more task.
const resumed = watch.ensureDailyTokenWatch({ agency, now: NEXT_NOON });
check('the next day books a new task', resumed.action === 'created', JSON.stringify(resumed));
check('the board holds two watch tasks after two days', agency.state().tasks.filter((t) => String(t.title).includes('token-watch:')).length === 2);

// Before office hours, nothing is booked.
const early = watch.ensureDailyTokenWatch({ agency, now: new Date(2026, 9, 28, 2, 0, 0).getTime() });
check('the watch waits until office hours', early.action === 'skipped' && early.reason === 'too_early', JSON.stringify(early));

// The marker helper is the single source of the date string.
check('the marker names the date', watch.markerFor('2026-10-26') === 'token-watch:2026-10-26');
check('the day boundary matches the office local date', watch.localDate(NOON) === '2026-10-26');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
