'use strict';
/**
 * briefing.js — turns office state into what the OWNER actually needs.
 *
 * The owner is not an operator. "Queue drained on model X" is an event the
 * office handled on its own; it is noise in an owner's inbox. What the owner
 * needs is: is the business on track, is anything waiting on my authority,
 * and what changed.
 *
 * Three tiers, in order of how much they should interrupt:
 *   decision  — only the owner can resolve this (strategic fork)
 *   authority — only the owner can authorise this (money, scope, risk, client)
 *   digest    — periodic health the owner reads, never replies to
 */

const agency = require('./agency');

const SEV = { DECISION: 'decision', AUTHORITY: 'authority', DIGEST: 'digest', INFO: 'info' };

function pct(n) { return `${Math.round((Number(n) || 0) * 100)}%`; }
function compact(n) {
  const v = Number(n) || 0;
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

/**
 * Things only the owner can authorise. The office must never decide these.
 */
function authorityItems(state, metrics, tokens) {
  const items = [];

  // Client-level escalation — the blocker has reached the top of the ladder.
  for (const e of state.escalations || []) {
    if (e.resolvedAt || e.level < 3) continue;
    items.push({
      kind: 'escalation',
      severity: SEV.AUTHORITY,
      title: `Blocked ${e.taskTitle}`,
      detail: `${e.reason || 'blocked'} — escalated to ${e.owner} after ${Math.round((Date.now() - e.blockedSince) / 3600000)}h`,
      needs: 'A decision on how to unblock, or accept the risk.',
    });
  }

  // Budget overrun — hours committed against the project's budget.
  const project = (state.projects || [])[0];
  if (project && project.budgetHours) {
    const committed = (state.tasks || [])
      .filter((t) => t.status !== 'done')
      .reduce((n, t) => n + (t.estimateHours || 0), 0);
    const spent = (state.tasks || [])
      .filter((t) => t.status === 'done')
      .reduce((n, t) => n + (t.estimateHours || 0), 0);
    if (spent + committed > project.budgetHours) {
      items.push({
        kind: 'budget',
        severity: SEV.AUTHORITY,
        title: 'Project budget exceeded',
        detail: `${spent + committed}h committed+spent against ${project.budgetHours}h budget (${spent}h spent, ${committed}h still to do)`,
        needs: 'Approve more budget, or cut scope.',
      });
    }
  }

  // A role pinned at its token ceiling — it cannot take more work.
  const roleBudget = tokens && tokens.roleBudget ? tokens.roleBudget : 0;
  const hotRoles = ((tokens && tokens.byRole) || []).filter((r) => roleBudget && (r.todayAutopilotTokens || 0) >= roleBudget);
  for (const r of hotRoles) {
    items.push({
      kind: 'token_budget',
      severity: SEV.AUTHORITY,
      title: `${r.name || r.matrixRole} is out of token budget`,
      detail: `${compact(r.todayAutopilotTokens)} of ${compact(roleBudget)} used today — that role cannot take more work`,
      needs: 'Raise its budget, or let it wait until tomorrow.',
    });
  }

  // Sprint about to finish with work still open.
  const cs = metrics.currentSprint;
  if (cs && cs.daysRemaining !== null && cs.daysRemaining <= 2 && cs.openTasks > 0) {
    items.push({
      kind: 'sprint_risk',
      severity: SEV.AUTHORITY,
      title: `${cs.name} ends in ${cs.daysRemaining}d with ${cs.openTasks} open`,
      detail: `${cs.doneTasks}/${cs.totalTasks} done, velocity ${(metrics.velocity || []).map((v) => `${v.completedPoints}/${v.committedPoints}`).join(' ')}`,
      needs: 'Extend the sprint, cut scope, or accept the shortfall.',
    });
  }

  return items;
}

/**
 * Work that is parked because no model could serve it.
 *
 * The owner does not care that a queue drained — they care that a task they
 * are waiting on is not moving, and why. So this reports the TASK, with the
 * cause, and omits the machinery.
 */
function queuedWork(queueItems, state) {
  if (!queueItems || !queueItems.length) return [];
  const byTitle = new Map((state.tasks || []).map((t) => [t.id, t]));
  const out = [];
  for (const item of queueItems) {
    if (item.status !== 'waiting') continue;
    // The queue stores ticks, not tasks — map a tick back to the work it
    // represents by naming the open tasks that are not moving.
    out.push({
      reason: 'No AI capacity available right now',
      tasks: (state.tasks || []).filter((t) => t.status === 'ready' || t.status === 'in_progress').slice(0, 5),
      waitingSince: item.queuedAt,
      attempts: item.attempts,
    });
  }
  return out;
}

/** The daily digest — business health, not machine events. */
function digest(state, metrics, tokens, decisions, queue, savings, lessons) {
  const cs = metrics.currentSprint || {};
  const tasks = state.tasks || [];
  const byStatus = (s) => tasks.filter((t) => t.status === s);
  const done = byStatus('done');
  const inProgress = byStatus('in_progress');
  const blocked = byStatus('blocked');
  const ready = byStatus('ready');

  const shippedToday = done.filter((t) => t.completedAt && Date.now() - t.completedAt < 24 * 3600 * 1000);

  const lines = [];
  lines.push('<b>Daily briefing</b>');
  lines.push('');

  // 1. Are we on track?
  const totalPoints = (metrics.velocity || []).reduce((n, v) => n + (v.committedPoints || 0), 0);
  const donePoints = (metrics.velocity || []).reduce((n, v) => n + (v.completedPoints || 0), 0);
  const trend = metrics.velocity && metrics.velocity.length > 1 ? metrics.velocity : [];
  const onTrack = cs.totalTasks ? (cs.doneTasks / cs.totalTasks) >= 0.5 : true;
  lines.push(`<b>${cs.name || 'No active sprint'}</b> — ${cs.doneTasks || 0}/${cs.totalTasks || 0} done, ${cs.openTasks || 0} open, ${cs.daysRemaining ?? '?'}d left`);
  lines.push(`${onTrack ? '🟢 on track' : '🟡 behind'} · ${donePoints}/${totalPoints} points · ${pct(metrics.utilization?.percent)} utilised · SLA ${pct(metrics.sla?.compliance)} · lead time ${metrics.leadTime?.avgHours || 0}h`);
  if (trend.length > 1) {
    lines.push(`Velocity by sprint: ${trend.map((v) => `${v.completedPoints}/${v.committedPoints}`).join(' → ')}`);
  }
  lines.push('');

  // 2. What needs me?
  if (decisions && decisions.length) {
    lines.push(`<b>🔴 ${decisions.length} decision(s) need you</b>`);
    for (const d of decisions) lines.push(`• <code>${d.id}</code> ${d.question}`);
    lines.push('');
  } else {
    lines.push('<b>🟢 Nothing needs your decision.</b>');
    lines.push('');
  }

  // 3. What shipped
  if (shippedToday.length) {
    lines.push(`<b>Shipped since yesterday (${shippedToday.length})</b>`);
    for (const t of shippedToday.slice(0, 6)) lines.push(`• ${t.title}`);
    lines.push('');
  }

  // 4. What's in flight
  if (inProgress.length) {
    lines.push(`<b>In progress (${inProgress.length})</b>`);
    for (const t of inProgress.slice(0, 6)) {
      const owner = t.ownerId ? (agency.ROSTER.find((a) => a.id === t.ownerId) || {}).name : 'unassigned';
      lines.push(`• ${t.title} <i>— ${owner}</i>`);
    }
    lines.push('');
  }

  // 5. What's stuck
  if (blocked.length) {
    lines.push(`<b>⛔ Blocked (${blocked.length})</b>`);
    for (const t of blocked.slice(0, 5)) lines.push(`• ${t.title} — ${t.blockedReason || 'no reason given'}`);
    lines.push('');
  }

  // 5b. Work parked because no model could serve it. The TASK is the news,
  // not the mechanism that parked it.
  const parked = queuedWork(queue, state);
  if (parked.length) {
    lines.push(`<b>⏸ Paused — no AI capacity (${parked.length})</b>`);
    for (const p of parked) {
      for (const t of p.tasks) lines.push(`• ${t.title} <i>— on hold</i>`);
      lines.push(`  <i>${p.reason}. It restarts by itself — nothing needed from you.</i>`);
    }
    lines.push('');
  }

  // 6. Ready but not started — utilisation problem
  if (ready.length) {
    lines.push(`<b>Ready but not started (${ready.length})</b> — ${ready.slice(0, 4).map((t) => t.title).join('; ')}`);
    lines.push('');
  }

  // 7. Money and tokens
  const cost = tokens && tokens.cost ? tokens.cost : 0;
  lines.push(`<b>Cost</b> $${cost.toFixed(2)} · office tokens today ${compact(tokens?.spentToday || 0)} · ${tokens?.spentTodayLabel || ''}`);
  const roleBudget = tokens && tokens.roleBudget ? tokens.roleBudget : 0;
  const hot = ((tokens && tokens.byRole) || []).filter((r) => (r.todayAutopilotTokens || 0) > 0).slice(0, 4);
  if (hot.length && roleBudget) {
    lines.push('Per role: ' + hot.map((r) => `${r.name || r.matrixRole} ${compact(r.todayAutopilotTokens)}`).join(' · '));
  }

  // 8. What the optimisation layer saved
  if (savings && savings.ok) {
    lines.push(`<b>Token optimisation saved ${savings.totalSavedLabel}</b> — rtk ${savings.rtk.tokensSavedLabel} (${savings.rtk.percent}% of ${savings.rtk.commands} commands) · caveman ${savings.caveman.tokensSavedLabel}`);
    const top = (savings.rtk.byCommand || [])[0];
    if (top) lines.push(`Best: <code>${top.command}</code> saved ${top.saved} tokens`);
  }

  // 9. What the office learned and is now doing differently
  if (lessons && lessons.length) {
    lines.push('');
    lines.push(`<b>Learned and applied (${lessons.length})</b>`);
    for (const l of lessons.slice(0, 4)) {
      lines.push(`• ${l.change}${l.appliesTo && l.appliesTo !== 'all' ? ` <i>(${l.appliesTo})</i>` : ''}`);
    }
  }

  lines.push('');
  lines.push('Reply /status for a fresh snapshot, /decisions for anything waiting on you.');
  return lines.join('\n');
}

/** A single message for one authority item. */
function authorityMessage(item) {
  const lines = [
    `<b>🟠 ${item.title}</b>`,
    '',
    item.detail,
    '',
    `<i>${item.needs}</i>`,
  ];
  return lines.join('\n');
}

module.exports = { SEV, authorityItems, digest, authorityMessage, queuedWork };
