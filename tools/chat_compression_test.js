#!/usr/bin/env node
/**
 * Measures whether the CHAT path (not just shell output) is actually
 * compressed, by comparing a prompt sent through plain opencode against the
 * same prompt sent through `caveman wrap opencode`.
 *
 * The signal is provider-reported input tokens for the same payload.
 */
const { execFile } = require('child_process');

const OPENCODE = '/root/.opencode/bin/opencode';
const CAVEMAN = '/usr/local/bin/caveman';

function run(cmd, args, env, timeoutMs = 240000) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      env: { ...process.env, ...env },
      timeout: timeoutMs,
      maxBuffer: 12 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message || '').slice(0, 300) });
      resolve({ ok: true, stdout });
    });
  });
}

// A payload big enough that compression is measurable.
const BIG = 'Filler line with enough words to be measurable in token accounting. '.repeat(120);

async function tokensFor(label, cmd, args, env) {
  const res = await run(cmd, args, env);
  if (!res.ok) return { label, ok: false, error: res.error };
  try {
    const parsed = JSON.parse(res.stdout);
    const data = parsed.data || parsed;
    const t = data.tokens || {};
    return {
      label, ok: true,
      input: t.input || 0,
      output: t.output || 0,
      cacheRead: (t.cache && t.cache.read) || 0,
      id: data.id || data.sessionID,
    };
  } catch (e) {
    return { label, ok: false, error: 'parse: ' + String(res.stdout).slice(0, 160) };
  }
}

(async () => {
  const prompt = `Read this and reply with the single word DONE:\n${BIG}`;

  console.log('creating two fresh sessions with identical payloads...\n');

  const plain = await tokensFor('plain opencode', OPENCODE,
    ['api', 'session.create', '--data', JSON.stringify({ title: 'cmp-plain' })]);

  const plainId = plain.id;
  let plainTokens = null;
  if (plainId) {
    await run(OPENCODE, ['api', 'session.prompt', '--param', `sessionID=${plainId}`, '--data', JSON.stringify({ text: prompt })]);
    await new Promise((r) => setTimeout(r, 25000));
    const list = await run(OPENCODE, ['api', 'session.message.list', '--param', `sessionID=${plainId}`, '--param', 'limit=10']);
    try {
      const msgs = JSON.parse(list.stdout).data || [];
      const asst = msgs.filter((m) => m.type === 'assistant').pop();
      if (asst && asst.tokens) plainTokens = asst.tokens;
    } catch (e) { /* ignore */ }
  }

  const wrapped = await tokensFor('caveman wrap', CAVEMAN,
    ['wrap', 'opencode', 'api', 'session.create', '--data', JSON.stringify({ title: 'cmp-wrapped' })],
    { PATH: `/root/.opencode/bin:${process.env.PATH}` });

  let wrappedTokens = null;
  const wrappedId = wrapped.id;
  if (wrappedId) {
    await run(CAVEMAN, ['wrap', 'opencode', 'api', 'session.prompt', '--param', `sessionID=${wrappedId}`, '--data', JSON.stringify({ text: prompt })],
      { PATH: `/root/.opencode/bin:${process.env.PATH}` });
    await new Promise((r) => setTimeout(r, 25000));
    const list = await run(OPENCODE, ['api', 'session.message.list', '--param', `sessionID=${wrappedId}`, '--param', 'limit=10']);
    try {
      const msgs = JSON.parse(list.stdout).data || [];
      const asst = msgs.filter((m) => m.type === 'assistant').pop();
      if (asst && asst.tokens) wrappedTokens = asst.tokens;
    } catch (e) { /* ignore */ }
  }

  console.log('RESULT');
  console.log('  plain   ', plain.ok ? `session ${plainId}` : plain.error);
  console.log('  wrapped ', wrapped.ok ? `session ${wrappedId}` : wrapped.error);
  console.log('  plain tokens   ', plainTokens ? JSON.stringify(plainTokens) : 'n/a');
  console.log('  wrapped tokens ', wrappedTokens ? JSON.stringify(wrappedTokens) : 'n/a');
})();
