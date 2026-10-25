'use strict';
/**
 * capacity.js — what the office has, how much of it is left, and when it comes back.
 *
 * The office ran on two numbers: a token budget and a step cap. Neither says
 * whether the machine can carry the work, and neither knows that the model
 * provider's quota resets on a 5-hour window and a weekly one. So the owner
 * could not answer "can the office keep working, and for how long".
 *
 * This module answers that from four sources:
 *   - the host: CPUs, load, memory, disk, uptime
 *   - the provider quota: the 5-hour and weekly windows (mmx quota)
 *   - the token plan: the daily office budget, the per-role budgets, and when
 *     the day's budget runs out at the current burn rate
 *   - the model hierarchy: which tier is serving, which is healthy, which is
 *     cooling down, and what the office falls back to next
 *
 * Nothing here writes. It is a read model for the dashboard.
 */

const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

/** The MiniMax quota CLI. It answers with JSON on stdout. */
const MMX_BIN = process.env.MMX_BIN || '/usr/local/bin/mmx';

/** A quota read is a subprocess call. Cache it briefly so a dashboard poll
 *  does not spawn one per panel refresh. */
const QUOTA_TTL_MS = 60 * 1000;

/** How long a candidate's health is trusted before it is probed again. */
const HEALTH_TTL_MS = 5 * 60 * 1000;

let quotaCache = { at: 0, value: null };

// ---------------------------------------------------------------- host

/** Load average per CPU. Above 1 the queue is longer than the machine. */
function loadPressure(load1, cpus) {
  const per = cpus ? load1 / cpus : load1;
  if (per >= 1.5) return 'critical';
  if (per >= 1.0) return 'elevated';
  if (per >= 0.7) return 'busy';
  return 'normal';
}

/** Disk usage of the filesystem the office lives on. */
function diskUsage(dir) {
  try {
    if (typeof fs.statfsSync === 'function') {
      const s = fs.statfsSync(dir);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      const used = total - s.bfree * s.bsize;
      return {
        path: dir,
        totalBytes: total,
        usedBytes: used,
        freeBytes: free,
        usedPercent: total ? Math.round((used / total) * 1000) / 10 : 0,
      };
    }
  } catch (e) { /* fall through to the shell */ }
  try {
    const out = require('child_process').execFileSync('df', ['-k', dir], { encoding: 'utf8' });
    const line = out.trim().split('\n').pop();
    const parts = line.split(/\s+/);
    const total = Number(parts[1]) * 1024;
    const used = Number(parts[2]) * 1024;
    const free = Number(parts[3]) * 1024;
    return { path: dir, totalBytes: total, usedBytes: used, freeBytes: free, usedPercent: total ? Math.round((used / total) * 1000) / 10 : 0 };
  } catch (e) {
    return null;
  }
}

/**
 * The host's capacity right now.
 * Load is sampled over three horizons so a dashboard can show a spike apart
 * from a sustained level.
 */
function sampleResources(stateDir) {
  const cpus = os.cpus() || [];
  const load = os.loadavg();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const disk = diskUsage(stateDir || '/');
  const memPercent = totalMem ? Math.round((usedMem / totalMem) * 1000) / 10 : 0;

  let pressure = loadPressure(load[0], cpus.length);
  if (memPercent >= 90) pressure = 'critical';
  else if (memPercent >= 80 && pressure === 'normal') pressure = 'elevated';

  return {
    cpus: cpus.length,
    load: { one: round(load[0]), five: round(load[1]), fifteen: round(load[2]) },
    loadPerCpu: cpus.length ? round(load[0] / cpus.length) : round(load[0]),
    memory: {
      totalBytes: totalMem,
      usedBytes: usedMem,
      freeBytes: freeMem,
      usedPercent: memPercent,
    },
    disk: disk,
    uptimeSeconds: Math.round(os.uptime()),
    pressure,
  };
}

function round(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// -------------------------------------------------------------- quota

/**
 * Read the provider's quota windows.
 * The shape is a 5-hour interval and a weekly window, each with the
 * percentage left and when it resets.
 */
function readQuota({ ttlMs = QUOTA_TTL_MS } = {}) {
  const now = Date.now();
  if (quotaCache.value && now - quotaCache.at < ttlMs) return quotaCache.value;

  return new Promise((resolve) => {
    execFile(MMX_BIN, ['quota'], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        quotaCache = { at: now, value: { ok: false, error: String(stderr || err.message || '').slice(0, 200), windows: [] } };
        return resolve(quotaCache.value);
      }
      let parsed;
      try { parsed = JSON.parse(stdout); }
      catch (e) {
        quotaCache = { at: now, value: { ok: false, error: 'unparseable quota response', windows: [] } };
        return resolve(quotaCache.value);
      }
      const windows = (parsed.model_remains || []).map((r) => ({
        model: r.model_name || 'general',
        interval: {
          label: '5-hour window',
          startAt: r.start_time,
          endAt: r.end_time,
          resetsInMs: Math.max(0, (r.end_time || 0) - now),
          remainingPercent: r.current_interval_remaining_percent,
          usageCount: r.current_interval_usage_count,
          totalCount: r.current_interval_total_count,
          status: r.current_interval_status,
        },
        weekly: {
          label: 'weekly window',
          startAt: r.weekly_start_time,
          endAt: r.weekly_end_time,
          resetsInMs: Math.max(0, (r.weekly_end_time || 0) - now),
          remainingPercent: r.current_weekly_remaining_percent,
          usageCount: r.current_weekly_usage_count,
          totalCount: r.current_weekly_total_count,
          status: r.current_weekly_status,
        },
      }));
      quotaCache = { at: now, value: { ok: true, readAt: now, windows } };
      resolve(quotaCache.value);
    });
  });
}

// --------------------------------------------------------- token plan

/**
 * The token plan: what is spent, what is left, and when the day's budget
 * runs out at the current rate.
 *
 * `spentToday` is the office's own accounting for the local day. The day
 * ends at local midnight, so the remaining hours are what the budget has to
 * last.
 */
function tokenPlan({ dailyBudget, spentToday, roleBudget, roleSpend, hoursLeftInDay }) {
  const budget = Number(dailyBudget) || 0;
  const spent = Number(spentToday) || 0;
  const remaining = Math.max(0, budget - spent);
  const percent = budget ? Math.round((spent / budget) * 1000) / 10 : 0;

  // Burn rate: what the office has spent per hour since the day started.
  const hoursElapsed = Math.max(0.25, 24 - (Number(hoursLeftInDay) || 0));
  const perHour = spent / hoursElapsed;
  const hoursToExhaust = perHour > 0 ? remaining / perHour : Infinity;

  const roles = Object.entries(roleSpend || {}).map(([role, used]) => {
    const u = Number(used) || 0;
    return {
      role,
      usedTokens: u,
      budgetTokens: roleBudget,
      usedPercent: roleBudget ? Math.round((u / roleBudget) * 1000) / 10 : 0,
      exhausted: u >= (Number(roleBudget) || Infinity),
    };
  }).sort((a, b) => b.usedPercent - a.usedPercent);

  return {
    dailyBudgetTokens: budget,
    spentTokens: spent,
    remainingTokens: remaining,
    usedPercent: percent,
    burnRatePerHour: Math.round(perHour),
    hoursLeftInDay: round(Number(hoursLeftInDay) || 0),
    projectedExhaustionHours: hoursToExhaust === Infinity ? null : round(hoursToExhaust),
    projectedExhaustionAt: hoursToExhaust === Infinity ? null : Date.now() + hoursToExhaust * 3600 * 1000,
    willExhaustToday: hoursToExhaust !== Infinity && hoursToExhaust <= (Number(hoursLeftInDay) || 0),
    roleBudgetTokens: roleBudget,
    roles,
  };
}

// ------------------------------------------------------ model hierarchy

/**
 * The model hierarchy as the router sees it, with the tier each candidate is
 * in and how long its health is trusted for.
 */
function modelHierarchy(candidates, { freeKeys = [], paidKeys = [] } = {}) {
  const now = Date.now();
  const rows = (candidates || []).map((c) => {
    const tier = freeKeys.includes(c.key) ? 'free' : (paidKeys.includes(c.key) ? 'paid' : 'other');
    const cooling = (c.exhaustedUntil || 0) > now;
    const age = now - (c.lastChecked || 0);
    return {
      key: c.key,
      providerID: c.providerID,
      modelID: c.modelID,
      tier,
      healthy: c.healthy,
      served: c.served || 0,
      failures: c.failures || 0,
      lastChecked: c.lastChecked || 0,
      checkedAgeMs: age,
      healthStale: age > HEALTH_TTL_MS,
      exhaustedUntil: c.exhaustedUntil || 0,
      coolingDown: cooling,
      coolingForMs: cooling ? c.exhaustedUntil - now : 0,
      lastError: c.lastError || null,
    };
  });

  const free = rows.filter((r) => r.tier === 'free');
  const paid = rows.filter((r) => r.tier === 'paid');
  const freeUsable = free.filter((r) => r.healthy === true && !r.coolingDown);
  const paidUsable = paid.filter((r) => r.healthy === true && !r.coolingDown);

  let serving = null;
  if (freeUsable.length) serving = 'free';
  else if (paidUsable.length) serving = 'paid';

  return {
    tiers: [
      { tier: 'free', label: 'Free tier', keys: free.map((r) => r.key), usable: freeUsable.length, total: free.length },
      { tier: 'paid', label: 'Paid fallback', keys: paid.map((r) => r.key), usable: paidUsable.length, total: paid.length },
    ],
    servingTier: serving,
    freeUsable: freeUsable.length,
    paidUsable: paidUsable.length,
    models: rows,
  };
}

module.exports = {
  sampleResources,
  readQuota,
  tokenPlan,
  modelHierarchy,
  HEALTH_TTL_MS,
  QUOTA_TTL_MS,
};
