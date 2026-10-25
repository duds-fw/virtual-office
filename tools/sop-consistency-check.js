'use strict';
/**
 * SOP / role-guidelines consistency check.
 *
 * Two documents describe the office. The code is the mechanism. If the two
 * disagree, the documents are wrong — an agent following a stale document
 * will do the wrong thing, and the office's own rule is that the code wins
 * (SOP-15.4).
 *
 * This check makes that disagreement loud instead of silent. It reads the
 * real values out of agency.js and asserts the documents match. It is
 * deliberately cheap and deliberately mechanical: it checks *facts*, not
 * prose quality.
 *
 * Run: node tools/sop-consistency-check.js
 */
const fs = require('fs');
const path = require('path');
const agency = require('../agency');

let pass = 0;
let fail = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else {
    fail++;
    failures.push(`${label}${detail ? ' :: ' + detail : ''}`);
    console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
  }
}

const ROOT = path.join(__dirname, '..');
const SOP = path.join(ROOT, 'docs', 'sop-virtual-office.md');
const ROLES = path.join(ROOT, 'docs', 'role-guidelines.md');

// agency.js does not export STATUSES, and this check must not change
// production code to serve a test. Read the authoritative list from source
// instead, and fail loudly if the source shape changes.
const agencySrc = fs.readFileSync(path.join(ROOT, 'agency.js'), 'utf8');
const statusMatch = agencySrc.match(/const\s+STATUSES\s*=\s*\[([^\]]+)\]/);
const STATUSES = statusMatch
  ? [...statusMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  : [];

function readOrSkip(p, label) {
  if (!fs.existsSync(p)) {
    fail++;
    failures.push(`${label} missing: ${p}`);
    console.log(`  FAIL  ${label} exists :: ${p} not found`);
    return null;
  }
  pass++;
  console.log(`  PASS  ${label} exists`);
  return fs.readFileSync(p, 'utf8');
}

console.log('\n== documents present ==');
const sop = readOrSkip(SOP, 'SOP document');
const roles = readOrSkip(ROLES, 'role guidelines document');
if (!sop || !roles) {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
console.log('\n== every roster role has a section ==');
for (const a of agency.ROSTER) {
  // Section heading contains the role's display name, e.g. "R-07 · Software Engineer".
  const re = new RegExp(`R-\\d+\\s*·[^\\n]*${a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  check(`section exists for ${a.name} (${a.matrixRole})`, re.test(roles));
}

// Every role id must appear exactly once as a section heading.
const headings = [...roles.matchAll(/^###\s+(R-\d+)\s*·\s*([^\n—]+?)\s*—/gm)].map((m) => ({
  id: m[1], name: m[2].trim(),
}));
check(`17 role sections present (found ${headings.length})`, headings.length === agency.ROSTER.length);
const ids = headings.map((h) => h.id);
check('no duplicate role section ids', new Set(ids).size === ids.length, ids.join(','));
const rosterNames = agency.ROSTER.map((a) => a.name);
const headingNames = headings.map((h) => h.name);
check('every roster name has a heading and no heading is extra',
  rosterNames.every((n) => headingNames.includes(n)) && headingNames.every((n) => rosterNames.includes(n)),
  `roster=[${rosterNames.join('|')}] headings=[${headingNames.join('|')}]`);

// ---------------------------------------------------------------------------
console.log('\n== phase eligibility matches the code ==');
// Each role section states its eligibility in "#### 3. Phase eligibility".
// The check is POSITIVE: the phases the guideline claims must be exactly the
// phases the code allows — no more, no fewer. A negative check (looking for
// forbidden claims) misses a bare "**Design** and **Review**".
const sections = roles.split(/^###\s+R-\d+/m).slice(1);
for (const a of agency.ROSTER) {
  const sec = sections.find((s) => s.includes(`— \`${a.matrixRole}\``));
  if (!sec) { check(`eligibility section found for ${a.name}`, false); continue; }
  const m = sec.match(/####\s*3\.\s*Phase eligibility\s*\n+([\s\S]*?)\n####/);
  if (!m) { check(`eligibility paragraph found for ${a.name}`, false); continue; }
  const text = m[1];

  // Phases the code allows.
  const allowed = a.phases;
  const allPhases = allowed.length === agency.PHASES.length;

  // Phases the guideline claims. "all 7 phases" means every phase.
  const claimed = new Set();
  if (/all\s+7\s+phases/i.test(text)) {
    for (const p of agency.PHASES) claimed.add(p);
  } else {
    for (const p of agency.PHASES) {
      if (new RegExp(`\\b${p}\\b`).test(text)) claimed.add(p);
    }
  }

  // Only a phase the code allows may be claimed.
  const forbidden = [...claimed].filter((p) => !allowed.includes(p));
  check(`${a.name} claims no phase the code forbids`,
    forbidden.length === 0,
    `code allows [${allowed.join(', ')}] but guideline claims [${[...claimed].join(', ')}]`);

  // Every phase the code allows must be stated.
  const missing = allowed.filter((p) => !claimed.has(p));
  check(`${a.name} states every phase the code allows`,
    missing.length === 0,
    `missing [${missing.join(', ')}]`);

  // "all 7 phases" is only correct for a role the code allows everywhere.
  if (allPhases) {
    check(`${a.name} may say "all 7 phases"`, /all\s+7\s+phases/i.test(text));
  }
}

// ---------------------------------------------------------------------------
console.log('\n== status vocabulary ==');
check('STATUSES was found in agency.js source', STATUSES.length > 0);
for (const s of STATUSES) {
  check(`SOP mentions status "${s}"`, new RegExp(`\\b${s}\\b`).test(sop));
}

const statusBlock = sop.match(/#### 4\.2[\s\S]*?#### 4\.3/);
if (statusBlock) {
  const listed = [...statusBlock[0].matchAll(/`(\w+)`/g)].map((m) => m[1]);
  const unknown = listed.filter((x) => !STATUSES.includes(x) && !x.includes('_'));
  check('SOP status table lists only real statuses', unknown.length === 0, unknown.join(','));
}

// ---------------------------------------------------------------------------
console.log('\n== gates ==');
const gateIds = Object.values(agency.GATES).map((g) => g.id);
for (const gid of gateIds) {
  check(`SOP mentions gate "${gid}"`, sop.includes(`\`${gid}\``));
  check(`role guidelines mention gate "${gid}"`, roles.includes(`\`${gid}\``));
}
for (const [phase, g] of Object.entries(agency.GATES)) {
  check(`SOP states "${g.label}" belongs to ${phase}`, sop.includes(g.label) && sop.includes(phase));
  for (const r of g.approverRoles) {
    check(`SOP lists approver role ${r} for ${g.id}`, sop.includes(`\`${r}\``));
  }
}
// Any backticked identifier that looks like a gate id must be a real gate.
// The code's gates are the only ones that exist; a document naming a gate the
// code does not have describes a control that cannot be enforced.
// The pattern allows any snake_case id ending in a gate-like suffix, so
// "design_review_gate" is caught as well as "design_review".
const gateLike = /`([a-z][a-z0-9_]*(?:_approval|_signoff|_gate))`/g;
const docsGateLike = [...new Set([
  ...sop.matchAll(gateLike),
  ...roles.matchAll(gateLike),
].map((m) => m[1]))];
const bogusGates = docsGateLike.filter((g) => !gateIds.includes(g));
check(`no document names a gate the code does not have`, bogusGates.length === 0,
  `bogus=[${bogusGates.join(', ')}] real=[${gateIds.join(', ')}]`);

// ---------------------------------------------------------------------------
console.log('\n== escalation path ==');
agency.ESCALATION_PATH.forEach((e, i) => {
  check(`SOP mentions L${i + 1} owner "${e.owner}"`, sop.includes(e.owner));
  check(`SOP mentions L${i + 1} matrixRole ${e.matrixRole}`, sop.includes(`\`${e.matrixRole}\``));
});
check('SOP does not invent a 4th escalation level',
  !/\bL4\b/.test(sop) && !/level 4|four levels/i.test(sop));

// ---------------------------------------------------------------------------
console.log('\n== capacity and token budget ==');
for (const a of agency.ROSTER) {
  // The role section's roster line states the code's capacity, e.g.
  // "**Roster:** capacity 40 h/sprint · eligible in all 7 phases".
  // The heading and the roster line may wrap across lines, so match the
  // capacity figure within the section rather than on one line.
  const sec = sections.find((s) => s.includes(`— \`${a.matrixRole}\``));
  if (!sec) { check(`capacity line found for ${a.name}`, false); continue; }
  const capRe = new RegExp(`capacity\\s+${a.capacityHours}\\s*h\\s*/\\s*sprint`);
  check(`guideline states ${a.name} capacity ${a.capacityHours}h/sprint`, capRe.test(sec));
}
check(`SOP states the token budget ${agency.ROLE_TOKEN_BUDGET.toLocaleString('en-US')}`,
  sop.includes(agency.ROLE_TOKEN_BUDGET.toLocaleString('en-US')) || sop.includes(String(agency.ROLE_TOKEN_BUDGET)));

// ---------------------------------------------------------------------------
console.log('\n== RACI is reproduced from the owner decision ==');
const raciRows = ['Registration', 'Triage', 'Planning', 'Delivery', 'Acceptance', 'Done'];
for (const stage of raciRows) {
  check(`SOP RACI covers stage "${stage}"`, new RegExp(`^\\|\\s*${stage}`, 'm').test(sop));
}
check('SOP assigns cross-project timeline to the Orchestrator',
  /Cross-project delivery timeline[^|]*\|\s*Orchestrator/i.test(sop));
check('SOP states the owner ratifies only on scope/budget/risk change',
  /ratification[^]*?scope[^]*?budget[^]*?risk/i.test(sop));

// ---------------------------------------------------------------------------
console.log('\n== no false compliance claims ==');
// A disclaimer ("this office is not certified to any standard") is required,
// not a violation. Only a CLAIM is a failure. Strip disclaimers before
// scanning, so the check catches claims without flagging the denial.
function stripDisclaimers(text) {
  return text
    .replace(/not\s+certified\s+to\s+any\s+standard/gi, '')
    .replace(/is\s+\*\*not\*\*[\s\S]{0,200}?certified/gi, '')
    .replace(/certified\s+ISMS/gi, '')
    .replace(/certification\s+or\s+conformity\s+claim/gi, '')
    .replace(/AIMS\s+certification/gi, '')
    .replace(/not\s+be\s+described\s+as\s+such/gi, '');
}
const claimScan = stripDisclaimers(sop) + '\n' + stripDisclaimers(roles);
const forbidden = [
  { re: /ISO[^.]{0,40}\bcompliant\b/i, label: 'ISO compliant' },
  { re: /\bISO 27001 compliant\b/i, label: 'ISO 27001 compliant' },
  { re: /\bfully compliant\b/i, label: 'fully compliant' },
  { re: /\baudit-?ready\b/i, label: 'audit-ready' },
  { re: /\bGDPR compliant\b/i, label: 'GDPR compliant' },
  { re: /\bSOC 2 compliant\b/i, label: 'SOC 2 compliant' },
  // A bare "is certified" / "are certified" is a claim.
  { re: /\b(?:is|are|has been|have been)\s+certified\b/i, label: 'is/are certified' },
];
for (const { re, label } of forbidden) {
  check(`no false compliance claim: ${label}`, !re.test(claimScan),
    (claimScan.match(re) || [])[0]);
}
// The SOP must affirmatively disclaim certification.
check('SOP explicitly disclaims certification', /not certified to any standard/i.test(sop));
// And it must name the standards it is NOT claiming, so the reader is not left guessing.
// The disclaimer may wrap across lines, so match against whitespace-normalised text.
// The named standards follow the disclaimer sentence, so use a window rather than
// a single sentence.
const sopFlat = sop.replace(/\s+/g, ' ');
const discWindow = sopFlat.match(/This office is not certified to any standard\.[^§]{0,300}/i);
check('SOP has a non-claims disclaimer sentence', !!discWindow);
for (const s of ['ISO 9001', 'ISO/IEC 27001', 'ISO/IEC 42001', 'SOC 2', 'ITIL', 'COBIT']) {
  check(`SOP disclaims "${s}" explicitly`, !!discWindow && discWindow[0].includes(s),
    discWindow ? 'not in disclaimer window' : 'no disclaimer found');
}

// ---------------------------------------------------------------------------
console.log('\n== draft markers present ==');
check('SOP is marked draft', /Status:\s*DRAFT/i.test(sop));
check('role guidelines are marked draft', /Status:\s*DRAFT/i.test(roles));
check('SOP has an owner approval sheet', /Owner approval/i.test(sop) && /Signature/i.test(sop));
check('role guidelines have an owner approval sheet', /Owner approval/i.test(roles) && /Signature/i.test(roles));

// ---------------------------------------------------------------------------
console.log('\n== cross-references resolve ==');
// Every SOP-x.y cited in the role guidelines must exist in the SOP.
const cited = [...new Set([...roles.matchAll(/SOP-\d+(?:\.\d+)*/g)].map((m) => m[0]))];
const unresolved = cited.filter((c) => !sop.includes(c));
check(`all ${cited.length} SOP clause citations resolve`, unresolved.length === 0, unresolved.join(','));

// Every invariant P1..P9 referenced must be defined in the SOP.
const invariants = [...new Set([...roles.matchAll(/\bP[1-9]\b/g)].map((m) => m[0]))].sort();
const undefinedInv = invariants.filter((p) => !new RegExp(`\\*\\*${p}\\*\\*`).test(sop) && !sop.includes(`(${p})`) && !sop.includes(` ${p} `));
check(`all ${invariants.length} invariant references are defined in the SOP`, undefinedInv.length === 0, undefinedInv.join(','));

// ---------------------------------------------------------------------------
console.log('\n== no role invents a board field ==');
// Fields the code actually has, versus fields the pipeline design introduces.
const shippedFields = [
  'estimateHours', 'role', 'phase', 'status', 'gates', 'blockedReason',
  'ownerId', 'projectId', 'sprintId', 'budgetHours', 'capacityHours',
];
for (const f of shippedFields) {
  // If a doc uses it, it should be marked or at least present in the code.
  if (roles.includes(f) || sop.includes(f)) {
    check(`field "${f}" exists in agency.js`, fs.readFileSync(path.join(ROOT, 'agency.js'), 'utf8').includes(f));
  }
}
// Designed-only fields must be marked [designed] wherever they appear.
const designedFields = ['acceptanceCriteria', 'deliverable', 'acceptedBy', 'ratified'];
for (const f of designedFields) {
  const inSop = sop.includes(f);
  const inRoles = roles.includes(f);
  if (!inSop && !inRoles) continue;
  const marked = new RegExp(`\[designed\\][^\\n]*${f}|${f}[^\\n]*\\[designed\\]|${f}[^\\n]*designed`).test(sop + '\n' + roles);
  check(`designed-only field "${f}" is marked as designed`, marked);
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail ? 1 : 0);
