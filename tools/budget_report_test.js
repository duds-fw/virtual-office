'use strict';
/**
 * Verifies the budget report item.
 *
 * Decision D7.1: the office is held to its project budget. It never spends
 * past the line. When the work needs more hours than the budget allows, the
 * office reports the shortfall to the owner — overrun, reason, options — and
 * the owner decides whether to raise the budget.
 *
 * Two things must hold:
 *   1. An overrun is reported BEFORE the hours are spent (committed work).
 *   2. A project inside its budget is never reported as an overrun.
 */
const briefing = require('../briefing');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
}

// --- budgetReport() in isolation -------------------------------------------

const over = briefing.budgetReport({
  projects: [{ id: 'p1', name: 'Overrun', budgetHours: 80, status: 'active' }],
  tasks: [
    { id: 't1', projectId: 'p1', status: 'done', estimateHours: 30 },
    { id: 't2', projectId: 'p1', status: 'backlog', estimateHours: 60 },  // committed
  ],
});
check('overrun is detected', over.length === 1, JSON.stringify(over));
check('overrun amount is right (30 spent + 60 committed - 80 = 10)',
  over[0] && over[0].overrun === 10, over[0] && String(over[0].overrun));
check('overrun carries the budget', over[0] && over[0].budget === 80);
check('overrun carries options', over[0] && over[0].options.length > 0);

const under = briefing.budgetReport({
  projects: [{ id: 'p2', name: 'Under', budgetHours: 80, status: 'active' }],
  tasks: [
    { id: 't3', projectId: 'p2', status: 'done', estimateHours: 10 },
    { id: 't4', projectId: 'p2', status: 'backlog', estimateHours: 20 },
  ],
});
check('a project inside budget is NOT reported', under.length === 0, JSON.stringify(under));

// A project with no budget is not reportable — there is no line to exceed.
const noBudget = briefing.budgetReport({
  projects: [{ id: 'p3', name: 'No budget', status: 'active' }],
  tasks: [{ id: 't5', projectId: 'p3', status: 'backlog', estimateHours: 999 }],
});
check('a project with no budget is not reported', noBudget.length === 0);

// Closed projects are history, not news.
const closed = briefing.budgetReport({
  projects: [{ id: 'p4', name: 'Done', budgetHours: 10, status: 'done' }],
  tasks: [{ id: 't6', projectId: 'p4', status: 'done', estimateHours: 100 }],
});
check('a closed project is not reported', closed.length === 0);

// Cancelled tasks do not count as committed work.
const cancelled = briefing.budgetReport({
  projects: [{ id: 'p5', name: 'Cancel', budgetHours: 10, status: 'active' }],
  tasks: [{ id: 't7', projectId: 'p5', status: 'cancelled', estimateHours: 100 }],
});
check('cancelled tasks do not create a false overrun', cancelled.length === 0);

// Another project's tasks must not contaminate this one.
const isolated = briefing.budgetReport({
  projects: [
    { id: 'p6', name: 'Mine', budgetHours: 10, status: 'active' },
    { id: 'p7', name: 'Theirs', budgetHours: 10, status: 'active' },
  ],
  tasks: [
    { id: 't8', projectId: 'p6', status: 'backlog', estimateHours: 5 },
    { id: 't9', projectId: 'p7', status: 'backlog', estimateHours: 500 },
  ],
});
check('projects are isolated — p6 is not reported because of p7',
  isolated.length === 1 && isolated[0].projectId === 'p7', JSON.stringify(isolated.map((i) => i.projectId)));

// --- the digest carries it -------------------------------------------------

const digestText = briefing.digest(
  {
    projects: [{ id: 'p8', name: 'Overrun Co', budgetHours: 80, status: 'active' }],
    tasks: [{ id: 't10', projectId: 'p8', status: 'backlog', estimateHours: 100 }],
  },
  { currentSprint: { name: 'S2', doneTasks: 0, totalTasks: 1, openTasks: 1 }, velocity: [], utilization: {}, sla: {}, leadTime: {} },
  {},
  [],
  null,
  null,
  null
);
check('the digest shows a budget report section', /Budget report/.test(digestText));
check('the digest names the project', /Overrun Co/.test(digestText));
check('the digest shows the overrun hours', /needs 20h more/.test(digestText), digestText.slice(-400));
check('the digest says it is not yet spent', /not yet spent/.test(digestText));

const cleanDigest = briefing.digest(
  {
    projects: [{ id: 'p9', name: 'Fine Co', budgetHours: 80, status: 'active' }],
    tasks: [{ id: 't11', projectId: 'p9', status: 'backlog', estimateHours: 10 }],
  },
  { currentSprint: { name: 'S2', doneTasks: 0, totalTasks: 1, openTasks: 1 }, velocity: [], utilization: {}, sla: {}, leadTime: {} },
  {},
  [],
  null,
  null,
  null
);
check('a clean budget shows no budget report section', !/Budget report/.test(cleanDigest));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
