'use strict';
/**
 * Verifies the autonomy step budget — the office's own throttle.
 *
 * The loop went dead because the daily cap counted every consumer of the step
 * budget: the queue drain spent the ticker's allowance, so the ticker was
 * refused from then on and the reason was computed and thrown away. Three
 * things must hold:
 *   1. the daily cap governs the ticker only — the queue drain cannot spend it
 *   2. the counter never passes the cap, even when ticks race for the last step
 *   3. every refusal says which limit refused it, and the reasons stay apart
 *
 * The office server is loaded as a module (no timers, no listener) against an
 * isolated state directory, so it never touches live office data.
 *   AGENCY_STATE_DIR=/tmp/autonomy-test node tools/autonomy_budget_test.js
 */
const fs = require('fs');
const path = require('path');

const STATE = process.env.AGENCY_STATE_DIR || '/tmp/autonomy-test';
fs.rmSync(STATE, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
process.env.AGENCY_STATE_DIR = STATE;

const office = require(path.join(__dirname, '..', 'server.js'));

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
}

const CFG = { enabled: true, stopped: false, maxStepsPerDay: 20, maxTicksPerHour: 4 };

/** A usage record as the office keeps it. */
function freshUsage() {
  return {
    date: '2026-10-25',
    stepsToday: 0,
    queuedStepsToday: 0,
    tickTimestamps: [],
    queuedTickTimestamps: [],
    lastTickAt: 0,
    refusals: {},
    refusalLog: [],
    lastRefusal: null,
  };
}

(async () => {
  console.log('--- the daily cap governs the ticker only ---');
  {
    const usage = freshUsage();
    for (let i = 0; i < 50; i++) office.claimAutonomyStep(usage, 'queue', CFG);
    check('the queue drain takes its own steps', usage.queuedStepsToday === 50, `queued=${usage.queuedStepsToday}`);
    check('the queue drain does not touch the ticker\'s counter', usage.stepsToday === 0, `steps=${usage.stepsToday}`);

    const claim = office.claimAutonomyStep(usage, 'ticker', CFG);
    check('the ticker is still allowed after the queue drain spent 50 steps', claim.allowed === true, JSON.stringify(claim));
    check('the ticker spends from its own counter', usage.stepsToday === 1 && usage.queuedStepsToday === 50,
      `steps=${usage.stepsToday} queued=${usage.queuedStepsToday}`);

    for (let i = 0; i < 30; i++) office.claimAutonomyStep(usage, 'ticker', CFG);
    check('the ticker stops at its own cap', usage.stepsToday === CFG.maxStepsPerDay, `steps=${usage.stepsToday}`);
    check('the queue drain is not blocked by the ticker\'s cap',
      office.claimAutonomyStep(usage, 'queue', CFG).allowed === true);
    check('the queue drain is not blocked by the ticker\'s hourly window', (() => {
      usage.tickTimestamps = [Date.now(), Date.now(), Date.now(), Date.now()];
      return office.autonomyBudget(usage, 'queue', CFG).allowed === true;
    })());
  }

  console.log('--- the cap holds when ticks race ---');
  {
    const usage = freshUsage();
    // 30 ticks start at once. Each claims its step before it waits, so the
    // claim is the race: no two ticks can take the last step.
    const tick = async (i) => {
      const claim = office.claimAutonomyStep(usage, 'ticker', CFG);
      if (!claim.allowed) return { ok: false, reason: claim.reason };
      await new Promise((r) => setTimeout(r, i % 3));
      return { ok: true };
    };
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => tick(i)));
    const served = results.filter((r) => r.ok).length;
    check('exactly the cap is served', served === CFG.maxStepsPerDay, `served=${served}`);
    check('the counter never passes the cap', usage.stepsToday <= CFG.maxStepsPerDay, `steps=${usage.stepsToday}`);
    check('the counter is exactly the cap', usage.stepsToday === CFG.maxStepsPerDay, `steps=${usage.stepsToday}`);
    check('the refused ticks say why', results.filter((r) => !r.ok).every((r) => r.reason === 'daily_steps_cap'),
      JSON.stringify(results.filter((r) => !r.ok).map((r) => r.reason)));
  }

  console.log('--- a claim that never fires is given back ---');
  {
    const usage = freshUsage();
    office.claimAutonomyStep(usage, 'ticker', CFG);
    check('the claim is counted', usage.stepsToday === 1, `steps=${usage.stepsToday}`);
    office.releaseAutonomyStep(usage, 'ticker');
    check('a released claim is not charged', usage.stepsToday === 0, `steps=${usage.stepsToday}`);
    check('the ticker can take the step again', office.claimAutonomyStep(usage, 'ticker', CFG).allowed === true);
  }

  console.log('--- every refusal says which limit refused it ---');
  {
    const usage = freshUsage();
    const stopped = office.autonomyBudget(usage, 'ticker', Object.assign({}, CFG, { stopped: true }));
    check('a stopped office is refused with kill_switch',
      stopped.allowed === false && stopped.reason === 'kill_switch', JSON.stringify(stopped));
    const disabled = office.autonomyBudget(usage, 'ticker', Object.assign({}, CFG, { enabled: false }));
    check('a disabled office is refused with disabled',
      disabled.allowed === false && disabled.reason === 'disabled', JSON.stringify(disabled));
    usage.stepsToday = CFG.maxStepsPerDay;
    const daily = office.autonomyBudget(usage, 'ticker', CFG);
    check('the daily cap is refused with daily_steps_cap',
      daily.allowed === false && daily.reason === 'daily_steps_cap', JSON.stringify(daily));
    usage.stepsToday = 0;
    usage.tickTimestamps = [Date.now(), Date.now(), Date.now(), Date.now()];
    const hourly = office.autonomyBudget(usage, 'ticker', CFG);
    check('the hourly cap is refused with hourly_tick_cap',
      hourly.allowed === false && hourly.reason === 'hourly_tick_cap', JSON.stringify(hourly));
  }

  console.log('--- the refusal record tells them apart ---');
  {
    const usage = freshUsage();
    const reasons = ['daily_steps_cap', 'hourly_tick_cap', 'kill_switch', 'disabled'];
    for (const reason of reasons) office.recordAutonomyRefusal(usage, reason, 'ticker');
    check('each reason is counted on its own', reasons.every((r) => usage.refusals[r] === 1), JSON.stringify(usage.refusals));
    check('the log keeps the reasons apart', new Set(usage.refusalLog.map((r) => r.reason)).size === reasons.length,
      JSON.stringify(usage.refusalLog.map((r) => r.reason)));
    check('the last refusal is the last one recorded', usage.lastRefusal.reason === 'disabled', JSON.stringify(usage.lastRefusal));
    check('the log records who was refused', usage.refusalLog.every((r) => r.consumer === 'ticker'));
    check('the log records when', usage.refusalLog.every((r) => Number.isFinite(r.at)));

    for (let i = 0; i < 100; i++) office.recordAutonomyRefusal(usage, 'daily_steps_cap', 'queue');
    check('the log does not grow without bound', usage.refusalLog.length <= 50, `len=${usage.refusalLog.length}`);
    check('the count keeps every refusal', usage.refusals.daily_steps_cap === 101, `count=${usage.refusals.daily_steps_cap || usage.refusals.daily_steps_cap}`);
    check('the queue consumer is logged as the queue', usage.refusalLog[usage.refusalLog.length - 1].consumer === 'queue');
  }

  console.log('--- a record from before the split is not charged to the ticker ---');
  {
    const legacy = { date: '2026-10-25', stepsToday: 22, tickTimestamps: [1, 2, 3], lastTickAt: 3 };
    const migrated = office.migrateAutonomyUsage(legacy);
    check('the legacy total is kept for the record', migrated.legacyStepsToday === 22, `legacy=${migrated.legacyStepsToday}`);
    check('the legacy total is not charged to the ticker', migrated.stepsToday === 0, `steps=${migrated.stepsToday}`);
    check('the queue counter starts empty', migrated.queuedStepsToday === 0, `queued=${migrated.queuedStepsToday}`);
    check('a migrated record is not migrated twice', office.migrateAutonomyUsage(migrated).legacyStepsToday === 22);
    check('a record that already has both counters is left alone', (() => {
      const split = { date: '2026-10-25', stepsToday: 3, queuedStepsToday: 4 };
      const kept = office.migrateAutonomyUsage(split);
      return kept.stepsToday === 3 && kept.queuedStepsToday === 4 && !Number.isFinite(kept.legacyStepsToday);
    })());
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
