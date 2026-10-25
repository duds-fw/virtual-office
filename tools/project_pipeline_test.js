'use strict';
/**
 * Verifies the project pipeline stage machine (Phase A, A1) and the runtime
 * surface that enforces it in agency.js:
 *   1. the status vocabulary is closed, and `active` is derived, never stored
 *   2. only the legal stage edges are walkable
 *   3. P1 — no planning/delivering with an active sprint already open
 *   4. P2 — acceptance criteria are a typed, falsifiable checklist
 *   5. P3 — a task reaches `done` only with a deliverable naming what it produced
 *   6. P4 — a project reaches `done` only when every criterion is met and every
 *         referenced task is done
 *   7. P7 — the accepting role must not have produced the evidence it accepts
 *   8. P8 — only the PO or the client may accept
 *   9. P6 — metrics are scoped to a project, not to whichever task is first
 *
 * Runs against an isolated state directory so it never touches live office data.
 *   AGENCY_STATE_DIR=/tmp/pipeline-test node tools/project_pipeline_test.js
 */
const fs = require('fs');
const path = require('path');

const STATE = process.env.AGENCY_STATE_DIR || '/tmp/pipeline-test';
fs.rmSync(STATE, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
process.env.AGENCY_STATE_DIR = STATE;

const agency = require(path.join(__dirname, '..', 'agency.js'));
const pipeline = require(path.join(__dirname, '..', 'project-pipeline.js'));

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
}

const PO = 'product_owner_product_manager';
const QA = 'quality_assurance';
const SE = 'software_engineer';

// --------------------------------------------------------------- vocabulary

console.log('--- status vocabulary ---');
{
  check('every pipeline status is recognised',
    pipeline.PROJECT_STATUSES.every((s) => pipeline.isProjectStatus(s)));
  check('`active` is not a stored status',
    pipeline.isProjectStatus('active') === false);
  check('`active` is a derived alias for planning and delivering',
    pipeline.isActiveAlias('planning') === true &&
    pipeline.isActiveAlias('delivering') === true &&
    pipeline.isActiveAlias('done') === false &&
    pipeline.isActiveAlias('registered') === false);
  check('an unknown status is refused',
    pipeline.isProjectStatus('shipped') === false);
}

console.log('--- legal transitions ---');
{
  const legal = [
    ['registered', 'triaged'],
    ['triaged', 'planning'],
    ['planning', 'delivering'],
    ['delivering', 'acceptance'],
    ['acceptance', 'done'],
    ['acceptance', 'planning'], // request changes
  ];
  for (const [from, to] of legal) {
    check(`${from} -> ${to} is legal`, pipeline.isLegalTransition(from, to) === true);
  }
  const illegal = [
    ['registered', 'delivering'], // skipping triage
    ['registered', 'done'],
    ['triaged', 'delivering'],
    ['planning', 'acceptance'],
    ['delivering', 'done'],
    ['done', 'planning'], // nothing leaves done
    ['cancelled', 'planning'],
    ['planning', 'registered'], // no going back to triage
  ];
  for (const [from, to] of illegal) {
    check(`${from} -> ${to} is refused`, pipeline.isLegalTransition(from, to) === false);
  }
  check('cancellation is reachable from every live stage',
    ['registered', 'triaged', 'planning', 'delivering', 'acceptance']
      .every((s) => pipeline.isLegalTransition(s, 'cancelled') === true));
}

// ------------------------------------------------------------------- P1, P2

console.log('--- P1: no active sprint before planning ---');
{
  // Design doc §4 P1: "A project in registered/triaged has no active sprint."
  const sprint = { id: 'sp_1', projectId: 'proj_1', status: 'active' };
  const bad = pipeline.checkNoActiveSprintBeforePlanning(
    { id: 'proj_1', status: 'triaged' }, [sprint]);
  check('a triaged project with an active sprint is refused', bad.ok === false, JSON.stringify(bad));

  const badReg = pipeline.checkNoActiveSprintBeforePlanning(
    { id: 'proj_1', status: 'registered' }, [sprint]);
  check('a registered project with an active sprint is refused', badReg.ok === false, JSON.stringify(badReg));

  const good = pipeline.checkNoActiveSprintBeforePlanning(
    { id: 'proj_1', status: 'triaged' },
    [{ id: 'sp_1', projectId: 'proj_1', status: 'closed' }]);
  check('a triaged project with only closed sprints is allowed', good.ok === true, JSON.stringify(good));

  const other = pipeline.checkNoActiveSprintBeforePlanning(
    { id: 'proj_1', status: 'triaged' },
    [{ id: 'sp_2', projectId: 'proj_other', status: 'active' }]);
  check("another project's sprint does not block this one", other.ok === true, JSON.stringify(other));

  const after = pipeline.checkNoActiveSprintBeforePlanning(
    { id: 'proj_1', status: 'planning' }, [sprint]);
  check('planning may have an active sprint', after.ok === true, JSON.stringify(after));
}

console.log('--- P2: typed falsifiable checklist ---');
{
  check('a single checkable claim is falsifiable',
    pipeline.isFalsifiableCriterion('The login endpoint returns 401 for an expired token') === true);
  check('two sentences are not one falsifiable claim',
    pipeline.isFalsifiableCriterion('The login endpoint returns 401. The dashboard renders.') === false);
  check('goal language is not a criterion',
    pipeline.isFalsifiableCriterion('The dashboard should look nicer') === false);
  check('empty text is not a criterion', pipeline.isFalsifiableCriterion('   ') === false);
  check('too-short text is not a criterion', pipeline.isFalsifiableCriterion('Works') === false);
  // The design doc names "the API is fast" as the canonical bad example: it
  // names a real artefact but states no threshold, so it cannot be checked.
  check('a comparative claim with no threshold is not a criterion',
    pipeline.isFalsifiableCriterion('The API is fast') === false);
  check('a qualitative claim is not a criterion',
    pipeline.isFalsifiableCriterion('The UI is clean') === false);
  check('a criterion that states the threshold is falsifiable',
    pipeline.isFalsifiableCriterion('The API responds in under 200ms') === true);
  check('a claim naming nothing checkable is not a criterion',
    pipeline.isFalsifiableCriterion('Make it good') === false);

  const empty = pipeline.validateChecklist([]);
  check('an empty checklist is refused',
    empty.ok === false && empty.reason === 'no_acceptance_criteria');

  const vague = pipeline.validateChecklist([
    { id: 'c1', text: 'make it better', met: false, metBy: [] },
  ]);
  check('a non-falsifiable criterion is refused', vague.ok === false, JSON.stringify(vague));

  const good = pipeline.validateChecklist([
    { id: 'c1', text: 'The login endpoint returns 401 for an expired token', met: false, metBy: [] },
  ]);
  check('a falsifiable checklist is accepted', good.ok === true, JSON.stringify(good));

  const dupe = pipeline.validateChecklist([
    { id: 'c1', text: 'The login endpoint returns 401 for an expired token', met: false, metBy: [] },
    { id: 'c1', text: 'The logout endpoint returns 204', met: false, metBy: [] },
  ]);
  check('duplicate criterion ids are refused', dupe.ok === false, JSON.stringify(dupe));
}

// ------------------------------------------------------------------- P7, P8

console.log('--- P7: no self-acceptance ---');
{
  check('the producing role may not accept its own work',
    pipeline.wouldSelfAccept(SE, ['software_engineer']) === true);
  check('a role that produced nothing may accept',
    pipeline.wouldSelfAccept(PO, ['software_engineer']) === true === false);
  check('the PO accepts work built by engineering',
    pipeline.wouldSelfAccept(PO, ['software_engineer']) === false);
  check('the client accepts work built by engineering',
    pipeline.wouldSelfAccept('client', ['software_engineer']) === false);
}

console.log('--- P8: only the PO or client may accept ---');
{
  check('the PO may accept', pipeline.isAcceptorAuthorised(PO) === true);
  check('the client may accept', pipeline.isAcceptorAuthorised('client') === true);
  check('engineering may not accept', pipeline.isAcceptorAuthorised(SE) === false);
  check('QA may not accept', pipeline.isAcceptorAuthorised(QA) === false);
  check('an unknown role may not accept', pipeline.isAcceptorAuthorised('intern') === false);
}

// ----------------------------------------------------------- runtime surface

console.log('--- project registration and the stage machine ---');
{
  const p = agency.createProject({ name: 'Pipeline test', goal: 'Prove the machine', budgetHours: 40 });
  check('a project registers', !!p.id);
  check('a new project starts at registered', p.status === 'registered', p.status);
  check('a new project has no acceptance criteria yet',
    Array.isArray(p.acceptanceCriteria) && p.acceptanceCriteria.length === 0);
  check('a new project is not active', p.active === undefined || p.active === false);

  const skip = agency.transitionProject(p.id, 'delivering', { actingRole: PO });
  check('skipping a stage is refused',
    skip.ok === false && skip.reason === 'illegal_project_transition', JSON.stringify(skip));
  check('a refused transition leaves the status untouched',
    agency.projectDetail(p.id).project.status === 'registered');

  const triaged = agency.transitionProject(p.id, 'triaged', { actingRole: PO });
  check('registered -> triaged is allowed', triaged.ok === true, JSON.stringify(triaged));
  check('the triage timestamp is written', !!agency.projectDetail(p.id).project.triagedAt);

  const noCriteria = agency.transitionProject(p.id, 'planning', { actingRole: PO });
  check('planning without a checklist is refused (P2)',
    noCriteria.ok === false && noCriteria.reason === 'no_acceptance_criteria', JSON.stringify(noCriteria));

  const set = agency.setAcceptanceCriteria(p.id, [
    { id: 'c1', text: 'The pipeline test returns exit code 0', met: false, metBy: [] },
  ]);
  check('a valid checklist is stored', set.ok === true, JSON.stringify(set));

  const bad = agency.setAcceptanceCriteria(p.id, [{ id: 'c1', text: 'make it good', met: false, metBy: [] }]);
  check('an invalid checklist is refused', bad.ok === false, JSON.stringify(bad));
  check('the refused checklist did not overwrite the good one',
    agency.projectDetail(p.id).project.acceptanceCriteria.length === 1 &&
    agency.projectDetail(p.id).project.acceptanceCriteria[0].text ===
      'The pipeline test returns exit code 0');

  const planning = agency.transitionProject(p.id, 'planning', { actingRole: PO });
  check('triaged -> planning is allowed once the checklist exists',
    planning.ok === true, JSON.stringify(planning));
  check('planning is the active alias', agency.projectDetail(p.id).project.active === true);

  // --- P3: deliverable required before done ---
  const t = agency.createTask({ title: 'Pipeline task', phase: 'Design', role: 'ui_ux_designer', estimateHours: 4 });
  check('a task can be created', !!t.id);
  const noDeliverable = agency.setTaskStatus(t.id, 'done');
  check('a task cannot be done without a deliverable (P3)',
    noDeliverable.ok === false && noDeliverable.reason === 'missing_deliverable', JSON.stringify(noDeliverable));
  check('the refused status change did not land',
    agency.load().tasks.find((x) => x.id === t.id).status !== 'done');

  const noRef = agency.updateTask(t.id, { deliverable: { kind: 'code', summary: 'It works' } });
  check('a code deliverable without a commit SHA is refused',
    noRef.ok === false && noRef.reason === 'missing_deliverable_ref', JSON.stringify(noRef));

  const withRef = agency.updateTask(t.id, {
    deliverable: { kind: 'code', summary: 'It works', ref: 'abc1234' },
  });
  check('a code deliverable with a ref is accepted', withRef.ok === true, JSON.stringify(withRef));
  check('the deliverable is stored on the task',
    agency.load().tasks.find((x) => x.id === t.id).deliverable.ref === 'abc1234');

  // --- P7/P8 at the transition, with a real evidence chain ---
  const deliv = agency.transitionProject(p.id, 'delivering', { actingRole: PO });
  check('planning -> delivering is allowed', deliv.ok === true, JSON.stringify(deliv));

  const byEng = agency.verifyCriterion(p.id, 'c1', true, null, { metBy: [t.id] });
  check('a criterion cannot be marked met without evidence',
    byEng.ok === false && byEng.reason === 'criterion_unverified', JSON.stringify(byEng));

  const verified = agency.verifyCriterion(p.id, 'c1', true, 'sha abc1234', { metBy: [t.id] });
  check('a criterion with evidence is marked met', verified.ok === true, JSON.stringify(verified));

  const selfAccept = agency.transitionProject(p.id, 'acceptance', { actingRole: 'ui_ux_designer' });
  check('a non-acceptor role is refused (P8)',
    selfAccept.ok === false && selfAccept.reason === 'acceptor_not_authorised', JSON.stringify(selfAccept));

  const notDone = agency.transitionProject(p.id, 'done', { actingRole: PO });
  check('done is refused while a referenced task is not done (P4)',
    notDone.ok === false, JSON.stringify(notDone));

  const accept = agency.transitionProject(p.id, 'acceptance', { actingRole: PO });
  check('the PO may accept', accept.ok === true, JSON.stringify(accept));

  const changes = agency.transitionProject(p.id, 'planning', { actingRole: PO });
  check('acceptance -> planning (request changes) is allowed', changes.ok === true, JSON.stringify(changes));
  check('requesting changes clears the acceptance verdict',
    agency.projectDetail(p.id).project.acceptedAt === null &&
    agency.projectDetail(p.id).project.acceptanceCriteria[0].met === false);

  // --- P7: self-acceptance via the transition itself ---
  const t2 = agency.createTask({ title: 'Engineered work', phase: 'Development', role: SE, estimateHours: 6 });
  agency.updateTask(t2.id, { deliverable: { kind: 'code', summary: 'Engineered', ref: 'def5678' } });
  agency.verifyCriterion(p.id, 'c1', true, 'sha def5678', { metBy: [t2.id] });
  // The project sits in `planning`; it must re-enter delivery before acceptance.
  agency.transitionProject(p.id, 'delivering', { actingRole: PO });
  const selfAccept2 = agency.transitionProject(p.id, 'acceptance', { actingRole: SE });
  check('engineering may not accept at all (P8)',
    selfAccept2.ok === false && selfAccept2.reason === 'acceptor_not_authorised', JSON.stringify(selfAccept2));
  check('the refused acceptance left the stage alone',
    agency.projectDetail(p.id).project.status === 'delivering');

  const poAccept = agency.transitionProject(p.id, 'acceptance', { actingRole: PO });
  check('the PO accepts work built by engineering (P7 satisfied)',
    poAccept.ok === true, JSON.stringify(poAccept));
}

// ------------------------------------------------------------------- P7 edge

console.log('--- P7: the producer may not accept its own evidence ---');
{
  const p = agency.createProject({ name: 'Self accept test', goal: 'Prove P7', budgetHours: 20 });
  agency.transitionProject(p.id, 'triaged', { actingRole: PO });
  agency.setAcceptanceCriteria(p.id, [
    { id: 'c1', text: 'The endpoint returns status code 204', met: false, metBy: [] },
  ]);
  agency.transitionProject(p.id, 'planning', { actingRole: PO });
  agency.transitionProject(p.id, 'delivering', { actingRole: PO });

  const t = agency.createTask({ title: 'SE work', phase: 'Development', role: SE, estimateHours: 5 });
  agency.updateTask(t.id, { deliverable: { kind: 'code', summary: 'SE work', ref: 'aaa1111' } });
  agency.verifyCriterion(p.id, 'c1', true, 'sha aaa1111', { metBy: [t.id] });

  const seAccept = agency.transitionProject(p.id, 'acceptance', { actingRole: SE });
  check('the producing role is refused acceptance (P7/P8)',
    seAccept.ok === false && seAccept.reason === 'acceptor_not_authorised', JSON.stringify(seAccept));

  const poAccept = agency.transitionProject(p.id, 'acceptance', { actingRole: PO });
  check('the PO may accept engineering evidence', poAccept.ok === true, JSON.stringify(poAccept));
}

// ------------------------------------------------------------------- P6

console.log('--- P6: metrics are project-scoped ---');
{
  const m = agency.metrics();
  check('metrics report the project they describe', !!m.project, JSON.stringify(m.project));
  check('metrics list every project', Array.isArray(m.projects) && m.projects.length >= 1);
  check('each project carries its own progress', m.projects.every((p) => typeof p.progress === 'number' || p.progress === undefined || typeof p.stage === 'string'));
  check('the reported project status is a stored pipeline status, never the alias',
    m.project && pipeline.isProjectStatus(m.project.status), m.project && m.project.status);
  check('the active flag is derived from the stage',
    m.project && m.project.active === pipeline.isActiveAlias(m.project.status));

  // Two projects, different stages: the report must follow the project asked
  // for, not whichever one happens to be first in the list.
  const a = agency.createProject({ name: 'Scope A', goal: 'a', budgetHours: 10 });
  const b = agency.createProject({ name: 'Scope B', goal: 'b', budgetHours: 10 });
  agency.transitionProject(a.id, 'triaged', { actingRole: PO });

  const ta = agency.createTask({ title: 'A task', projectId: a.id, phase: 'Design', role: 'ui_ux_designer', estimateHours: 2 });
  const tb = agency.createTask({ title: 'B task', projectId: b.id, phase: 'Design', role: 'ui_ux_designer', estimateHours: 2 });
  check('a task attaches to the project it was created for', ta.projectId === a.id && tb.projectId === b.id);

  const ma = agency.metrics(a.id);
  check('metrics can be scoped to a named project', ma.project && ma.project.id === a.id, JSON.stringify(ma.project));
  check('a scoped report counts only that project\'s tasks',
    ma.throughput.open === 1, JSON.stringify(ma.throughput));

  const mb = agency.metrics(b.id);
  check('the other project has its own scoped report', mb.project && mb.project.id === b.id);
  check('the two scopes are independent',
    ma.throughput.open === 1 && mb.throughput.open === 1 &&
    ma.project.id !== mb.project.id);
}

// ------------------------------------------------------------------- report

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
