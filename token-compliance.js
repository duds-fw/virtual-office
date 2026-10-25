'use strict';
/**
 * token-compliance.js — measures whether agents actually follow the token
 * rules, rather than merely having them.
 *
 * Rules are advice. Compliance has to be observed. This compares what the
 * agents did against what they should have done, and produces a number the
 * office can act on — including as a retrospective lesson.
 *
 * Signals used:
 *   RTK      — counts the commands it proxied. Anything the agents ran that
 *              RTK did not proxy was command output that entered context
 *              unoptimised.
 *   Caveman  — counts the payloads it compressed.
 *   Spend    — per-role token spend against the per-role budget.
 */

const { execFile } = require('child_process');

const RTK_BIN = '/usr/local/bin/rtk';

function run(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message || '').slice(0, 160), stdout: stdout || '' });
      resolve({ ok: true, stdout: stdout || '' });
    });
  });
}

function parseRtkGain(text) {
  const out = { commands: 0, tokensSaved: 0, percent: 0, passthrough: 0, byCommand: [] };
  if (!text) return out;
  const cmds = text.match(/Total commands:\s*(\d+)/);
  if (cmds) out.commands = Number(cmds[1]);
  const saved = text.match(/Tokens saved:\s*(\d+)\s*\(([\d.]+)%\)/);
  if (saved) { out.tokensSaved = Number(saved[1]); out.percent = Number(saved[2]); }
  const rowRe = /^\s*\d+\.\s+(.+?)\s{2,}(\d+)\s+(\d+)\s+([\d.]+)%/gm;
  let m;
  while ((m = rowRe.exec(text)) !== null) {
    const cmd = m[1].trim();
    out.byCommand.push({ command: cmd.slice(0, 60), count: Number(m[2]), saved: Number(m[3]), percent: Number(m[4]) });
    if (/passthrough|fallback/i.test(cmd)) out.passthrough += Number(m[2]);
  }
  return out;
}

/**
 * Compliance signal.
 *
 * `proxyRate` is the share of agent shell commands that went through RTK.
 * A low rate means command output is entering context unoptimised.
 * `zeroSaveRate` is the share of proxied commands that saved nothing —
 * usually because the command was already minimal.
 */
async function collect({ tokens } = {}) {
  const gain = await run(RTK_BIN, ['gain']);
  const rtk = gain.ok ? parseRtkGain(gain.stdout) : { commands: 0, tokensSaved: 0, percent: 0, passthrough: 0, byCommand: [] };

  const byRole = (tokens && tokens.byRole) || [];
  const roleBudget = (tokens && tokens.roleBudget) || 0;
  const overBudget = byRole.filter((r) => roleBudget && (r.todayAutopilotTokens || 0) >= roleBudget);
  const nearBudget = byRole.filter((r) => roleBudget && (r.todayAutopilotTokens || 0) >= roleBudget * 0.8);

  // The health of the optimisation layer, in one judgement.
  let grade = 'unknown';
  let advice = 'No optimisation data yet — have the agents run some commands.';
  if (rtk.commands > 0) {
    const proxyRate = rtk.commands ? (rtk.commands - rtk.passthrough) / rtk.commands : 0;
    if (rtk.tokensSaved === 0) {
      grade = 'failing';
      advice = 'Commands are being proxied but nothing is being saved — check that agents use the rtk subcommands that actually trim output (rtk ls, rtk grep, rtk read, rtk tree).';
    } else if (proxyRate < 0.3) {
      grade = 'weak';
      advice = 'Most shell commands bypass the optimiser. Delegate with rtk-wrapped commands, or state the expected output size so agents filter at the source.';
    } else if (overBudget.length) {
      grade = 'at-risk';
      advice = `${overBudget.length} role(s) are at their token ceiling. Raise the budget or let those roles wait — the office is throttling work.`;
    } else {
      grade = 'healthy';
      advice = 'Optimisation is engaged. Keep the scoping rules; they are what make the savings compound.';
    }
  }

  return {
    ok: true,
    grade,
    advice,
    rtk: {
      commands: rtk.commands,
      proxied: Math.max(0, rtk.commands - rtk.passthrough),
      passthrough: rtk.passthrough,
      tokensSaved: rtk.tokensSaved,
      percent: rtk.percent,
      byCommand: rtk.byCommand.slice(0, 6),
    },
    roles: {
      budget: roleBudget,
      atCeiling: overBudget.map((r) => r.name || r.matrixRole),
      nearCeiling: nearBudget.map((r) => r.name || r.matrixRole),
    },
    collectedAt: Date.now(),
  };
}

module.exports = { collect, parseRtkGain };
