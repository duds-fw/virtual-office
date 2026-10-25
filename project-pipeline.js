'use strict';
/**
 * project-pipeline.js — the project stage machine.
 *
 * The office runs projects through six stages:
 *   registered -> triaged -> planning -> delivering -> acceptance -> done
 * with `cancelled` reachable from any live stage.
 *
 * This module owns the vocabulary, the legal transitions, and the invariants
 * P1-P9 that guard them. It is deliberately free of state I/O: every function
 * takes the project (and whatever context it needs) and returns a verdict, so
 * the state machine can be tested without a server and without a state file.
 *
 * `agency.js` owns the state; this module owns the rules.
 */

/** The seven project statuses. `active` is a derived alias, never stored. */
const PROJECT_STATUSES = [
  'registered',
  'triaged',
  'planning',
  'delivering',
  'acceptance',
  'done',
  'cancelled',
];

/** The derived alias kept for readers that still ask "is it active?". */
const ACTIVE_ALIAS_STATUSES = ['planning', 'delivering'];

/**
 * The legal stage transitions.
 *
 * Each edge names the stage it leaves, the stage it enters, and whether the
 * edge is cancellable. The order of the keys IS the pipeline order.
 */
const PROJECT_TRANSITIONS = {
  registered: ['triaged', 'cancelled'],
  triaged: ['planning', 'cancelled'],
  planning: ['delivering', 'cancelled'],
  delivering: ['acceptance', 'cancelled'],
  acceptance: ['done', 'planning', 'cancelled'],
  done: [],
  cancelled: [],
};

/** Pipeline order, used for progress reporting. */
const PROJECT_STAGE_ORDER = [
  'registered',
  'triaged',
  'planning',
  'delivering',
  'acceptance',
  'done',
];

/** The roles that may accept a project (P8). */
const ACCEPTOR_ROLES = ['product_owner_product_manager', 'client'];

/**
 * Is this a status the office recognises?
 * `active` is deliberately NOT accepted as a stored status — it is derived.
 */
function isProjectStatus(status) {
  return PROJECT_STATUSES.includes(status);
}

/** The derived `active` alias: true while a project is live but not finished. */
function isActiveAlias(status) {
  return ACTIVE_ALIAS_STATUSES.includes(status);
}

/**
 * Is the move from `from` to `to` legal?
 * `cancelled` is reachable from every live stage; nothing leaves `done`.
 */
function isLegalTransition(from, to) {
  if (!isProjectStatus(from) || !isProjectStatus(to)) return false;
  const allowed = PROJECT_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

/**
 * Is this acceptance criterion text a falsifiable claim?
 *
 * A criterion must be a single claim that can be true or false. Free text that
 * cannot be checked is a goal, not a criterion (P2).
 *
 * The test is structural, not semantic — the office cannot judge whether a
 * sentence is checkable in the abstract. Two properties are required:
 *
 *   1. It is one sentence, of non-trivial length, that is not goal language.
 *   2. It names a checkable subject — an endpoint, file, artifact, interface,
 *      field, metric, or observable state. "Make it good" names nothing that
 *      can be inspected, so it is a goal.
 *
 * A goal is not a criterion. It belongs in `project.goal`.
 */
function isFalsifiableCriterion(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return false;
  if (t.length > 300) return false;
  // More than one sentence is not one falsifiable claim.
  const sentences = t.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().length);
  if (sentences.length > 1) return false;
  // Too short to state a checkable condition.
  if (t.length < 12) return false;
  // Goal language describes an outcome, not a checkable condition.
  if (/\b(should|could|would like|as fast as possible|better|nicer|goal|aim|want|good|great|nice|make it|improve)\b/i.test(t)) return false;
  // Comparative or qualitative claims describe a degree, not a state. They may
  // name a real artefact ("the API is fast") and still not be checkable, because
  // nothing states the threshold. A criterion names the threshold itself.
  if (/\b(fast|slow|quick|responsive|efficient|clean|simple|robust|secure|reliable|scalable|maintainable|readable|beautiful|easy|intuitive|seamless|professional)\b/i.test(t)) return false;
  // A checkable subject: something in the system that can be inspected.
  const checkable = [
    /\b(api|endpoint|route|request|response|payload|json|status code|header|body|schema)\b/i,
    /\b(file|module|function|class|method|script|repo|repository|code|commit|branch|test|test suite|build)\b/i,
    /\b(ui|button|form|page|screen|component|layout|style|css|icon|favicon|render)\b/i,
    /\b(config|setting|option|flag|environment|variable|manifest|package)\b/i,
    /\b(dashboard|report|metric|number|count|total|rate|percentage|latency|uptime|log|audit)\b/i,
    /\b(user|role|permission|access|token|session|credential|login|auth|password|policy)\b/i,
    /\b(record|row|column|table|database|migration|seed|data)\b/i,
    /\b(error|exception|failure|warning|exit code|return code|status)\b/i,
  ];
  if (!checkable.some((re) => re.test(t))) return false;
  return true;
}

/**
 * Validate a project acceptance checklist (P2).
 *
 * Returns { ok, reason, errors }. A checklist is a list of
 * {id, text, met, metBy[], evidence?} and every criterion must carry
 * falsifiable text.
 */
function validateChecklist(criteria) {
  if (!Array.isArray(criteria)) return { ok: false, reason: 'no_acceptance_criteria', errors: ['not an array'] };
  if (criteria.length === 0) return { ok: false, reason: 'no_acceptance_criteria', errors: ['empty'] };
  const errors = [];
  const seen = new Set();
  for (const c of criteria) {
    if (!c || typeof c !== 'object') { errors.push('criterion is not an object'); continue; }
    if (!c.id || typeof c.id !== 'string') { errors.push('criterion has no id'); continue; }
    if (seen.has(c.id)) { errors.push(`duplicate criterion id ${c.id}`); continue; }
    seen.add(c.id);
    if (!isFalsifiableCriterion(c.text)) {
      errors.push(`criterion ${c.id} is not a falsifiable claim: ${JSON.stringify(c.text)}`);
    }
  }
  if (errors.length) return { ok: false, reason: 'criterion_not_falsifiable', errors };
  return { ok: true, reason: null, errors: [] };
}

/**
 * Normalise a criterion into the canonical stored shape.
 *
 * The verdict fields (`met`, `metBy`, `evidence`) are deliberately NOT taken
 * from the caller. A checklist is a plan of what will be checked; the verdict
 * is reached separately by `verifyCriterion`, which enforces the evidence rule.
 * Honouring a caller-supplied `met: true` here would make the checklist a
 * self-asserted verdict and collapse the two acts of acceptance into one.
 */
function normaliseCriterion(raw, index) {
  return {
    id: raw.id || `ac_${index + 1}`,
    text: String(raw.text || '').trim(),
    met: false,
    metBy: [],
    evidence: null,
  };
}

/**
 * P7 — the role that produced a delivery may not accept that delivery.
 *
 * `metByRoles` is the set of roles that produced the evidence behind the met
 * criteria. `acceptingRole` must differ from every one of them.
 */
function wouldSelfAccept(acceptingRole, metByRoles) {
  if (!acceptingRole) return true;
  const producers = new Set((metByRoles || []).filter(Boolean));
  return producers.has(acceptingRole);
}

/**
 * P8 — only the Product Owner or the client may accept.
 */
function isAcceptorAuthorised(acceptingRole) {
  return ACCEPTOR_ROLES.includes(acceptingRole);
}

/**
 * P4 — a project may reach `done` only if every criterion is met, every met
 * criterion has a metBy task, and every referenced task is itself done.
 *
 * `tasksById` maps task id -> task object.
 */
function checkDoneGates(project, tasksById) {
  const criteria = Array.isArray(project.acceptanceCriteria) ? project.acceptanceCriteria : [];
  if (criteria.length === 0) return { ok: false, reason: 'no_acceptance_criteria', errors: ['empty checklist'] };
  const errors = [];
  const referenced = new Set();
  for (const c of criteria) {
    if (c.met !== true) { errors.push(`criterion ${c.id} is not met`); continue; }
    if (!Array.isArray(c.metBy) || c.metBy.length === 0) {
      errors.push(`criterion ${c.id} has no metBy task`);
      continue;
    }
    for (const tid of c.metBy) {
      referenced.add(tid);
      const t = (tasksById || {})[tid];
      if (!t) { errors.push(`criterion ${c.id} references unknown task ${tid}`); continue; }
      if (t.status !== 'done') errors.push(`criterion ${c.id} references task ${tid} which is not done`);
      // The task must belong to THIS project. A project record carries `id`,
      // not `projectId` — testing `project.projectId` here compared against
      // undefined and let another project's work satisfy the gate.
      if (project.id && t.projectId && t.projectId !== project.id) {
        errors.push(`criterion ${c.id} references task ${tid} from another project`);
      }
    }
  }
  if (errors.length) return { ok: false, reason: 'acceptance_not_met', errors };
  return { ok: true, reason: null, errors: [] };
}

/**
 * P1 — a project in registered/triaged has no active sprint.
 * `sprints` are the project's sprints.
 */
function checkNoActiveSprintBeforePlanning(project, sprints) {
  const status = project.status;
  if (status !== 'registered' && status !== 'triaged') return { ok: true };
  const active = (sprints || []).filter((s) => s.projectId === project.id && s.status === 'active');
  if (active.length) {
    return { ok: false, reason: 'illegal_project_transition', errors: [`project in ${status} has ${active.length} active sprint(s)`] };
  }
  return { ok: true };
}

/**
 * Decide whether a project may move from `from` to `to`.
 *
 * This is the single decision point for a stage change. It returns
 * { ok, reason, errors } and never mutates anything — the caller performs the
 * move once the verdict is ok.
 *
 * `ctx` carries what the verdict needs:
 *   - actingRole:  the matrixRole performing the move
 *   - project:     the project being moved
 *   - tasksById:   task id -> task
 *   - sprints:     the project's sprints (P1)
 *   - criteria:    the checklist being carried into the move
 */
function canTransition(from, to, ctx = {}) {
  const errors = [];
  if (!isProjectStatus(from)) {
    return { ok: false, reason: 'illegal_project_transition', errors: [`unknown source status ${from}`] };
  }
  if (!isLegalTransition(from, to)) {
    return {
      ok: false,
      reason: 'illegal_project_transition',
      errors: [`${from} -> ${to} is not a legal transition`],
    };
  }

  const project = ctx.project || {};
  const actingRole = ctx.actingRole || null;

  // Leaving triage requires a usable checklist (P2).
  if (from === 'triaged' && to === 'planning') {
    const v = validateChecklist(ctx.criteria);
    if (!v.ok) return { ok: false, reason: v.reason, errors: v.errors };
  }

  // A project may not be planning or delivering with an active sprint already
  // open before planning (P1).
  const p1 = checkNoActiveSprintBeforePlanning({ ...project, status: from }, ctx.sprints);
  if (!p1.ok) return p1;

  // Acceptance: only the PO or the client may accept (P8), and the accepting
  // role must not have produced the evidence (P7).
  if (to === 'acceptance') {
    if (!isAcceptorAuthorised(actingRole)) {
      return { ok: false, reason: 'acceptor_not_authorised', errors: [`${actingRole || 'unknown role'} may not accept a project`] };
    }
    const criteria = ctx.criteria || [];
    const metByRoles = [];
    const tasksById = ctx.tasksById || {};
    for (const c of criteria) {
      if (c.met !== true) continue;
      for (const tid of c.metBy || []) {
        const t = tasksById[tid];
        if (t && t.role) metByRoles.push(t.role);
      }
    }
    if (wouldSelfAccept(actingRole, metByRoles)) {
      return { ok: false, reason: 'self_acceptance', errors: [`${actingRole} produced the evidence it is trying to accept`] };
    }
  }

  // Done: every criterion met, every referenced task done (P4).
  if (to === 'done') {
    const g = checkDoneGates({ ...project, acceptanceCriteria: ctx.criteria || project.acceptanceCriteria || [] }, ctx.tasksById);
    if (!g.ok) return { ok: false, reason: g.reason, errors: g.errors };
  }

  // Moving back from acceptance to planning is the "request changes" path.
  if (from === 'acceptance' && to === 'planning') {
    if (!isAcceptorAuthorised(actingRole)) {
      return { ok: false, reason: 'acceptor_not_authorised', errors: [`${actingRole || 'unknown role'} may not request changes`] };
    }
  }

  void errors;
  return { ok: true, reason: null, errors: [] };
}

/**
 * Progress for a project: how far along the pipeline it is and how much of
 * its own acceptance work is complete.
 */
function projectProgress(project, tasksById) {
  const criteria = Array.isArray(project.acceptanceCriteria) ? project.acceptanceCriteria : [];
  const met = criteria.filter((c) => c.met === true).length;
  const ownTasks = Object.values(tasksById || {}).filter((t) => t.projectId === project.id);
  const doneTasks = ownTasks.filter((t) => t.status === 'done').length;
  const spentHours = ownTasks
    .filter((t) => t.status === 'done')
    .reduce((n, t) => n + (Number(t.estimateHours) || 0), 0);
  const stageIndex = PROJECT_STAGE_ORDER.indexOf(project.status);
  return {
    status: project.status,
    stageIndex: stageIndex === -1 ? null : stageIndex,
    stageCount: PROJECT_STAGE_ORDER.length,
    criteriaTotal: criteria.length,
    criteriaMet: met,
    criteriaOutstanding: criteria.length - met,
    tasksTotal: ownTasks.length,
    tasksDone: doneTasks,
    hoursSpent: spentHours,
    budgetHours: project.budgetHours || null,
    budgetOverrun: project.budgetHours ? Math.max(0, spentHours - project.budgetHours) : 0,
  };
}

/**
 * Migrate a legacy record onto the pipeline vocabulary.
 *
 * The office ran projects with a single hardcoded `active` status before the
 * stage machine existed, and ran tasks with no deliverable field before P3
 * existed. Loading such a record must not leave the office holding a status
 * the machine does not recognise, so the migration happens once, at the
 * boundary, and every consumer then sees a valid model.
 *
 * `active` maps to `delivering`: the legacy status meant "a live project with
 * work in flight", which is exactly what `delivering` means in the pipeline.
 * `active` is a derived alias from here on, never a stored value.
 *
 * Returns { changed, notes } so the caller can log what it repaired.
 */
function migrateProject(project) {
  const notes = [];
  if (!project || typeof project !== 'object') return { changed: false, notes };

  if (project.status === 'active') {
    project.status = 'delivering';
    notes.push(`status active -> delivering`);
  }
  if (!isProjectStatus(project.status)) {
    project.status = 'registered';
    notes.push(`unknown status ${project.status} -> registered`);
  }
  if (!Array.isArray(project.acceptanceCriteria)) {
    project.acceptanceCriteria = [];
  }
  if (project.delivery === undefined) project.delivery = null;
  if (project.dueAt === undefined) project.dueAt = null;
  if (project.triagedAt === undefined) project.triagedAt = null;
  if (project.acceptedAt === undefined) project.acceptedAt = null;
  if (project.closedAt === undefined) project.closedAt = null;
  if (project.acceptedBy === undefined) project.acceptedBy = null;
  if (project.ratified === undefined) project.ratified = false;

  return { changed: notes.length > 0, notes };
}

/**
 * Migrate a legacy task onto the pipeline model.
 *
 * A task closed before P3 existed has no deliverable. Backfilling one would
 * invent a claim about work that was never described, so the migration records
 * the fact of completion instead: the task keeps its `done` status and gains a
 * deliverable that says so honestly.
 */
function migrateTask(task) {
  const notes = [];
  if (!task || typeof task !== 'object') return { changed: false, notes };
  if (!task.deliverable && task.status === 'done') {
    task.deliverable = {
      kind: 'record',
      summary: 'Closed before the deliverable field existed; no deliverable was recorded at the time.',
      ref: null,
      url: null,
      at: task.completedAt || task.createdAt || Date.now(),
      migrated: true,
    };
    notes.push('backfilled a deliverable for a task closed before P3');
  }
  return { changed: notes.length > 0, notes };
}

module.exports = {
  PROJECT_STATUSES,
  PROJECT_STAGE_ORDER,
  PROJECT_TRANSITIONS,
  ACTIVE_ALIAS_STATUSES,
  ACCEPTOR_ROLES,
  isProjectStatus,
  isActiveAlias,
  isLegalTransition,
  isFalsifiableCriterion,
  validateChecklist,
  normaliseCriterion,
  wouldSelfAccept,
  isAcceptorAuthorised,
  checkDoneGates,
  checkNoActiveSprintBeforePlanning,
  canTransition,
  projectProgress,
  migrateProject,
  migrateTask,
};
