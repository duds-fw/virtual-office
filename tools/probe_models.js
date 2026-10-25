#!/usr/bin/env node
/**
 * Probe candidate models and report which ones can actually serve a prompt.
 * Usage: node tools/probe_models.js [provider/model ...]
 */
const { execFile } = require('child_process');

const OPENCODE_BIN = '/root/.opencode/bin/opencode';

function api(args, timeoutMs = 90000) {
  return new Promise((resolve) => {
    execFile(OPENCODE_BIN, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message || '').slice(0, 200) });
      try { resolve({ ok: true, json: JSON.parse(stdout) }); }
      catch (e) { resolve({ ok: false, error: 'unparseable: ' + String(stdout).slice(0, 120) }); }
    });
  });
}

async function probe(providerID, modelID) {
  const created = await api(['api', 'session.create', '--data', JSON.stringify({
    title: 'probe', model: { providerID, id: modelID },
  })]);
  if (!created.ok || !created.json.data) return { providerID, modelID, ok: false, error: created.error || 'create failed' };
  const sessionID = created.json.data.id;
  await api(['api', 'session.prompt', '--param', `sessionID=${sessionID}`, '--data',
    JSON.stringify({ text: 'reply with exactly: PROBE_OK' })]);

  // Give it time to answer, then read the assistant message.
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const msgs = await api(['api', 'session.message.list', '--param', `sessionID=${sessionID}`, '--param', 'limit=6']);
    const list = (msgs.json && (msgs.json.data || msgs.json.messages)) || [];
    const assistant = list.filter((m) => m.type === 'assistant').pop();
    if (!assistant) continue;
    const text = (assistant.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ');
    if (assistant.error) {
      const msg = assistant.error.message || '';
      const quota = /usage limit|quota|credits|subscribe/i.test(msg);
      return { providerID, modelID, ok: false, quota, error: msg.slice(0, 160) };
    }
    if (text.includes('PROBE_OK')) return { providerID, modelID, ok: true, served: assistant.model };
  }
  return { providerID, modelID, ok: false, error: 'no response in time' };
}

(async () => {
  const args = process.argv.slice(2);
  const candidates = args.length ? args : [
    'opencode/big-pickle',
    'opencode/beam-free',
    'opencode/glm-5.3-flash-free',
    'opencode/deepseek-v4.1-flash-free',
    'opencode/flint-40b-free',
    'opencode/mimo-v2.6-flash-free',
    'opencode/nemotron-3.5-lightning-free',
    'minimax-coding-plan/MiniMax-M3.1-Flash',
  ];
  for (const c of candidates) {
    const [providerID, modelID] = c.split('/');
    const r = await probe(providerID, modelID);
    const status = r.ok ? 'OK      ' : (r.quota ? 'QUOTA   ' : 'FAILED  ');
    console.log(`${status} ${c.padEnd(44)} ${r.ok ? (r.served && r.served.id) : r.error}`);
  }
})();
