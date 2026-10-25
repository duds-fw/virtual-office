'use strict';
/**
 * agency.js — the duDDev Virtual Office domain model.
 *
 * Models the office as a real agency:
 *   Projects -> Sprints -> Tasks, with a Resourced roster, Approval Gates,
 *   Escalations, Standups and Delivery Metrics.
 *
 * This module is the single source of truth for agency state. The HTTP layer
 * (server.js) exposes it; the 3D office view renders it. Both read/write here.
 */

const fs = require('fs');
const path = require('path');

const STATE_DIR = process.env.AGENCY_STATE_DIR || path.join(__dirname, 'state');
const FILE = path.join(STATE_DIR, 'agency.json');
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

const PHASES = ['Planning', 'Analysis', 'Design', 'Development', 'Review', 'Deployment', 'Operations'];

/** Approval gates: a task cannot enter the phase until its gate is approved. */
const GATES = {
  Development: {
    id: 'design_approval',
    label: 'Design approval',
    approverRoles: ['ui_ux_designer', 'product_owner_product_manager'],
  },
  Deployment: {
    id: 'security_signoff',
    label: 'Security sign-off',
    approverRoles: ['network_and_security', 'security_operations_soc'],
  },
};

/** Escalation path for blocked work: agent -> PM -> Orchestrator -> client. */
const ESCALATION_PATH = [
  { level: 1, owner: 'Product Owner', matrixRole: 'product_owner_product_manager' },
  { level: 2, owner: 'Orchestrator', matrixRole: 'orchestrator_lead' },
  { level: 3, owner: 'Client', matrixRole: 'client' },
];

const BLOCK_ESCALATION_MS = Number(process.env.AGENCY_ESCALATION_MS) || 24 * 60 * 60 * 1000;

/**
 * Per-role daily token budget.
 *
 * Token spend is a resource like hours: a role that has already burned its
 * daily budget is not eligible for more work until the next local day.
 */
const ROLE_TOKEN_BUDGET = Number(process.env.AGENCY_ROLE_TOKEN_BUDGET) || 2_000_000;
let roleTokenBudget = ROLE_TOKEN_BUDGET;

/** Runtime-adjustable per-role budget (tunable without a restart). */
function setRoleTokenBudget(n) {
  const v = Number(n);
  if (Number.isFinite(v) && v > 0) roleTokenBudget = v;
  return roleTokenBudget;
}

/** Token spend today per matrix role, injected by the server from session usage. */
let roleTokenUsage = {};

function setRoleTokenUsage(map) {
  roleTokenUsage = (map && typeof map === 'object') ? map : {};
}

/** Tokens a role has spent today against its budget. */
function roleTokenState(matrixRole) {
  const used = Number(roleTokenUsage[matrixRole] || 0);
  return {
    used,
    capacity: roleTokenBudget,
    utilization: roleTokenBudget ? used / roleTokenBudget : 0,
    exhausted: used >= roleTokenBudget,
  };
}

/**
 * The resourced roster. capacityHours is per sprint (a 2-week sprint).
 * `subagent` is the OpenCode subagent that actually performs the work.
 */
const ROSTER = [
  { id: 'orch',  name: 'Orchestrator',   title: 'Lead Orchestrator',   matrixRole: 'orchestrator_lead',              subagent: null,             capacityHours: 40, phases: PHASES },
  { id: 'hermes',name: 'Hermes',         title: 'Dispatcher',          matrixRole: 'hermes_dispatcher',               subagent: 'hermes',         capacityHours: 20, phases: PHASES },
  { id: 'po',    name: 'Product Owner',  title: 'Product Mgmt',        matrixRole: 'product_owner_product_manager',  subagent: 'plan',           capacityHours: 24, phases: ['Planning', 'Analysis'] },
  { id: 'be',    name: 'Biz Enablement', title: 'Business Enablement', matrixRole: 'business_enablement',             subagent: 'general',        capacityHours: 16, phases: ['Planning', 'Analysis', 'Operations'] },
  { id: 'da',    name: 'Data Analyst',   title: 'Data Analyst',        matrixRole: 'data_analyst',                    subagent: 'explore',        capacityHours: 24, phases: ['Analysis', 'Planning'] },
  { id: 'ux',    name: 'UI/UX',          title: 'UI/UX Designer',      matrixRole: 'ui_ux_designer',                  subagent: 'documenter',     capacityHours: 32, phases: ['Design'] },
  { id: 'se',    name: 'Software Eng',   title: 'Software Engineer',   matrixRole: 'software_engineer',              subagent: 'build',          capacityHours: 40, phases: ['Development'] },
  { id: 'de',    name: 'Database Eng',   title: 'Database Engineer',   matrixRole: 'database_engineer',              subagent: 'general',        capacityHours: 32, phases: ['Design', 'Development'] },
  { id: 'aie',   name: 'AI Eng',         title: 'AI Engineer',         matrixRole: 'ai_engineer',                     subagent: 'general',        capacityHours: 32, phases: ['Design', 'Development'] },
  { id: 'qa',    name: 'QA',             title: 'Quality Assurance',   matrixRole: 'quality_assurance',              subagent: 'tester',         capacityHours: 32, phases: ['Review'] },
  { id: 'ns',    name: 'NetSec',         title: 'Network & Security',  matrixRole: 'network_and_security',           subagent: 'security-auditor',capacityHours: 24, phases: ['Review', 'Operations'] },
  { id: 'soc',   name: 'SOC',            title: 'Security Operations', matrixRole: 'security_operations_soc',         subagent: 'security-auditor',capacityHours: 20, phases: ['Review', 'Operations'] },
  { id: 'dso',   name: 'DevOps',         title: 'DevOps/SRE',          matrixRole: 'devops_sre',                      subagent: 'devops',         capacityHours: 32, phases: ['Deployment', 'Operations'] },
  { id: 'ce',    name: 'Cloud Eng',      title: 'Cloud Engineer',      matrixRole: 'cloud_engineer',                  subagent: 'devops',         capacityHours: 24, phases: ['Deployment', 'Operations'] },
  { id: 'iti',   name: 'IT Infra',       title: 'IT Infrastructure',   matrixRole: 'it_infrastructure',              subagent: 'devops',         capacityHours: 24, phases: ['Deployment', 'Operations'] },
  { id: 'dba',   name: 'DBA',            title: 'Database Admin',      matrixRole: 'database_administrator',         subagent: 'devops',         capacityHours: 20, phases: ['Deployment', 'Operations'] },
  { id: 'sd',    name: 'Service Desk',   title: 'IT Support',          matrixRole: 'it_support_service_desk',        subagent: 'general',        capacityHours: 24, phases: ['Operations'] },
];

const OPEN_STATUSES = ['ready', 'in_progress', 'review'];

/**
 * The complete status vocabulary (F-13). A task may only ever hold one of
 * these; anything else is refused at the boundary instead of being stored.
 * 'review' stays in OPEN_STATUSES: work awaiting review still holds capacity.
 */
const STATUSES = ['backlog', 'ready', 'in_progress', 'review', 'blocked', 'done', 'cancelled'];

/** An estimate is hours of work: finite and inside this range (F-12). */
const MIN_ESTIMATE_HOURS = 0.25;
const MAX_ESTIMATE_HOURS = 200;

let db = null;

// ---------------------------------------------------------------- persistence

function defaultDb() {
  const now = Date.now();
  const project = {
    id: 'proj_office_build',
    name: 'Build the Virtual Office to work like a real agency',
    goal: 'Transform the 3D virtual office into a real agency: projects, sprints, approval gates, standups, client feedback, escalation, metrics, workload and resource management.',
    client: 'internal',
    status: 'active',
    budgetHours: 480,
    createdAt: now,
  };
  const sprint = {
    id: 'sprint_1',
    projectId: project.id,
    name: 'Sprint 1 — Agency Foundation',
    goal: 'Ship the agency core: project/sprint model, resourced workload, approval gates.',
    startDate: now,
    endDate: now + 14 * 24 * 60 * 60 * 1000,
    status: 'active',
    createdAt: now,
  };
  return {
    projects: [project],
    sprints: [sprint],
    tasks: [],
    escalations: [],
    decisions: [],
    standups: [],
    activity: [],
    createdAt: now,
  };
}

function load() {
  if (db) return db;
  try {
    if (fs.existsSync(FILE)) {
      const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (parsed && Array.isArray(parsed.tasks)) {
        db = parsed;
        return db;
      }
    }
  } catch (e) {
    console.error('[agency] load failed, reseeding:', e.message);
  }
  db = defaultDb();
  seedSprintOne();
  save();
  return db;
}

/** Seed the first sprint with the real backlog of building the agency itself. */
function seedSprintOne() {
  const d = db;
  const project = d.projects[0];
  const sprint = d.sprints[0];
  const backlog = [
    { title: 'Define project & sprint data model', phase: 'Planning', role: 'product_owner_product_manager', estimateHours: 8 },
    { title: 'Map agency workflow & requirements', phase: 'Analysis', role: 'business_enablement', estimateHours: 8 },
    { title: 'Design office board & workload panels', phase: 'Design', role: 'ui_ux_designer', estimateHours: 12 },
    { title: 'Implement project/sprint/task engine', phase: 'Development', role: 'software_engineer', estimateHours: 16 },
    { title: 'Persist agency state to disk', phase: 'Development', role: 'database_engineer', estimateHours: 8 },
    { title: 'Wire autonomy to agency API', phase: 'Development', role: 'ai_engineer', estimateHours: 8 },
    { title: 'Test task lifecycle & resource rules', phase: 'Review', role: 'quality_assurance', estimateHours: 8 },
    { title: 'Security review of agency API', phase: 'Review', role: 'network_and_security', estimateHours: 4 },
    { title: 'Deploy agency release', phase: 'Deployment', role: 'devops_sre', estimateHours: 4 },
    { title: 'Runbook & SLA monitoring', phase: 'Operations', role: 'it_support_service_desk', estimateHours: 4 },
  ];
  for (const b of backlog) {
    const t = {
      id: 'task_' + Math.random().toString(36).slice(2, 8),
      projectId: project.id,
      sprintId: sprint.id,
      title: b.title,
      phase: b.phase,
      role: b.role,
      estimateHours: b.estimateHours,
      points: pointsFor(b.estimateHours),
      ownerId: null,
      status: 'backlog',
      gates: {},
      blockedReason: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      dueAt: sprint.endDate,
    };
    d.tasks.push(t);
  }
  d.activity.unshift({ time: Date.now(), who: 'Orchestrator', text: `seeded Sprint 1 with ${backlog.length} tasks across ${new Set(backlog.map(b => b.phase)).size} phases` });
}

/**
 * Persist the state file. Returns false when the write failed, so a caller
 * whose change must not be half-applied (an escalation resolve) can undo it
 * instead of pretending the state was stored.
 */
function save() {
  if (!db) return false;
  try {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, FILE);
    return true;
  } catch (e) {
    console.error('[agency] save failed:', e.message);
    return false;
  }
}

function logActivity(who, text) {
  const d = load();
  d.activity.unshift({ time: Date.now(), who, text });
  if (d.activity.length > 200) d.activity.length = 200;
}

// ------------------------------------------------------------------- helpers

function roster() {
  return ROSTER;
}

function agentById(id) {
  return ROSTER.find((a) => a.id === id) || null;
}

function agentByRole(matrixRole) {
  return ROSTER.find((a) => a.matrixRole === matrixRole) || null;
}

function pointsFor(hours) {
  return Math.max(1, Math.round(Number(hours) / 4));
}

/** A status is valid only when it comes from the fixed vocabulary (F-13). */
function isKnownStatus(status) {
  return typeof status === 'string' && STATUSES.includes(status);
}

/** Estimates feed capacity and points: finite and inside the range (F-12). */
function validEstimate(hours) {
  const n = Number(hours);
  return Number.isFinite(n) && n >= MIN_ESTIMATE_HOURS && n <= MAX_ESTIMATE_HOURS;
}

/** A role is valid when the roster has it and someone works the phase (F-14). */
function roleEligibleForPhase(matrixRole, phase) {
  return ROSTER.some((a) => a.matrixRole === matrixRole && a.phases.includes(phase));
}

/**
 * The resourcing rule, in one place: the agent must carry the task's role,
 * work the task's phase, not be a manager and have a subagent to do the work.
 * Auto-assign and an explicitly chosen owner both use it (F-20).
 */
function agentEligibleForTask(agent, task) {
  return (
    !!agent &&
    agent.matrixRole === task.role &&
    agent.phases.includes(task.phase) &&
    !agent.manager &&
    !!agent.subagent
  );
}

function activeSprint(projectId) {
  const d = load();
  return (
    d.sprints.find((s) => s.projectId === projectId && s.status === 'active') ||
    d.sprints.find((s) => s.projectId === projectId) ||
    null
  );
}

function taskById(id) {
  return load().tasks.find((t) => t.id === id) || null;
}

/** Hours an agent is currently committed to across all open tasks. */
function loadFor(agentId) {
  const d = load();
  return d.tasks
    .filter((t) => t.ownerId === agentId && OPEN_STATUSES.includes(t.status))
    .reduce((sum, t) => sum + (t.estimateHours || 0), 0);
}

function workload() {
  return ROSTER.map((a) => {
    const load = loadFor(a.id);
    const tokens = roleTokenState(a.matrixRole);
    return {
      ...a,
      loadHours: load,
      freeHours: Math.max(0, a.capacityHours - load),
      utilization: a.capacityHours ? load / a.capacityHours : 0,
      tokenToday: tokens.used,
      tokenCapacity: tokens.capacity,
      tokenUtilization: tokens.utilization,
      tokenExhausted: tokens.exhausted,
      status: a.manager ? 'manager' : (load > 0 || tokens.used > 0) ? 'working' : 'idle',
    };
  });
}

// ------------------------------------------------------------------- projects

function createProject({ name, goal, client, budgetHours }) {
  const d = load();
  const p = {
    id: 'proj_' + Math.random().toString(36).slice(2, 8),
    name: name || 'Untitled project',
    goal: goal || '',
    client: client || 'internal',
    status: 'active',
    budgetHours: Number(budgetHours) || 480,
    createdAt: Date.now(),
  };
  d.projects.unshift(p);
  logActivity('Orchestrator', `opened project "${p.name}"`);
  save();
  return p;
}

function createSprint({ projectId, name, goal, days }) {
  const d = load();
  const now = Date.now();
  const pid = projectId || (d.projects[0] && d.projects[0].id);
  // Opening a sprint closes the previous one — a project has one active sprint.
  for (const s of d.sprints) {
    if (s.projectId === pid && s.status === 'active') {
      s.status = 'completed';
      s.completedAt = now;
    }
  }
  const s = {
    id: 'sprint_' + Math.random().toString(36).slice(2, 8),
    projectId: pid,
    name: name || `Sprint ${d.sprints.length + 1}`,
    goal: goal || '',
    startDate: now,
    endDate: now + (Number(days) || 14) * 24 * 60 * 60 * 1000,
    status: 'active',
    createdAt: now,
  };
  d.sprints.unshift(s);
  logActivity('Orchestrator', `planned ${s.name}`);
  save();
  return s;
}

// ---------------------------------------------------------------------- tasks

function createTask({ title, projectId, sprintId, phase, role, estimateHours, ownerId }) {
  const d = load();
  const p = projectId || (d.projects[0] && d.projects[0].id);
  if (!p || !d.projects.some((x) => x.id === p)) return { ok: false, reason: 'unknown_project' };
  const ph = PHASES.includes(phase) ? phase : 'Planning';
  if (role) {
    if (!ROSTER.some((a) => a.matrixRole === role)) return { ok: false, reason: 'invalid_role' };
    if (!roleEligibleForPhase(role, ph)) return { ok: false, reason: 'role_not_eligible' };
  }
  const matrixRole = role || (ROSTER.find((a) => a.phases.includes(ph)) || {}).matrixRole || 'business_enablement';
  let sprint = null;
  if (sprintId) {
    sprint = d.sprints.find((s) => s.id === sprintId);
    if (!sprint) return { ok: false, reason: 'unknown_sprint' };
    // A task may only live in a sprint of its own project.
    if (sprint.projectId !== p) return { ok: false, reason: 'sprint_project_mismatch' };
  } else {
    sprint = activeSprint(p);
  }
  const hours = estimateHours === undefined || estimateHours === null ? 8 : Number(estimateHours);
  if (!validEstimate(hours)) return { ok: false, reason: 'invalid_estimate_hours' };
  const t = {
    id: 'task_' + Math.random().toString(36).slice(2, 8),
    projectId: p,
    sprintId: sprint ? sprint.id : null,
    title: title || 'Untitled task',
    phase: ph,
    role: matrixRole,
    estimateHours: hours,
    points: pointsFor(hours),
    ownerId: ownerId || null,
    status: 'backlog',
    gates: {},
    blockedReason: null,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    dueAt: sprint ? sprint.endDate : null,
  };
  d.tasks.unshift(t);
  logActivity('Orchestrator', `created task "${t.title}" (${ph}, ${hours}h)`);
  save();
  return t;
}

/**
 * Resource management: assign a task to an agent without over-committing them.
 * If no agentId is given, pick the eligible agent with the most free capacity.
 */
function assignTask(taskId, agentId) {
  const d = load();
  const t = taskById(taskId);
  if (!t) return { ok: false, reason: 'task_not_found' };

  // A role that has spent its daily token budget takes no more work.
  const tokenState = roleTokenState(t.role);
  if (tokenState.exhausted) {
    t.status = 'blocked';
    t.blockedReason = `role token budget exhausted: ${t.role} used ${tokenState.used.toLocaleString()} of ${tokenState.capacity.toLocaleString()}`;
    recordEscalation(t, `Token budget exhausted for ${t.role}`);
    logActivity('Orchestrator', `blocked "${t.title}": ${t.blockedReason}`);
    save();
    return { ok: false, reason: 'role_token_budget_exhausted', role: t.role, ...tokenState };
  }

  let agent;
  if (agentId) {
    agent = agentById(agentId);
    if (!agent) return { ok: false, reason: 'agent_not_found' };
    // An explicitly chosen owner gets the same eligibility filter as
    // auto-assign: no managers, no phase-ineligible agents (F-20).
    if (!agentEligibleForTask(agent, t)) {
      return { ok: false, reason: 'ineligible_agent', agentId: agent.id, role: t.role, phase: t.phase };
    }
  } else {
    const eligible = ROSTER.filter((a) => agentEligibleForTask(a, t));
    if (!eligible.length) return { ok: false, reason: 'no_eligible_agent' };
    eligible.sort((a, b) => freeHours(b) - freeHours(a));
    agent = eligible[0];
  }

  const committed = loadFor(agent.id);
  if (committed + t.estimateHours > agent.capacityHours) {
    t.status = 'blocked';
    t.blockedReason = `no capacity: ${agent.name} has ${freeHours(agent.id)}h free, needs ${t.estimateHours}h`;
    t.ownerId = agent.id;
    recordEscalation(t, `Over-allocated ${agent.name}`);
    logActivity('Orchestrator', `blocked "${t.title}": ${t.blockedReason}`);
    save();
    return { ok: false, reason: 'insufficient_capacity', agentId: agent.id, freeHours: freeHours(agent.id) };
  }

  t.ownerId = agent.id;
  t.status = t.status === 'backlog' ? 'ready' : t.status;
  logActivity(agent.name, `assigned "${t.title}" (${t.estimateHours}h)`);
  save();
  return { ok: true, agentId: agent.id, task: t };
}

function freeHours(agentId) {
  const a = agentById(agentId);
  if (!a) return 0;
  return Math.max(0, a.capacityHours - loadFor(agentId));
}

/**
 * Move a task to the next phase. Blocked when an approval gate for the target
 * phase has not been signed off.
 */
function advanceTask(taskId) {
  const d = load();
  const t = taskById(taskId);
  if (!t) return { ok: false, reason: 'task_not_found' };
  if (t.status === 'done') return { ok: false, reason: 'already_done' };

  const idx = PHASES.indexOf(t.phase);
  if (idx === -1) return { ok: false, reason: 'bad_phase' };
  if (idx === PHASES.length - 1) {
    t.status = 'done';
    t.completedAt = Date.now();
    // Backfill startedAt so lead time (completed - started) is measurable.
    t.startedAt = t.startedAt || t.createdAt;
    t.blockedReason = null;
    resolveEscalations(t.id, 'task done');
    logActivity(t.ownerId ? (agentById(t.ownerId) || {}).name || 'system' : 'system', `completed "${t.title}"`);
    save();
    return { ok: true, task: t, phase: t.phase, done: true };
  }

  const nextPhase = PHASES[idx + 1];
  const gate = GATES[nextPhase];
  if (gate && t.gates[gate.id] !== 'approved') {
    t.status = 'blocked';
    t.blockedReason = `awaiting ${gate.label}`;
    logActivity('Orchestrator', `"${t.title}" blocked — awaiting ${gate.label}`);
    save();
    return { ok: false, reason: 'gate_pending', gate: gate.id, label: gate.label, task: t };
  }

  t.phase = nextPhase;
  t.role = (ROSTER.find((a) => a.phases.includes(nextPhase) && !a.manager && a.subagent) || {}).matrixRole || t.role;
  t.status = 'ready';
  t.startedAt = t.startedAt || Date.now();
  t.blockedReason = null;
  t.ownerId = null;
  logActivity('Orchestrator', `"${t.title}" advanced to ${nextPhase}`);
  save();
  return { ok: true, task: t, phase: nextPhase };
}

function resolveEscalations(taskId, resolution) {
  const d = load();
  let changed = false;
  for (const e of d.escalations) {
    if (e.taskId === taskId && !e.resolvedAt) {
      e.resolvedAt = Date.now();
      e.resolution = resolution;
      changed = true;
    }
  }
  if (changed) save();
}

/**
 * Resolve a single escalation (design spec §5).
 *
 * Closes the escalation only: the task keeps its status and its blocked
 * reason, so a re-assign can still self-heal (PO decision D2). `resolvedAt` is
 * stamped server-side and is kept only when the state file was written
 * successfully — a failed save leaves the escalation open.
 */
function resolveEscalation(id, reason) {
  const d = load();
  const e = d.escalations.find((x) => x.id === id);
  if (!e) {
    return { ok: false, code: 'escalation_not_found', message: `no escalation with id "${id}"` };
  }
  if (e.resolvedAt) {
    return { ok: false, code: 'already_resolved', message: `escalation "${id}" was already resolved` };
  }
  const t = d.tasks.find((x) => x.id === e.taskId);
  if (!t || t.status !== 'blocked') {
    return { ok: false, code: 'task_not_blocked', message: `task "${e.taskId}" is no longer blocked` };
  }

  const note = typeof reason === 'string' && reason.trim() ? reason.trim() : null;
  const prevResolvedAt = e.resolvedAt;
  const prevResolution = e.resolution;
  e.resolvedAt = Date.now();
  if (note) e.resolution = note;
  logActivity('Orchestrator', `resolved escalation on "${e.taskTitle}"${note ? `: ${note}` : ''}`);
  const entry = d.activity[0];
  if (!save()) {
    // The state file could not be written — the escalation stays open, in
    // memory and on disk (spec §5: 500, resolvedAt must not persist).
    e.resolvedAt = prevResolvedAt;
    if (prevResolution === undefined) delete e.resolution;
    else e.resolution = prevResolution;
    if (d.activity[0] === entry) d.activity.shift();
    return { ok: false, code: 'internal_error', message: 'could not persist the resolved escalation' };
  }
  return {
    ok: true,
    escalation: {
      id: e.id,
      taskId: e.taskId,
      taskTitle: e.taskTitle,
      reason: e.reason,
      level: e.level,
      owner: e.owner,
      matrixRole: e.matrixRole,
      blockedSince: e.blockedSince,
      createdAt: e.createdAt,
      resolvedAt: e.resolvedAt,
    },
  };
}

function setTaskStatus(taskId, status, reason) {
  const t = taskById(taskId);
  if (!t) return { ok: false, reason: 'task_not_found' };
  // Fixed vocabulary: an unknown status is refused, never stored (F-13).
  if (!isKnownStatus(status)) return { ok: false, reason: 'invalid_status' };
  // A task may not be completed while its phase gate is unsigned: marking a
  // Deployment task done must not skip the security sign-off (F-03).
  const gate = GATES[t.phase];
  if (status === 'done' && gate && !(t.gates && t.gates[gate.id] === 'approved')) {
    return { ok: false, reason: 'gate_pending', gate: gate.id, label: gate.label, task: t };
  }
  t.status = status;
  if (status === 'in_progress' && !t.startedAt) t.startedAt = Date.now();
  if (status === 'done') {
    // A task completed without going through advanceTask still needs the
    // timestamps that lead-time and SLA metrics are computed from.
    if (!t.startedAt) t.startedAt = t.createdAt;
    if (!t.completedAt) t.completedAt = Date.now();
  }
  if (status === 'blocked') {
    t.blockedReason = reason || 'blocked';
    recordEscalation(t, reason || 'blocked');
  } else {
    t.blockedReason = null;
    // A blocker that got picked up is no longer an open escalation.
    resolveEscalations(taskId, `task ${status}`);
  }
  save();
  return { ok: true, task: t };
}

function approveGate(taskId, gateId, role) {
  const t = taskById(taskId);
  if (!t) return { ok: false, reason: 'task_not_found' };
  const gate = Object.values(GATES).find((g) => g.id === gateId);
  if (!gate) return { ok: false, reason: 'unknown_gate' };
  if (!gate.approverRoles.includes(role)) {
    return { ok: false, reason: 'role_not_approver', approverRoles: gate.approverRoles };
  }
  t.gates[gate.id] = 'approved';
  t.gates[gate.id + '_by'] = role;
  t.gates[gate.id + '_at'] = Date.now();
  logActivity('Orchestrator', `"${t.title}" — ${gate.label} approved by ${role}`);
  save();
  return { ok: true, task: t };
}

function escalationStep(level) {
  return ESCALATION_PATH[Math.min(ESCALATION_PATH.length, Math.max(1, level)) - 1];
}

/**
 * Escalation climbs with time, not only when someone re-blocks a task.
 * A blocker nobody picks up has to reach the PM, then the lead, then the
 * client — so the level is derived from blockedEvery time state is read.
 */
function refreshEscalationLevels() {
  const d = load();
  const now = Date.now();
  let changed = false;
  for (const e of d.escalations) {
    if (e.resolvedAt) continue;
    const level = Math.min(3, 1 + Math.floor((now - e.blockedSince) / BLOCK_ESCALATION_MS));
    const step = escalationStep(level);
    if (e.level !== level || e.owner !== step.owner) {
      e.level = level;
      e.owner = step.owner;
      e.matrixRole = step.matrixRole;
      changed = true;
    }
    // Show the task's current title — a renamed task should not keep a
    // stale name on the escalation board.
    const t = d.tasks.find((x) => x.id === e.taskId);
    if (t && t.title !== e.taskTitle) {
      e.taskTitle = t.title;
      changed = true;
    }
  }
  if (changed) save();
  return d.escalations;
}

function recordEscalation(task, reason) {
  const d = load();
  const existing = d.escalations.find((e) => e.taskId === task.id && !e.resolvedAt);
  const blockedSince = existing ? existing.blockedSince : Date.now();
  const level = Math.min(3, 1 + Math.floor((Date.now() - blockedSince) / BLOCK_ESCALATION_MS));
  const step = escalationStep(level);
  if (existing) {
    existing.level = level;
    existing.owner = step.owner;
    existing.matrixRole = step.matrixRole;
    existing.reason = reason;
  } else {
    d.escalations.unshift({
      id: 'esc_' + Math.random().toString(36).slice(2, 8),
      taskId: task.id,
      taskTitle: task.title,
      reason,
      level,
      owner: step.owner,
      matrixRole: step.matrixRole,
      blockedSince,
      createdAt: Date.now(),
      resolvedAt: null,
    });
  }
  if (d.escalations.length > 100) d.escalations.length = 100;
}

// ------------------------------------------------------------------- standups

function standup() {
  const d = load();
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const since = dayStart.getTime();
  // Local calendar date — the host runs UTC+8, so a UTC date would label
  // today's standup with yesterday's date after 16:00 local.
  const now = new Date();
  const localDay = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const perAgent = ROSTER.filter((a) => !a.manager).map((a) => {
    const mine = d.tasks.filter((t) => t.ownerId === a.id);
    return {
      agentId: a.id,
      name: a.name,
      title: a.title,
      matrixRole: a.matrixRole,
      done: mine.filter((t) => t.status === 'done' && (t.completedAt || 0) >= since).map((t) => t.title),
      inProgress: mine.filter((t) => t.status === 'in_progress' || t.status === 'review').map((t) => t.title),
      blockers: mine.filter((t) => t.status === 'blocked').map((t) => ({ title: t.title, reason: t.blockedReason })),
      loadHours: loadFor(a.id),
      capacityHours: a.capacityHours,
    };
  });

  const record = {
    date: localDay,
    createdAt: Date.now(),
    agents: perAgent,
    totals: {
      done: perAgent.reduce((n, x) => n + x.done.length, 0),
      inProgress: perAgent.reduce((n, x) => n + x.inProgress.length, 0),
      blockers: perAgent.reduce((n, x) => n + x.blockers.length, 0),
    },
  };
  const existing = d.standups.find((s) => s.date === record.date);
  if (existing) {
    Object.assign(existing, record);
    save();
    return existing;
  }
  d.standups.unshift(record);
  if (d.standups.length > 60) d.standups.length = 60;
  save();
  return record;
}

// -------------------------------------------------------------------- metrics

function metrics() {
  const d = load();
  refreshEscalationLevels();
  const now = Date.now();
  const done = d.tasks.filter((t) => t.status === 'done');
  const open = d.tasks.filter((t) => t.status !== 'done');

  const sprint = d.sprints.find((s) => s.status === 'active') || d.sprints[0] || null;
  const sprintTasks = sprint ? d.tasks.filter((t) => t.sprintId === sprint.id) : [];

  const velocity = d.sprints.map((s) => {
    const st = d.tasks.filter((t) => t.sprintId === s.id && t.status === 'done');
    return {
      sprintId: s.id,
      name: s.name,
      committedPoints: d.tasks.filter((t) => t.sprintId === s.id).reduce((n, t) => n + t.points, 0),
      completedPoints: st.reduce((n, t) => n + t.points, 0),
      completedHours: st.reduce((n, t) => n + t.estimateHours, 0),
    };
  });

  const leadTimes = done
    .filter((t) => t.completedAt && t.startedAt)
    .map((t) => t.completedAt - t.startedAt);
  const avgLeadTime = leadTimes.length
    ? Math.round(leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length / 3600000)
    : 0;

  const wl = workload();
  const totalCapacity = wl.reduce((n, a) => n + a.capacityHours, 0);
  const totalLoad = wl.reduce((n, a) => n + a.loadHours, 0);

  const completedOnTime = done.filter((t) => !t.dueAt || (t.completedAt || 0) <= t.dueAt).length;
  const defectTasks = done.filter((t) => t.defect).length;

  return {
    velocity,
    currentSprint: sprint ? {
      id: sprint.id,
      name: sprint.name,
      goal: sprint.goal,
      endDate: sprint.endDate,
      daysRemaining: sprint.endDate ? Math.max(0, Math.ceil((sprint.endDate - now) / 86400000)) : null,
      totalTasks: sprintTasks.length,
      doneTasks: sprintTasks.filter((t) => t.status === 'done').length,
      openTasks: sprintTasks.filter((t) => t.status !== 'done').length,
      blockedTasks: sprintTasks.filter((t) => t.status === 'blocked').length,
      inProgressTasks: sprintTasks.filter((t) => t.status === 'in_progress').length,
    } : null,
    leadTime: { avgHours: avgLeadTime, samples: leadTimes.length },
    utilization: {
      totalCapacityHours: totalCapacity,
      totalLoadHours: totalLoad,
      percent: totalCapacity ? totalLoad / totalCapacity : 0,
      overAllocated: wl.filter((a) => a.loadHours > a.capacityHours).map((a) => a.id),
    },
    tokens: {
      roleBudget: roleTokenBudget,
      byRole: wl
        .filter((a) => !a.manager)
        .map((a) => ({
          matrixRole: a.matrixRole,
          name: a.name,
          used: a.tokenToday,
          capacity: a.tokenCapacity,
          utilization: a.tokenUtilization,
          exhausted: a.tokenExhausted,
        }))
        .sort((x, y) => y.used - x.used),
      exhausted: wl.filter((a) => a.tokenExhausted).map((a) => a.matrixRole),
    },
    defects: { count: defectTasks, rate: done.length ? defectTasks / done.length : 0 },
    sla: {
      completedOnTime,
      completedTotal: done.length,
      compliance: done.length ? completedOnTime / done.length : 1,
    },
    throughput: { completed: done.length, open: open.length },
    escalations: {
      open: d.escalations.filter((e) => !e.resolvedAt).length,
      byLevel: ESCALATION_PATH.map((s) => ({
        level: s.level,
        owner: s.owner,
        count: d.escalations.filter((e) => !e.resolvedAt && e.level === s.level).length,
      })),
    },
  };
}

// --------------------------------------------------------------- public state

function state() {
  const d = load();
  refreshEscalationLevels();
  return {
    phases: PHASES,
    gates: GATES,
    escalationPath: ESCALATION_PATH,
    projects: d.projects,
    sprints: d.sprints,
    tasks: d.tasks,
    roster: workload(),
    // The payload carries open AND resolved escalations: the office UI renders
    // resolved rows in its collapsed "Resolved (N)" section (design spec
    // §6.6, §6.8). The open count stays in metrics().escalations.open, which
    // filters on !resolvedAt.
    escalations: d.escalations,
    activity: d.activity.slice(0, 50),
    metrics: metrics(),
    standup: standup(),
  };
}

/** Edit a task's descriptive fields. Titles and estimates change in real work. */
function updateTask(taskId, patch) {
  const t = taskById(taskId);
  if (!t) return { ok: false, reason: 'task_not_found' };
  const d = load();

  // Validate before mutating: a rejected patch must not change the task.
  let estimate = null;
  if (patch.estimateHours !== undefined && patch.estimateHours !== null) {
    estimate = Number(patch.estimateHours);
    if (!validEstimate(estimate)) return { ok: false, reason: 'invalid_estimate_hours' };
  }
  if (typeof patch.projectId === 'string' && patch.projectId) {
    if (!d.projects.some((x) => x.id === patch.projectId)) return { ok: false, reason: 'unknown_project' };
    if (patch.projectId !== t.projectId) return { ok: false, reason: 'project_mismatch' };
  }
  let sprintId = null;
  if (typeof patch.sprintId === 'string' && patch.sprintId) {
    const sprint = d.sprints.find((s) => s.id === patch.sprintId);
    if (!sprint) return { ok: false, reason: 'unknown_sprint' };
    // A task may only move to a sprint of its own project.
    if (sprint.projectId !== t.projectId) return { ok: false, reason: 'sprint_project_mismatch' };
    sprintId = sprint.id;
  }
  const nextPhase = typeof patch.phase === 'string' && PHASES.includes(patch.phase) ? patch.phase : t.phase;
  if (typeof patch.role === 'string' && patch.role) {
    if (!ROSTER.some((a) => a.matrixRole === patch.role)) return { ok: false, reason: 'invalid_role' };
    if (!roleEligibleForPhase(patch.role, nextPhase)) return { ok: false, reason: 'role_not_eligible' };
  }

  if (typeof patch.title === 'string' && patch.title.trim()) t.title = patch.title.trim();
  if (typeof patch.description === 'string') t.description = patch.description.trim();
  if (estimate !== null) {
    t.estimateHours = estimate;
    t.points = pointsFor(estimate);
  }
  if (sprintId) {
    t.sprintId = sprintId;
    logActivity('Orchestrator', `moved "${t.title}" to a different sprint`);
  }
  if (typeof patch.phase === 'string' && PHASES.includes(patch.phase)) {
    t.phase = patch.phase;
    t.role = (ROSTER.find((a) => a.phases.includes(patch.phase) && !a.manager && a.subagent) || {}).matrixRole || t.role;
  }
  save();
  return { ok: true, task: t };
}

/** Cancel a task that has not started — a PM pulls work off the board. */
function cancelTask(taskId) {
  const d = load();
  const t = taskById(taskId);
  if (!t) return { ok: false, reason: 'task_not_found' };
  if (t.status === 'in_progress' || t.status === 'review') {
    return { ok: false, reason: 'task_in_progress' };
  }
  d.tasks = d.tasks.filter((x) => x.id !== taskId);
  d.escalations = d.escalations.filter((e) => e.taskId !== taskId);
  logActivity('Orchestrator', `cancelled "${t.title}"`);
  save();
  return { ok: true, cancelled: t.id };
}

/**
 * What the office may decide on its own, and what must go to the owner.
 *
 * The office is autonomous within a sprint's committed scope. Anything that
 * changes the client's outcome, cost, or timing is the owner's call.
 */
const DECISION_POLICY = {
  strategic: [
    'Changing the goal, scope, or acceptance criteria of a project',
    'Adding, removing, or re-prioritising work in a sprint',
    'Spending beyond budget, or moving budget between projects',
    'Accepting a known defect or risk to hit a date',
    'Choosing between approaches with different business outcomes',
    'Anything that changes what the client receives, when, or at what cost',
  ],
  execution: [
    'Implementation approach, library choice, internal architecture',
    'Task breakdown, which subagent, and ordering within a sprint',
    'Fixing a bug, writing tests, refactoring, adding instrumentation',
    'Retrying a failed operation or restarting a service',
    'Any reversible change inside the sprint’s committed scope',
  ],
};

let decisions = [];

/** Decisions live in the persisted store so a restart never loses one. */
function decisionStore() {
  const d = load();
  if (!Array.isArray(d.decisions)) d.decisions = decisions.length ? decisions : [];
  decisions = d.decisions;
  return d;
}

/**
 * Raise a strategic decision for the owner.
 * Only strategic matters belong here — execution questions are the office's job.
 */
function raiseDecision({ question, context, options, taskId, projectId, sprintId, requestedBy, severity }) {
  const d = decisionStore();
  const id = 'dec_' + Math.random().toString(36).slice(2, 7);
  const rec = {
    id,
    question: String(question || '').slice(0, 400),
    context: String(context || '').slice(0, 800),
    options: (options || []).slice(0, 6).map((o, i) => ({
      id: o.id || String.fromCharCode(97 + i),
      label: String(o.label || o).slice(0, 80),
      note: o.note ? String(o.note).slice(0, 200) : '',
    })),
    taskId: taskId || null,
    projectId: projectId || (d.projects[0] && d.projects[0].id),
    sprintId: sprintId || null,
    requestedBy: requestedBy || 'Orchestrator',
    severity: severity || 'strategic',
    status: 'pending',
    answer: null,
    answeredBy: null,
    answeredAt: null,
    createdAt: Date.now(),
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  };
  decisions.unshift(rec);
  if (decisions.length > 100) decisions.length = 100;
  logActivity('Orchestrator', `raised decision ${id} for the owner: ${rec.question.slice(0, 80)}`);
  save();
  return rec;
}

/** The owner answers. The answer becomes part of the task record. */
function answerDecision(id, optionId, answeredBy) {
  const d = decisionStore();
  const rec = d.decisions.find((x) => x.id === id);
  if (!rec) return { ok: false, reason: 'decision_not_found' };
  if (rec.status !== 'pending') return { ok: false, reason: `already_${rec.status}` };
  const opt = rec.options.find((o) => o.id === optionId) || null;
  rec.status = 'answered';
  rec.answer = opt ? opt.label : String(optionId);
  rec.answerId = opt ? opt.id : String(optionId);
  rec.answeredBy = answeredBy || 'owner';
  rec.answeredAt = Date.now();

  // An answered decision releases the task that raised it.
  let released = null;
  if (rec.taskId) {
    const t = taskById(rec.taskId);
    if (t && t.status === 'blocked' && /decision/i.test(t.blockedReason || '')) {
      t.status = 'ready';
      t.blockedReason = null;
      resolveEscalations(rec.taskId, 'decision answered');
      released = t;
    }
  }
  logActivity('Orchestrator', `owner answered ${id}: ${rec.answer}`);
  save();

  // What changed as a result — the owner needs to know their answer did
  // something, not just that it was recorded.
  const effects = [];
  if (released) effects.push(`"${released.title}" released and is ready to start`);
  const touched = d.tasks.filter((t) => t.decisionId === rec.id);
  for (const t of touched) effects.push(`"${t.title}" updated`);
  if (!effects.length) {
    effects.push('No task was held on this decision — it is now part of the office record');
  }
  return { ok: true, decision: rec, effects, released: released ? released.id : null };
}

function pendingDecisions() {
  return decisionStore().decisions.filter((d) => d.status === 'pending');
}

function listDecisions() {
  return decisionStore().decisions.slice(0, 40);
}

/** Escalations that have reached the client level need the owner. */
function clientLevelEscalations() {
  return load().escalations.filter((e) => !e.resolvedAt && e.level >= 3);
}

/**
 * Retrospective learning.
 *
 * A retrospective is only worth holding if what it teaches changes how the
 * office works. Lessons are stored, feed the next sprint's planning, and are
 * surfaced to the owner so the loop is visible rather than ceremonial.
 */
let lessons = [];

function lessonStore() {
  const d = load();
  if (!Array.isArray(d.lessons)) d.lessons = lessons.length ? lessons : [];
  lessons = d.lessons;
  return d;
}

/**
 * Record what a sprint taught. Each lesson names the change it causes.
 * `appliesTo` scopes the lesson to a phase or role so it can be enforced.
 */
function recordLesson({ sprintId, observation, change, appliesTo, source }) {
  const d = lessonStore();
  const lesson = {
    id: 'les_' + Math.random().toString(36).slice(2, 7),
    sprintId: sprintId || null,
    observation: String(observation || '').slice(0, 300),
    change: String(change || '').slice(0, 300),
    appliesTo: appliesTo || 'all',
    source: source || 'retrospective',
    createdAt: Date.now(),
    appliedCount: 0,
  };
  d.lessons.unshift(lesson);
  if (d.lessons.length > 100) d.lessons.length = 100;
  logActivity('Orchestrator', `lesson recorded: ${lesson.change}`);
  save();
  return lesson;
}

function listLessons() {
  return lessonStore().lessons.slice(0, 50);
}

/**
 * How a lesson changes behaviour.
 *
 * A lesson that says "delegate smaller scopes" must actually change the
 * dispatch prompt — otherwise the retrospective is theatre.
 */
function lessonsFor(sprintId) {
  return lessonStore().lessons.filter((l) => !l.sprintId || !sprintId || l.sprintId === sprintId);
}

/** Prompt guidance derived from recorded lessons. */
function lessonGuidance(sprintId) {
  const ls = lessonsFor(sprintId);
  if (!ls.length) return '';
  const lines = ['LEARNED FROM THE LAST RETROSPECTIVE (apply these):'];
  for (const l of ls.slice(0, 5)) {
    lines.push(`- [${l.appliesTo}] ${l.change}${l.observation ? ` (because: ${l.observation})` : ''}`);
  }
  return lines.join('\n');
}

/** Count how often a lesson was actually applied. */
function markLessonApplied(lessonId) {
  const d = lessonStore();
  const l = d.lessons.find((x) => x.id === lessonId);
  if (!l) return false;
  l.appliedCount++;
  save();
  return true;
}

module.exports = {
  PHASES,
  GATES,
  ESCALATION_PATH,
  ROSTER,
  ROLE_TOKEN_BUDGET,
  getRoleTokenBudget: () => roleTokenBudget,
  setRoleTokenBudget,
  setRoleTokenUsage,
  roleTokenState,
  state,
  metrics,
  standup,
  workload,
  createProject,
  createSprint,
  createTask,
  assignTask,
  advanceTask,
  setTaskStatus,
  resolveEscalation,
  DECISION_POLICY,
  raiseDecision,
  answerDecision,
  pendingDecisions,
  listDecisions,
  clientLevelEscalations,
  recordLesson,
  listLessons,
  lessonsFor,
  lessonGuidance,
  markLessonApplied,
  updateTask,
  cancelTask,
  approveGate,
  load,
  save,
};
