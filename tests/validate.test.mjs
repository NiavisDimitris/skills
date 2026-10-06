import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  inferType,
  isAbsoluteUri,
  isRfc3339Date,
  isRfc3339DateTime,
  loadSchema,
  validateAgainstSchema,
  validateConfig,
  validateReport,
  validateStateMatrix,
  isGateIssue,
} from '../skills/design-qa/scripts/lib/schema-check.mjs';
import { computeScorecard, isLoopClosed, rankFindings } from '../skills/design-qa/scripts/lib/ranking.mjs';
import { applyTriage, buildTriage } from '../skills/design-qa/scripts/lib/triage.mjs';
import { ROOT, fixture, loadFixture, run, script, tmpDir } from './_helpers.mjs';

const VALIDATE = script('validate.mjs');
/**
 * The fixtures are hand-assembled test reports: scripts run by the tests skip build
 * verification (tests/_helpers.mjs), and say so on stderr. Every other rule passes.
 */
function onlyBuildErrors(res) {
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /design-qa: TEST MODE: build verification skipped \(DESIGN_QA_TEST_SKIP_BUILD_VERIFY=1\)/);
}

function errorsOf(report, opts) {
  return validateReport(report, opts).errors.map((e) => `${e.path}: ${e.message}`);
}

function expectError(report, pattern, opts) {
  const errors = errorsOf(report, opts);
  assert.ok(errors.some((e) => pattern.test(e)), `expected an error matching ${pattern}, got:\n${errors.join('\n')}`);
}

test('the fixture report is valid', () => {
  const result = validateReport(loadFixture('report-valid.json'));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.valid, true);
});

test('keys whose value may be null can be omitted', () => {
  const r = loadFixture('report-valid.json');
  delete r.findings[0].knownDrift;
  delete r.findings[0].rank;
  delete r.findings[1].fix.patchHint;
  delete r.stateMatrix[0].note;
  delete r.meta.ticket;
  delete r.scorecard.pixelDiff.hover.image;
  assert.deepEqual(errorsOf(r), []);
});

test('missing required keys are reported with their path', () => {
  const r = loadFixture('report-valid.json');
  delete r.findings[3].ledger;
  delete r.stateMatrix[0].result;
  delete r.meta.figma.frame;
  expectError(r, /^findings\[3\]\.ledger: required key is missing$/);
  expectError(r, /^stateMatrix\[0\]\.result: required key is missing$/);
  expectError(r, /^meta\.figma\.frame: required key is missing$/);
});

test('enum violations list the allowed values', () => {
  const r = loadFixture('report-valid.json');
  r.findings[3].severity = 'CRITICAL';
  r.stateMatrix[1].result = 'OK';
  r.meta.mode = 'review';
  expectError(r, /^findings\[3\]\.severity: expected one of BLOCKER, WARNING, PASS, CANNOT_VERIFY, DS_CANDIDATE \(got "CRITICAL"\)$/);
  expectError(r, /^stateMatrix\[1\]\.result: expected one of PASS, FAIL, CANNOT_VERIFY, MISSING_IN_CODE, NOT_SPECIFIED \(got "OK"\)$/);
  expectError(r, /^meta\.mode: expected one of audit, fix, ci \(got "review"\)$/);
});

test('types, patterns, ranges and formats', () => {
  const r = loadFixture('report-valid.json');
  r.findings[0].id = 'DQ-1';
  r.scorecard.match = 120;
  r.findings[1].fix.effort = 9;
  r.meta.generatedAt = 'yesterday';
  r.meta.app.viewport.width = '1440';
  r.meta.app.url = 'localhost:3000';
  expectError(r, /^findings\[0\]\.id: must match \^DQ-\\d\{3,\}\$ \(got "DQ-1"\)$/);
  expectError(r, /^scorecard\.match: must be <= 100 \(got 120\)$/);
  expectError(r, /^findings\[1\]\.fix\.effort: must be <= 5/);
  expectError(r, /^meta\.generatedAt: expected an ISO-8601 date-time/);
  expectError(r, /^meta\.app\.viewport\.width: expected integer, got "1440"$/);
  expectError(r, /^meta\.app\.url: expected an absolute URL/);
});

test('finding ids must be unique', () => {
  const r = loadFixture('report-valid.json');
  r.findings[4].id = 'DQ-002';
  expectError(r, /^findings\[4\]\.id: duplicate id "DQ-002" \(first used at findings\[1\]\)$/);
});

test('every reference must point at an existing finding', () => {
  const r = loadFixture('report-valid.json');
  r.ledgers.style[0].findingIds.push('DQ-099');
  r.stateMatrix[0].findings.push('DQ-098');
  r.openDecisions[0].relatedFindings = ['DQ-097'];
  r.fixLoop[0].findingIds = ['DQ-096'];
  expectError(r, /^ledgers\.style\[0\]\.findingIds\[1\]: references unknown finding "DQ-099"$/);
  expectError(r, /^stateMatrix\[0\]\.findings\[5\]: references unknown finding "DQ-098"$/);
  expectError(r, /^openDecisions\[0\]\.relatedFindings\[0\]: references unknown finding "DQ-097"$/);
  expectError(r, /^fixLoop\[0\]\.findingIds\[0\]: references unknown finding "DQ-096"$/);
});

test('severity PASS / CANNOT_VERIFY require resolution NONE', () => {
  const r = loadFixture('report-valid.json');
  r.findings[4].resolution = 'FIX_CODE'; // DQ-005 PASS
  r.findings[5].resolution = 'DATA'; // DQ-006 CANNOT_VERIFY
  expectError(r, /^findings\[4\]\.resolution: must be NONE when severity is PASS or CANNOT_VERIFY \(got "FIX_CODE"\)$/, { skipScorecard: true });
  expectError(r, /^findings\[5\]\.resolution: must be NONE when severity is PASS or CANNOT_VERIFY \(got "DATA"\)$/, { skipScorecard: true });
});

test('severity BLOCKER / WARNING / DS_CANDIDATE forbid resolution NONE', () => {
  const r = loadFixture('report-valid.json');
  r.findings[0].resolution = 'NONE';
  r.findings[3].resolution = 'NONE';
  expectError(r, /^findings\[0\]\.resolution: must not be NONE when severity is BLOCKER, WARNING or DS_CANDIDATE/, { skipScorecard: true });
  expectError(r, /^findings\[3\]\.resolution: must not be NONE/, { skipScorecard: true });
});

test('scorecard values must equal the derived ones', () => {
  const r = loadFixture('report-valid.json');
  r.scorecard.parity = 80;
  r.scorecard.match = 80;
  r.scorecard.verdict = 'REVIEW';
  r.scorecard.bySeverity.WARNING = 2;
  r.scorecard.byResolution.NONE = 1;
  r.scorecard.stateCoverage.verified = 5;
  r.scorecard.pixelDiff.empty.band = 'review';
  expectError(r, /^scorecard\.parity: scorecard\.parity was removed: match and settled replace it/);
  expectError(r, /^scorecard\.match: expected 73 \(the mean of matchByState/);
  expectError(r, /^scorecard\.verdict: expected FAIL \(DQ-001 is an open BLOCKER/);
  expectError(r, /^scorecard\.bySeverity\.WARNING: expected 5 \(counted from findings\[\]\.severity\), got 2$/);
  expectError(r, /^scorecard\.byResolution\.NONE: expected 2/);
  expectError(r, /^scorecard\.stateCoverage\.verified: expected 3/);
  expectError(r, /^scorecard\.pixelDiff\.empty\.band: expected "fail" for 7\.2% \(pass < 1, review <= 5\), got "review"$/);
});

test('scorecard 2.0: dismissed and designSystem are required and derived', () => {
  const r = loadFixture('report-valid.json');
  r.scorecard.dismissed = 0;
  r.scorecard.designSystem = { tokens: 1, components: 1, motion: 0 };
  expectError(r, /^scorecard\.dismissed: expected 1 \(findings with resolution DISMISSED\), got 0$/);
  expectError(r, /^scorecard\.designSystem\.tokens: expected 2 \(open style findings with an expected token the code does not use\), got 1$/);
  expectError(r, /^scorecard\.designSystem\.motion: expected 1 \(open motion findings\), got 0$/);
  assert.ok(!errorsOf(r).some((e) => e.startsWith('scorecard.designSystem.components')));

  const missing = loadFixture('report-valid.json');
  for (const k of ['unexplained', 'debt', 'loopClosed', 'dismissed', 'designSystem']) delete missing.scorecard[k];
  for (const k of ['unexplained', 'debt', 'loopClosed', 'dismissed', 'designSystem']) {
    expectError(missing, new RegExp(`^scorecard\\.${k}: required key is missing$`));
  }
});

test('pixel-diff bands follow configured tolerances', () => {
  const r = loadFixture('report-valid.json');
  const config = { tolerances: { pixelDiff: { pass: 0.1, review: 0.3 } } };
  expectError(r, /^scorecard\.pixelDiff\["with-data"\]\.band: expected "fail" for 0\.4% \(pass < 0\.1, review <= 0\.3\), got "pass"$/, { config });
});

test('unknown keys are warnings, not errors', () => {
  const r = loadFixture('report-valid.json');
  r.meta.notes = 'hello';
  r.findings[0].extra = true;
  r.$schema = './report.schema.json';
  const result = validateReport(r);
  assert.equal(result.valid, true);
  assert.deepEqual(
    result.warnings.map((w) => w.path),
    ['meta.notes', 'findings[0].extra'],
  );
});

test('rank buckets: only FIX_CODE fills fix-now/debt; everything else is none (errors)', () => {
  const ranked = () => {
    const r = loadFixture('report-valid.json');
    r.findings = rankFindings(r.findings);
    return r;
  };
  assert.deepEqual(errorsOf(ranked()), [], 'ranks from rankFindings are valid');

  const fixInNone = ranked();
  fixInNone.findings[1].rank = { score: 225, bucket: 'none' }; // DQ-002 is FIX_CODE
  expectError(fixInNone, /^findings\[1\]\.rank\.bucket: must be "fix-now" or "debt" for a FIX_CODE finding with severity BLOCKER, WARNING or DS_CANDIDATE \(got "none"\)$/);

  const unrankedInDebt = ranked();
  unrankedInDebt.findings[4].rank = { score: 0, bucket: 'debt' }; // DQ-005 is PASS / NONE
  unrankedInDebt.findings[6].rank = { score: 0, bucket: 'fix-now' }; // DQ-007 is INTENTIONAL
  unrankedInDebt.findings[8].rank = { score: 225, bucket: 'fix-now' }; // DQ-009 is DISMISSED
  expectError(unrankedInDebt, /^findings\[4\]\.rank\.bucket: must be "none": only FIX_CODE findings with severity BLOCKER, WARNING or DS_CANDIDATE are ranked \(got "debt"\)$/);
  expectError(unrankedInDebt, /^findings\[6\]\.rank\.bucket: must be "none"/);
  expectError(unrankedInDebt, /^findings\[8\]\.rank\.bucket: must be "none"/);

  const unknownBucket = ranked();
  unknownBucket.findings[0].rank = { score: 334, bucket: 'later' };
  expectError(unknownBucket, /^findings\[0\]\.rank\.bucket: expected one of fix-now, debt, none \(got "later"\)$/);

  const sync = ranked();
  sync.findings[2].rank = { score: 233, bucket: 'sync-figma' };
  expectError(sync, /^findings\[2\]\.rank\.bucket: the sync-figma bucket was removed in 2\.0: FIX_CODE findings are fix-now or debt, everything else none$/);

  assert.equal(validateReport(unrankedInDebt, { skipRanks: true }).valid, true, 'skipRanks ignores ranks about to be recomputed');
});

test('a fix-now/debt split that differs from topN is a warning, not an error', () => {
  const r = loadFixture('report-valid.json');
  r.findings = rankFindings(r.findings, { topN: 1 }); // everything but DQ-001 lands in debt
  const result = validateReport(r); // default topN 5 puts all five FIX_CODE findings in fix-now
  assert.equal(result.valid, true);
  assert.deepEqual(
    result.warnings.map((w) => `${w.path}: ${w.message}`),
    [
      'findings[1].rank.bucket: is "debt" but the ranking rules give "fix-now" (score 225, topN 5)',
      'findings[2].rank.bucket: is "debt" but the ranking rules give "fix-now" (score 233, topN 5)',
      'findings[3].rank.bucket: is "debt" but the ranking rules give "fix-now" (score 123, topN 5)',
      'findings[7].rank.bucket: is "debt" but the ranking rules give "fix-now" (score 225, topN 5)',
    ],
  );
  assert.deepEqual(validateReport(r, { topN: 1 }).warnings, [], 'no warning with the same topN');
});

test('config: the fixture and the shipped example validate', () => {
  assert.deepEqual(validateConfig(loadFixture('config.json')).errors, []);
  const example = path.join(ROOT, 'examples', 'design-qa.config.example.json');
  if (existsSync(example)) {
    const result = validateConfig(JSON.parse(readFileSync(example, 'utf8')));
    assert.deepEqual(result.errors, [], 'examples/design-qa.config.example.json must validate');
  }
});

test('config: a preCapture selector is a string or { selector, states } scoped to some states', () => {
  const c = loadFixture('config.json');
  c.app.preCapture = { hide: ['.chat-widget', { selector: '.promo-banner', states: ['with-data', 'empty'] }], remove: [{ selector: '#cookie', states: ['error'] }], click: ['button.dismiss'] };
  assert.deepEqual(validateConfig(c).errors, []);
  c.app.preCapture.hide[1] = { selector: '.promo-banner', states: [] };
  c.app.preCapture.remove[0] = { selector: '#cookie' };
  c.app.preCapture.click[0] = 'a { color: red }';
  const errors = validateConfig(c).errors.map((e) => e.path);
  for (const p of ['app.preCapture.hide[1]', 'app.preCapture.remove[0]', 'app.preCapture.click[0]']) assert.ok(errors.some((e) => e.startsWith(p)), `${p}: ${errors.join(', ')}`);
});

test('config: semantic errors and unknown-key warnings', () => {
  const c = loadFixture('config.json');
  c.app.baseUrl = 'localhost:3000';
  c.tolerances.pixelDiff = { pass: 5, review: 1 };
  c.surfaces.items.states.hover = { action: 'hover' };
  c.surfaces.items.states.focus = { action: 'keyboard' };
  c.surfaces.items.states.loading.mock = { delayMs: 10 };
  c.app.auth = { type: 'login', login: null };
  c.surfaces.items.colour = 'red';
  const result = validateConfig(c);
  const errors = result.errors.map((e) => `${e.path}: ${e.message}`);
  const has = (re) => assert.ok(errors.some((e) => re.test(e)), `missing ${re} in\n${errors.join('\n')}`);
  has(/^app\.baseUrl: must be an absolute http\(s\) URL or an environment-variable placeholder \(a \$ sign followed by \{NAME\}\) \(got "localhost:3000"\)$/);
  has(/^tolerances\.pixelDiff: pass \(5\) must be <= review \(1\)$/);
  has(/^surfaces\.items\.states\.hover: action "hover" needs a "selector"$/);
  has(/^surfaces\.items\.states\.focus: action "keyboard" needs "keys"/);
  has(/^surfaces\.items\.states\.loading\.mock\.urlPattern: required key is missing$/);
  has(/^app\.auth\.login: is required when auth\.type is "login"$/);
  assert.deepEqual(result.warnings.map((w) => w.path), ['surfaces.items.colour']);
});

test('state matrix files are arrays of state rows', () => {
  const rows = loadFixture('report-valid.json').stateMatrix;
  assert.equal(validateStateMatrix(rows).valid, true);
  rows[2].result = 'MAYBE';
  delete rows[0].label;
  const errors = validateStateMatrix(rows).errors.map((e) => `${e.path}: ${e.message}`);
  assert.ok(errors.includes('[0].label: required key is missing'));
  assert.ok(errors.some((e) => e.startsWith('[2].result: expected one of PASS')));
  assert.equal(validateStateMatrix({}).valid, false);
});

test('inferType', () => {
  assert.equal(inferType(loadFixture('report-valid.json')), 'report');
  assert.equal(inferType(loadFixture('config.json')), 'config');
  assert.equal(inferType([{ state: 'empty', result: 'PASS' }]), 'state-matrix');
  assert.equal(inferType([]), 'state-matrix');
  assert.equal(inferType({ hello: 1 }), null);
  assert.equal(inferType([1, 2]), null);
});

test('schemas: draft-07, and the state-matrix row is identical to the report one', () => {
  for (const name of ['report', 'config', 'state-matrix']) {
    assert.equal(loadSchema(name).$schema, 'http://json-schema.org/draft-07/schema#', name);
  }
  assert.deepEqual(loadSchema('state-matrix').definitions.stateMatrixRow, loadSchema('report').definitions.stateMatrixRow);
});

test('schema interpreter: $ref, if/then, anyOf, not', () => {
  const schema = {
    definitions: { n: { type: 'integer', minimum: 1 } },
    type: 'object',
    properties: { a: { $ref: '#/definitions/n' }, b: { anyOf: [{ type: 'string' }, { type: 'null' }] }, c: { not: { const: 'x' } } },
    if: { properties: { a: { const: 1 } }, required: ['a'] },
    then: { required: ['b'] },
  };
  assert.deepEqual(validateAgainstSchema({ a: 2, c: 'y' }, schema).errors, []);
  const errs = validateAgainstSchema({ a: 1, c: 'x' }, schema).errors.map((e) => `${e.path}: ${e.message}`);
  assert.ok(errs.includes('b: required key is missing'));
  assert.ok(errs.some((e) => e.startsWith('c: must not match')));
  assert.ok(validateAgainstSchema({ a: 0, b: 3 }, schema).errors.length >= 2);
});

test('CLI: exit 0 for a valid report, 1 with readable errors, 2 for usage problems', async () => {
  onlyBuildErrors(await run(VALIDATE, [fixture('report-valid.json')]));

  const dir = tmpDir();
  const bad = loadFixture('report-valid.json');
  bad.findings[3].severity = 'CRITICAL';
  const badFile = path.join(dir, 'report.json');
  writeFileSync(badFile, JSON.stringify(bad));
  const fail = await run(VALIDATE, [badFile]);
  assert.equal(fail.code, 1);
  assert.match(fail.stderr, /ERROR findings\[3\]\.severity: expected one of BLOCKER/);
  assert.match(fail.stderr, /FAIL\s+.*\(report\): \d+ errors?/);

  const json = await run(VALIDATE, [badFile, '--json']);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.valid, false);
  assert.equal(parsed.type, 'report');

  const quiet = await run(VALIDATE, [fixture('config.json'), '--quiet']);
  assert.equal(quiet.code, 0);
  assert.equal(quiet.stdout, '');

  const missing = await run(VALIDATE, [path.join(dir, 'nope.json')]);
  assert.equal(missing.code, 2);
  const unknown = path.join(dir, 'unknown.json');
  writeFileSync(unknown, '{"hello": 1}');
  assert.equal((await run(VALIDATE, [unknown])).code, 2);
  const broken = path.join(dir, 'broken.json');
  writeFileSync(broken, '{"schemaVersion": ');
  assert.equal((await run(VALIDATE, [broken])).code, 1);
  assert.equal((await run(VALIDATE, [fixture('config.json'), '--type', 'nope'])).code, 2);
  const help = await run(VALIDATE, ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--type <type>/);
});

test('CLI: --config supplies pixel-diff tolerances; config files validate by inference', async () => {
  const dir = tmpDir();
  const cfg = path.join(dir, 'design-qa.config.json');
  const config = loadFixture('config.json');
  config.tolerances.pixelDiff = { pass: 0.1, review: 0.3 };
  writeFileSync(cfg, JSON.stringify(config));
  const res = await run(VALIDATE, [fixture('report-valid.json'), '--config', cfg]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /scorecard\.pixelDiff\["with-data"\]\.band: expected "fail"/);
  const cfgRes = await run(VALIDATE, [fixture('config.json')]);
  assert.equal(cfgRes.code, 0, cfgRes.stderr);
  assert.match(cfgRes.stdout, /valid config/);
});

// ---------------------------------------------------------------------------
// Triage, unexplained, debt, loopClosed
// ---------------------------------------------------------------------------

function triagedReport() {
  const r = loadFixture('report-valid.json');
  const { triage } = buildTriage(r, { fixIds: ['DQ-002'], decidedBy: 'Dana', decidedAt: '2026-09-24T09:00:00Z', source: 'cli' });
  return applyTriage(r, triage);
}

test('a triaged report validates; unexplained, debt and loopClosed are required and derived', () => {
  const r = triagedReport();
  assert.equal(r.schemaVersion, '2.0');
  assert.deepEqual(validateReport(r).errors, []);
  assert.deepEqual(validateReport(r).warnings, []);

  const missing = triagedReport();
  delete missing.scorecard.unexplained;
  delete missing.scorecard.loopClosed;
  expectError(missing, /^scorecard\.unexplained: required key is missing$/);
  expectError(missing, /^scorecard\.loopClosed: required key is missing$/);

  const drift = triagedReport();
  drift.scorecard.unexplained = 0;
  drift.scorecard.debt.ticketed = 2;
  drift.scorecard.loopClosed = true;
  expectError(drift, /^scorecard\.unexplained: expected 5 \(open findings that are not ticketed debt\), got 0$/);
  expectError(drift, /^scorecard\.debt\.ticketed: expected 0 \(debt items with a ticket\), got 2$/);
  expectError(drift, /^scorecard\.loopClosed: expected false \(unexplained 5, open decisions 1\), got true$/);
});

test('triage: a BLOCKER can never be debt', () => {
  const r = triagedReport();
  const i = r.triage.items.findIndex((item) => item.findingId === 'DQ-001');
  r.triage.items[i].decision = 'debt';
  r.scorecard = computeScorecard(r);
  const errors = errorsOf(r);
  assert.ok(
    errors.includes(`triage.items[${i}].decision: DQ-001 is a BLOCKER: blockers cannot be deferred; fix it or sign it off as INTENTIONAL`),
    errors.join('\n'),
  );
});

test('triage: exactly one decision for every triageable finding', () => {
  const r = triagedReport();
  r.triage.items = r.triage.items.filter((item) => item.findingId !== 'DQ-004');
  r.triage.items.push({ findingId: 'DQ-002', decision: 'debt', reason: null, ticket: null });
  r.triage.items.push({ findingId: 'DQ-099', decision: 'debt' });
  r.triage.items.push({ findingId: 'DQ-005', decision: 'debt' });
  r.triage.items.push({ findingId: 'DQ-009', decision: 'fix-now' });
  r.triage.items.push({ findingId: 'DQ-003', decision: 'later' });
  r.scorecard = computeScorecard(r);
  expectError(r, /^triage\.items: no decision for DQ-004: every FIX_CODE finding with severity BLOCKER, WARNING or DS_CANDIDATE needs "fix-now" or "debt"$/);
  expectError(r, /^triage\.items\[\d+\]\.findingId: duplicate decision for "DQ-002" \(first at triage\.items\[\d+\]\)$/);
  expectError(r, /^triage\.items\[\d+\]\.findingId: references unknown finding "DQ-099"$/);
  expectError(r, /^triage\.items\[\d+\]\.findingId: DQ-005 is not triageable \(PASS \/ NONE\)/);
  expectError(r, /^triage\.items\[\d+\]\.findingId: DQ-009 is not triageable \(WARNING \/ DISMISSED\): only FIX_CODE findings/);
  expectError(r, /^triage\.items\[\d+\]\.decision: expected one of fix-now, debt \(got "later"\)$/);
});

test('triage: tickets need provider, key, url and createdAt', () => {
  const r = triagedReport();
  const i = r.triage.items.findIndex((item) => item.findingId === 'DQ-004');
  r.triage.items[i].ticket = { provider: 'trello', key: 'X-1' };
  r.scorecard = computeScorecard(r);
  expectError(r, new RegExp(`^triage\\.items\\[${i}\\]\\.ticket\\.provider: expected one of jira, linear, github`));
  expectError(r, new RegExp(`^triage\\.items\\[${i}\\]\\.ticket\\.url: required key is missing$`));
});

// ---------------------------------------------------------------------------
// schemaVersion 2.0: removals, dismissals, source, motion, screens
// ---------------------------------------------------------------------------

test('only schemaVersion 2.0 validates; a 1.x report gets one clear message', () => {
  for (const version of ['1.0', '1.1']) {
    const old = loadFixture('report-valid.json');
    old.schemaVersion = version;
    delete old.meta.source;
    assert.deepEqual(errorsOf(old), [`schemaVersion: schemaVersion 2.0 required; 1.x reports: re-run the pass (got "${version}")`]);
  }
  const future = loadFixture('report-valid.json');
  future.schemaVersion = '3.0';
  expectError(future, /^schemaVersion: schemaVersion 2\.0 required; 1\.x reports: re-run the pass \(got "3\.0"\)$/);
});

test('removed 1.x values get messages that say what to do instead', () => {
  const r = loadFixture('report-valid.json');
  r.findings[2].resolution = 'SYNC_FIGMA';
  r.stateMatrix[2].result = 'MISSING_IN_DESIGN';
  r.ledgers.state[2].result = 'MISSING_IN_DESIGN';
  r.meta.mode = 'sync';
  r.stateMatrix[0].captured.figma = 'figma/with-data.png';
  r.evidence.states.empty.figma = 'figma/empty.png';
  const opts = { skipScorecard: true };
  expectError(r, /^findings\[2\]\.resolution: SYNC_FIGMA was removed in 2\.0: reclassify as FIX_CODE or dismiss it$/, opts);
  expectError(r, /^stateMatrix\[2\]\.result: MISSING_IN_DESIGN was removed in 2\.0: the state matrix lists only states the design defines; drop this row$/, opts);
  expectError(r, /^ledgers\.state\[2\]\.result: MISSING_IN_DESIGN was removed in 2\.0/, opts);
  expectError(r, /^meta\.mode: mode "sync" was removed in 2\.0 \(design → code only\): use audit or fix$/, opts);
  expectError(r, /^stateMatrix\[0\]\.captured\.figma: captured\.figma was renamed to captured\.design in 2\.0 \(got "figma\/with-data\.png"\)$/, opts);
  expectError(r, /^evidence\.states\.empty\.figma: evidence\.states\.<state>\.figma was renamed to design in 2\.0/, opts);
  assert.ok(!errorsOf(r, opts).some((e) => /expected one of FIX_CODE/.test(e)), 'no generic enum error next to the removal message');

  const rows = loadFixture('report-valid.json').stateMatrix;
  rows[1].result = 'MISSING_IN_DESIGN';
  assert.deepEqual(validateStateMatrix(rows).errors.map((e) => `${e.path}: ${e.message}`), [
    '[1].result: MISSING_IN_DESIGN was removed in 2.0: the state matrix lists only states the design defines; drop this row',
  ]);
});

test('DISMISSED needs a dismissal with a reason; only BLOCKER, WARNING and DS_CANDIDATE can be dismissed', () => {
  const r = loadFixture('report-valid.json');
  assert.equal(r.findings[8].resolution, 'DISMISSED');
  const noDismissal = loadFixture('report-valid.json');
  delete noDismissal.findings[8].dismissal;
  expectError(noDismissal, /^findings\[8\]\.dismissal: is required when resolution is DISMISSED: \{ kind, reason, by, date, source \}$/);
  noDismissal.findings[8].dismissal = null;
  expectError(noDismissal, /^findings\[8\]\.dismissal: is required when resolution is DISMISSED/);

  const blank = loadFixture('report-valid.json');
  blank.findings[8].dismissal.reason = '   ';
  expectError(blank, /^findings\[8\]\.dismissal\.reason: must say why the finding is dismissed \(got only whitespace\)$/);
  blank.findings[8].dismissal.reason = '';
  expectError(blank, /^findings\[8\]\.dismissal\.reason: must not be empty$/);

  const bad = loadFixture('report-valid.json');
  bad.findings[8].dismissal.kind = 'intentional';
  bad.findings[8].dismissal.source = 'email';
  bad.findings[8].dismissal.date = '2026-09-23';
  delete bad.findings[8].dismissal.by;
  delete bad.findings[8].dismissal.priorRef;
  expectError(bad, /^findings\[8\]\.dismissal\.kind: expected one of not-an-issue, remove \(got "intentional"\)$/);
  expectError(bad, /^findings\[8\]\.dismissal\.source: expected one of report-ui, chat, cli, prior-pass/);
  expectError(bad, /^findings\[8\]\.dismissal\.date: expected an ISO-8601 date-time/);
  assert.ok(!errorsOf(bad).some((e) => /\.by|priorRef/.test(e)), 'by and priorRef may be omitted');

  const pass = loadFixture('report-valid.json');
  pass.findings[4].resolution = 'DISMISSED'; // DQ-005 is PASS
  pass.findings[4].dismissal = structuredClone(r.findings[8].dismissal);
  expectError(pass, /^findings\[4\]\.resolution: must be NONE when severity is PASS or CANNOT_VERIFY \(got "DISMISSED"\)$/, { skipScorecard: true });

  const stray = loadFixture('report-valid.json');
  stray.findings[1].dismissal = structuredClone(r.findings[8].dismissal);
  const result = validateReport(stray);
  assert.equal(result.valid, true);
  assert.deepEqual(result.warnings.map((w) => `${w.path}: ${w.message}`), ['findings[1].dismissal: is ignored: resolution is FIX_CODE, not DISMISSED']);
});

test('meta.source is required; meta.figma only for Figma sources, with the same frame', () => {
  const noSource = loadFixture('report-valid.json');
  delete noSource.meta.source;
  expectError(noSource, /^meta\.source: required key is missing$/);

  const noFigma = loadFixture('report-valid.json');
  delete noFigma.meta.figma;
  expectError(noFigma, /^meta\.figma: is required when meta\.source\.kind is "figma" \(\{ fileKey, nodeId, url, frame \}\)$/);
  noFigma.meta.source.kind = 'figma-prototype';
  expectError(noFigma, /^meta\.figma: is required when meta\.source\.kind is "figma-prototype"/);
  noFigma.meta.source = { kind: 'prototype', url: 'https://acme.framer.website/items', label: null, tool: 'framer', frame: { width: 1440, height: 900 } };
  noFigma.meta.tools.figmaAccess = 'none';
  noFigma.meta.tools.prototypeCapture = 'script';
  assert.deepEqual(errorsOf(noFigma), [], 'a coded prototype needs no meta.figma');

  const frames = loadFixture('report-valid.json');
  frames.meta.source.frame = { width: 1280, height: 800 };
  expectError(frames, /^meta\.figma\.frame: must equal meta\.source\.frame \(1280×800\), got 1440×900$/);

  const bad = loadFixture('report-valid.json');
  bad.meta.source.kind = 'sketch';
  bad.meta.source.tool = 'webflow';
  bad.meta.tools.prototypeCapture = 'manual';
  expectError(bad, /^meta\.source\.kind: expected one of figma, figma-prototype, prototype \(got "sketch"\)$/);
  expectError(bad, /^meta\.source\.tool: expected one of figma-make, framer, v0, lovable, html, other, null/);
  expectError(bad, /^meta\.tools\.prototypeCapture: expected one of script, playwright-mcp, builtin, null/);
});

test('motion ledger: required, observed null means missing motion; expected.source and evidence types', () => {
  const r = loadFixture('report-valid.json');
  assert.equal(r.ledgers.motion[0].observed, null);
  delete r.ledgers.motion[0].observed;
  assert.deepEqual(errorsOf(r), [], 'observed may be omitted (null)');

  const missing = loadFixture('report-valid.json');
  delete missing.ledgers.motion;
  expectError(missing, /^ledgers\.motion: required key is missing$/);

  const bad = loadFixture('report-valid.json');
  bad.ledgers.motion[0].trigger = 'wiggle';
  bad.ledgers.motion[0].observed = { durationMs: -1 };
  bad.ledgers.motion[0].findingIds = ['DQ-099'];
  bad.findings[0].expected.source = 'sketch';
  bad.findings[0].evidence[0].type = 'video';
  expectError(bad, /^ledgers\.motion\[0\]\.trigger: expected one of hover, focus, press, click, load, state-change, scroll, timeout, other/);
  expectError(bad, /^ledgers\.motion\[0\]\.observed\.type: required key is missing$/);
  expectError(bad, /^ledgers\.motion\[0\]\.findingIds\[0\]: references unknown finding "DQ-099"$/);
  expectError(bad, /^findings\[0\]\.expected\.source: expected one of figma, prototype, ticket, design-rules/);
  expectError(bad, /^findings\[0\]\.evidence\[0\]\.type: expected one of screenshot, design, computed, dom, motion, figma, diff/);
});

test('multi-screen: the prototype fixture validates; screens, state prefixes and finding screens must agree', () => {
  const ok = validateReport(loadFixture('report-multiscreen.json'));
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.warnings, []);

  const r = loadFixture('report-multiscreen.json');
  r.stateMatrix[0].state = 'with-data';
  r.stateMatrix[1].screen = 'checkout';
  delete r.stateMatrix[2].screen;
  r.findings[0].screen = 'payment';
  r.findings[1].state = 'cart/with-data';
  delete r.findings[2].screen;
  r.meta.screens.push({ id: 'cart', name: 'Cart again' });
  const result = validateReport(r, { skipScorecard: true });
  const errors = result.errors.map((e) => `${e.path}: ${e.message}`);
  const has = (re) => assert.ok(errors.some((e) => re.test(e)), `missing ${re} in\n${errors.join('\n')}`);
  has(/^stateMatrix\[0\]\.state: must be "<screen>\/<state>" with a meta\.screens id \(cart, checkout\) when meta\.screens is set \(got "with-data"\)$/);
  has(/^stateMatrix\[1\]\.screen: must equal the state prefix "cart" \(got "checkout"\)$/);
  has(/^stateMatrix\[2\]\.screen: is required when meta\.screens is set \(expected "checkout"\)$/);
  has(/^findings\[0\]\.screen: references unknown screen "payment" \(meta\.screens: cart, checkout\)$/);
  has(/^findings\[1\]\.state: must start with "checkout\/" \(the finding's screen\), got "cart\/with-data"$/);
  has(/^meta\.screens\[2\]\.id: duplicate screen id "cart" \(first used at meta\.screens\[0\]\)$/);
  assert.ok(result.warnings.some((w) => w.path === 'findings[2].screen' && /is missing: meta\.screens is set/.test(w.message)));

  const single = loadFixture('report-valid.json');
  single.stateMatrix[0].screen = 'items';
  single.findings[0].screen = 'items';
  expectError(single, /^stateMatrix\[0\]\.screen: is only allowed when meta\.screens lists the screens$/);
  expectError(single, /^findings\[0\]\.screen: is only allowed when meta\.screens lists the screens$/);

  const badId = loadFixture('report-multiscreen.json');
  badId.meta.screens[0].id = 'Cart Page';
  expectError(badId, /^meta\.screens\[0\]\.id: must match/, { skipScorecard: true });
});

test('design backfill: the fixture validates; ids, reasons, figma, the gate and designed states are checked', () => {
  const ok = loadFixture('report-backfill.json');
  assert.deepEqual(validateReport(ok).errors, []);
  assert.deepEqual(validateReport({ ...loadFixture('report-valid.json'), backfill: null }).errors, [], 'backfill: null is no backfill');

  const r = loadFixture('report-backfill.json');
  r.backfill.items[1].id = 'BF-001';
  r.backfill.items.push({ id: 'BF-4', state: 'empty', label: 'Empty', discoveredBy: 'code', decision: 'maybe' });
  r.backfill.items[2].reason = '  ';
  const errors = errorsOf(r, { skipScorecard: true });
  const has = (re) => assert.ok(errors.some((e) => re.test(e)), `missing ${re} in\n${errors.join('\n')}`);
  has(/^backfill\.items\[1\]\.id: duplicate id "BF-001" \(first used at backfill\.items\[0\]\)$/);
  has(/^backfill\.items\[3\]\.id: must match \^BF-\\d\{3,\}\$ \(got "BF-4"\)$/);
  has(/^backfill\.items\[3\]\.discoveredBy: expected one of config, source, ticket, capture \(got "code"\)$/);
  has(/^backfill\.items\[3\]\.decision: expected one of pending, build, not-needed \(got "maybe"\)$/);
  has(/^backfill\.items\[3\]\.state: "empty" is a stateMatrix row: the design defines it, so it is not an undesigned state \(drop this backfill item\)$/);
  has(/^backfill\.items\[2\]\.reason: is required when decision is "not-needed": say why this state needs no design frame$/);

  const notBuild = loadFixture('report-backfill.json');
  notBuild.backfill.items[1].decision = 'pending';
  expectError(notBuild, /^backfill\.items\[1\]\.figma: is only allowed when decision is "build" \(got "pending"\)$/, { skipScorecard: true });

  const early = loadFixture('report-backfill.json');
  early.backfill.gate.override = null;
  early.scorecard = computeScorecard(early);
  const reopened = validateReport(early);
  assert.deepEqual(reopened.errors, [], 'frames built earlier stay valid when step 1 reopens');
  assert.ok(
    reopened.warnings.some((w) => w.path === 'backfill.items[1].figma' && /built while production does not match the design/.test(w.message)),
    'but the report warns',
  );
  const badOverride = loadFixture('report-backfill.json');
  badOverride.backfill.gate.override = { by: null, date: 'friday', reason: '' };
  expectError(badOverride, /^backfill\.gate\.override\.reason: must not be empty$/, { skipScorecard: true });
  expectError(badOverride, /^backfill\.gate\.override\.date: expected an ISO-8601 date-time/, { skipScorecard: true });

  const figma = loadFixture('report-backfill.json');
  figma.backfill.items[1].figma.url = 'not a url';
  figma.backfill.items[1].figma.roundTrip.band = 'fail';
  const fr = validateReport(figma);
  assert.ok(fr.errors.some((e) => e.path === 'backfill.items[1].figma.url'));
  assert.ok(fr.warnings.some((w) => w.path === 'backfill.items[1].figma.roundTrip.band' && /is "fail" but 0\.6% is "pass"/.test(w.message)));

  const single = loadFixture('report-backfill.json');
  single.backfill.items[0].screen = 'items';
  expectError(single, /^backfill\.items\[0\]\.screen: is only allowed when meta\.screens lists the screens$/);
  const multi = loadFixture('report-multiscreen.json');
  multi.backfill = {
    gate: { override: null },
    items: [
      { id: 'BF-001', state: 'cart/bulk-selected', screen: 'cart', label: 'Bulk selected', discoveredBy: 'source', decision: 'pending' },
      { id: 'BF-002', state: 'cart/promo', screen: 'checkout', label: 'Promo', discoveredBy: 'ticket', decision: 'pending' },
      { id: 'BF-003', state: 'promo', screen: 'payment', label: 'Promo', discoveredBy: 'ticket', decision: 'pending' },
      { id: 'BF-004', state: 'checkout/toast', label: 'Toast', discoveredBy: 'source', decision: 'pending' },
    ],
  };
  multi.scorecard = computeScorecard(multi);
  const mr = validateReport(multi);
  const merr = mr.errors.map((e) => `${e.path}: ${e.message}`);
  assert.deepEqual(merr, [
    'backfill.items[1].state: must start with "checkout/" (the item\'s screen), got "cart/promo"',
    'backfill.items[2].screen: references unknown screen "payment" (meta.screens: cart, checkout)',
  ]);
  assert.ok(mr.warnings.some((w) => w.path === 'backfill.items[3].screen' && /is missing: meta\.screens is set/.test(w.message)));
});

test('design backfill: scorecard.backfill exists exactly when backfill does, with derived values', () => {
  const r = loadFixture('report-backfill.json');
  r.scorecard.backfill.toBuild = 2;
  r.scorecard.backfill.ready = false;
  expectError(r, /^scorecard\.backfill\.toBuild: expected 1 \(items decided "build" without a Figma frame yet\), got 2$/);
  expectError(r, /^scorecard\.backfill\.ready: expected true \(loopClosed false, backfill\.gate\.override set\), got false$/);

  const missing = loadFixture('report-backfill.json');
  delete missing.scorecard.backfill;
  expectError(missing, /^scorecard\.backfill: is required when report\.backfill is set/);

  const extra = loadFixture('report-valid.json');
  extra.scorecard.backfill = { candidates: 0, toBuild: 0, built: 0, notNeeded: 0, pending: 0, ready: false };
  expectError(extra, /^scorecard\.backfill: must be omitted: the report has no backfill block$/);

  const shape = loadFixture('report-backfill.json');
  shape.scorecard.backfill = { candidates: 3 };
  expectError(shape, /^scorecard\.backfill\.toBuild: required key is missing$/);
});

test('CLI: validate.mjs reports backfill errors and documents the rules', async () => {
  const dir = tmpDir();
  const bad = loadFixture('report-backfill.json');
  bad.backfill.items[2].reason = null;
  bad.scorecard = computeScorecard(bad);
  const file = path.join(dir, 'report.json');
  writeFileSync(file, JSON.stringify(bad));
  const res = await run(VALIDATE, [file]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /ERROR backfill\.items\[2\]\.reason: is required when decision is "not-needed"/);
  const help = await run(VALIDATE, ['--help']);
  assert.match(help.stdout, /Design backfill \(step 2, optional "backfill" block\)/);
});

// ---------------------------------------------------------------------------
// INTENTIONAL sign-offs, formats, inference, --json, warnings
// ---------------------------------------------------------------------------

test('INTENTIONAL needs a signoff with a non-blank by and reason, or a cited known drift', () => {
  const ok = loadFixture('report-valid.json');
  assert.equal(ok.findings[6].resolution, 'INTENTIONAL');
  ok.findings[6].knownDrift = null;
  assert.deepEqual(errorsOf(ok), [], 'a signoff alone is enough (date-only signoff dates stay valid)');
  ok.findings[6].signoff.date = '2026-09-20T09:00:00Z';
  assert.deepEqual(errorsOf(ok), [], 'so is a date-time');

  const drift = loadFixture('report-valid.json');
  drift.findings[6].signoff = null;
  assert.deepEqual(errorsOf(drift), [], 'a cited known drift is enough');

  const neither = loadFixture('report-valid.json');
  neither.findings[6].signoff = null;
  neither.findings[6].knownDrift = '  ';
  expectError(neither, /^findings\[6\]\.signoff: is required when resolution is INTENTIONAL: \{ by, date, reason \}/);
  delete neither.findings[6].signoff;
  delete neither.findings[6].knownDrift;
  expectError(neither, /^findings\[6\]\.signoff: is required when resolution is INTENTIONAL/);

  const blank = loadFixture('report-valid.json');
  blank.findings[6].signoff = { by: ' ', date: 'last week', reason: '' };
  expectError(blank, /^findings\[6\]\.signoff\.by: must name who signed off \(not blank\) \(got " "\)$/);
  expectError(blank, /^findings\[6\]\.signoff\.reason: must say why the divergence is accepted \(not blank\)/);
  expectError(blank, /^findings\[6\]\.signoff\.date: must be a date \(2026-01-31\) or an ISO-8601 date-time/);
  blank.findings[6].signoff.date = '2026-02-30';
  expectError(blank, /^findings\[6\]\.signoff\.date: must be a date/);
});

test('INTENTIONAL without a signoff cannot fake every finding settled and a closed loop (which also opens the backfill gate)', () => {
  const r = loadFixture('report-backfill.json');
  for (const f of r.findings) {
    if (['FIX_CODE', 'UNCLASSIFIED'].includes(f.resolution)) Object.assign(f, { resolution: 'INTENTIONAL', signoff: null, knownDrift: null, fix: null });
  }
  r.openDecisions = [];
  r.triage = null;
  r.backfill.gate.override = null;
  r.findings = rankFindings(r.findings.map((f) => ({ ...f, rank: null })));
  r.stateMatrix.forEach((row) => {
    if (row.result === 'MISSING_IN_CODE') row.result = 'FAIL';
  });
  r.scorecard.pixelDiff.empty.percent = 4; // a fail band is explained only by what names its area
  r.scorecard = computeScorecard(r);
  assert.equal(r.scorecard.settled.count, r.scorecard.settled.total);
  assert.equal(isLoopClosed(r), true);
  const result = validateReport(r);
  assert.equal(result.valid, false);
  const unsigned = result.errors.filter((e) => /^findings\[\d+\]\.signoff$/.test(e.path)).length;
  assert.equal(unsigned, 5, result.errors.map((e) => `${e.path}: ${e.message}`).join('\n'));
});

test('date-time is strict RFC 3339 (what ajv-formats and Date.parse both accept); date is a real calendar day', () => {
  const good = [
    '2026-01-31T12:00:00Z',
    '2026-01-31t12:00:00z',
    '2026-01-31T12:00:00.123456Z',
    '2026-01-31T12:00:00+05:30',
    '2026-01-31T23:59:59-23:59',
    '2024-02-29T00:00:00Z',
    '2000-02-29T00:00:00Z',
  ];
  const bad = [
    '2026-09-22 14:30:00Z', // space separator
    '2026-09-22T14:30Z', // no seconds
    '2026-09-22T14:30:00', // no time zone
    '2026-02-30T12:00:00Z', // no such day
    '2026-02-29T12:00:00Z', // not a leap year
    '1900-02-29T12:00:00Z', // century, not a leap year
    '2026-01-31T24:00:00Z', // hour 24
    '2026-01-31T12:60:00Z',
    '2026-12-31T23:59:60Z', // leap second: Date.parse cannot read it
    '2026-01-31T12:00:00+0530', // offset without a colon
    '2026-01-31T12:00:00+05',
    '2026-01-31T12:00:00+24:00',
    '2026-13-01T12:00:00Z',
    '2026-1-31T12:00:00Z',
    '2026-01-31',
    'yesterday',
  ];
  for (const v of good) assert.equal(isRfc3339DateTime(v), true, v);
  for (const v of bad) assert.equal(isRfc3339DateTime(v), false, v);
  for (const v of good) assert.ok(!Number.isNaN(Date.parse(v)), `${v}: the decisions flow can read it`);
  assert.equal(isRfc3339Date('2024-02-29'), true);
  for (const v of ['2026-02-29', '2026-04-31', '2026-00-10', '2026-01-31T00:00:00Z', 26]) assert.equal(isRfc3339Date(v), false, String(v));

  const r = loadFixture('report-valid.json');
  r.meta.generatedAt = '2026-09-22 14:30:00Z';
  r.triage = { decidedAt: '2026-09-22T14:30', source: 'cli', items: [] };
  expectError(r, /^meta\.generatedAt: expected an ISO-8601 date-time \(e\.g\. 2026-01-31T12:00:00Z\) \(got "2026-09-22 14:30:00Z"\)$/, { skipTriage: false, skipScorecard: true });
  expectError(r, /^triage\.decidedAt: expected an ISO-8601 date-time/, { skipScorecard: true });
});

test('uri: parsed with new URL; file: URLs pass; ${…} placeholders only in config documents', () => {
  for (const v of ['https://example.com/x?y=1', 'http://localhost:3000', 'file:///home/me/proto/index.html', 'file:/home/me/proto/index.html', 'https://www.figma.com/design/AbC/Items?node-id=1-2']) {
    assert.equal(isAbsoluteUri(v), true, v);
  }
  for (const v of ['${PREVIEW_URL}', 'not a url ${', 'localhost:3000', 'https://exa mple.com', 'http://', '/abs/path', 'example.com']) {
    assert.equal(isAbsoluteUri(v), false, v);
  }
  assert.equal(isAbsoluteUri('${PREVIEW_URL}', { placeholders: true }), true);
  assert.equal(validateAgainstSchema('${PREVIEW_URL}', { type: 'string', format: 'uri' }, { placeholders: true }).errors.length, 0);

  const r = loadFixture('report-valid.json');
  r.meta.app.url = '${PREVIEW_URL}';
  expectError(r, /^meta\.app\.url: expected an absolute URL \(got "\$\{PREVIEW_URL\}"\)$/);
  const proto = loadFixture('report-valid.json');
  delete proto.meta.figma;
  proto.meta.source = { kind: 'prototype', url: 'file:/home/me/proto/index.html', label: null, tool: 'html', frame: { width: 1440, height: 900 } };
  proto.meta.tools.figmaAccess = 'none';
  assert.deepEqual(errorsOf(proto), [], 'file:/abs is a valid source URL');
});

test('schemas: errorMessage text never contains a ${…} template (ajv-errors reads it as a JSON pointer)', () => {
  const walk = (node, at, out) => {
    if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${at}[${i}]`, out));
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'errorMessage' && typeof v === 'string' && /\$\{[^}]+\}/.test(v)) out.push(`${at}.${k}`);
        walk(v, `${at}.${k}`, out);
      }
    }
    return out;
  };
  for (const name of ['report', 'config', 'state-matrix', 'decisions', 'annotations']) assert.deepEqual(walk(loadSchema(name), name, []), [], name);
});

test('config: report.debtLog must be a .md path', () => {
  const c = loadFixture('config.json');
  c.report.debtLog = 'qa-reports/design-debt.md';
  assert.deepEqual(validateConfig(c).errors, []);
  c.report.debtLog = 'qa-reports/design-debt.json';
  const errors = validateConfig(c).errors.map((e) => `${e.path}: ${e.message}`);
  assert.deepEqual(errors, ['report.debtLog: must be the path of a Markdown file ending in .md (the JSON log is written next to it) (got "qa-reports/design-debt.json")']);
});

test('warnings: pixel-diff keys that are not stateMatrix states', () => {
  const r = loadFixture('report-valid.json');
  r.scorecard.pixelDiff.with_data = { ...r.scorecard.pixelDiff['with-data'] };
  r.scorecard = computeScorecard(r);
  const result = validateReport(r);
  assert.equal(result.valid, true);
  assert.deepEqual(result.warnings.map((w) => `${w.path}: ${w.message}`), [
    'scorecard.pixelDiff.with_data: state "with_data" is not a row of stateMatrix (rows: with-data, empty, loading, error, hover)',
  ]);
});

test('inferType: one identifying key is enough, so a broken file gets its real errors', () => {
  const r = loadFixture('report-valid.json');
  delete r.findings;
  assert.equal(inferType(r), 'report');
  assert.equal(inferType({ findings: [] }), 'report');
  assert.equal(inferType({ app: { baseUrl: 'http://localhost:3000' } }), 'config');
  assert.equal(inferType({ surfaces: {} }), 'config');
  assert.equal(inferType({ hello: 1 }), null);
});

test('CLI: a report without findings exits 1 with "required"; --json always prints a result', async () => {
  const dir = tmpDir();
  const r = loadFixture('report-valid.json');
  delete r.findings;
  const file = path.join(dir, 'report.json');
  writeFileSync(file, JSON.stringify(r));
  const res = await run(VALIDATE, [file]);
  assert.equal(res.code, 1, res.stderr);
  assert.match(res.stderr, /ERROR findings: required key is missing/);
  const json = await run(VALIDATE, [file, '--json']);
  assert.equal(json.code, 1);
  assert.equal(JSON.parse(json.stdout).type, 'report');
  assert.ok(JSON.parse(json.stdout).errors.some((e) => e.path === 'findings' && e.message === 'required key is missing'));

  const cases = [
    [path.join(dir, 'nope.json'), 2, /file not found/, null],
    [path.join(dir, 'broken.json'), 1, /is not valid JSON/, null],
    [path.join(dir, 'unknown.json'), 2, /cannot infer the file type/, null],
  ];
  writeFileSync(cases[1][0], '{"schemaVersion": ');
  writeFileSync(cases[2][0], '{"hello": 1}');
  for (const [target, code, message, type] of cases) {
    const out = await run(VALIDATE, [target, '--json']);
    assert.equal(out.code, code, `${path.basename(target)}: ${out.stderr}`);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.valid, false);
    assert.equal(parsed.type, type);
    assert.match(parsed.file, new RegExp(`${path.basename(target).replace('.', '\\.')}$`));
    assert.deepEqual(parsed.warnings, []);
    assert.equal(parsed.errors.length, 1);
    assert.equal(parsed.errors[0].path, '(root)');
    assert.match(parsed.errors[0].message, message);
  }
  const usage = await run(VALIDATE, [file, '--json', '--type', 'nope']);
  assert.equal(usage.code, 2);
  assert.match(JSON.parse(usage.stdout).errors[0].message, /--type must be one of/);
  assert.equal((await run(VALIDATE, [dir])).code, 2, 'a folder is a usage error');
});

test('docs: a backfill frame recorded while step 1 is open is a warning (schema description and --help agree)', async () => {
  assert.match(loadSchema('report').definitions.backfill.description, /a figma frame while not ready \(no loopClosed, no override\) is a warning/);
  const help = (await run(VALIDATE, ['--help'])).stdout.replace(/\s+/g, ' ');
  assert.match(help, /is a warning: backfill\.mjs --record refuses it/);
  assert.match(help, /INTENTIONAL ⇒ a signoff/);
});

// ---------------------------------------------------------------------------
// Evidence gates: an incomplete pass, pins, crops, remote targets, full-length
// comparisons and the design-system audit
// ---------------------------------------------------------------------------

// The evidence gates are errors in validate.mjs (and at review start), warnings elsewhere.
const GATES = { evidenceGates: 'error' };
const warningsOf = (report, opts) => validateReport(report, opts).warnings.map((w) => `${w.path}: ${w.message}`);
function expectWarning(report, pattern, opts) {
  const warnings = warningsOf(report, opts);
  assert.ok(warnings.some((w) => pattern.test(w)), `expected a warning matching ${pattern}, got:\n${warnings.join('\n')}`);
}
const recomputed = (r) => ({ ...r, scorecard: computeScorecard(r) });

test('INCOMPLETE: a pass that compared nothing never reads REVIEW at match 100%', () => {
  // The capture landed on a sign-in page: both designed states CANNOT_VERIFY, the only findings are auth notes.
  const r = loadFixture('report-valid.json');
  r.stateMatrix = r.stateMatrix.filter((row) => ['with-data', 'error'].includes(row.state)).map((row) => ({ ...row, result: 'CANNOT_VERIFY', findings: [] }));
  r.findings = r.findings.filter((f) => f.id === 'DQ-006');
  r.ledgers = { structure: [], component: [], style: [], state: [], behavior: [], motion: [] };
  r.openDecisions = [];
  r.fixLoop = [];
  r.scorecard = { ...computeScorecard(r), verdict: 'REVIEW', match: 100, loopClosed: true };
  expectError(r, /^scorecard\.verdict: expected INCOMPLETE \(no state was verified \(0 of 2 captured and compared: 2 CANNOT_VERIFY\); nothing was captured and compared: fix the capture/, GATES);
  expectError(r, /^scorecard\.match: expected null \(no state was verified, so match is not measured\), got 100$/, GATES);
  expectError(r, /^scorecard\.loopClosed: expected false \(unexplained 0, open decisions 0, verdict INCOMPLETE\), got true$/, GATES);
  const fixed = recomputed(r);
  assert.deepEqual([fixed.scorecard.verdict, fixed.scorecard.match, fixed.scorecard.loopClosed], ['INCOMPLETE', null, false]);
  assert.deepEqual(errorsOf(fixed, GATES), [], 'the schema takes verdict INCOMPLETE and match null');
  const schema = loadSchema('report').definitions.scorecard.properties;
  assert.ok(schema.verdict.enum.includes('INCOMPLETE'));
  assert.deepEqual(schema.match.type, ['integer', 'null']);
});

test('pins: an open FIX_CODE finding needs an evidence entry with state and crop, or a real unpinnedReason', () => {
  const r = loadFixture('report-valid.json');
  r.findings[2].evidence[0].crop = null; // DQ-003, hover
  r.scorecard = computeScorecard(r);
  expectError(r, /^findings\[2\]\.evidence: an open FIX_CODE finding needs a pin: an evidence entry with both "state" and "crop" \{ x, y, w, h \} in that image's pixels \(no entry has a crop\)\. Only a finding with no place on any capture goes without, with findings\[2\]\.unpinnedReason saying why$/, GATES);
  assert.equal(r.scorecard.unpinned, 1);

  const cropNoState = loadFixture('report-valid.json');
  cropNoState.findings[2].evidence[0].state = null;
  cropNoState.scorecard = computeScorecard(cropNoState);
  expectError(cropNoState, /^findings\[2\]\.evidence: .*\(a crop but no state\)/, GATES);

  const short = structuredClone(r);
  short.findings[2].unpinnedReason = 'no pin';
  expectError(short, /^findings\[2\]\.unpinnedReason: must say why the finding has no place on any capture: what is absent, where \(at least 20 characters, got 6\)$/, GATES);
  const reasoned = structuredClone(r);
  reasoned.findings[2].unpinnedReason = 'The hover tooltip never renders in the app, so nothing on the capture marks it.';
  assert.deepEqual(errorsOf(reasoned, GATES), []);

  // Exempt without a reason: the state is MISSING_IN_CODE and nothing of it was captured.
  const missing = loadFixture('report-valid.json');
  missing.findings[0].state = 'loading';
  missing.findings[0].evidence = [{ type: 'design', path: 'figma/loading.png', crop: null, state: 'loading' }];
  missing.scorecard = computeScorecard(missing);
  assert.ok(!errorsOf(missing, GATES).some((e) => e.startsWith('findings[0]')), errorsOf(missing, GATES).join('\n'));
  assert.equal(missing.scorecard.unpinned, 1, 'still counted: the report shows how many findings have no pin');

  const both = loadFixture('report-valid.json');
  both.findings[2].unpinnedReason = 'This one has a pin anyway, so the reason is ignored.';
  expectWarning(both, /^findings\[2\]\.unpinnedReason: is ignored: the finding has a pin$/);

  const drift = loadFixture('report-valid.json');
  drift.scorecard.unpinned = 3;
  expectError(drift, /^scorecard\.unpinned: expected 0 \(open FIX_CODE findings without an evidence entry carrying both state and crop\), got 3$/, GATES);

  const many = loadFixture('report-valid.json');
  for (const f of many.findings.filter((x) => x.resolution === 'FIX_CODE')) {
    f.evidence = f.evidence.map((e) => ({ ...e, crop: null }));
    f.unpinnedReason = 'Absent from the capture: nothing on the page to point at.';
  }
  many.scorecard = computeScorecard(many);
  assert.deepEqual(errorsOf(many, GATES), []);
  expectWarning(many, /^findings: 5 of 5 open FIX_CODE findings have no pin: unpinnedReason is for findings with no place on any capture/);
});

test('crops: one that starts outside its image is an error, one that runs past an edge a warning', () => {
  const r = loadFixture('report-valid.json');
  r.findings[2].evidence[0].crop = { x: 1500, y: 240, w: 40, h: 40 }; // hover screenshot, 1440 wide
  expectError(r, /^findings\[2\]\.evidence\[0\]\.crop: lies outside the app image of state "hover": x 1500 is past its width 1440 \(meta\.app\.viewport × meta\.app\.dpr\); measure the crop in that image's pixels$/, GATES);

  const edge = loadFixture('report-valid.json');
  edge.findings[2].evidence[0].crop = { x: 1400, y: 240, w: 100, h: 40 };
  assert.deepEqual(errorsOf(edge, GATES), []);
  expectWarning(edge, /^findings\[2\]\.evidence\[0\]\.crop: runs past the edge of the app image of state "hover" \(1440×\?; x \+ w = 1500, y \+ h = 280\): clip it to the image$/);

  // Heights are checked only when diff.mjs recorded them (a full-page capture is taller than the viewport).
  const tall = loadFixture('report-valid.json');
  tall.findings[2].evidence[0].crop = { x: 24, y: 2400, w: 1392, h: 56 };
  assert.deepEqual(errorsOf(tall, GATES), [], 'no height known: a full-page capture may be this tall');
  Object.assign(tall.scorecard.pixelDiff.hover, { designHeight: 900, appHeight: 900, padded: null });
  expectError(tall, /^findings\[2\]\.evidence\[0\]\.crop: lies outside the app image of state "hover": y 2400 is past its height 900 \(scorecard\.pixelDiff\.hover\.appHeight\)/, GATES);

  const design = loadFixture('report-valid.json');
  design.findings[0].evidence[1].crop = { x: 1440, y: 0, w: 10, h: 10 };
  expectError(design, /^findings\[0\]\.evidence\[1\]\.crop: lies outside the design image of state "empty": x 1440 is past its width 1440 \(meta\.source\.frame\)/, GATES);
});

test('remote target: findings are grounded in the capture; meta.target matches the URL; a source-checkout note is expected', () => {
  const r = loadFixture('report-valid.json');
  r.meta.app.url = 'https://staging.acme.dev/items';
  r.meta.app.commit = '9f3c2a1e7b4d8c06a5f2e19d3b7c4a8e0f6d2b51';
  // Filed from a local checkout: only a design-side image and a source file.
  r.findings[3].evidence = [{ type: 'design', path: 'figma/with-data.png', crop: { x: 24, y: 200, w: 300, h: 40 }, state: 'with-data' }];
  expectError(r, /^findings\[3\]\.evidence: the target is a deployed build \("https:\/\/staging\.acme\.dev\/items"\): ground the finding in the capture with evidence of type screenshot, computed, dom, motion, diff; a source file is only a hint from a local checkout that may differ from what is deployed$/, GATES);
  assert.equal(errorsOf(r, GATES).filter((e) => /deployed build/.test(e)).length, 1, 'findings with app-side evidence pass');
  expectWarning(r, /^meta\.target: the target is a deployed build and the local checkout's commit is unknown \(meta\.target\.localCommit\): add a meta\.degradations entry/);

  r.meta.target = { kind: 'local', localCommit: '1a2b3c4d5e6f', deployedCommit: null };
  expectError(r, /^meta\.target\.kind: must be "remote": meta\.app\.url "https:\/\/staging\.acme\.dev\/items" is not a local host \(a deployed build\)$/, GATES);
  r.meta.target.kind = 'remote';
  expectWarning(r, /^meta\.target: the target is a deployed build and the local checkout \(1a2b3c4d5e6f\) differs from the deployed build \(9f3c2a1e7b4d\)/);
  r.meta.degradations.push({ step: 'source trace', reason: 'Local checkout 1a2b3c4 is behind the deployed build 9f3c2a1.', impact: 'File references are hints; findings come from the captured DOM.' });
  assert.ok(!warningsOf(r).some((w) => w.startsWith('meta.target')), 'the degradation note answers the warning');
  r.meta.degradations.pop();
  r.meta.target.localCommit = '9f3c2a1';
  assert.ok(!warningsOf(r).some((w) => w.startsWith('meta.target')), 'same commit (prefix): no note needed');

  const local = loadFixture('report-valid.json');
  local.findings[3].evidence = [{ type: 'design', path: 'figma/with-data.png', crop: { x: 24, y: 200, w: 300, h: 40 }, state: 'with-data' }];
  assert.deepEqual(errorsOf(local, GATES), [], 'a local target may cite source files');
  local.meta.target = { kind: 'remote' };
  expectError(local, /^meta\.target\.kind: must be "local": meta\.app\.url "http:\/\/localhost:3000\/items" is a local host$/, GATES);
});

test('full-length comparison: a design image shorter than the known frame is a truncated comparison', () => {
  const r = loadFixture('report-valid.json');
  r.meta.source.frame = { width: 1440, height: 4292 };
  r.meta.figma.frame = { width: 1440, height: 4292 };
  Object.assign(r.scorecard.pixelDiff['with-data'], { designHeight: 1080, appHeight: 1080, padded: null });
  expectError(r, /^scorecard\.pixelDiff\["with-data"\]\.designHeight: the design image is 1080 px tall but the design frame is 4292 px \(meta\.source\.frame\): only the top 1080 px were compared\. Export the full frame, capture the app full-page and re-run diff\.mjs \(it pads the smaller image\), or record a meta\.degradations entry \{ "step": "capture-coverage:with-data", "reason": "<why only part was compared>", "impact": "…" \} \(when this state's frame differs from that, set stateMatrix\[\]\.designed\.frame\)$/, GATES);
  expectWarning(r, /^scorecard\.pixelDiff\.empty: does not record designHeight and appHeight: cannot check that the full 4292 px frame \(meta\.source\.frame\) was compared; copy them from diff\.mjs$/);

  const explained = structuredClone(r);
  explained.meta.degradations.push({ step: 'capture-coverage:with-data', reason: 'with-data compared on the top 1080 px only', impact: 'below the fold not compared' });
  assert.ok(!errorsOf(explained, GATES).some((e) => e.includes('designHeight')));
  // Only a degradation about this state's coverage explains it: not a routine one naming the
  // state, not a truncation note about another state.
  const routine = structuredClone(r);
  routine.meta.degradations.push(
    { step: 'motion:with-data', reason: 'reading the transitions of with-data failed', impact: 'motion not compared' },
    { step: 'capture:empty', reason: 'empty compared on the top 900 px only', impact: 'below not compared' },
  );
  assert.ok(errorsOf(routine, GATES).some((e) => e.includes('designHeight')), 'a routine degradation does not excuse a truncated comparison');
  const stepped = structuredClone(r);
  stepped.meta.degradations.push({ step: 'capture-coverage:with-data', reason: 'The frame is a 4292 px canvas export.', impact: 'Below 1080 px nothing is compared.' });
  assert.ok(!errorsOf(stepped, GATES).some((e) => e.includes('designHeight')), 'the capture-coverage step');

  const ownFrame = structuredClone(r);
  ownFrame.stateMatrix[0].designed.frame = { width: 1440, height: 1080 };
  assert.ok(!errorsOf(ownFrame, GATES).some((e) => e.includes('designHeight')), 'stateMatrix[].designed.frame wins over meta.source.frame');

  // Full design, viewport-only app: diff.mjs pads the app, the missing part counts as different. Not truncated.
  const padded = loadFixture('report-valid.json');
  padded.meta.source.frame = { width: 1440, height: 4292 };
  padded.meta.figma.frame = { width: 1440, height: 4292 };
  Object.assign(padded.scorecard.pixelDiff['with-data'], { designHeight: 4292, appHeight: 3092, padded: { side: 'app', rows: 1200 } });
  assert.ok(!errorsOf(padded, GATES).some((e) => e.includes('pixelDiff')), errorsOf(padded, GATES).join('\n'));
  assert.ok(!warningsOf(padded).some((w) => w.includes('with-data"].padded')));
  padded.scorecard.pixelDiff['with-data'].padded = null;
  expectWarning(padded, /^scorecard\.pixelDiff\["with-data"\]\.padded: expected \{ "side": "app", "rows": 1200 \} \(designHeight 4292, appHeight 3092\): copy it from diff\.mjs$/);
});

test('pixelDiff heights and padding survive render-report.mjs --recompute --write-back', async () => {
  const dir = tmpDir();
  const r = loadFixture('report-valid.json');
  Object.assign(r.scorecard.pixelDiff['with-data'], { designHeight: 900, appHeight: 900, padded: null });
  Object.assign(r.scorecard.pixelDiff.empty, { designHeight: 900, appHeight: 700, padded: { side: 'app', rows: 200 } });
  r.stateMatrix[1].captured.page.height = 700; // the app page itself is 700 px tall (captured whole)
  delete r.scorecard.unpinned;
  const file = path.join(dir, 'report.json');
  writeFileSync(file, JSON.stringify(r));
  const res = await run(script('render-report.mjs'), ['--in', file, '--out', path.join(dir, 'r.html'), '--template', fixture('template.html'), '--recompute', '--write-back']);
  assert.equal(res.code, 0, res.stderr);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(saved.scorecard.pixelDiff.empty, { percent: 7.2, band: 'fail', image: 'diff/empty.png', designHeight: 900, appHeight: 700, padded: { side: 'app', rows: 200 } });
  assert.deepEqual(saved.scorecard.pixelDiff['with-data'].padded, null);
  assert.equal(saved.scorecard.unpinned, 0, '--recompute writes unpinned');
  onlyBuildErrors(await run(VALIDATE, [file]));
});

test('design-system audit: open findings with no token or component finding and no audit is a warning', () => {
  const r = loadFixture('report-valid.json');
  for (const f of r.findings) if (['style', 'component'].includes(f.ledger) && f.resolution === 'FIX_CODE') f.ledger = 'structure';
  r.scorecard = computeScorecard(r);
  assert.deepEqual([r.scorecard.designSystem.tokens, r.scorecard.designSystem.components], [null, null], 'not checked, never 0');
  const message = /^meta\.tools\.dsAudit: no design-system audit was run: token and component mismatches were not looked for\. Run the design-system audit/;
  expectWarning(r, message);
  r.meta.tools.dsAudit = 'none';
  expectWarning(r, message);
  r.meta.tools.dsAudit = 'script';
  r.meta.dsAudit = { elementsChecked: 1480, offTokenValues: 0, nonSystemComponents: 0, output: 'evidence/ds-audit.json' };
  r.scorecard = computeScorecard(r);
  assert.deepEqual([r.scorecard.designSystem.tokens, r.scorecard.designSystem.components], [0, 0]);
  assert.ok(!warningsOf(r).some((w) => w.startsWith('meta.tools.dsAudit')));
  assert.deepEqual(errorsOf(r, GATES), []);
  // The audit ran and its candidates were rejected: the empty section is the rejections' doing.
  r.rejections = [{ kind: 'audit', key: 'style:radius:999px', state: 'with-data', screen: null, reason: 'out-of-scope', detail: 'Audit noise from the theme, not ours.', percentOfPage: null, crop: null, knownDrift: null, duplicateOf: null, coveredBy: null }];
  expectWarning(r, /^rejections: 0 token and 0 component findings beside open findings, and 1 design-system audit candidate\(s\) rejected: check each rejection/);
  // A check that did not run says why, never 0 (meta.notChecked, written by build-report.mjs).
  r.meta.notChecked = { components: 'no component library is configured: set designSystem.libraries in design-qa.config.json' };
  r.scorecard = computeScorecard(r);
  assert.deepEqual([r.scorecard.designSystem.tokens, r.scorecard.designSystem.components], [0, null]);
  r.scorecard.designSystem.components = 0;
  expectError(r, /^scorecard\.designSystem\.components: expected null \(not checked: no component library is configured/);
  r.meta.tools.dsAudit = 'maybe';
  expectError(r, /^meta\.tools\.dsAudit: expected one of script, manual, none \(got "maybe"\)$/, GATES);
  assert.ok(!warningsOf(loadFixture('report-valid.json')).some((w) => w.startsWith('meta.tools.dsAudit')), 'token or component findings exist: no warning');
});

test('docs: --help describes the evidence gates and INCOMPLETE', async () => {
  const help = (await run(VALIDATE, ['--help'])).stdout.replace(/\s+/g, ' ');
  for (const s of ['INCOMPLETE when nothing was captured and compared', 'Evidence gates', 'unpinnedReason (at least 20 characters', 'on a remote target', 'truncated comparison', 'no design-system audit was run']) {
    assert.ok(help.includes(s), s);
  }
});

test('evidence gates are warnings by default (old reports still go through) and errors with evidenceGates "error"', () => {
  const r = loadFixture('report-valid.json');
  delete r.scorecard.unpinned; // a 0.2.1 report has no unpinned count
  r.findings[2].evidence[0].crop = null; // unpinned
  r.meta.app.url = 'https://staging.acme.dev/items';
  r.findings[3].evidence = [{ type: 'design', path: 'figma/with-data.png', crop: { x: 24, y: 200, w: 300, h: 40 }, state: 'with-data' }];
  const lenient = validateReport(r);
  assert.deepEqual(lenient.errors, [], 'structural and derived rules still pass');
  const gateWarnings = lenient.warnings.filter(isGateIssue).map((w) => w.path);
  assert.deepEqual(gateWarnings, ['findings[2].evidence', 'findings[3].evidence']);
  const strict = validateReport(r, GATES);
  assert.deepEqual(strict.errors.map((e) => e.path), ['findings[2].evidence', 'findings[3].evidence']);
  assert.ok(strict.errors.every(isGateIssue));
  assert.deepEqual(Object.keys(strict.errors[0]), ['path', 'message'], 'the gate flag stays out of JSON output');
});

test('whole page: width truncation, right padding, app captures smaller than the page, missing page records, clipped panels', () => {
  const r = loadFixture('report-valid.json');
  // Design: a 1920-wide frame compared on its left 1440 px.
  r.meta.source.frame = { width: 1920, height: 900 };
  r.meta.figma.frame = { width: 1920, height: 900 };
  Object.assign(r.scorecard.pixelDiff['with-data'], { designHeight: 900, appHeight: 900, padded: null, designWidth: 1440, appWidth: 1780, paddedRight: null });
  expectError(r, /^scorecard\.pixelDiff\["with-data"\]\.designWidth: the design image is 1440 px wide but the design frame is 1920 px \(meta\.source\.frame\): only the left 1440 px were compared\./, GATES);
  expectWarning(r, /^scorecard\.pixelDiff\["with-data"\]\.paddedRight: expected \{ "side": "design", "cols": 340 \} \(designWidth 1440, appWidth 1780\): copy it from diff\.mjs$/);
  r.scorecard.pixelDiff['with-data'].paddedRight = { side: 'design', cols: 340 };
  assert.ok(!warningsOf(r).some((w) => w.includes('paddedRight')));

  // App: the page scrolls to 4292 px but only the first screen was captured.
  const app = loadFixture('report-valid.json');
  app.stateMatrix[0].captured.page = { width: 1440, height: 4292, fullPage: false, clipped: 0 };
  expectError(app, /^stateMatrix\[0\]\.captured\.page: the app capture of state "with-data" is 1440×900 but the page is 1440×4292: only the top 900 px were captured; capture the whole page \(capture\.mjs captures the full scroll size by default\) and re-run diff\.mjs, or record a meta\.degradations entry \{ "step": "capture-coverage:with-data", "reason": "<why only part was captured>", "impact": "…" \}$/, GATES);
  assert.ok(validateReport(app).warnings.some((w) => isGateIssue(w) && w.path === 'stateMatrix[0].captured.page'), 'a warning outside validate.mjs');
  app.stateMatrix[0].captured.page = { width: 1920, height: 4292, fullPage: true, clipped: 0, image: { width: 1440, height: 4292 } };
  expectError(app, /the app capture of state "with-data" is 1440×4292 but the page is 1920×4292: only the left 1440 px were captured/, GATES);
  app.stateMatrix[0].captured.page = { width: 1440, height: 4292, fullPage: true, clipped: 0 };
  Object.assign(app.scorecard.pixelDiff['with-data'], { appWidth: 1440, appHeight: 4292 });
  assert.ok(!errorsOf(app, GATES).some((e) => e.includes('captured.page')), 'the whole page (size from pixelDiff appWidth/appHeight)');
  app.stateMatrix[0].captured.page.image = { width: 1440, height: 1080 };
  app.meta.degradations.push({ step: 'capture', reason: 'with-data: the page streams rows forever, captured the top 1080 px; full-page capture impossible', impact: 'below not compared' });
  assert.ok(errorsOf(app, GATES).some((e) => e.includes('captured.page')), 'free text never excuses a partial capture, whatever it says');
  app.meta.degradations.push({ step: 'capture-coverage:with-data', reason: 'the page streams rows forever', impact: 'below the first 1080 px not compared' });
  assert.ok(!errorsOf(app, GATES).some((e) => e.includes('captured.page')), 'the exact capture-coverage:<state> step explains it');

  const missing = loadFixture('report-valid.json');
  delete missing.stateMatrix[4].captured.page; // hover
  expectWarning(missing, /^stateMatrix\[4\]\.captured\.page: is missing: cannot check that the whole page was captured for state "hover"/);
  const clipped = loadFixture('report-valid.json');
  clipped.stateMatrix[0].captured.page.clipped = 1;
  expectWarning(clipped, /^stateMatrix\[0\]\.captured\.page\.clipped: 1 scroll container of state "with-data" still hides content: what is inside was not compared/);
  const routineClip = structuredClone(clipped);
  routineClip.meta.degradations.push({ step: 'mock:with-data', reason: 'a mock of with-data matched no request', impact: 'the state may show loaded data' });
  assert.ok(warningsOf(routineClip).some((w) => w.includes('clipped')), 'a routine degradation naming the state does not explain hidden content');
  clipped.meta.degradations.push({ step: 'capture', reason: 'with-data: the side panel scrolls independently', impact: 'its lower half not compared' });
  assert.ok(!warningsOf(clipped).some((w) => w.includes('clipped')));
});

test('meta.screens[].variantOf: optional; an unknown screen id is a warning', () => {
  const r = loadFixture('report-multiscreen.json');
  r.meta.screens.push({ id: 'cart-600', name: 'Cart 600', designRef: null, appRoute: '/cart', frame: { width: 600, height: 1400 }, variantOf: 'cart' });
  assert.deepEqual(errorsOf(r), []);
  assert.ok(!warningsOf(r).some((w) => w.includes('variantOf')));
  r.meta.screens[2].variantOf = 'basket';
  expectWarning(r, /^meta\.screens\[2\]\.variantOf: references unknown screen "basket" \(meta\.screens: cart, checkout, cart-600\)$/);
});
