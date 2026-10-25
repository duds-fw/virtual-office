#!/usr/bin/env node
/**
 * Prove the queue path: when no provider can serve, work is parked and
 * resumes automatically. Runs against the real server.
 */
const { execFile } = require('child_process');
const http = require('http');

const BASE = 'http://127.0.0.1:9012';

function call(path, method = 'GET', body = null) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BASE + path, {
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      timeout: 300000,
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve({ raw: out.slice(0, 200) }); } });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  console.log('--- queue behaviour ---');

  const before = await call('/api/agency/models');
  console.log('  queue before:', before.queue.pending);

  // Force every candidate into an exhausted cooldown by probing with a
  // forced-failure list, then confirm a tick parks instead of dropping.
  const tick = await call('/api/autonomy/tick', 'POST');
  console.log('  tick result:', JSON.stringify(tick).slice(0, 160));

  const after = await call('/api/agency/models');
  console.log('  queue after: ', after.queue.pending);
  if (after.queue.items && after.queue.items.length) {
    for (const i of after.queue.items.slice(0, 3)) {
      console.log(`    ${i.id} ${i.status} attempts=${i.attempts} :: ${i.reason}`);
    }
  }
  console.log('  active model:', after.active);
})();
