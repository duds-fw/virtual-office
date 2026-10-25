'use strict';
/**
 * Verifies D9-A: the engine serves the vocabulary, the console holds none.
 *
 * The console may map semantic state to pixels; it may not own a list. So:
 *
 *   AC1  the engine serves one authoritative vocabulary, and it agrees with
 *        the engine's own constants
 *   AC2  the console names no task status, phase, gate id or roster role id
 *   AC3  the office keeps one phase-to-room map, not two
 *   AC4  a status the engine adds later appears in the console with no
 *        change to the console
 *
 * The browser proof in AC4 runs only when the office server and a chromium
 * are both available; without them the check is reported as skipped.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
process.env.AGENCY_STATE_DIR = process.env.AGENCY_STATE_DIR || '/tmp/agency-vocabulary-test';
const agency = require(path.join(ROOT, 'agency.js'));
const pipeline = require(path.join(ROOT, 'project-pipeline.js'));
const UI_PATH = path.join(ROOT, 'public', 'index.html');

const CANARY = 'canary_status';

let pass = 0;
let fail = 0;
let skip = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
}
function skipped(label, why) { skip++; console.log(`  SKIP  ${label} :: ${why}`); }

const ui = fs.readFileSync(UI_PATH, 'utf8');
const vocab = agency.vocabulary();

// ------------------------------------------------------------------- AC1
console.log('\nAC1  the engine serves the vocabulary');

const LIST_KEYS = ['taskStatuses', 'taskStatusTones', 'projectStatuses', 'projectStages',
  'phases', 'phaseRoles', 'gates', 'phaseFlags', 'roles'];
check('the vocabulary carries every list the console needs',
  LIST_KEYS.every((k) => vocab[k] !== undefined && vocab[k] !== null));

check('the task statuses are the engine\'s own list',
  JSON.stringify(vocab.taskStatuses) === JSON.stringify(agency.STATUSES),
  JSON.stringify(vocab.taskStatuses));
check('every task status has a tone',
  vocab.taskStatuses.every((s) => typeof vocab.taskStatusTones[s] === 'string' && vocab.taskStatusTones[s].length),
  JSON.stringify(vocab.taskStatusTones));
check('a tone is one of the console\'s pixel tones',
  Object.values(vocab.taskStatusTones).every((t) => ['muted', 'info', 'warn', 'danger', 'ok', 'accent'].includes(t)),
  JSON.stringify(Object.values(vocab.taskStatusTones)));

check('the project statuses are the pipeline\'s',
  JSON.stringify(vocab.projectStatuses) === JSON.stringify(pipeline.PROJECT_STATUSES));
check('the project stages are the pipeline\'s order',
  JSON.stringify(vocab.projectStages) === JSON.stringify(pipeline.PROJECT_STAGE_ORDER));

check('the phases are the engine\'s', JSON.stringify(vocab.phases) === JSON.stringify(agency.PHASES));
check('every phase has a role row',
  vocab.phases.every((p) => vocab.phaseRoles.some((r) => r.phase === p)),
  JSON.stringify(vocab.phaseRoles.map((r) => r.phase)));
const matrixRoles = new Set(vocab.roles.map((r) => r.matrixRole));
check('every role a phase names is on the roster',
  vocab.phaseRoles.every((r) => r.roles.every((id) => matrixRoles.has(id))));
check('the roster covers every agent in the engine',
  JSON.stringify(vocab.roles.map((r) => r.matrixRole).sort())
    === JSON.stringify(agency.ROSTER.map((r) => r.matrixRole).sort()));

check('the gates are the engine\'s',
  JSON.stringify(vocab.gates.map((g) => g.id).sort())
    === JSON.stringify(Object.keys(agency.GATES).map((p) => agency.GATES[p].id).sort()));
check('a gate names the phase it sits in', vocab.gates.every((g) => vocab.phases.includes(g.phase)));
check('a gate\'s approvers are on the roster',
  vocab.gates.every((g) => g.approverRoles.every((id) => matrixRoles.has(id))));
check('the deployment phase is named by a flag',
  typeof vocab.phaseFlags.deploy === 'string' && vocab.phases.includes(vocab.phaseFlags.deploy),
  JSON.stringify(vocab.phaseFlags));

// The endpoint and the engine must be the same source.
function getJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch (e) { resolve({ status: res.statusCode, json: null }); } });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
  });
}

(async () => {
  const http1 = await getJson('http://localhost:9012/api/agency/vocabulary');
  if (http1.status !== 200) {
    skipped('the endpoint serves the vocabulary', `HTTP ${http1.status}`);
  } else {
    check('the endpoint serves the vocabulary', true);
    check('the endpoint and the engine agree',
      JSON.stringify(http1.json) === JSON.stringify(vocab),
      'the endpoint and agency.vocabulary() differ');
    check('the endpoint serves no more than the engine does',
      Object.keys(http1.json).length === Object.keys(vocab).length);
  }

  // ------------------------------------------------------------------- AC2
  console.log('\nAC2  the console holds no vocabulary');

  const forbidden = new Set([
    ...vocab.phases, ...vocab.taskStatuses,
    ...vocab.gates.map((g) => g.id), ...vocab.roles.map((r) => r.matrixRole),
  ]);
  const literals = new Set();
  for (const m of ui.matchAll(/'([^'\\\n]{1,80})'|"([^"\\\n]{1,80})"|`([^`\\]{1,80})`/g)) {
    literals.add([m[1], m[2], m[3]].find((v) => v !== undefined));
  }
  const literalHits = [...literals].filter((l) => forbidden.has(l)).sort();
  check('no string in the console names a status, phase, gate or role',
    literalHits.length === 0, literalHits.join(', '));

  const style = (ui.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1];
  const classes = new Set([...style.matchAll(/\.([A-Za-z][\w-]*)\s*[,{:]/g)].map((m) => m[1]));
  const classHits = [...classes].filter((c) => forbidden.has(c)).sort();
  check('no style rule is named after a status, phase, gate or role',
    classHits.length === 0, classHits.join(', '));

  check('the console reads the vocabulary from the engine',
    /fetch\(['"]\/api\/agency\/vocabulary['"]/.test(ui));
  check('the console owns no status-to-style map',
    !/PILL_CLASS|STATUS_CLASS|statusClass/.test(ui));

  // ------------------------------------------------------------------- AC3
  console.log('\nAC3  one phase-to-room map');

  const mapDefs = (ui.match(/const\s+PHASE_ROOM\b/g) || []).length;
  check('the phase-to-room map is defined once', mapDefs === 1, `found ${mapDefs}`);
  check('the map is built from the engine\'s phases, not written out',
    /PHASE_ROOM\s*\[/.test(ui) || /PHASE_ROOM\[/.test(ui) || /forEach\([^)]*=>\s*\{[^}]*PHASE_ROOM\[/.test(ui),
    'no dynamic assignment into PHASE_ROOM');
  check('the office room is keyed by the engine\'s phase names',
    /ROOMS\[phase\]|ROOMS\[slot\.key\]/.test(ui) || /PHASE_ROOM\[phase\]/.test(ui));

  // ------------------------------------------------------------------- AC4
  console.log('\nAC4  a status the engine adds appears in the console');

  // The engine adds a status; the console is not touched.
  const src = fs.readFileSync(path.join(ROOT, 'agency.js'), 'utf8');
  const patched = src
    .replace("const STATUSES = ['backlog'", `const STATUSES = ['${CANARY}', 'backlog'`)
    .replace("const STATUS_TONES = {\n", `const STATUS_TONES = {\n  ${CANARY}: 'info',\n`);
  const tmp = path.join(ROOT, `.tmp-agency-canary-${process.pid}.js`);
  fs.writeFileSync(tmp, patched);
  let canaryVocab = null;
  try {
    canaryVocab = require(tmp).vocabulary();
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  check('the engine serves the new status', canaryVocab.taskStatuses.includes(CANARY));
  check('the engine gives the new status a tone',
    canaryVocab.taskStatusTones[CANARY] === 'info',
    JSON.stringify(canaryVocab.taskStatusTones[CANARY]));
  check('the console did not change to know about it',
    !ui.includes(CANARY) && !literals.has(CANARY));

  // The console maps a tone to pixels generically.
  const toneSrc = (ui.match(/const toneFor\s*=\s*\(?[^=]*=>[^\n]*/) || [''])[0];
  check('the console derives a tone generically', /STATUS_TONE\[/.test(toneSrc), toneSrc);
  check('the console renders a pill from the tone, not from a status map',
    /pill pill-\$\{toneFor\(/.test(ui));

  const browser = await browserProof(canaryVocab);
  if (!browser) skipped('the browser proof', 'no chromium or no office server');
  else {
    check('the new status appears in the console', browser.pillText === CANARY, browser.pillText);
    check('the new status wears the tone the engine gave it',
      browser.pillClass === 'pill-info', browser.pillClass);
    check('the console raised no error', browser.errors.length === 0, browser.errors.join(' | '));
  }

  console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
  process.exit(fail ? 1 : 0);
})();

/** Load the console with the canary vocabulary and a canary task. */
async function browserProof(canaryVocab) {
  const pw = loadPlaywright();
  if (!pw) return null;
  const base = await getJson('http://localhost:9012/api/agency/health');
  if (base.status !== 200) return null;
  const chrome = findChromium();
  if (!chrome) return null;
  let browser;
  try {
    browser = await pw.chromium.launch({ executablePath: chrome, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.route('**/api/agency/vocabulary', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(canaryVocab),
    }));
    await page.route('**/api/opencode/live', async (route) => {
      const res = await route.fetch();
      const data = await res.json();
      if (data.agency) {
        const sprint = (data.agency.metrics || {}).currentSprint || null;
        data.agency.tasks = (data.agency.tasks || []).concat([{
          id: 'task_canary', title: 'Canary', status: CANARY,
          phase: canaryVocab.phases[0], sprintId: sprint ? sprint.id : null,
          ownerId: null, estimateHours: 1, points: 1,
        }]);
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    });
    await page.goto('http://localhost:9012/', { waitUntil: 'domcontentloaded' });
    await page.click('.vnav-btn[data-view="office"]').catch(() => {});
    await page.waitForFunction(
      (name) => [...document.querySelectorAll('.pill')].some((p) => p.textContent.trim() === name),
      CANARY, { timeout: 20000 },
    ).catch(() => {});
    const found = await page.evaluate((name) => {
      const p = [...document.querySelectorAll('.pill')].find((x) => x.textContent.trim() === name);
      return p ? { text: p.textContent.trim(), cls: p.className } : { text: '', cls: '' };
    }, CANARY);
    return { pillText: found.text, pillClass: found.cls.replace('pill ', '').trim(), errors };
  } catch (e) {
    return { pillText: '', pillClass: '', errors: [String(e)] };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function loadPlaywright() {
  const candidates = ['playwright-core', 'playwright'];
  for (const c of candidates) { try { return require(c); } catch (e) { /* next */ } }
  const roots = ['/root/.npm/_npx'];
  for (const r of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(r); } catch (e) { continue; }
    for (const d of dirs) {
      const p = path.join(r, d, 'node_modules', 'playwright-core');
      if (fs.existsSync(p)) { try { return require(p); } catch (e) { /* next */ } }
    }
  }
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
