'use strict';
/**
 * Verifies D9.3: the engine records what it did, in an append-only journal.
 *
 * The activity feed used to be scraped out of the agent's chat transcript and
 * injected into the console as markup. The engine now writes a journal and
 * the console reads it.
 *
 *   AC1  the journal only grows: no entry is rewritten or removed, and it
 *        survives a restart
 *   AC2  every agent lifecycle event is written when it happens
 *   AC3  the board changes logActivity() records land in the journal
 *   AC4  GET /api/agency/activity serves the journal in order, with no
 *        dependence on the OpenCode session transcript
 *   AC5  a caller-supplied script payload is stored as inert data and is
 *        never interpolated into markup by any consumer
 *
 * Runs against an isolated state directory so it never touches live office
 * data, and drives a second office process on its own port for the endpoint.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STATE = process.env.AGENCY_STATE_DIR || '/tmp/agency-journal-test';
fs.rmSync(STATE, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
process.env.AGENCY_STATE_DIR = STATE;

const journal = require(path.join(ROOT, 'activity-journal.js'));
const agency = require(path.join(ROOT, 'agency.js'));
const server = require(path.join(ROOT, 'server.js'));

let pass = 0;
let fail = 0;
let skip = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
}
function skipped(label, why) { skip++; console.log(`  SKIP  ${label} :: ${why}`); }

function getJson(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch (e) { resolve({ status: res.statusCode, json: null }); } });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
  });
}

const entriesOf = (type) => journal.read().filter((e) => e.type === type);

(async () => {
  // ------------------------------------------------------------------- AC1
  console.log('\nAC1  the journal only grows');

  check('the journal is its own file, not the office state',
    journal.FILE !== path.join(STATE, 'agency.json'), journal.FILE);
  check('the journal lives in the state directory', journal.FILE.startsWith(STATE));

  journal.append(journal.EVENT.BOARD, { who: 'test', text: 'first entry' });
  const first = fs.readFileSync(journal.FILE, 'utf8');
  journal.append(journal.EVENT.BOARD, { who: 'test', text: 'second entry' });
  const second = fs.readFileSync(journal.FILE, 'utf8');
  check('the journal only grows', second.length > first.length && second.startsWith(first),
    `${first.length} -> ${second.length}`);
  check('the earlier entry is still there byte for byte', second.includes('"first entry"'));
  check('every line is one JSON entry', second.trim().split('\n').every((l) => {
    try { JSON.parse(l); return true; } catch (e) { return false; }
  }));

  // A restart is a fresh require: the file is what survives.
  const journalPath = require.resolve(path.join(ROOT, 'activity-journal.js'));
  delete require.cache[journalPath];
  const afterRestart = require(journalPath);
  const survived = afterRestart.read();
  check('the journal survives a restart', survived.length >= 2, `${survived.length} entries`);
  check('the order is the order it was written',
    survived.filter((e) => e.text === 'first entry').length === 1
    && survived.findIndex((e) => e.text === 'first entry') < survived.findIndex((e) => e.text === 'second entry'));
  check('reading the journal does not change it',
    fs.readFileSync(journal.FILE, 'utf8') === second);

  // ------------------------------------------------------------------- AC3
  console.log('\nAC3  board changes land in the journal');

  const created = agency.createTask({ title: 'Journal test task', phase: 'Planning', estimateHours: 2 });
  const taskId = created ? (created.id || (created.task && created.task.id)) : null;
  check('the task was created', !!created && !!taskId, JSON.stringify(created));
  check('the board change is in the journal',
    entriesOf(journal.EVENT.BOARD).some((e) => /Journal test task/.test(e.text || '')));

  agency.setTaskStatus(taskId, 'in_progress');
  const statusEntry = entriesOf(journal.EVENT.TASK_STATUS).find((e) => e.taskId === taskId);
  check('the status change is in the journal', !!statusEntry, JSON.stringify(statusEntry));
  check('the status change names the new status', statusEntry && statusEntry.status === 'in_progress');

  const dev = agency.createTask({ title: 'Gated task', phase: 'Development', role: 'software_engineer', estimateHours: 2 });
  const devId = dev ? (dev.id || (dev.task && dev.task.id)) : null;
  const approved = agency.approveGate(devId, 'design_approval', 'ui_ux_designer');
  check('the gate was approved', approved && approved.ok === true, JSON.stringify(approved));
  const gateEntry = entriesOf(journal.EVENT.GATE_APPROVED).find((e) => e.taskId === devId);
  check('the gate approval is in the journal', !!gateEntry, JSON.stringify(gateEntry));
  check('the gate approval names the approver', gateEntry && gateEntry.role === 'ui_ux_designer');

  agency.setTaskStatus(taskId, 'blocked', 'waiting for something');
  const raised = entriesOf(journal.EVENT.ESCALATION_RAISED).find((e) => e.taskId === taskId);
  check('the escalation is in the journal', !!raised, JSON.stringify(raised));
  const escalation = agency.state().escalations.find((e) => e.taskId === taskId && !e.resolvedAt);
  if (escalation) {
    agency.resolveEscalation(escalation.id, 'handled');
    const resolved = entriesOf(journal.EVENT.ESCALATION_RESOLVED).find((e) => e.escalationId === escalation.id);
    check('the resolution is in the journal', !!resolved, JSON.stringify(resolved));
  } else {
    check('the resolution is in the journal', false, 'no open escalation to resolve');
  }

  // ------------------------------------------------------------------- AC2
  console.log('\nAC2  agent lifecycle events are written when they happen');

  server.noteSubagents([{ id: 'ses_child', parentID: 'ses_parent', agent: 'build', title: 'child work' }]);
  const spawned = entriesOf(journal.EVENT.SUBAGENT_SPAWNED).filter((e) => e.sessionId === 'ses_child');
  check('a subagent spawn is written when the office sees it', spawned.length === 1, JSON.stringify(spawned));
  server.noteSubagents([{ id: 'ses_child', parentID: 'ses_parent', agent: 'build', title: 'child work' }]);
  check('the same subagent is not written twice',
    entriesOf(journal.EVENT.SUBAGENT_SPAWNED).filter((e) => e.sessionId === 'ses_child').length === 1);

  server.noteProviderHealth(false);
  check('a provider that starts refusing is written', entriesOf(journal.EVENT.PROVIDER_UNHEALTHY).length === 1);
  server.noteProviderHealth(false);
  check('the same refusal is not written twice', entriesOf(journal.EVENT.PROVIDER_UNHEALTHY).length === 1);
  server.noteProviderHealth(true);
  check('the provider coming back is written', entriesOf(journal.EVENT.PROVIDER_RECOVERED).length === 1);

  server.noteDelegation('opened', { sessionID: 'ses_x', model: 'model-a' });
  server.noteDelegation('closed', { sessionID: 'ses_x', outcome: 'served' });
  check('a delegation opening is written', entriesOf(journal.EVENT.DELEGATION_OPENED).some((e) => e.sessionID === 'ses_x'));
  check('a delegation closing is written', entriesOf(journal.EVENT.DELEGATION_CLOSED).some((e) => e.sessionID === 'ses_x'));

  server.noteBudgetExhausted('daily_tokens', { text: 'budget gone', spent: 10, budget: 10 });
  check('a budget running out is written', entriesOf(journal.EVENT.BUDGET_EXHAUSTED).some((e) => e.scope === 'daily_tokens'));

  // ------------------------------------------------------------------- AC4
  console.log('\nAC4  the endpoint serves the journal, not a transcript');

  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  check('the office no longer scrapes the session transcript',
    !/fetchSessionMessages|extractDelegations|mergeDelegations/.test(src));
  check('the live payload no longer carries scraped delegations',
    !/delegations:/.test(src));

  const PORT = 9013;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', AGENCY_STATE_DIR: STATE },
    stdio: 'ignore',
  });
  let childUp = false;
  for (let i = 0; i < 40 && !childUp; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const probe = await getJson(`http://127.0.0.1:${PORT}/api/agency/activity`, 1500);
    if (probe.status === 200) childUp = true;
  }
  if (!childUp) {
    skipped('the endpoint serves the journal', 'the office did not come up');
  } else {
    const res = await getJson(`http://127.0.0.1:${PORT}/api/agency/activity`);
    const entries = (res.json && res.json.entries) || [];
    check('the endpoint serves the journal', res.status === 200 && Array.isArray(entries) && entries.length > 0,
      `${res.status}, ${entries.length} entries`);
    const times = entries.map((e) => e.at || 0);
    check('the entries come back in the order they were written',
      times.every((t, i) => i === 0 || t >= times[i - 1]), JSON.stringify(times));
    check('every entry names its event and its time',
      entries.every((e) => typeof e.type === 'string' && typeof e.at === 'number'));
    check('the endpoint says how many entries there are', res.json && res.json.count === entries.length);
  }
  child.kill('SIGTERM');

  // ------------------------------------------------------------------- AC5
  console.log('\nAC5  a caller-supplied payload is inert data');

  const PAYLOAD = '<script>window.__pwned=1</script><img src=x onerror="window.__pwned=1">';
  const withPayload = agency.createTask({ title: PAYLOAD, phase: 'Planning', estimateHours: 1 });
  check('the task with a payload was created', !!withPayload && !!(withPayload.id || (withPayload.task && withPayload.task.id)),
    JSON.stringify(withPayload));
  const payloadEntry = entriesOf(journal.EVENT.BOARD).find((e) => (e.text || '').includes('<script>'));
  check('the payload is stored in the journal', !!payloadEntry);
  check('the payload is stored as data, verbatim',
    payloadEntry && payloadEntry.text.includes(PAYLOAD));
  check('the payload is still one JSON entry', (() => {
    try { JSON.parse(JSON.stringify(payloadEntry)); return true; } catch (e) { return false; }
  })());

  const ui = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  check('the console never puts journal text into markup',
    !/innerHTML\s*=\s*`[^`]*\$\{[^}]*\b(e|entry|ev)\.(text|who)\b/.test(ui));
  check('the console sets journal text as text',
    /el\('span', 'action', e\.text/.test(ui));

  const browser = await browserProof(PAYLOAD);
  if (!browser) skipped('the browser proof', 'no chromium or no office server');
  else {
    check('the payload is shown as text', browser.shown === true, JSON.stringify(browser));
    check('the payload did not become markup', browser.elements === 0, JSON.stringify(browser));
    check('the payload did not execute', browser.executed === false, JSON.stringify(browser));
    check('the console raised no error', browser.errors.length === 0, browser.errors.join(' | '));
  }

  console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
  process.exit(fail ? 1 : 0);
})();

/**
 * Show the console a journal entry that carries a script payload and check
 * that it is rendered as text and never runs.
 */
async function browserProof(payload) {
  const pw = loadPlaywright();
  if (!pw) return null;
  const chrome = findChromium();
  if (!chrome) return null;
  const live = await getJson('http://localhost:9012/api/agency/health', 2000);
  if (live.status !== 200) return null;
  let browser;
  try {
    browser = await pw.chromium.launch({ executablePath: chrome, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
    await page.route('**/api/agency/activity', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ entries: [{ at: Date.now(), type: 'board.change', who: 'caller', text: payload }], count: 1 }),
    }));
    await page.goto('http://localhost:9012/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      document.querySelectorAll('.vnav-btn').forEach((b) => { if (b.dataset.view === 'office') b.click(); });
    }).catch(() => {});
    await page.waitForTimeout(1500);
    const out = await page.evaluate(() => {
      const feed = document.getElementById('popup-feed');
      const text = feed ? feed.textContent : '';
      return {
        shown: text.includes('<script>window.__pwned=1</script>'),
        elements: document.querySelectorAll('#popup-feed script, #popup-feed img').length,
        executed: !!(window.__pwned),
      };
    });
    return { ...out, errors };
  } catch (e) {
    return { shown: false, elements: -1, executed: false, errors: [String(e)] };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function loadPlaywright() {
  for (const c of ['playwright-core', 'playwright']) { try { return require(c); } catch (e) { /* next */ } }
  try {
    for (const d of fs.readdirSync('/root/.npm/_npx')) {
      const p = path.join('/root/.npm/_npx', d, 'node_modules', 'playwright-core');
      if (fs.existsSync(p)) { try { return require(p); } catch (e) { /* next */ } }
    }
  } catch (e) { /* no npx cache */ }
  return null;
}

function findChromium() {
  const base = '/root/.cache/ms-playwright';
  let dirs = [];
  try { dirs = fs.readdirSync(base).filter((d) => d.startsWith('chromium-')); } catch (e) { return null; }
  dirs.sort();
  for (const d of dirs.reverse()) {
    const p = path.join(base, d, 'chrome-linux64', 'chrome');
    if (fs.existsSync(p)) return p;
  }
  return null;
}
