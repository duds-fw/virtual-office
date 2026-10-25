'use strict';
/**
 * agency_transition_test.js — the regression suite for the project pipeline
 * invariants P1-P9 of docs/design-project-pipeline.md section 4.
 *
 * Every invariant gets at least one check, labelled with its invariant id:
 *
 *   P1  a project in registered/triaged has no active sprint
 *   P2  a project leaves triaged only with a falsifiable acceptance checklist
 *   P3  a task reaches done only with a deliverable naming what it produced
 *   P4  a project reaches done only when every criterion is met, every met
 *       criterion cites a metBy task, and every referenced task is done
 *   P5  a task's projectId matches its sprint's projectId
 *   P6  metrics() is project-scoped
 *   P7  the role that produced the delivery may not accept that delivery
 *   P8  only product_owner_product_manager or client may accept a project
 *   P9  the Orchestrator owns the timeline and may not bypass the stage order
 *
 * The rules under test live in project-pipeline.js; agency.js is the state
 * holder and the surface the office (and the HTTP layer) actually calls, so
 * every check goes through agency.js.
 *
 * Runs against an isolated state directory so it never touches live office
 * data (state/agency.json).
 *   AGENCY_STATE_DIR=/tmp/agency-transition-test node tools/agency_transition_test.js
 */
const fs = require('fs');
const path = require('path');

// The isolated state dir, wired through the same AGENCY_STATE_DIR mechanism
// agency.js reads at load time. The live office state lives in <repo>/state —
// never point the harness at it, whatever the environment says.
const ISOLATED_STATE = '/tmp/agency-transition-test';
const LIVE_STATE = path.resolve(__dirname, '..', 'state');
const requested = process.env.AGENCY_STATE_DIR || ISOLATED_STATE;
const resolved = path.resolve(requested);
const STATE = resolved === LIVE_STATE || resolved.startsWith(LIVE_STATE + path.sep)
  ? ISOLATED_STATE
  : requested;
fs.rmSync(STATE, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
process.env.AGENCY_STATE_DIR = STATE;

const agency = require(path.join(__dirname, '..', 'agency.js'));

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
}

/** A broken precondition is a broken suite, not a failed invariant. */
function must(cond, message) {
  if (!cond) throw new Error(`setup failed: ${message}`);
}

/**
 * The record a factory call returned. agency.js hands records back directly
 * today; tolerate a {ok, project|task|sprint} wrapper as well so the suite
 * tests the invariants, not a return shape.
 */
function rec(result) {
  if (!result) return null;
  if (result.id) return result;
  for (const key of ['project', 'task', 'sprint', 'criterion']) {
    if (result[key] && result[key].id) return result[key];
  }
  return null;
}

const ORCH = 'orchestrator_lead';
const PO = 'product_owner_product_manager';
const CLIENT = 'client';

// Falsifiable criterion texts: one claim, a checkable subject, no goal or
// qualitative language. GOAL_TEXT is the counter-example.
const CRIT_A = 'The GET /api/agency/projects endpoint returns HTTP 200 with a JSON array of projects.';
const CRIT_B = 'The POST /api/agency/project endpoint stores a project record whose status is registered.';
const GOAL_TEXT = 'Make the pipeline feel good for everyone.';
const EVIDENCE = 'Evidence: release v1.2.3 is published and the API test suite passes.';

/**
 * Drive a project to `delivering` with a usable checklist.
 * `criteria` is a list of criterion texts (or {id, text} objects).
 */
function toDelivering(name, criteria) {
  const p = rec(agency.createProject({ name }));
  must(p && p.id, 'the project must be created');
  const triaged = agency.transitionProject(p.id, 'triaged', { actingRole: ORCH });
  must(triaged.ok === true, `registered -> triaged must be allowed: ${JSON.stringify(triaged.errors)}`);
  const list = (criteria || [CRIT_A]).map((c, i) =>
    typeof c === 'string' ? { id: `c${i + 1}`, text: c } : c);
  const set = agency.setAcceptanceCriteria(p.id, list);
  must(set.ok === true, `a falsifiable checklist must be accepted: ${JSON.stringify(set.errors)}`);
  const planning = agency.transitionProject(p.id, 'planning', { actingRole: ORCH });
  must(planning.ok === true, `triaged -> planning must be allowed: ${JSON.stringify(planning.errors)}`);
  const delivering = agency.transitionProject(p.id, 'delivering', { actingRole: ORCH });
  must(delivering.ok === true, `planning -> delivering must be allowed: ${JSON.stringify(delivering.errors)}`);
  return p;
}

/** A completed task with a deliverable — work a criterion can cite. */
function doneTask(projectId, title, role, phase) {
  const t = rec(agency.createTask({
    title,
    projectId,
    phase: phase || 'Operations',
    role: role || 'it_support_service_desk',
    estimateHours: 4,
  }));
  must(t && t.id, `the task "${title}" must be created`);
  agency.updateTask(t.id, { deliverable: { kind: 'code', summary: `Shipped ${title}`, ref: 'abc1234' } });
  const done = agency.setTaskStatus(t.id, 'done', 'completed');
  must(done.ok === true, `the task "${title}" must reach done: ${JSON.stringify(done.errors)}`);
  return t;
}

console.log('--- P1: a project in registered/triaged has no active sprint ---');
{
  const p = rec(agency.createProject({ name: 'P1 sprint guard' }));
  must(p && p.id, 'the project must be created');
  const sprint = rec(agency.createSprint({ projectId: p.id, name: 'P1 sprint' }));
  const active = agency.state().sprints.find((s) => s.id === sprint.id);
  const blocked = agency.transitionProject(p.id, 'triaged', { actingRole: ORCH });
  check('P1 a registered project with an active sprint cannot advance',
    !!active && active.status === 'active' && blocked.ok === false && blocked.reason === 'illegal_project_transition',
    `sprint=${active && active.status} :: ${JSON.stringify(blocked.errors)}`);
  check('P1 the refused move leaves the project in registered',
    agency.projectDetail(p.id).project.status === 'registered',
    agency.projectDetail(p.id).project.status);
}

console.log('--- P2: a project leaves triaged only with a falsifiable checklist ---');
{
  const p = rec(agency.createProject({ name: 'P2 checklist' }));
  must(p && p.id, 'the project must be created');
  const triaged = agency.transitionProject(p.id, 'triaged', { actingRole: ORCH });
  check('P2 a project may be triaged', triaged.ok === true && triaged.project.status === 'triaged',
    JSON.stringify(triaged.errors));

  const empty = agency.transitionProject(p.id, 'planning', { actingRole: ORCH });
  check('P2 a project cannot leave triaged with an empty checklist',
    empty.ok === false && empty.reason === 'no_acceptance_criteria', JSON.stringify(empty.errors));

  const goal = agency.setAcceptanceCriteria(p.id, [{ id: 'c1', text: GOAL_TEXT }]);
  check('P2 a criterion whose text is a goal is refused',
    goal.ok === false && goal.reason === 'criterion_not_falsifiable', JSON.stringify(goal.errors));
  check('P2 the refused checklist is not stored',
    agency.projectDetail(p.id).project.acceptanceCriteria.length === 0,
    JSON.stringify(agency.projectDetail(p.id).project.acceptanceCriteria));

  const good = agency.setAcceptanceCriteria(p.id, [{ id: 'c1', text: CRIT_A }]);
  check('P2 a falsifiable criterion is accepted',
    good.ok === true && agency.projectDetail(p.id).project.acceptanceCriteria.length === 1,
    JSON.stringify(good.errors));

  const planning = agency.transitionProject(p.id, 'planning', { actingRole: ORCH });
  check('P2 a project leaves triaged once the checklist is falsifiable',
    planning.ok === true && planning.project.status === 'planning', JSON.stringify(planning.errors));
}

console.log('--- P3: a task reaches done only with a deliverable ---');
{
  const p = rec(agency.createProject({ name: 'P3 deliverable' }));
  must(p && p.id, 'the project must be created');
  const t = rec(agency.createTask({
    title: 'P3 ship the release',
    projectId: p.id,
    phase: 'Deployment',
    role: 'devops_sre',
    estimateHours: 4,
  }));
  must(t && t.id, 'the task must be created');
  agency.approveGate(t.id, 'security_signoff', 'security_operations_soc');

  const noDeliverable = agency.setTaskStatus(t.id, 'done', 'shipped');
  check('P3 a task cannot reach done without a deliverable',
    noDeliverable.ok === false && noDeliverable.reason === 'missing_deliverable',
    JSON.stringify(noDeliverable.errors));
  check('P3 the refused task is not done',
    agency.state().tasks.find((x) => x.id === t.id).status !== 'done',
    agency.state().tasks.find((x) => x.id === t.id).status);

  agency.updateTask(t.id, { deliverable: { kind: 'record', summary: '   ' } });
  const blank = agency.setTaskStatus(t.id, 'done', 'shipped');
  check('P3 a deliverable without a summary is not a deliverable',
    blank.ok === false && blank.reason === 'missing_deliverable', JSON.stringify(blank.errors));

  agency.updateTask(t.id, { deliverable: { kind: 'code', summary: 'Deployed the pipeline release', ref: 'abc1234' } });
  const done = agency.setTaskStatus(t.id, 'done', 'shipped');
  check('P3 a task reaches done once a deliverable names what it produced',
    done.ok === true && done.task.status === 'done', JSON.stringify(done.errors));
}

console.log('--- P4: a project reaches done only with every criterion met ---');
{
  // (a) one criterion of two is met.
  const p4a = toDelivering('P4 one criterion unmet', [CRIT_A, CRIT_B]);
  const t4a = doneTask(p4a.id, 'P4 delivered work');
  const v4a = agency.verifyCriterion(p4a.id, 'c1', true, EVIDENCE, { metBy: [t4a.id] });
  must(v4a.ok === true, `the criterion must be verifiable: ${JSON.stringify(v4a.errors)}`);
  const accept4a = agency.transitionProject(p4a.id, 'acceptance', { actingRole: PO });
  must(accept4a.ok === true, `the PO must be able to accept: ${JSON.stringify(accept4a.errors)}`);
  const done4a = agency.transitionProject(p4a.id, 'done', { actingRole: PO });
  check('P4 a project cannot reach done while a criterion is unmet',
    done4a.ok === false && done4a.reason === 'acceptance_not_met', JSON.stringify(done4a.errors));
  check('P4 the refused project stays in acceptance',
    agency.projectDetail(p4a.id).project.status === 'acceptance',
    agency.projectDetail(p4a.id).project.status);

  // (b) the criterion is met, but the task it cites is not done.
  const p4b = toDelivering('P4 cited task unfinished');
  const t4b = rec(agency.createTask({
    title: 'P4 unfinished work',
    projectId: p4b.id,
    phase: 'Operations',
    role: 'it_support_service_desk',
    estimateHours: 4,
  }));
  must(t4b && t4b.id, 'the cited task must be created');
  const v4b = agency.verifyCriterion(p4b.id, 'c1', true, EVIDENCE, { metBy: [t4b.id] });
  must(v4b.ok === true, `the criterion must be verifiable: ${JSON.stringify(v4b.errors)}`);
  const accept4b = agency.transitionProject(p4b.id, 'acceptance', { actingRole: PO });
  must(accept4b.ok === true, `the PO must be able to accept: ${JSON.stringify(accept4b.errors)}`);
  const done4b = agency.transitionProject(p4b.id, 'done', { actingRole: PO });
  check('P4 a criterion met by a task that is not done does not open the done gate',
    done4b.ok === false && done4b.reason === 'acceptance_not_met' && /not done/i.test(JSON.stringify(done4b.errors)),
    JSON.stringify(done4b.errors));

  // (c) every criterion met and every cited task done.
  const p4c = toDelivering('P4 fully met');
  const t4c = doneTask(p4c.id, 'P4 complete work');
  const v4c = agency.verifyCriterion(p4c.id, 'c1', true, EVIDENCE, { metBy: [t4c.id] });
  must(v4c.ok === true, `the criterion must be verifiable: ${JSON.stringify(v4c.errors)}`);
  const accept4c = agency.transitionProject(p4c.id, 'acceptance', { actingRole: PO });
  must(accept4c.ok === true, `the PO must be able to accept: ${JSON.stringify(accept4c.errors)}`);
  const done4c = agency.transitionProject(p4c.id, 'done', { actingRole: PO });
  check('P4 a project with every criterion met reaches done',
    done4c.ok === true && done4c.project.status === 'done', JSON.stringify(done4c.errors));
  const progress = agency.projectDetail(p4c.id).project.progress;
  check('P4 the closed project reports every criterion met',
    progress.criteriaMet === progress.criteriaTotal && progress.criteriaOutstanding === 0,
    JSON.stringify({ met: progress.criteriaMet, total: progress.criteriaTotal }));
}

console.log('--- P5: a task lives in a sprint of its own project ---');
{
  const p5a = rec(agency.createProject({ name: 'P5 project A' }));
  const p5b = rec(agency.createProject({ name: 'P5 project B' }));
  const sprint = rec(agency.createSprint({ projectId: p5b.id, name: 'P5 sprint B' }));
  const cross = agency.createTask({
    title: 'P5 cross-project task',
    projectId: p5a.id,
    sprintId: sprint.id,
    phase: 'Planning',
    role: PO,
    estimateHours: 4,
  });
  check('P5 a task cannot join a sprint of another project',
    cross.ok === false && cross.reason === 'sprint_project_mismatch', JSON.stringify(cross));
  check('P5 the refused task was not created',
    !agency.state().tasks.some((t) => t.title === 'P5 cross-project task'),
    'a task from another project was stored');
}

console.log('--- P6: metrics are project-scoped ---');
{
  const p6a = rec(agency.createProject({ name: 'P6 project A' }));
  const p6b = rec(agency.createProject({ name: 'P6 project B' }));
  agency.createTask({ title: 'P6 A task', projectId: p6a.id, phase: 'Planning', role: PO, estimateHours: 4 });
  agency.createTask({ title: 'P6 B task one', projectId: p6b.id, phase: 'Planning', role: PO, estimateHours: 4 });
  agency.createTask({ title: 'P6 B task two', projectId: p6b.id, phase: 'Planning', role: PO, estimateHours: 4 });

  const mA = agency.metrics(p6a.id);
  const mB = agency.metrics(p6b.id);
  check('P6 metrics(projectId) count only that project\'s tasks',
    !!mA.project && mA.project.id === p6a.id && mA.throughput.open === 1 && mA.throughput.completed === 0,
    JSON.stringify({ project: mA.project && mA.project.id, throughput: mA.throughput }));
  check('P6 two projects do not share a task count',
    mB.throughput.open === 2 && mA.throughput.open !== mB.throughput.open,
    JSON.stringify({ a: mA.throughput, b: mB.throughput }));
  check('P6 the report names the project it describes',
    !!mB.project && mB.project.id === p6b.id, JSON.stringify(mB.project && mB.project.id));

  const mDefault = agency.metrics();
  check('P6 metrics() without a projectId defaults to a live project',
    !!mDefault.project && ['planning', 'delivering', 'acceptance'].includes(mDefault.project.status),
    JSON.stringify(mDefault.project && mDefault.project.status));

  const listed = agency.listProjects();
  check('P6 listProjects reports every project with its own status and progress',
    listed.ok === true &&
      listed.projects.length === agency.state().projects.length &&
      listed.projects.every((p) => typeof p.status === 'string' && typeof p.criteriaTotal === 'number'),
    `${listed.projects.length} of ${agency.state().projects.length} projects`);
}

console.log('--- P7: the role that produced the delivery may not accept it ---');
{
  const p = toDelivering('P7 self acceptance');
  // The Product Owner authored the work the criterion cites.
  const poWork = doneTask(p.id, 'P7 PO authored the checklist', PO, 'Planning');
  const verified = agency.verifyCriterion(p.id, 'c1', true, EVIDENCE, { metBy: [poWork.id] });
  check('P7 a criterion can cite the delivering role\'s own task',
    verified.ok === true, JSON.stringify(verified.errors));

  const selfAccept = agency.transitionProject(p.id, 'acceptance', { actingRole: PO });
  check('P7 the role that produced the evidence may not accept it',
    selfAccept.ok === false && selfAccept.reason === 'self_acceptance', JSON.stringify(selfAccept.errors));
  check('P7 the refused acceptance leaves the project in delivering',
    agency.projectDetail(p.id).project.status === 'delivering',
    agency.projectDetail(p.id).project.status);

  const clientAccept = agency.transitionProject(p.id, 'acceptance', { actingRole: CLIENT });
  check('P7 an authorised acceptor that did not produce the evidence may accept',
    clientAccept.ok === true && clientAccept.project.status === 'acceptance',
    JSON.stringify(clientAccept.errors));
}

console.log('--- P8: only the Product Owner or the client may accept ---');
{
  const p = toDelivering('P8 acceptor authority');
  const refused = agency.transitionProject(p.id, 'acceptance', { actingRole: 'software_engineer' });
  check('P8 a role outside the acceptor list may not accept',
    refused.ok === false && refused.reason === 'acceptor_not_authorised', JSON.stringify(refused.errors));
  check('P8 the refused acceptance leaves the project in delivering',
    agency.projectDetail(p.id).project.status === 'delivering',
    agency.projectDetail(p.id).project.status);

  // The Product Owner accepts: the record does not claim the owner ratified it.
  const pPo = toDelivering('P8 PO acceptance');
  const tPo = doneTask(pPo.id, 'P8 delivered work');
  agency.verifyCriterion(pPo.id, 'c1', true, EVIDENCE, { metBy: [tPo.id] });
  const acceptPo = agency.transitionProject(pPo.id, 'acceptance', { actingRole: PO });
  must(acceptPo.ok === true, `the PO must be able to accept: ${JSON.stringify(acceptPo.errors)}`);
  const closePo = agency.transitionProject(pPo.id, 'done', { actingRole: PO });
  must(closePo.ok === true, `the PO must be able to close: ${JSON.stringify(closePo.errors)}`);
  const poRecord = agency.projectDetail(pPo.id).project;
  check('P8 a Product Owner acceptance is not recorded as ratified',
    poRecord.acceptedBy === PO && poRecord.ratified === false,
    JSON.stringify({ acceptedBy: poRecord.acceptedBy, ratified: poRecord.ratified }));

  // The client accepts on the owner's behalf: that IS recorded as ratification.
  const pClient = toDelivering('P8 client acceptance');
  const tClient = doneTask(pClient.id, 'P8 client delivered work');
  agency.verifyCriterion(pClient.id, 'c1', true, EVIDENCE, { metBy: [tClient.id] });
  const acceptClient = agency.transitionProject(pClient.id, 'acceptance', { actingRole: CLIENT });
  must(acceptClient.ok === true, `the client must be able to accept: ${JSON.stringify(acceptClient.errors)}`);
  const closeClient = agency.transitionProject(pClient.id, 'done', { actingRole: CLIENT });
  must(closeClient.ok === true, `the client must be able to close: ${JSON.stringify(closeClient.errors)}`);
  const clientRecord = agency.projectDetail(pClient.id).project;
  check('P8 a client acceptance is recorded as ratified',
    clientRecord.acceptedBy === CLIENT && clientRecord.ratified === true,
    JSON.stringify({ acceptedBy: clientRecord.acceptedBy, ratified: clientRecord.ratified }));
}

console.log('--- P9: the Orchestrator owns the timeline and may not bypass the stage order ---');
{
  const p = rec(agency.createProject({ name: 'P9 orchestrator sequencing' }));
  must(p && p.id, 'the project must be created');

  const skip = agency.transitionProject(p.id, 'delivering', { actingRole: ORCH });
  check('P9 the Orchestrator may not skip a stage',
    skip.ok === false && skip.reason === 'illegal_project_transition', JSON.stringify(skip.errors));
  check('P9 the refused move leaves the project in registered',
    agency.projectDetail(p.id).project.status === 'registered',
    agency.projectDetail(p.id).project.status);

  // An explicit sequencing flag does not unlock an illegal stage jump.
  const sequenced = agency.transitionProject(p.id, 'delivering', {
    actingRole: ORCH,
    sequenced: true,
    sequence: [p.id],
  });
  check('P9 an explicit sequencing flag does not unlock an illegal stage jump',
    sequenced.ok === false && sequenced.reason === 'illegal_project_transition', JSON.stringify(sequenced.errors));

  const poJump = agency.transitionProject(p.id, 'done', { actingRole: PO });
  check('P9 no role may jump the stage order',
    poJump.ok === false && poJump.reason === 'illegal_project_transition', JSON.stringify(poJump.errors));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
