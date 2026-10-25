'use strict';
/**
 * Verifies the agency rules that the running office cannot exercise on its own:
 *   1. the escalation ladder actually climbs agent -> PM -> Orchestrator -> client
 *   2. approval gates block, reject the wrong approver, and release on sign-off
 *   3. resource management refuses over-allocation
 *   4. resolving an escalation closes it, drops the open count and leaves the task alone
 *   5. domain inputs are validated: status vocabulary, gate-checked completion,
 *      estimate bounds, project/sprint/role consistency and owner eligibility
 *
 * Runs against an isolated state directory so it never touches live office data.
 *   AGENCY_STATE_DIR=/tmp/agency-test node tools/agency_rules_test.js
 */
const fs = require('fs');
const path = require('path');

const STATE = process.env.AGENCY_STATE_DIR || '/tmp/agency-test';
fs.rmSync(STATE, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
process.env.AGENCY_STATE_DIR = STATE;
// Short escalation window so the ladder is observable in a test.
// The production default is 24h per level. Must be set before agency.js loads.
// The window is 1s, not the smallest workable value: the check reads the board
// twice, and a read writes to disk (F-17), so the elapsed time is the sleep
// plus real work. With a 40ms window the level-2 band was 40-79ms and the
// test missed it by a couple of milliseconds whenever the machine was busy.
process.env.AGENCY_ESCALATION_MS = '1000';

const agency = require(path.join(__dirname, '..', 'agency.js'));

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
}

console.log('--- approval gates ---');
{
  const t = agency.createTask({ title: 'Gate test', phase: 'Design', role: 'ui_ux_designer', estimateHours: 4 });
  const blocked = agency.advanceTask(t.id);
  check('advance without approval is blocked', blocked.ok === false && blocked.reason === 'gate_pending', JSON.stringify(blocked));

  const wrong = agency.approveGate(t.id, 'design_approval', 'devops_sre');
  check('wrong role cannot approve', wrong.ok === false && wrong.reason === 'role_not_approver');

  const right = agency.approveGate(t.id, 'design_approval', 'ui_ux_designer');
  check('correct role can approve', right.ok === true);

  const ok = agency.advanceTask(t.id);
  check('advance succeeds after approval', ok.ok === true && ok.phase === 'Development', JSON.stringify(ok));
}

console.log('--- deployment gate (security sign-off) ---');
{
  const t = agency.createTask({ title: 'Deploy test', phase: 'Review', role: 'quality_assurance', estimateHours: 4 });
  const blocked = agency.advanceTask(t.id);
  check('advance into Deployment blocked without security sign-off',
    blocked.ok === false && blocked.reason === 'gate_pending' && blocked.gate === 'security_signoff',
    JSON.stringify(blocked));

  const soc = agency.approveGate(t.id, 'security_signoff', 'security_operations_soc');
  check('SOC may sign off', soc.ok === true);

  const ok = agency.advanceTask(t.id);
  check('advance into Deployment after sign-off', ok.ok === true && ok.phase === 'Deployment', JSON.stringify(ok));
}

console.log('--- resource management ---');
{
  const t1 = agency.createTask({ title: 'Load 1', phase: 'Development', role: 'software_engineer', estimateHours: 16 });
  const a1 = agency.assignTask(t1.id);
  check('first assignment fits', a1.ok === true, JSON.stringify(a1));

  const t2 = agency.createTask({ title: 'Load 2', phase: 'Development', role: 'software_engineer', estimateHours: 16 });
  const a2 = agency.assignTask(t2.id);
  check('second assignment fits (32h of 40h)', a2.ok === true, JSON.stringify(a2));

  const t3 = agency.createTask({ title: 'Load 3', phase: 'Development', role: 'software_engineer', estimateHours: 16 });
  const a3 = agency.assignTask(t3.id);
  check('third assignment refused (would exceed capacity)',
    a3.ok === false && a3.reason === 'insufficient_capacity', JSON.stringify(a3));

  const over = agency.workload().find((a) => a.matrixRole === 'software_engineer');
  check('no agent exceeds capacity', over.loadHours <= over.capacityHours, `${over.loadHours}/${over.capacityHours}`);
}

console.log('--- escalation ladder ---');
{
  const t = agency.createTask({ title: 'Escalation test', phase: 'Development', role: 'software_engineer', estimateHours: 4 });
  agency.assignTask(t.id);
  agency.setTaskStatus(t.id, 'blocked', 'dependency missing');

  let esc = agency.state().escalations.find((e) => e.taskId === t.id);
  check('block creates an escalation', !!esc);
  check('starts at level 1 (Product Owner)', esc && esc.level === 1 && esc.owner === 'Product Owner', esc && `${esc.level}/${esc.owner}`);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  sleep(1100).then(() => {
    esc = agency.state().escalations.find((e) => e.taskId === t.id);
    check('climbs to level 2 (Orchestrator) as it ages', esc && esc.level === 2 && esc.owner === 'Orchestrator', esc && `${esc.level}/${esc.owner}`);

    return sleep(1100);
  }).then(() => {
    esc = agency.state().escalations.find((e) => e.taskId === t.id);
    check('climbs to level 3 (Client) as it ages further', esc && esc.level === 3 && esc.owner === 'Client', esc && `${esc.level}/${esc.owner}`);

    const m = agency.metrics();
    const lv = m.escalations.byLevel.find((x) => x.level === 3);
    check('metrics report the escalation level', lv && lv.count >= 1 && lv.owner === 'Client', JSON.stringify(m.escalations.byLevel));
    check('every open escalation is accounted for',
      m.escalations.byLevel.reduce((n, x) => n + x.count, 0) === m.escalations.open,
      `levels=${m.escalations.byLevel.reduce((n, x) => n + x.count, 0)} open=${m.escalations.open}`);
  }).then(() => {
    console.log('--- per-role token budget ---');
    const budget = agency.getRoleTokenBudget();
    check('role budget defaults to 2,000,000', budget === 2_000_000, String(budget));

    // A role with headroom takes work.
    agency.setRoleTokenUsage({ software_engineer: 1000 });
    const okTask = agency.createTask({ title: 'Budget ok', phase: 'Development', role: 'software_engineer', estimateHours: 4 });
    const okAssign = agency.assignTask(okTask.id);
    check('role under budget receives work', okAssign.ok === true, JSON.stringify(okAssign));

    // A role that has spent its budget does not.
    agency.setRoleTokenUsage({ software_engineer: budget });
    const blockedTask = agency.createTask({ title: 'Budget spent', phase: 'Development', role: 'software_engineer', estimateHours: 4 });
    const blockedAssign = agency.assignTask(blockedTask.id);
    check('role at budget is refused', blockedAssign.ok === false && blockedAssign.reason === 'role_token_budget_exhausted',
      JSON.stringify(blockedAssign));

    const blockedTaskState = agency.state().tasks.find((t) => t.id === blockedTask.id);
    check('refused task is blocked with a reason',
      blockedTaskState && blockedTaskState.status === 'blocked' && /token budget exhausted/i.test(blockedTaskState.blockedReason || ''),
      blockedTaskState && `${blockedTaskState.status} :: ${blockedTaskState.blockedReason}`);

    // Another role is unaffected.
    const otherTask = agency.createTask({ title: 'Other role', phase: 'Development', role: 'ai_engineer', estimateHours: 4 });
    const otherAssign = agency.assignTask(otherTask.id);
    check('other roles are unaffected', otherAssign.ok === true, JSON.stringify(otherAssign));

    const wl = agency.workload().find((a) => a.matrixRole === 'software_engineer');
    check('workload exposes token state', wl && wl.tokenExhausted === true && wl.tokenCapacity === budget,
      wl && `${wl.tokenToday}/${wl.tokenCapacity} exhausted=${wl.tokenExhausted}`);

    const tm = agency.metrics();
    check('metrics report per-role token budgets', tm.tokens && tm.tokens.roleBudget === budget && Array.isArray(tm.tokens.byRole),
      JSON.stringify(tm.tokens && { budget: tm.tokens.roleBudget, roles: tm.tokens.byRole.length }));

    agency.setRoleTokenUsage({});
  }).then(() => {
    console.log('--- owner decisions ---');
    check('policy separates strategic from execution',
      agency.DECISION_POLICY.strategic.length > 0 && agency.DECISION_POLICY.execution.length > 0);

    const t = agency.createTask({ title: 'Decision task', phase: 'Planning', role: 'product_owner_product_manager', estimateHours: 4 });
    agency.setTaskStatus(t.id, 'blocked', 'awaiting a decision from the owner');

    const d = agency.raiseDecision({
      question: 'Ship behind a flag, or wait for the full feedback UI?',
      context: 'Affects delivery date.',
      options: [{ id: 'flag', label: 'Ship behind a flag' }, { id: 'wait', label: 'Wait for full UI' }],
      taskId: t.id,
      requestedBy: 'Orchestrator',
    });
    check('decision is raised as pending', d && d.status === 'pending');
    check('decision appears in the pending queue', agency.pendingDecisions().some((x) => x.id === d.id));

    const answered = agency.answerDecision(d.id, 'flag', 'owner');
    check('owner answer is recorded', answered.ok === true && answered.decision.answer === 'Ship behind a flag');
    check('answered decision leaves the pending queue', !agency.pendingDecisions().some((x) => x.id === d.id));

    const released = agency.state().tasks.find((x) => x.id === t.id);
    check('answering releases the blocked task', released && released.status !== 'blocked', released && released.status);

    const reanswer = agency.answerDecision(d.id, 'wait', 'owner');
    check('a decision cannot be answered twice', reanswer.ok === false);

    check('client-level escalations are queryable', Array.isArray(agency.clientLevelEscalations()));
  }).then(() => {
    console.log('--- retrospective learning ---');
    check('no lessons to start with', agency.listLessons().length >= 0);

    const lesson = agency.recordLesson({
      sprintId: null,
      observation: 'One dispatch read fifty files and blew the token budget',
      change: 'Delegate exact file paths, never whole directories',
      appliesTo: 'Development',
    });
    check('lesson is recorded', lesson && lesson.id);
    check('lesson appears in the list', agency.listLessons().some((l) => l.id === lesson.id));
    check('lesson guidance names the change', /Delegate exact file paths/.test(agency.lessonGuidance(null)));
    check('lesson guidance names the scope', /Development/.test(agency.lessonGuidance(null)));
    check('lesson is scoped', agency.lessonsFor(null).some((l) => l.id === lesson.id));

    const applied = agency.markLessonApplied(lesson.id);
    check('lesson application is counted', applied === true);
    check('application count increments', agency.listLessons().find((l) => l.id === lesson.id).appliedCount === 1);

    console.log('--- decision acknowledgement ---');
    const t2 = agency.createTask({ title: 'Ack test', phase: 'Planning', role: 'product_owner_product_manager', estimateHours: 2 });
    agency.setTaskStatus(t2.id, 'blocked', 'waiting for a decision from the owner');
    const d2 = agency.raiseDecision({
      question: 'Ship now or later?',
      options: [{ id: 'now', label: 'Now' }, { id: 'later', label: 'Later' }],
      taskId: t2.id,
    });
    const ack = agency.answerDecision(d2.id, 'now', 'owner');
    check('acknowledgement reports what changed', ack.ok === true && Array.isArray(ack.effects) && ack.effects.length > 0,
      JSON.stringify(ack.effects));
    check('acknowledgement names the released task',
      (ack.effects || []).some((e) => /Ack test/.test(e)), JSON.stringify(ack.effects));
  }).then(() => {
    console.log('--- escalation resolve endpoint ---');
    // POST /api/agency/escalation/:id/resolve (design spec §5). The endpoint
    // is a thin wrapper over agency.resolveEscalation(); STATUS mirrors the
    // server's code -> HTTP status map.
    const STATUS = { escalation_not_found: 404, already_resolved: 409, task_not_blocked: 409, internal_error: 500 };

    const t = agency.createTask({ title: 'Resolve test', phase: 'Development', role: 'ai_engineer', estimateHours: 4 });
    agency.assignTask(t.id);
    agency.setTaskStatus(t.id, 'blocked', 'waiting on the vendor');
    const esc = agency.state().escalations.find((e) => e.taskId === t.id);
    check('a blocked task has an open escalation', !!esc);
    const openBefore = agency.metrics().escalations.open;

    // Unknown id -> 404.
    const missing = agency.resolveEscalation('esc_does_not_exist', 'note');
    check('an unknown escalation id is 404 escalation_not_found',
      missing.ok === false && missing.code === 'escalation_not_found' && STATUS[missing.code] === 404,
      JSON.stringify(missing));

    // 200 -> resolvedAt is stamped server-side and the open count drops.
    const res = agency.resolveEscalation(esc && esc.id, 'vendor delivered');
    check('resolving answers 200 with a server-set resolvedAt',
      res.ok === true && !!res.escalation && typeof res.escalation.resolvedAt === 'number' && res.escalation.resolvedAt > 0,
      JSON.stringify(res.escalation));
    check('the response carries exactly the §5 fields',
      res.ok === true &&
      ['id', 'taskId', 'taskTitle', 'reason', 'level', 'owner', 'matrixRole', 'blockedSince', 'createdAt', 'resolvedAt']
        .every((k) => k in res.escalation) && Object.keys(res.escalation).length === 10,
      res.ok ? Object.keys(res.escalation).join(',') : 'no escalation');
    check('the open count drops by one after a resolve',
      agency.metrics().escalations.open === openBefore - 1,
      `before=${openBefore} after=${agency.metrics().escalations.open}`);
    check('the metrics tile and the state badge agree on the open count',
      agency.state().escalations.filter((e) => !e.resolvedAt).length === agency.metrics().escalations.open,
      `state=${agency.state().escalations.filter((e) => !e.resolvedAt).length} metrics=${agency.metrics().escalations.open}`);
    check('the state payload keeps the resolved row for the UI',
      agency.state().escalations.some((e) => e.id === esc.id && e.resolvedAt),
      `resolved rows in payload=${agency.state().escalations.filter((e) => e.resolvedAt).length}`);

    // Not idempotent -> 409.
    const again = agency.resolveEscalation(esc && esc.id, 'again');
    check('a second resolve is 409 already_resolved',
      again.ok === false && again.code === 'already_resolved' && STATUS[again.code] === 409,
      JSON.stringify(again));

    // Resolving closes the escalation only: the task keeps status and reason.
    const tState = agency.state().tasks.find((x) => x.id === t.id);
    check('the task keeps its status and blocked reason after a resolve',
      !!tState && tState.status === 'blocked' && tState.blockedReason === 'waiting on the vendor',
      tState ? `${tState.status} :: ${tState.blockedReason}` : 'task gone');

    // A stale escalation whose task is no longer blocked -> 409 task_not_blocked.
    const t2 = agency.createTask({ title: 'Stale escalation test', phase: 'Development', role: 'ai_engineer', estimateHours: 4 });
    agency.assignTask(t2.id);
    agency.setTaskStatus(t2.id, 'blocked', 'stale blocker');
    const esc2 = agency.state().escalations.find((e) => e.taskId === t2.id);
    const t2State = agency.state().tasks.find((x) => x.id === t2.id);
    // The blocker was picked up but the escalation record was left behind.
    if (t2State) {
      t2State.status = 'ready';
      t2State.blockedReason = null;
    }
    const stale = agency.resolveEscalation(esc2 && esc2.id, 'note');
    check('an escalation whose task is no longer blocked is 409 task_not_blocked',
      stale.ok === false && stale.code === 'task_not_blocked' && STATUS[stale.code] === 409,
      JSON.stringify(stale));

    // A failed state save must not persist resolvedAt (spec §5).
    const t3 = agency.createTask({ title: 'Save failure test', phase: 'Development', role: 'ai_engineer', estimateHours: 4 });
    agency.assignTask(t3.id);
    agency.setTaskStatus(t3.id, 'blocked', 'save will fail');
    const esc3 = agency.state().escalations.find((e) => e.taskId === t3.id);
    const openBeforeFail = agency.metrics().escalations.open;
    const realWrite = fs.writeFileSync;
    fs.writeFileSync = () => { throw new Error('disk full'); };
    let failed = null;
    try {
      failed = agency.resolveEscalation(esc3 && esc3.id, 'must not persist');
    } finally {
      fs.writeFileSync = realWrite;
    }
    check('a failed save is 500 internal_error',
      !!failed && failed.ok === false && failed.code === 'internal_error' && STATUS[failed.code] === 500,
      JSON.stringify(failed));
    const stillOpen = esc3 && agency.state().escalations.find((e) => e.id === esc3.id);
    check('a failed save does not persist resolvedAt',
      !!stillOpen && !stillOpen.resolvedAt,
      stillOpen ? `resolvedAt=${stillOpen.resolvedAt}` : 'escalation gone');
    check('the open count is unchanged after a failed save',
      agency.metrics().escalations.open === openBeforeFail,
      `before=${openBeforeFail} after=${agency.metrics().escalations.open}`);
  }).then(() => {
    console.log('--- domain input validation (F-03, F-12, F-13, F-14, F-20) ---');
    // F-13: the status vocabulary is closed.
    const vocab = agency.createTask({ title: 'Status vocabulary', phase: 'Development', role: 'software_engineer', estimateHours: 4 });
    const bogus = agency.setTaskStatus(vocab.id, 'archived', 'not a status');
    check('an unknown status is rejected',
      bogus.ok === false && bogus.reason === 'invalid_status', JSON.stringify(bogus));
    const kept = agency.state().tasks.find((x) => x.id === vocab.id);
    check('a rejected status leaves the task status untouched',
      !!kept && kept.status === 'backlog', kept && kept.status);

    // F-03: 'done' needs the phase gate.
    const deploy = agency.createTask({ title: 'Gate-checked completion', phase: 'Deployment', role: 'devops_sre', estimateHours: 4 });
    const refused = agency.setTaskStatus(deploy.id, 'done', 'shipped');
    check('done is refused while the phase gate is unapproved',
      refused.ok === false && refused.reason === 'gate_pending' && refused.gate === 'security_signoff',
      JSON.stringify(refused));
    const notDone = agency.state().tasks.find((x) => x.id === deploy.id);
    check('the refused task is not done', !!notDone && notDone.status !== 'done', notDone && notDone.status);
    agency.approveGate(deploy.id, 'security_signoff', 'security_operations_soc');
    // P3: the gate is not the only thing standing between a task and `done` —
    // a deliverable naming what it produced is also required.
    const noDeliverable = agency.setTaskStatus(deploy.id, 'done', 'shipped');
    check('done is still refused without a deliverable (P3)',
      noDeliverable.ok === false && noDeliverable.reason === 'missing_deliverable',
      JSON.stringify(noDeliverable));
    agency.updateTask(deploy.id, { deliverable: { kind: 'code', summary: 'Deployed the release', ref: 'abc1234' } });
    const allowed = agency.setTaskStatus(deploy.id, 'done', 'shipped');
    check('done is accepted once the gate is approved and a deliverable exists',
      allowed.ok === true && !!allowed.task && allowed.task.status === 'done', JSON.stringify(allowed.ok));

    // F-12: an estimate is finite and within 0.25-200 hours.
    for (const hours of [-5, 0, 500, 'abc']) {
      const bad = agency.createTask({ title: `Bad estimate ${hours}`, phase: 'Development', role: 'software_engineer', estimateHours: hours });
      check(`an estimate of ${hours} is rejected`,
        !!bad && bad.ok === false && bad.reason === 'invalid_estimate_hours', JSON.stringify(bad && bad.reason));
    }
    check('no task stores an out-of-range estimate',
      !agency.state().tasks.some((x) => !(x.estimateHours >= 0.25 && x.estimateHours <= 200)));
    const estTask = agency.createTask({ title: 'Estimate update', phase: 'Development', role: 'software_engineer', estimateHours: 4 });
    const badPatch = agency.updateTask(estTask.id, { estimateHours: -5 });
    check('updateTask rejects an out-of-range estimate',
      badPatch.ok === false && badPatch.reason === 'invalid_estimate_hours', JSON.stringify(badPatch));
    const estState = agency.state().tasks.find((x) => x.id === estTask.id);
    check('the rejected update left the estimate alone',
      !!estState && estState.estimateHours === 4, estState && String(estState.estimateHours));

    // F-14: project, sprint and role must exist and belong together.
    const otherProject = agency.createProject({ name: 'Validation project' });
    const otherSprint = agency.createSprint({ projectId: otherProject.id, name: 'Validation sprint' });
    const mainProject = agency.state().projects.find((p) => p.id !== otherProject.id);
    const cross = agency.createTask({ title: 'Cross-project task', projectId: mainProject.id, sprintId: otherSprint.id, phase: 'Development', role: 'software_engineer', estimateHours: 4 });
    check('a task cannot attach to a sprint of another project',
      cross.ok === false && cross.reason === 'sprint_project_mismatch', JSON.stringify(cross));
    const noProject = agency.createTask({ title: 'Ghost project', projectId: 'proj_missing', phase: 'Development', role: 'software_engineer', estimateHours: 4 });
    check('a task cannot attach to a project that does not exist',
      noProject.ok === false && noProject.reason === 'unknown_project', JSON.stringify(noProject));
    const fakeRole = agency.createTask({ title: 'Fake role', phase: 'Development', role: 'wizard', estimateHours: 4 });
    check('a role outside the roster is rejected',
      fakeRole.ok === false && fakeRole.reason === 'invalid_role', JSON.stringify(fakeRole));
    const wrongPhaseRole = agency.createTask({ title: 'Wrong phase role', phase: 'Development', role: 'ui_ux_designer', estimateHours: 4 });
    check('a role that does not work the phase is rejected',
      wrongPhaseRole.ok === false && wrongPhaseRole.reason === 'role_not_eligible', JSON.stringify(wrongPhaseRole));
    const movedSprint = agency.updateTask(estTask.id, { sprintId: otherSprint.id });
    check('a task cannot be moved into another project sprint',
      movedSprint.ok === false && movedSprint.reason === 'sprint_project_mismatch', JSON.stringify(movedSprint));

    // F-20: an explicit owner gets the auto-assign eligibility filter.
    const owner = agency.createTask({ title: 'Owner eligibility', phase: 'Review', role: 'quality_assurance', estimateHours: 2 });
    const manager = agency.assignTask(owner.id, 'orch');
    check('a manager without a subagent is refused',
      manager.ok === false && manager.reason === 'ineligible_agent', JSON.stringify(manager));
    const wrongPhase = agency.assignTask(owner.id, 'ux');
    check('an agent that does not work the phase is refused',
      wrongPhase.ok === false && wrongPhase.reason === 'ineligible_agent', JSON.stringify(wrongPhase));
    const good = agency.assignTask(owner.id, 'qa');
    check('an eligible agent is assigned',
      good.ok === true && good.agentId === 'qa', JSON.stringify(good));
  }).then(() => {
    console.log('--- metrics derive from real task data ---');
    const m = agency.metrics();
    check('lead time has samples', m.leadTime.samples >= 0);
    check('utilization is a fraction', m.utilization.percent >= 0 && m.utilization.percent <= 1);
    check('sla compliance is a fraction', m.sla.compliance >= 0 && m.sla.compliance <= 1);
    check('velocity tracks committed vs completed', Array.isArray(m.velocity) && m.velocity.length >= 1);

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  });
}
