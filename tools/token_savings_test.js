'use strict';
/**
 * Verifies that the savings report reads RTK's real numbers.
 *
 * RTK prints compact magnitudes — "Tokens saved: 5.7K (37.7%)" — not plain
 * integers. The parser expected digits alone, so it read them as no number
 * at all and the office reported zero tokens saved while RTK had in fact
 * saved thousands. The report is how the owner sees whether the optimisation
 * layer earns its keep, so it has to read the real figures.
 *
 *   AC1  compact magnitudes parse to the number they stand for
 *   AC2  the summary totals parse, not just the per-command rows
 *   AC3  the largest saver is not lost to a NaN sort
 *   AC4  plain integers still parse — the old format keeps working
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const savings = require(path.join(ROOT, 'token-savings.js'));

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
}

// AC1 — the conversion itself.
check('a plain integer is itself', savings.parseCompact('807') === 807);
check('5.7K is 5700', savings.parseCompact('5.7K') === 5700);
check('1.2M is 1200000', savings.parseCompact('1.2M') === 1200000);
check('2K is 2000', savings.parseCompact('2K') === 2000);
check('a lowercase suffix is accepted', savings.parseCompact('3.4k') === 3400);
check('a spaced suffix is accepted', savings.parseCompact('5.7 K') === 5700);
check('nonsense is zero, not NaN', savings.parseCompact('abc') === 0);
check('an empty value is zero', savings.parseCompact('') === 0);

// AC2 — the summary block, in the format RTK actually prints.
const live = `RTK Token Savings (Global Scope)
════════════════════════════════════════════════════════════

Total commands:    82
Input tokens:      15.1K
Output tokens:     9.4K
Tokens saved:      5.7K (37.7%)
Total exec time:   552ms (avg 6ms)

By Command
───────────────────────────────────────────────────────────────────────
  #  Command                   Count  Saved  Total%    Time  Impact
───────────────────────────────────────────────────────────────────────
 1.  rtk grep                     25   2.1K   28.6%     9ms  ██████████
 2.  rtk ls -la                    4    807   63.8%     6ms  ████░░░░░░
 3.  rtk ls -1                     1    202   71.4%     4ms  █░░░░░░░░░
`;
const parsed = savings.parseRtkGain(live);
check('the command count is read', parsed.commands === 82, String(parsed.commands));
check('the saved total is read, not zero', parsed.tokensSaved === 5700, String(parsed.tokensSaved));
check('the saved percent is read', parsed.percent === 37.7, String(parsed.percent));
check('the input tokens are read', parsed.inputTokens === 15100, String(parsed.inputTokens));
check('the output tokens are read', parsed.outputTokens === 9400, String(parsed.outputTokens));
check('every per-command row is read', parsed.byCommand.length === 3, String(parsed.byCommand.length));

// AC3 — the biggest saver must be first, and must not be NaN.
check('the largest saver sorts first', parsed.byCommand[0].command === 'rtk grep', parsed.byCommand[0].command);
check('the largest saver has a number, not NaN', Number.isFinite(parsed.byCommand[0].saved), String(parsed.byCommand[0].saved));
check('the largest saver is 2.1K', parsed.byCommand[0].saved === 2100, String(parsed.byCommand[0].saved));

// AC4 — the plain-integer format still parses.
const plain = `Total commands:    10
Input tokens:      1000
Output tokens:     500
Tokens saved:      250 (20.0%)
 1.  rtk ls                        2    100   50.0%     1ms  ████░░░░░░
`;
const parsedPlain = savings.parseRtkGain(plain);
check('plain integers still parse', parsedPlain.tokensSaved === 250, String(parsedPlain.tokensSaved));
check('plain rows still parse', parsedPlain.byCommand.length === 1 && parsedPlain.byCommand[0].saved === 100, JSON.stringify(parsedPlain.byCommand));

// An empty or broken output must not produce NaN anywhere.
const empty = savings.parseRtkGain('');
check('empty output is zero, not NaN', empty.tokensSaved === 0 && empty.commands === 0);
check('empty output has no rows', empty.byCommand.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
