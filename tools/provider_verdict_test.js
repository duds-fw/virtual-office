#!/usr/bin/env node
'use strict';
/**
 * tools/provider_verdict_test.js — the office must know whether the provider
 * actually did the work.
 *
 * `session.prompt` returns as soon as the request is accepted; the model
 * answers later, and a refusal (quota exhausted) arrives as an error on the
 * assistant's message. Reading the verdict too early reads "ok" every time,
 * which is how a blind office reported healthy ticks and why the owner was
 * told the office had stopped working while it had not.
 *
 * No provider is contacted: the session reader is injected.
 */

const assert = require('assert');
const path = require('path');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
}

const server = require(path.join(__dirname, '..', 'server.js'));

const healthy = { id: 'm2', type: 'assistant', content: [{ type: 'text', text: 'done' }] };
const refused = { id: 'm2', type: 'assistant', error: { type: 'provider.quota', message: 'provider.quota: usage limit reached' } };
const failedFinish = { id: 'm2', type: 'assistant', finish: 'error', content: [{ type: 'text', text: 'stopped' }] };

(async () => {
  console.log('--- reading the failure out of a provider message ---');
  check('a healthy message carries no failure', server.errorOf(healthy) === null, String(server.errorOf(healthy)));
  check('an error field is read', /usage limit/.test(String(server.errorOf(refused))), String(server.errorOf(refused)));
  check('an error finish is read', String(server.errorOf(failedFinish)) === 'provider error', String(server.errorOf(failedFinish)));
  check('a message with no shape is not a failure', server.errorOf(null) === null);

  console.log('--- a tick that the provider refused is not served ---');
  {
    const v = await server.providerVerdict('ses_x', '{}', 'm1', { messagesFn: async () => [healthy, refused] });
    check('the tick is not served', v.ok === false, JSON.stringify(v));
    check('the refusal is reported', /usage limit/.test(String(v.error)), JSON.stringify(v));
    check('the refusal is recognised as a quota refusal', v.quotaExhausted === true, JSON.stringify(v));
  }

  console.log('--- a tick the model answered is served ---');
  {
    const v = await server.providerVerdict('ses_x', '{}', 'm1', { messagesFn: async () => [healthy] });
    check('the tick is served', v.ok === true, JSON.stringify(v));
    check('there is no failure text', v.error === null, JSON.stringify(v));
  }

  console.log('--- an error in the prompt response is caught without waiting ---');
  {
    const stdout = JSON.stringify({ data: { info: { error: { message: 'usage limit reached' } } } });
    const v = await server.providerVerdict('ses_x', stdout, 'm1', { messagesFn: async () => [healthy] });
    check('the tick is not served', v.ok === false, JSON.stringify(v));
    check('the refusal is recognised as a quota refusal', v.quotaExhausted === true, JSON.stringify(v));
  }

  console.log('--- a refusal that lands on a later message is caught ---');
  {
    let call = 0;
    const messagesFn = async () => {
      call++;
      return call === 1 ? [{ id: 'm1', type: 'user' }] : [{ id: 'm1', type: 'user' }, refused];
    };
    const v = await server.providerVerdict('ses_x', '{}', 'm0', { messagesFn });
    check('the tick is not served', v.ok === false, JSON.stringify(v));
    check('the office waited for the answer', call >= 2, `polls ${call}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
