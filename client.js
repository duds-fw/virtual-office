'use strict';
/**
 * client.js — the owner/client channel for the Virtual Office.
 *
 * The owner is the client. This module is the transport that reaches them:
 * strategic decision requests, escalations that reach the top of the ladder,
 * and periodic project status reports.
 *
 * Telegram is the current transport, but nothing in the domain depends on it —
 * `deliver()` is the seam. Swapping in email or Slack means adding a
 * transport, not changing the office.
 *
 * Credentials live in state/client.json (0600) or in the environment.
 */

const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, 'state');
const CONFIG_FILE = path.join(STATE_DIR, 'client.json');
const TELEGRAM_API = 'https://api.telegram.org';

if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

let config = {
  transport: 'telegram',
  botToken: null,
  chatId: null,
  username: null,
  reportsEnabled: true,
  reportHour: 8,
  // IANA timezone the owner lives in. The report fires at reportHour in THIS
  // zone, regardless of the host clock (the host may run a different offset).
  timezone: 'Asia/Jakarta',
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      config = { ...config, ...parsed };
    }
  } catch (e) {
    console.error('[client] config load failed:', e.message);
  }
  if (!config.botToken && process.env.TELEGRAM_BOT_TOKEN) config.botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!config.chatId && process.env.TELEGRAM_CHAT_ID) config.chatId = process.env.TELEGRAM_CHAT_ID;
  return config;
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch (e) {
    console.error('[client] config save failed:', e.message);
  }
}

function isConfigured() {
  loadConfig();
  return Boolean(config.botToken && config.chatId);
}

/** Verify a bot token with Telegram and remember the bot identity. */
async function setBotToken(token) {
  const clean = String(token || '').trim();
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(clean)) {
    return { ok: false, error: 'That does not look like a Telegram bot token (expected digits:alphanumeric).' };
  }
  const res = await fetch(`${TELEGRAM_API}/bot${clean}/getMe`);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).description || ''; } catch {}
    return { ok: false, error: `Telegram rejected the token${detail ? ': ' + detail : ''}.` };
  }
  const body = await res.json();
  loadConfig();
  config.botToken = clean;
  config.username = body.result.username;
  saveConfig();
  return { ok: true, username: body.result.username, botName: body.result.first_name };
}

function setChatId(id) {
  loadConfig();
  const n = Number(id);
  if (!Number.isFinite(n)) return { ok: false, error: 'Chat id must be numeric.' };
  config.chatId = String(n);
  saveConfig();
  return { ok: true, chatId: config.chatId };
}

async function api(path, body) {
  loadConfig();
  if (!config.botToken) return { ok: false, error: 'no_bot_token' };
  const res = await fetch(`${TELEGRAM_API}/bot${config.botToken}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = {};
  try { payload = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, payload };
}

/** Send plain text to the owner. */
async function send(text, opts = {}) {
  loadConfig();
  if (!config.botToken || !config.chatId) return { ok: false, error: 'not_configured' };
  const body = {
    chat_id: config.chatId,
    text: String(text).slice(0, 4000),
    parse_mode: opts.parse_mode || 'HTML',
    disable_web_page_preview: true,
  };
  // opts.buttons is already a 2-D array of rows — do not wrap it again.
  if (opts.buttons && opts.buttons.length) body.reply_markup = { inline_keyboard: opts.buttons };
  const res = await api('sendMessage', body);
  if (!res.ok) {
    const detail = res.payload && res.payload.description ? res.payload.description : `HTTP ${res.status}`;
    console.error('[client] send failed:', detail);
    return { ok: false, error: detail };
  }
  return { ok: true, messageID: res.payload.result && res.payload.result.message_id };
}

/** Telegram inline keyboard: an array of rows, each row an array of buttons. */
function keyboard(rows) {
  return rows.map((row) => row.map((b) => ({ text: b.label, callback_data: b.data })));
}

/** A strategic decision request, formatted for the owner with tappable options. */
async function sendDecisionRequest(decision, context = {}) {
  const rows = [];
  for (const opt of decision.options || []) {
    rows.push([{ label: opt.label, data: `decide:${decision.id}:${opt.id}` }]);
  }
  const body = [
    `<b>Decision needed — ${decision.requestedBy || 'the office'}</b>`,
    '',
    decision.question,
  ];
  if (decision.context) body.push('', `<i>${decision.context}</i>`);
  if (context.taskTitle) body.push('', `Task: ${context.taskTitle}`);
  body.push('', `id <code>${decision.id}</code> · severity ${decision.severity || 'strategic'}`);
  return send(body.join('\n'), { buttons: rows.length ? keyboard(rows) : null });
}

/** A blocker that has reached the top of the escalation ladder. */
async function sendEscalation(escalation, context = {}) {
  const body = [
    `<b>Escalation L${escalation.level} — ${escalation.owner}</b>`,
    '',
    escalation.taskTitle,
    escalation.reason ? `Reason: ${escalation.reason}` : '',
    context.blockedSince ? `Blocked since: ${new Date(context.blockedSince).toLocaleString()}` : '',
    '',
    'Reply with /status for the full picture.',
  ].filter(Boolean);
  return send(body.join('\n'));
}

/**
 * The owner briefing is built by briefing.js — this module only transports
 * it. There is no separate status formatter here on purpose: one briefing
 * shape for every message the owner receives.
 */
async function sendStatusReport(report) {
  return send(String(report || ''));
}

/**
 * Long-poll Telegram for owner commands.
 * `onCommand(cmd)` receives { chatId, text, command, args, callbackData }.
 */
function startPolling(onCommand) {
  let offset = 0;
  let stopped = false;

  async function loop() {
    while (!stopped) {
      loadConfig();
      if (!config.botToken) { await new Promise((r) => setTimeout(r, 5000)); continue; }
      try {
        const res = await fetch(`${TELEGRAM_API}/bot${config.botToken}/getUpdates?offset=${offset}&timeout=25`);
        if (!res.ok) { await new Promise((r) => setTimeout(r, 5000)); continue; }
        const body = await res.json();
        const updates = body.result || [];
        for (const u of updates) {
          offset = u.update_id + 1;
          const chat = (u.message && u.message.chat) || (u.callback_query && u.callback_query.message && u.callback_query.message.chat);
          if (!chat) continue;
          console.log(`[client] update ${u.update_id} type=${u.type}`);

          // Auto-capture the owner's chat id the first time they write.
          if (!config.chatId) {
            config.chatId = String(chat.id);
            saveConfig();
            console.log('[client] captured owner chat id', config.chatId);
            await send(`Owner channel connected. This chat is now the office's client channel.\n\nCommands: /status /decisions /decide &lt;id&gt; &lt;option&gt; /token /help`);
          }

          if (u.callback_query) {
            const data = u.callback_query.data || '';
            await api('answerCallbackQuery', { callback_query_id: u.callback_query.id });
            onCommand({ chatId: chat.id, text: '', command: 'callback', args: [], callbackData: data, from: u.callback_query.from });
            continue;
          }
          const text = (u.message.text || '').trim();
          if (!text) continue;
          const parts = text.split(/\s+/);
          const cmd = parts[0].startsWith('/') ? parts[0].slice(1).split('@')[0].toLowerCase() : '';
          onCommand({ chatId: chat.id, text, command: cmd, args: parts.slice(1), from: u.message.from });
        }
      } catch (e) {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
  loop();
  return () => { stopped = true; };
}

/**
 * Wall-clock hour in the owner's timezone.
 * Uses Intl so it stays correct across DST changes without a hardcoded offset.
 */
function ownerHour(ts = Date.now()) {
  loadConfig();
  const tz = config.timezone || 'Asia/Jakarta';
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz });
    const h = Number(fmt.format(new Date(ts)));
    return Number.isFinite(h) ? h % 24 : new Date(ts).getHours();
  } catch (e) {
    return new Date(ts).getHours();
  }
}

/** Update channel settings (report time, timezone, whether reports are sent). */
function updateSettings(patch) {
  loadConfig();
  if (Number.isFinite(Number(patch.reportHour)) && Number(patch.reportHour) >= 0 && Number(patch.reportHour) <= 23) {
    config.reportHour = Number(patch.reportHour);
  }
  if (patch.reportsEnabled !== undefined) config.reportsEnabled = Boolean(patch.reportsEnabled);
  if (typeof patch.timezone === 'string' && patch.timezone.trim()) {
    // Validate the zone before storing it.
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: patch.timezone.trim() });
      config.timezone = patch.timezone.trim();
    } catch (e) {
      return { ...status(), error: 'unknown_timezone' };
    }
  }
  saveConfig();
  return status();
}

function status() {
  loadConfig();
  return {
    transport: config.transport,
    configured: Boolean(config.botToken && config.chatId),
    botTokenSet: Boolean(config.botToken),
    chatId: config.chatId,
    username: config.username,
    reportsEnabled: config.reportsEnabled !== false,
    reportHour: config.reportHour,
    timezone: config.timezone,
    ownerHourNow: ownerHour(),
  };
}

module.exports = {
  loadConfig,
  saveConfig,
  status,
  ownerHour,
  isConfigured,
  setBotToken,
  setChatId,
  updateSettings,
  send,
  sendDecisionRequest,
  sendEscalation,
  sendStatusReport,
  startPolling,
};
