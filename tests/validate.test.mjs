import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  inferType,
  loadSchema,
  validateAgainstSchema,
  validateConfig,
  validateReport,
  validateStateMatrix,
} from '../skills/design-qa/scripts/lib/schema-check.mjs';
import { computeScorecard, rankFindings } from '../skills/design-qa/scripts/lib/ranking.mjs';
import { applyTriage, buildTriage } from '../skills/design-qa/scripts/lib/triage.mjs';
import { ROOT, fixture, loadFixture, run, script, tmpDir } from './_helpers.mjs';

const VALIDATE = script('validate.mjs');

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
  r.scorecard.parity = 120;
  r.findings[1].fix.effort = 9;
  r.meta.generatedAt = 'yesterday';
  r.meta.app.viewport.width = '1440';
  r.meta.app.url = 'localhost:3000';
  expectError(r, /^findings\[0\]\.id: must match \^DQ-\\d\{3,\}\$ \(got "DQ-1"\)$/);
  expectError(r, /^scorecard\.parity: must be <= 100 \(got 120\)$/);
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
  r.scorecard.verdict = 'REVIEW';
  r.scorecard.bySeverity.WARNING = 2;
  r.scorecard.byResolution.NONE = 1;
  r.scorecard.stateCoverage.verified = 5;
  r.scorecard.pixelDiff.empty.band = 'review';
  expectError(r, /^scorecard\.parity: expected 38 \(5 open of 8 findings; 1 dismissed not counted\), got 80$/);
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
  has(/^app\.baseUrl: must be an absolute http\(s\) URL or a \$\{ENV_VAR\} placeholder \(got "localhost:3000"\)$/);
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
  const ok = await run(VALIDATE, [fixture('report-valid.json')]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /OK\s+.*report-valid\.json is a valid report \(0 warnings\)/);

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

  const quiet = await run(VALIDATE, [fixture('report-valid.json'), '--quiet']);
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
