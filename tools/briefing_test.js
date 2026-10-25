'use strict';
/**
 * Verifies the owner briefing answers owner questions, not machine questions.
 * A briefing that mentions queue mechanics or model names is a failure.
 */
const briefing = require('../briefing');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
}

const state = {
  projects: [{ id: 'p1', name: 'Virtual Office', budgetHours: 480 }],
  tasks: [
    { id: 't1', title: 'Ship the thing', status: 'done', estimateHours: 8, completedAt: Date.now() - 3600000 },
    { id: 't2', title: 'Build the thing', status: 'in_progress', estimateHours: 8, ownerId: 'se', role: 'software_engineer' },
    { id: 't3', title: 'Stuck thing', status: 'blocked', estimateHours: 4, blockedReason: 'upstream missing' },
    { id: 't4', title: 'Backlog item', status: 'ready', estimateHours: 8 },
    { id: 't5', title: 'Old done thing', status: 'done', estimateHours: 8, completedAt: Date.now() - 5 * 86400000 },
  ],
  escalations: [],
};

const metrics = {
  currentSprint: { name: 'Sprint 2', doneTasks: 1, totalTasks: 4, openTasks: 3, blockedTasks: 1, daysRemaining: 10 },
  velocity: [{ name: 'Sprint 1', completedPoints: 16, committedPoints: 16 }, { name: 'Sprint 2', completedPoints: 4, committedPoints: 20 }],
  utilization: { percent: 0.42 },
  sla: { compliance: 1 },
  leadTime: { avgHours: 3 },
};

const tokens = {
  spentToday: 1234567, spentTodayLabel: '1.23M tokens', cost: 4.85,
  byRole: [{ name: 'Orchestrator', matrixRole: 'orchestrator_lead', todayAutopilotTokens: 771000 }],
  roleBudget: 2000000,
};

console.log('--- briefing content ---');
const d = briefing.digest(state, metrics, tokens, []);
check('leads with sprint health', /Sprint 2/.test(d) && /1\/4 done/.test(d));
check('states on-track or behind', /behind|on track/.test(d));
check('shows velocity trend across sprints', /16\/16 → 4\/20/.test(d));
check('says when nothing needs a decision', /Nothing needs your decision/.test(d));
check('lists what shipped', /Ship the thing/.test(d));
check('does NOT list old shipments as new', !/Old done thing/.test(d));
check('lists in-progress work with the owner', /Build the thing/.test(d) && /Software Eng/.test(d));
check('lists blocked work with the reason', /Stuck thing/.test(d) && /upstream missing/.test(d));
check('lists ready-but-unstarted work', /Backlog item/.test(d));
check('reports cost and tokens', /\$4\.85/.test(d) && /1\.23M/.test(d));

console.log('\n--- briefing says nothing about machinery ---');
// "queue" is only forbidden as a machine term; a task whose title legitimately
// contains it is fine. Check the briefing's own wording, not user content.
const ownWords = d.replace(/•[^\n]*/g, '').replace(/<b>[^<]*<\/b>/g, '');
for (const forbidden of ['queue', 'drained', 'MiniMax', 'minimax', 'beam-free', 'big-pickle', 'provider', 'token budget today']) {
  check(`does not mention "${forbidden}"`, !new RegExp(forbidden, 'i').test(ownWords));
}

console.log('\n--- pending decisions surface ---');
const d2 = briefing.digest(state, metrics, tokens, [{ id: 'dec_1', question: 'Which approach?' }]);
check('decision count shown', /1 decision\(s\) need you/.test(d2));
check('decision question shown', /Which approach\?/.test(d2));
check('decision id shown for answering', /dec_1/.test(d2));

console.log('\n--- authority items ---');
check('no authority items when healthy', briefing.authorityItems(state, metrics, tokens).length === 0);

const overBudget = {
  ...state,
  projects: [{ id: 'p1', name: 'Virtual Office', budgetHours: 10 }],
};
const items = briefing.authorityItems(overBudget, metrics, tokens);
check('budget overrun raises an authority item', items.some((i) => i.kind === 'budget'), JSON.stringify(items.map((i) => i.kind)));

const hotTokens = { ...tokens, byRole: [{ name: 'Orchestrator', matrixRole: 'orchestrator_lead', todayAutopilotTokens: 2000000 }] };
const tokenItems = briefing.authorityItems(state, metrics, hotTokens);
check('exhausted role raises an authority item', tokenItems.some((i) => i.kind === 'token_budget'));

const l3 = { ...state, escalations: [{ taskId: 't3', taskTitle: 'Stuck thing', reason: 'waiting on client', level: 3, owner: 'Client', blockedSince: Date.now() - 60000000, resolvedAt: null }] };
const escItems = briefing.authorityItems(l3, metrics, tokens);
check('L3 escalation raises an authority item', escItems.some((i) => i.kind === 'escalation'), JSON.stringify(escItems.map((i) => i.kind)));

const sprintRisk = { ...metrics, currentSprint: { ...metrics.currentSprint, daysRemaining: 1, openTasks: 5 } };
const riskItems = briefing.authorityItems(state, sprintRisk, tokens);
check('sprint ending with open work raises an item', riskItems.some((i) => i.kind === 'sprint_risk'));

console.log('\n--- queued work is reported as TASKS, not mechanics ---');
const q = [{ id: 'q1', status: 'waiting', kind: 'autopilot_tick', reason: 'no model provider available', queuedAt: Date.now() - 60000, attempts: 2 }];
const dq = briefing.digest(state, metrics, tokens, [], q);
check('paused work is called out', /Paused/.test(dq));
check('names the tasks that are waiting', /Build the thing/.test(dq) && /Backlog item/.test(dq));
check('explains the cause without machine jargon', /no AI capacity/i.test(dq));
check('says the owner needs to do nothing', /nothing needed from you/i.test(dq));
check('does not mention the queue mechanism', !/queue/i.test(dq.replace(/•[^\n]*/g, '')));

const dq2 = briefing.digest(state, metrics, tokens, [], []);
check('no paused section when nothing is parked', !/Paused/.test(dq2));

console.log('\n--- savings reported ---');
const savings = {
  ok: true, totalSaved: 191, totalSavedLabel: '191', percentOfSpend: 0.02,
  rtk: { commands: 11, tokensSaved: 191, tokensSavedLabel: '191', percent: 36.7, byCommand: [{ command: 'rtk ls docs', saved: 58, percent: 57.4 }] },
  caveman: { records: 1, tokensSaved: 101, tokensSavedLabel: '101', percent: 0.3, byType: [] },
};
const ds = briefing.digest(state, metrics, tokens, [], [], savings, []);
check('shows what optimisation saved', /Token optimisation saved 191/.test(ds));
check('breaks down rtk and caveman', /rtk 191/.test(ds) && /caveman 101/.test(ds));
check('shows rtk efficiency', /36\.7%/.test(ds));

console.log('\n--- lessons reported ---');
const lessons = [
  { id: 'les_1', appliesTo: 'Development', change: 'Delegate file scopes explicitly, never whole directories', observation: 'One dispatch read 50 files', appliedCount: 3 },
];
const dl = briefing.digest(state, metrics, tokens, [], [], savings, lessons);
check('shows what the office learned', /Learned and applied/.test(dl));
check('shows the behaviour change', /Delegate file scopes explicitly/.test(dl));
check('shows the scope it applies to', /Development/.test(dl));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
