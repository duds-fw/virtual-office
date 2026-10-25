'use strict';
/**
 * Verifies the model router's selection rules.
 *
 * The office went blind twice over:
 *   1. the probe gave a model 20 seconds to answer and declared working
 *      models dead with "no response in time"
 *   2. every tick re-probed the whole ladder, so one unlucky probe cost the
 *      office a provider it had already proved
 *
 * What must hold:
 *   1. a model whose health was checked recently is used without a probe
 *   2. the free tier is tried before the paid fallback
 *   3. a candidate in cooldown is skipped
 *   4. when the ladder cannot be verified inside the budget, a candidate that
 *      has served before is still offered rather than blinding the office
 *   5. when nothing can serve, the router says so (null) instead of guessing
 *
 * The prober is injected, so no provider is contacted.
 */
const path = require('path');
const router = require(path.join(__dirname, '..', 'model-router.js'));

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
}

const FREE = router.MODEL_POLICY.free;
const PAID = router.MODEL_POLICY.paid;
const FREE_KEY = FREE[0];
const PAID_KEY = PAID[0];

/** A prober that answers from a table, and counts what it was asked. */
function prober(table) {
  const calls = [];
  const fn = async (c) => {
    calls.push(c.key);
    const r = (table[c.key] || {});
    if (r.healthy) {
      router.simulateOutcome(c.key, { healthy: true, lastChecked: Date.now(), lastError: null });
      return router.simulateOutcome(c.key, {}) ? { ...c, healthy: true } : c;
    }
    router.simulateOutcome(c.key, { healthy: false, lastChecked: Date.now(), lastError: r.error || 'probe failed' });
    return { ...c, healthy: false };
  };
  fn.calls = calls;
  return fn;
}

(async () => {
  console.log('--- a healthy model is used without probing it again ---');
  {
    router.resetState();
    router.simulateOutcome(FREE_KEY, { healthy: true, lastChecked: Date.now() - 5000, served: 2 });
    const p = prober({});
    const m = await router.selectModel({ probeFn: p });
    check('a recently checked healthy model is returned', !!m && m.key === FREE_KEY, JSON.stringify(m));
    check('it was not probed', p.calls.length === 0, `probed ${p.calls.length}`);
    check('it is marked as trusted', m && m.trusted === true);
  }

  console.log('--- health goes stale and is probed again ---');
  {
    router.resetState();
    router.simulateOutcome(FREE_KEY, { healthy: true, lastChecked: Date.now() - (router.HEALTH_TTL_MS + 1000), served: 2 });
    const p = prober({ [FREE_KEY]: { healthy: true } });
    const m = await router.selectModel({ probeFn: p });
    check('a stale health is probed', p.calls.length === 1, `probed ${p.calls.length}`);
    check('the probed model is returned', !!m && m.key === FREE_KEY, JSON.stringify(m));
    check('a freshly probed model is not marked trusted', m && m.trusted !== true);
  }

  console.log('--- the free tier is tried before the paid fallback ---');
  {
    router.resetState();
    const p = prober({ [FREE_KEY]: { healthy: true } });
    const m = await router.selectModel({ probeFn: p });
    check('the free model is chosen', !!m && m.key === FREE_KEY, JSON.stringify(m));
    check('the paid model was not reached', !p.calls.includes(PAID_KEY), p.calls.join(','));
    check('the free model is not degraded', m && m.degraded === false);
  }

  console.log('--- the paid fallback is used when the free tier cannot serve ---');
  {
    router.resetState();
    const p = prober({ [FREE_KEY]: { healthy: false, error: 'no response in time' }, [PAID_KEY]: { healthy: true } });
    const m = await router.selectModel({ probeFn: p });
    check('the paid model is chosen', !!m && m.key === PAID_KEY, JSON.stringify(m));
    check('the paid model is marked degraded', m && m.degraded === true);
  }

  console.log('--- a candidate in cooldown is skipped ---');
  {
    router.resetState();
    router.simulateOutcome(FREE_KEY, { healthy: false, exhaustedUntil: Date.now() + 5 * 60 * 1000, lastChecked: Date.now() });
    const p = prober({ [PAID_KEY]: { healthy: true } });
    const m = await router.selectModel({ probeFn: p });
    check('the cooling model is not probed', !p.calls.includes(FREE_KEY), p.calls.join(','));
    check('the next tier is used', !!m && m.key === PAID_KEY, JSON.stringify(m));
  }

  console.log('--- the office is not blinded when the ladder cannot be verified ---');
  {
    router.resetState();
    // Nothing probes healthy, but one candidate has served before.
    router.simulateOutcome(PAID_KEY, { healthy: false, served: 4, lastChecked: Date.now() - 60 * 1000, lastError: 'probe failed' });
    const p = prober({});
    const m = await router.selectModel({ probeFn: p });
    check('a model that served before is still offered', !!m, JSON.stringify(m));
    check('it is offered as unverified', m && m.unverified === true, JSON.stringify(m));
    check('the office is not left with no model', m !== null);
  }

  console.log('--- nothing can serve and nothing has served before ---');
  {
    router.resetState();
    const p = prober({});
    const m = await router.selectModel({ probeFn: p });
    check('the router reports that nothing can serve', m === null, JSON.stringify(m));
  }

  console.log('--- the probe budget is bounded ---');
  {
    check('the total probe budget is finite', router.PROBE_TOTAL_BUDGET_MS > 0 && router.PROBE_TOTAL_BUDGET_MS <= 5 * 60 * 1000,
      String(router.PROBE_TOTAL_BUDGET_MS));
    check('the trust window covers a burst of calls', router.HEALTH_TTL_MS >= 60 * 1000, String(router.HEALTH_TTL_MS));
    check('the trust window outlives one probe of the whole ladder', router.HEALTH_TTL_MS > router.PROBE_TOTAL_BUDGET_MS,
      `${router.HEALTH_TTL_MS} vs ${router.PROBE_TOTAL_BUDGET_MS}`);
  }

  console.log('--- a quota refusal exhausts the provider, not just the model ---');
  {
    router.resetState();
    const provider = FREE_KEY.split('/')[0];
    const refused = router.noteRefusal(FREE_KEY, 'Free usage limit reached. Connect a provider to keep going.');
    check('a quota refusal is recognised', refused === true);
    const st = router.status();
    const sameProvider = st.candidates.filter((c) => c.key.split('/')[0] === provider);
    check('every model on that provider is exhausted', sameProvider.length > 1 && sameProvider.every((c) => c.exhausted),
      JSON.stringify(sameProvider.map((c) => c.key + ':' + c.exhausted)));
    const other = st.candidates.filter((c) => c.key.split('/')[0] !== provider);
    check('the other provider is not exhausted', other.every((c) => !c.exhausted),
      JSON.stringify(other.map((c) => c.key + ':' + c.exhausted)));
    const p = prober({ [PAID_KEY]: { healthy: true } });
    const m = await router.selectModel({ probeFn: p });
    check('the dead provider is not probed', !p.calls.some((k) => k.split('/')[0] === provider), p.calls.join(','));
    check('the office falls through to the route that can serve', !!m && m.key === PAID_KEY, JSON.stringify(m));
  }

  console.log('--- a refusal that is not about quota does not exhaust the provider ---');
  {
    router.resetState();
    const provider = FREE_KEY.split('/')[0];
    const refused = router.noteRefusal(FREE_KEY, 'no response in time');
    check('a non-quota refusal is not a quota refusal', refused === false);
    const st = router.status();
    const sameProvider = st.candidates.filter((c) => c.key.split('/')[0] === provider);
    check('the provider is not exhausted by it', sameProvider.every((c) => !c.exhausted),
      JSON.stringify(sameProvider.map((c) => c.key + ':' + c.exhausted)));
  }

  console.log('--- the policy is the hierarchy the office documents ---');
  {
    check('there is a free tier', FREE.length > 0);
    check('there is a paid fallback', PAID.length > 0);
    check('the free tier is tried first in the policy order', FREE[0] !== PAID[0]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
