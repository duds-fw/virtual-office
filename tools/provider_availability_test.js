#!/usr/bin/env node
'use strict';
/**
 * tools/provider_availability_test.js — regression proof for the owner's
 * channel.
 *
 * The owner reported that the office kept telling them it had stopped
 * working. These cases pin the rule that ends that: one message per episode.
 */

const assert = require('assert');
const { createAvailability } = require('../provider-availability');

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (e) {
    checks.push({ name, ok: false, error: e.message });
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
  } catch (e) {
    checks.push({ name, ok: false, error: e.message });
  }
}

(async () => {
  // --- one message per episode -------------------------------------------
  await checkAsync('repeated blindness reports send one message', async () => {
    const sent = [];
    const a = createAvailability({ send: (t) => { sent.push(t); return true; } });
    await a.report('blind', { reason: 'no provider', queued: 3 });
    await a.report('blind', { reason: 'no provider', queued: 3 });
    await a.report('blind', { reason: 'no provider', queued: 3 });
    assert.strictEqual(sent.length, 1, `expected 1 message, got ${sent.length}`);
    assert.ok(/stopped working/.test(sent[0]));
    assert.ok(/Queued work: 3/.test(sent[0]));
  });

  await checkAsync('recovery is reported once', async () => {
    const sent = [];
    const a = createAvailability({ send: (t) => { sent.push(t); return true; } });
    await a.report('blind', { reason: 'no provider' });
    await a.report('working', { reason: 'serving again' });
    await a.report('working', { reason: 'serving again' });
    assert.strictEqual(sent.length, 2);
    assert.ok(/working again/.test(sent[1]));
  });

  await checkAsync('a flap inside the quiet window is silent', async () => {
    const sent = [];
    let clock = 1000;
    const a = createAvailability({ send: (t) => { sent.push(t); return true; }, now: () => clock });
    await a.report('blind', { reason: 'a' });        // sent
    clock += 60 * 60 * 1000 + 1000;                  // quiet window passed
    await a.report('working', { reason: 'b' });      // sent
    clock += 60 * 1000;                              // inside the quiet window
    await a.report('blind', { reason: 'c' });        // flapping — dropped
    assert.strictEqual(sent.length, 2, `expected 2 messages, got ${sent.length}`);
    assert.strictEqual(a.current(), 'blind');
  });

  await checkAsync('a dropped blindness has no orphan recovery', async () => {
    const sent = [];
    let clock = 1000;
    const a = createAvailability({ send: (t) => { sent.push(t); return true; }, now: () => clock });
    await a.report('blind', { reason: 'a' });        // sent
    clock += 1000;
    await a.report('working', { reason: 'b' });      // sent: the owner was told
    clock += 60 * 1000;                              // flap inside the quiet window
    await a.report('blind', { reason: 'c' });        // dropped
    clock += 1000;
    await a.report('working', { reason: 'd' });      // no orphan recovery
    assert.strictEqual(sent.length, 2, `expected 2 messages, got ${sent.length}`);
    assert.strictEqual(a.current(), 'working');
  });

  await checkAsync('a recovery without an announced blindness says nothing', async () => {
    const sent = [];
    const a = createAvailability({ send: (t) => { sent.push(t); return true; } });
    const r = await a.report('working', { reason: 'never blind' });
    assert.strictEqual(r.sent, false);
    assert.ok(['same_state', 'never_announced'].includes(r.reason), `unexpected reason ${r.reason}`);
    assert.strictEqual(sent.length, 0);
  });

  await checkAsync('an unconfigured channel sends nothing', async () => {
    const sent = [];
    const a = createAvailability({ send: (t) => { sent.push(t); return false; } });
    const r = await a.report('blind', { reason: 'no provider' });
    assert.strictEqual(r.sent, false);
    assert.strictEqual(r.reason, 'not_configured');
    assert.strictEqual(sent.length, 1);   // the channel was called, it declined
  });

  await checkAsync('an unknown state is refused', async () => {
    const a = createAvailability({ send: () => true });
    let threw = false;
    try { await a.report('sideways', {}); } catch (e) { threw = true; }
    assert.ok(threw, 'an unknown state must be refused');
  });

  // --- the queue rule that stops the backlog ------------------------------
  await checkAsync('the queue keeps one waiting item per kind', async () => {
    const path = require('path');
    const fs = require('fs');
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wq-'));
    const file = path.join(dir, 'work-queue.json');
    // The queue writes to the file the environment names, so the test never
    // touches the live queue.
    process.env.WORK_QUEUE_FILE = file;
    delete require.cache[require.resolve('../work-queue')];
    const q = require('../work-queue');
    const a = q.enqueue({ kind: 'autopilot_tick', reason: 'first' });
    const b = q.enqueue({ kind: 'autopilot_tick', reason: 'second' });
    assert.strictEqual(a.id, b.id, 'a second item of the same kind must reuse the waiting one');
    const waiting = q.pending().filter((i) => i.kind === 'autopilot_tick');
    assert.strictEqual(waiting.length, 1, `queue must not grow per failure, has ${waiting.length}`);
    delete process.env.WORK_QUEUE_FILE;
  });

  await checkAsync('a collapsed backlog keeps one item per kind', async () => {
    const path = require('path');
    const fs = require('fs');
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wq2-'));
    const file = path.join(dir, 'work-queue.json');
    fs.writeFileSync(file, JSON.stringify([
      { id: 'q_a', kind: 'autopilot_tick', status: 'waiting', queuedAt: 1 },
      { id: 'q_b', kind: 'autopilot_tick', status: 'waiting', queuedAt: 2 },
      { id: 'q_c', kind: 'autopilot_tick', status: 'waiting', queuedAt: 3 },
    ]));
    process.env.WORK_QUEUE_FILE = file;
    delete require.cache[require.resolve('../work-queue')];
    const q = require('../work-queue');
    const waiting = q.pending();
    assert.strictEqual(waiting.length, 1, `backlog must collapse to one item, has ${waiting.length}`);
    assert.strictEqual(waiting[0].id, 'q_c', 'the newest item is the one kept');
    delete process.env.WORK_QUEUE_FILE;
  });

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok ? '' : ` — ${c.error}`}`);
  console.log(`\n${checks.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})();
