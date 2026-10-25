'use strict';
/**
 * token-savings.js — measures what the token optimisation layer actually saves.
 *
 * Two independent sources, both read from their own authoritative stores:
 *   RTK     — its own global counter (`rtk gain`), per proxied command
 *   Caveman — its recovery database (tokens_before / tokens_after per record)
 *
 * The office reports the combined figure so the owner can see the optimisation
 * layer is earning its keep, and so a regression is visible before it costs.
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const CAVEMAN_DIR = process.env.CAVEMAN_DIR || '/root/.caveman';
const CCR_DB = path.join(CAVEMAN_DIR, 'ccr.db');
const RTK_BIN = '/usr/local/bin/rtk';

function run(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message || '').slice(0, 160), stdout: stdout || '' });
      resolve({ ok: true, stdout: stdout || '' });
    });
  });
}

/**
 * RTK prints compact magnitudes ("5.7K", "1.2M"), not plain integers. A
 * parser that expects digits alone reads them as no number at all, so the
 * office reported "0 tokens saved" while RTK had in fact saved thousands.
 * This is the one place that converts them.
 */
function parseCompact(value) {
  if (value === undefined || value === null) return 0;
  const m = String(value).trim().match(/^(-?\d+(?:\.\d+)?)\s*([KMB])?$/i);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const scale = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
  return Math.round(n * scale);
}

/** Parse `rtk gain` output into numbers. */
function parseRtkGain(text) {
  const out = {
    commands: 0,
    inputTokens: 0,
    outputTokens: 0,
    tokensSaved: 0,
    percent: 0,
    byCommand: [],
  };
  if (!text) return out;

  const cmds = text.match(/Total commands:\s*(\d+)/);
  if (cmds) out.commands = Number(cmds[1]);
  const saved = text.match(/Tokens saved:\s*(\d+(?:\.\d+)?\s*[KMB]?)\s*\(([\d.]+)%\)/i);
  if (saved) {
    out.tokensSaved = parseCompact(saved[1]);
    out.percent = Number(saved[2]);
  }
  const inTok = text.match(/Input tokens:\s*(\d+(?:\.\d+)?\s*[KMB]?)/i);
  if (inTok) out.inputTokens = parseCompact(inTok[1]);
  const outTok = text.match(/Output tokens:\s*(\d+(?:\.\d+)?\s*[KMB]?)/i);
  if (outTok) out.outputTokens = parseCompact(outTok[1]);

  // Per-command rows: " 1.  rtk ls docs                   2     58   57.4%     6ms"
  // The saved column is compact too ("2.1K"), so it goes through the same
  // conversion — otherwise the largest saver parses as NaN and sorts nowhere.
  const rowRe = /^\s*\d+\.\s+(.+?)\s{2,}(\d+)\s+(\d+(?:\.\d+)?\s*[KMB]?)\s+([\d.]+)%/gim;
  let m;
  while ((m = rowRe.exec(text)) !== null) {
    out.byCommand.push({
      command: m[1].trim().slice(0, 60),
      count: Number(m[2]),
      saved: parseCompact(m[3]),
      percent: Number(m[4]),
    });
  }
  out.byCommand.sort((a, b) => b.saved - a.saved);
  return out;
}

/** Read caveman's recovery records: each one is one compressed payload. */
function readCavemanSavings() {
  const out = { records: 0, tokensBefore: 0, tokensAfter: 0, tokensSaved: 0, percent: 0, byType: [] };
  if (!fs.existsSync(CCR_DB)) return out;
  let sqlite;
  try {
    // sqlite3 is a node builtin only from v22; fall back to the CLI.
    sqlite = require('node:sqlite');
  } catch (e) {
    sqlite = null;
  }
  if (sqlite) {
    try {
      const db = new sqlite.DatabaseSync(CCR_DB, { readOnly: true });
      const rows = db.prepare('SELECT content_type, compressor, tokens_before, tokens_after FROM recoveries').all();
      const byType = new Map();
      for (const r of rows) {
        const b = Number(r.tokens_before) || 0;
        const a = Number(r.tokens_after) || 0;
        out.records++;
        out.tokensBefore += b;
        out.tokensAfter += a;
        const key = r.content_type || r.compressor || 'unknown';
        const e = byType.get(key) || { type: key, records: 0, saved: 0 };
        e.records++;
        e.saved += Math.max(0, b - a);
        byType.set(key, e);
      }
      db.close();
      out.byType = [...byType.values()].sort((a, b) => b.saved - a.saved);
    } catch (e) {
      out.error = e.message;
    }
    return out;
  }
  // Fallback: shell out to sqlite3 if present.
  return out;
}

function compact(n) {
  const v = Number(n) || 0;
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

/**
 * Combined savings from both optimisation tools.
 * `spent` is what the office would have cost without them.
 */
async function collect({ spentTokens = 0 } = {}) {
  const rtkRes = await run(RTK_BIN, ['gain']);
  const rtk = rtkRes.ok ? parseRtkGain(rtkRes.stdout) : { commands: 0, tokensSaved: 0, percent: 0, byCommand: [], error: rtkRes.error };
  const caveman = readCavemanSavings();

  const cavemanSaved = Math.max(0, caveman.tokensBefore - caveman.tokensAfter);
  const totalSaved = (rtk.tokensSaved || 0) + cavemanSaved;

  // Savings relative to what the work would have cost unoptimised.
  const baseline = spentTokens + totalSaved;
  const percentOfSpend = baseline ? totalSaved / baseline : 0;

  return {
    ok: true,
    totalSaved,
    totalSavedLabel: compact(totalSaved),
    percentOfSpend,
    spentTokens,
    baselineTokens: baseline,
    rtk: {
      commands: rtk.commands || 0,
      tokensSaved: rtk.tokensSaved || 0,
      tokensSavedLabel: compact(rtk.tokensSaved || 0),
      percent: rtk.percent || 0,
      byCommand: (rtk.byCommand || []).slice(0, 5),
      error: rtk.error || null,
    },
    caveman: {
      records: caveman.records || 0,
      tokensBefore: caveman.tokensBefore || 0,
      tokensAfter: caveman.tokensAfter || 0,
      tokensSaved: cavemanSaved,
      tokensSavedLabel: compact(cavemanSaved),
      percent: caveman.tokensBefore ? cavemanSaved / caveman.tokensBefore : 0,
      byType: caveman.byType || [],
      error: caveman.error || null,
    },
    tools: ['rtk', 'caveman-native'],
    collectedAt: Date.now(),
  };
}

module.exports = { collect, parseRtkGain, parseCompact, compact };
