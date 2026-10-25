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

// The role token budget is one number with three homes: the code that
// enforces it (agency.js), the code that reports it (server.js) and the
// ratified document that states it. They drifted once — 2,000,000 enforced
// while 1,000,000 was reported — and the checker passed, because it compared
// the document against the number that happened to be enforced. It now
// compares all three against each other.
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const agencyDefault = agencySrc.match(/ROLE_TOKEN_BUDGET\s*=\s*Number\(process\.env\.AGENCY_ROLE_TOKEN_BUDGET\)\s*\|\|\s*([\d_]+)/);
const serverDefault = serverSrc.match(/roleTokenBudget:\s*(?:agency\.getRoleTokenBudget\(\)|([\d_]+))/);
check('the enforced role token budget is a single number in agency.js', !!agencyDefault);
check('server.js reads the role token budget from agency.js', !!serverDefault && !serverDefault[1],
  serverDefault && serverDefault[1] ? `server.js carries its own copy: ${serverDefault[1]}` : '');
if (agencyDefault) {
  const enforced = Number(agencyDefault[1].replace(/_/g, ''));
  check('the enforced role token budget is the one the office ratified', enforced === agency.ROLE_TOKEN_BUDGET,
    `agency.js ${enforced} vs ratified ${agency.ROLE_TOKEN_BUDGET}`);
  check('the SOP states the enforced role token budget',
    sop.includes(enforced.toLocaleString('en-US')) || sop.includes(String(enforced)));
}

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
console.log('\n== ratification markers present ==');
// The gate follows the documents' true state. It did not weaken: where it
// once asked for a DRAFT header, it now asks for a RATIFIED header *and*
// for the completed approval sheet and the ratification date, so a document
// cannot claim to be in force without the owner's signature being on it.
check('SOP is marked ratified', /Status:\s*RATIFIED/i.test(sop));
check('role guidelines are marked ratified', /Status:\s*RATIFIED/i.test(roles));
check('SOP has an owner approval sheet', /Owner approval/i.test(sop) && /Signature/i.test(sop));
check('role guidelines have an owner approval sheet', /Owner approval/i.test(roles) && /Signature/i.test(roles));
check('SOP records the owner approval and the ratification date',
  /\*\*Owner approval\*\*\s*\|\s*✅/.test(sop) && /\*\*Ratified on:\*\*\s*2026-10-26/.test(sop));
check('role guidelines record the owner approval and the ratification date',
  /\*\*Owner approval\*\*\s*\|\s*✅/.test(roles) && /\*\*Ratified on:\*\*\s*2026-10-26/.test(roles));

// ---------------------------------------------------------------------------
console.log('\n== cross-references resolve ==');
// Every SOP-x.y cited in the role guidelines must exist in the SOP.
// A section reference like "SOP §3.5.3" is also a valid pointer: it names a
// section heading rather than a numbered clause. Accept both forms, but
// require that a bare clause-shaped token resolves.
const cited = [...new Set([...roles.matchAll(/\bSOP-\d+(?:\.\d+)*/g)].map((m) => m[0]))];
const unresolved = cited.filter((c) => !sop.includes(c));
check(`all ${cited.length} SOP clause citations resolve`, unresolved.length === 0, unresolved.join(','));
// Section-style pointers (SOP §x.y) must name a real section heading.
const sectionRefs = [...new Set([...roles.matchAll(/SOP\s*§\s*(\d+(?:\.\d+)*)/g)].map((m) => m[1]))];
for (const ref of sectionRefs) {
  const heading = new RegExp(`^#{2,4}\\s*${ref.replace(/\./g, '\\.')}\\s+\\S`, 'm');
  check(`SOP section pointer §${ref} resolves to a heading`, heading.test(sop));
}

// Every invariant P1..P9 referenced must be DEFINED in the SOP — and defined
// as a row in the §3.4 invariant table, not merely mentioned in prose. A
// mention elsewhere (e.g. "*(Invariant P7.)*") does not define it.
const invariants = [...new Set([...roles.matchAll(/\bP[1-9]\b/g)].map((m) => m[0]))].sort();
const invariantBlock = sop.match(/###\s*3\.4\s+The nine pipeline invariants([\s\S]*?)###\s*3\.5/);
check('SOP has an invariant definition section', !!invariantBlock);
const undefinedInv = invariants.filter((p) => {
  if (!invariantBlock) return true;
  return !new RegExp(`^\\|\\s*\\*\\*${p}\\*\\*\\s*\\|`, 'm').test(invariantBlock[1]);
});
check(`all ${invariants.length} invariant references are defined as table rows in §3.4`,
  undefinedInv.length === 0, undefinedInv.join(','));
// The table must contain exactly the nine invariants, and no others.
if (invariantBlock) {
  const rowInv = [...invariantBlock[1].matchAll(/^\|\s*\*\*(P\d+)\*\*\s*\|/gm)].map((m) => m[1]);
  const expected = Array.from({ length: 9 }, (_, i) => `P${i + 1}`);
  const extra = rowInv.filter((p) => !expected.includes(p));
  const absent = expected.filter((p) => !rowInv.includes(p));
  check('invariant table contains no invented invariant', extra.length === 0, extra.join(','));
  check('invariant table contains all nine invariants', absent.length === 0, absent.join(','));
}

// ---------------------------------------------------------------------------
console.log('\n== pipeline stage machine ==');
// The SOP must define the full state machine, not just describe it. These are
// the elements that make the pipeline *controlled*: the status vocabulary, the
// legal transitions, the transition table, the error codes, and the API
// surface that enforces them.

// 3.5.1 — the seven project statuses.
const PROJECT_STATUSES = [
  'registered', 'triaged', 'planning', 'delivering', 'acceptance', 'done', 'cancelled',
];
check('SOP has a project status vocabulary section',
  /###\s*3\.5\.1\s+Project status vocabulary/.test(sop));
// The vocabulary must be a TABLE ROW, not merely a mention somewhere in the
// prose — a status dropped from the table but still mentioned in P1/P2 must
// be caught.
const statusVocabBlock = sop.match(/####\s*3\.5\.1\s+Project status vocabulary([\s\S]*?)####\s*3\.5\.2/);
check('project status vocabulary block located', !!statusVocabBlock);
for (const s of PROJECT_STATUSES) {
  const inVocab = statusVocabBlock
    ? new RegExp(`^\\|\\s*\`${s}\`\\s*\\|`, 'm').test(statusVocabBlock[1])
    : false;
  check(`SOP status vocabulary table defines "${s}"`, inVocab,
    `no table row for "${s}" in §3.5.1`);
  // And it must be mentioned in the SOP at all.
  check(`SOP mentions project status "${s}"`, new RegExp(`\`${s}\``).test(sop));
}
check('SOP states `active` is not a project status',
  /`active` is \*\*not\*\* a project status/i.test(sop));

// 3.5.2 / 3.5.3 — legal transitions and the transition table.
check('SOP has a legal transitions diagram',
  /####\s*3\.5\.2\s+Legal transitions/.test(sop));
check('SOP has a transition table',
  /####\s*3\.5\.3\s+Transition table/.test(sop));

// Every transition T1..T7 must exist in the SOP and in the transition table.
const TRANSITIONS = [
  { id: 'T1', from: 'registered', to: 'triaged' },
  { id: 'T2', from: 'triaged', to: 'planning' },
  { id: 'T3', from: 'planning', to: 'delivering' },
  { id: 'T4', from: 'delivering', to: 'acceptance' },
  { id: 'T5', from: 'acceptance', to: 'delivering' },
  { id: 'T6', from: 'acceptance', to: 'done' },
  { id: 'T7', from: 'any', to: 'cancelled' },
];
const transitionTable = sop.match(/####\s*3\.5\.3\s+Transition table([\s\S]*?)####\s*3\.5\.4/);
check('transition table block located', !!transitionTable);
for (const t of TRANSITIONS) {
  check(`SOP defines transition ${t.id}`, sop.includes(`**${t.id}**`) || sop.includes(`| ${t.id} |`),
    `no ${t.id} in SOP`);
  if (transitionTable) {
    const row = transitionTable[1].split('\n').find((l) => l.trim().startsWith(`| ${t.id} `));
    check(`transition table has a row for ${t.id}`, !!row);
    if (row) {
      check(`${t.id} row names its from-status (${t.from})`, row.includes(`\`${t.from}\``), row);
      check(`${t.id} row names its to-status (${t.to})`, row.includes(`\`${t.to}\``), row);
      // Each row must name a trigger, an initiator, a precondition and an enforcer.
      const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
      check(`${t.id} row has trigger, initiator, precondition and enforcer`, cells.length >= 6,
        `${cells.length} cells: ${cells.join(' | ')}`);
    }
  }
}
// The transition table must not contain an undefined transition id.
if (transitionTable) {
  const rowIds = [...transitionTable[1].matchAll(/^\|\s*(T\d+)\s*\|/gm)].map((m) => m[1]);
  const known = TRANSITIONS.map((t) => t.id);
  const unknown = rowIds.filter((id) => !known.includes(id));
  check('transition table contains no undefined transition id', unknown.length === 0, unknown.join(','));
  const missing = known.filter((id) => !rowIds.includes(id));
  check('transition table contains every defined transition', missing.length === 0, missing.join(','));
}

// 3.5.5 — the nine transition error codes.
const ERROR_CODES = [
  'project_not_registered', 'no_acceptance_criteria', 'criterion_not_falsifiable',
  'illegal_project_transition', 'acceptance_not_met', 'criterion_unverified',
  'self_acceptance', 'acceptor_not_authorised', 'missing_deliverable',
];
check('SOP has a transition error codes section',
  /####\s*3\.5\.5\s+Transition error codes/.test(sop));
// Each code must be a TABLE ROW in §3.5.5, not merely mentioned in prose.
const errorCodeBlock = sop.match(/####\s*3\.5\.5\s+Transition error codes([\s\S]*?)####\s*3\.5\.6/);
check('transition error code block located', !!errorCodeBlock);
for (const code of ERROR_CODES) {
  const inTable = errorCodeBlock
    ? new RegExp(`^\\|\\s*\`${code}\`\\s*\\|`, 'm').test(errorCodeBlock[1])
    : false;
  check(`SOP error code table defines "${code}"`, inTable,
    `no table row for "${code}" in §3.5.5`);
}
// No code table row may name a code outside the known set.
if (errorCodeBlock) {
  const rowCodes = [...errorCodeBlock[1].matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)].map((m) => m[1]);
  const unknown = rowCodes.filter((c) => !ERROR_CODES.includes(c));
  check('SOP error code table contains no undefined code', unknown.length === 0, unknown.join(','));
}

// 3.5.4 — the verify step inside Acceptance.
check('SOP has a verify-step section', /####\s*3\.5\.4\s+The `verify` step inside Acceptance/.test(sop));
// Prose wraps across lines, so match against whitespace-normalised text.
const sopFlatAll = sop.replace(/\s+/g, ' ');
check('SOP states verification precedes the acceptance decision',
  /Verification \*\*MUST\*\* be complete before the decision/i.test(sopFlatAll));
check('SOP states verification is performed by a role other than the deliverer',
  /verification has been performed by a role other than the one that produced the delivery/i.test(sopFlatAll));

// 11A — the endpoint-to-transition mapping.
check('SOP has an API surface section', /##\s*11A\.\s+The pipeline's API surface/.test(sop));
const apiBlock = sop.match(/##\s*11A\.[\s\S]*?(?=\n##\s+12\.)/);
check('API surface block located', !!apiBlock);
if (apiBlock) {
  // Every transition must be reachable through a named endpoint. An endpoint
  // row may serve two transitions ("T3, T4"), so match the whole cell.
  for (const t of TRANSITIONS) {
    const cell = new RegExp(`\\|\\s*(?:[A-Z]\\d+,\\s*)*${t.id}(?:\\s*,|\\s*\\|)`, 'm');
    check(`API surface maps a transition for ${t.id}`, cell.test(apiBlock[0]),
      `no endpoint row references ${t.id}`);
  }
  // Each stage endpoint must be present.
  for (const p of ['triage', 'plan', 'deliver', 'verify', 'accept', 'ratify', 'cancel']) {
    check(`API surface has a /${p} endpoint`, apiBlock[0].includes(`/${p}`));
  }
  // Read endpoints named by SOP-11A.2 / 11A.3.
  for (const p of ['/api/agency/project/:id', '/api/agency/projects', '/api/agency/timeline']) {
    check(`API surface names ${p}`, apiBlock[0].includes(p));
  }
  check('API surface forbids direct status writes',
    /No other route, no direct state write/.test(sop));
}

// ---------------------------------------------------------------------------
console.log('\n== role guidelines cover pipeline stage transitions ==');
// The roles that own transitions must have a procedure for them, and must
// name the transitions they own.
const stageOwners = [
  { name: 'Orchestrator', owns: ['T2', 'T3', 'T4', 'T7'] },
  { name: 'Product Owner', owns: ['T1', 'T5', 'T6', 'T7'] },
];
for (const owner of stageOwners) {
  const sec = sections.find((s) => s.includes(`— \`${owner.name === 'Orchestrator'
    ? 'orchestrator_lead' : 'product_owner_product_manager'}\``));
  check(`role guidelines have a section for ${owner.name}`, !!sec);
  if (!sec) continue;
  for (const t of owner.owns) {
    check(`${owner.name} names transition ${t}`, new RegExp(`\\b${t}\\b`).test(sec),
      `${t} not mentioned in ${owner.name} section`);
  }
  check(`${owner.name} has a stage-transition procedure`,
    /Moving a project through its stages/i.test(sec));
  // A role must not claim to own another role's transitions. A mention inside a
  // prohibition ("MUST NOT perform T1") or a consultation note ("Consult: the
  // PO on ... T1") is correct, not a claim. Only an AFFIRMATIVE ownership
  // statement counts as a claim.
  // Prose wraps, so the prohibition and the verb it governs can sit on
  // different lines — normalise to one line before matching.
  const notOwn = owner.name === 'Orchestrator'
    ? ['T1', 'T5', 'T6']
    : ['T2', 'T3', 'T4'];
  const secLines = sec.replace(/\s+/g, ' ').split(/(?<=\.)\s+/);
  for (const t of notOwn) {
    const claim = new RegExp(
      `(?:owns?|owned by|performs?|initiates?|drives?)[^.]{0,80}\\b${t}\\b`, 'i');
    const offending = secLines.filter((line) => {
      if (!claim.test(line)) return false;
      if (/MUST NOT|not the |belong to|Consult|consult/i.test(line)) return false;
      return true;
    });
    check(`${owner.name} does not claim ${t}`, offending.length === 0, offending.join(' / '));
  }
}

// QA owns the verify step and must not accept.
const qaSec = sections.find((s) => s.includes('— `quality_assurance`'));
check('role guidelines have a section for QA', !!qaSec);
if (qaSec) {
  check('QA owns the verify step', /verif/i.test(qaSec));
  // QA produces a verdict and does not accept — either the "MUST NOT accept"
  // form or the plain "QA does not accept" statement satisfies this.
  check('QA states it does not accept',
    /MUST NOT accept/i.test(qaSec) || /QA does not accept/i.test(qaSec));
}

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
