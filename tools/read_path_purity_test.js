'use strict';
/**
 * Verifies the read path is pure (F-17).
 *
 * A read must never write. With wildcard CORS any page could otherwise drive
 * continuous state rewrites, and a read that mutates blurs the audit trail.
 *
 *   1. GET-the-equivalent calls (agency.state, agency.currentStandup) leave the
 *      state file byte-identical
 *   2. a derived escalation level is applied in memory by a read but is not
 *      persisted by that read
 *   3. the explicit write path (agency.standup) records exactly one standup
 *      per day and is idempotent
 *
 * Runs against an isolated state directory so it never touches live office data.
 *   AGENCY_STATE_DIR=/tmp/agency-test node tools/read_path_purity_test.js
 */
const fs = require('fs');
const path = require('path');

const STATE = process.env.AGENCY_STATE_DIR || '/tmp/agency-read-path-test';
fs.rmSync(STATE, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
process.env.AGENCY_STATE_DIR = STATE;
// A 1s escalation window so a level change is observable without waiting a day.
process.env.AGENCY_ESCALATION_MS = '1000';

const agency = require(path.join(__dirname, '..', 'agency.js'));
const FILE = path.join(STATE, 'agency.json');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
}
function snapshot() {
  try { return fs.readFileSync(FILE); } catch (e) { return null; }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  console.log('--- the read path writes nothing ---');
  {
    // Put something on disk first, so a read has a file to leave alone.
    const t = agency.createTask({ title: 'Read path probe', phase: 'Development', role: 'software_engineer', estimateHours: 1 });
    agency.setTaskStatus(t.id, 'blocked', 'probe');
    const before = snapshot();
    check('the office has a state file to read', before !== null);

    const board = agency.state();
    check('a read returns the board', board && Array.isArray(board.tasks) && board.tasks.length > 0);
    check('a read leaves the state file byte-identical', before && snapshot().equals(before),
      `before ${before && before.length} bytes, after ${snapshot() && snapshot().length} bytes`);

    const standup = agency.currentStandup();
    check('a read returns a standup', standup && standup.date && Array.isArray(standup.agents));
    check('reading the standup writes nothing', before && snapshot().equals(before));

    agency.state();
    agency.currentStandup();
    agency.metrics();
    agency.workload();
    check('repeated reads still write nothing', before && snapshot().equals(before));
  }

  console.log('--- derived escalation levels are in-memory only ---');
  {
    const before = snapshot();
    const d = JSON.parse(before.toString());
    const esc = (d.escalations || [])[0];
    check('the probe left an escalation to derive from', !!esc, JSON.stringify(d.escalations || []).slice(0, 120));
    if (esc) {
      // Age the escalation past the 1s window so the derived level differs
      // from the stored one.
      await sleep(1100);
      const board = agency.state();
      const live = board.escalations.find((e) => e.id === esc.id);
      check('a read derives the new level in memory', live && live.level > esc.level,
        `stored ${esc.level}, derived ${live && live.level}`);
      check('a read does not persist the derived level', snapshot().equals(before));
    }
  }

  console.log('--- the write path records a standup ---');
  {
    const before = snapshot();
    const saved = agency.standup();
    check('the write path returns the standup', saved && saved.date);
    const after = snapshot();
    check('the write path wrote to disk', !after.equals(before));
    const d = JSON.parse(after.toString());
    const today = (d.standups || []).filter((s) => s.date === saved.date);
    check('exactly one standup is recorded for today', today.length === 1, `found ${today.length}`);
    agency.standup();
    const d2 = JSON.parse(snapshot().toString());
    const today2 = (d2.standups || []).filter((s) => s.date === saved.date);
    check('recording again does not duplicate the day', today2.length === 1, `found ${today2.length}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
