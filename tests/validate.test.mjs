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
import { rankFindings } from '../skills/design-qa/scripts/lib/ranking.mjs';
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
  expectError(r, /^stateMatrix\[1\]\.result: expected one of PASS, FAIL, CANNOT_VERIFY, MISSING_IN_CODE, MISSING_IN_DESIGN, NOT_SPECIFIED/);
  expectError(r, /^meta\.mode: expected one of audit, fix, sync, ci/);
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
  expectError(r, /^stateMatrix\[0\]\.findings\[3\]: references unknown finding "DQ-098"$/);
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
  expectError(r, /^scorecard\.parity: expected 43 \(4 open of 7 findings\), got 80$/);
  expectError(r, /^scorecard\.verdict: expected FAIL \(DQ-001 is an open BLOCKER/);
  expectError(r, /^scorecard\.bySeverity\.WARNING: expected 3 \(counted from findings\[\]\.severity\), got 2$/);
  expectError(r, /^scorecard\.byResolution\.NONE: expected 2/);
  expectError(r, /^scorecard\.stateCoverage\.verified: expected 3/);
  expectError(r, /^scorecard\.pixelDiff\.empty\.band: expected "fail" for 7\.2% \(pass < 1, review <= 5\), got "review"$/);
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

test('rank buckets: only FIX_CODE fills fix-now/debt, only SYNC_FIGMA fills sync-figma (errors)', () => {
  const ranked = () => {
    const r = loadFixture('report-valid.json');
    r.findings = rankFindings(r.findings);
    return r;
  };
  assert.deepEqual(errorsOf(ranked()), [], 'ranks from rankFindings are valid');

  const syncInFixNow = ranked();
  syncInFixNow.findings[2].rank = { score: 233, bucket: 'fix-now' }; // DQ-003 is SYNC_FIGMA
  expectError(syncInFixNow, /^findings\[2\]\.rank\.bucket: must be "sync-figma" for a SYNC_FIGMA finding: fix-now and debt are for FIX_CODE only \(got "fix-now"\)$/);

  const fixInSync = ranked();
  fixInSync.findings[1].rank = { score: 225, bucket: 'sync-figma' }; // DQ-002 is FIX_CODE
  expectError(fixInSync, /^findings\[1\]\.rank\.bucket: must be "fix-now" or "debt" for a FIX_CODE finding with severity BLOCKER, WARNING or DS_CANDIDATE \(got "sync-figma"\)$/);

  const unrankedInDebt = ranked();
  unrankedInDebt.findings[4].rank = { score: 0, bucket: 'debt' }; // DQ-005 is PASS / NONE
  unrankedInDebt.findings[6].rank = { score: 0, bucket: 'sync-figma' }; // DQ-007 is INTENTIONAL
  expectError(unrankedInDebt, /^findings\[4\]\.rank\.bucket: must be "none": only FIX_CODE and SYNC_FIGMA findings with severity BLOCKER, WARNING or DS_CANDIDATE are ranked \(got "debt"\)$/);
  expectError(unrankedInDebt, /^findings\[6\]\.rank\.bucket: must be "none"/);

  const unknownBucket = ranked();
  unknownBucket.findings[0].rank = { score: 334, bucket: 'later' };
  expectError(unknownBucket, /^findings\[0\]\.rank\.bucket: expected one of fix-now, debt, sync-figma, none \(got "later"\)$/);

  assert.equal(validateReport(syncInFixNow, { skipRanks: true }).valid, true, 'skipRanks ignores ranks about to be recomputed');
});

test('a fix-now/debt split that differs from topN is a warning, not an error', () => {
  const r = loadFixture('report-valid.json');
  r.findings = rankFindings(r.findings, { topN: 1 }); // DQ-002 and DQ-004 land in debt
  const result = validateReport(r); // default topN 5 would put them in fix-now
  assert.equal(result.valid, true);
  assert.deepEqual(
    result.warnings.map((w) => `${w.path}: ${w.message}`),
    [
      'findings[1].rank.bucket: is "debt" but the ranking rules give "fix-now" (score 225, topN 5)',
      'findings[3].rank.bucket: is "debt" but the ranking rules give "fix-now" (score 123, topN 5)',
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
