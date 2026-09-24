import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUCKETS,
  band,
  bucketKind,
  compareIds,
  computeScorecard,
  deriveVerdict,
  explainVerdict,
  findingsInBucket,
  parity,
  rankFindings,
  resolveOptions,
  scoreFinding,
  stateCoverage,
} from '../skills/design-qa/scripts/lib/ranking.mjs';
import { loadFixture } from './_helpers.mjs';

const finding = (id, severity, resolution, ledger = 'style', effort) => ({
  id,
  title: id,
  ledger,
  severity,
  resolution,
  fix: effort === undefined ? null : { summary: 's', files: [], effort },
});

const baseReport = (over = {}) => ({
  findings: [],
  stateMatrix: [],
  openDecisions: [],
  scorecard: { pixelDiff: {} },
  ...over,
});

test('band: pass below the pass tolerance, review up to and including review, fail above', () => {
  assert.equal(band(0), 'pass');
  assert.equal(band(0.99), 'pass');
  assert.equal(band(1), 'review');
  assert.equal(band(5), 'review');
  assert.equal(band(5.01), 'fail');
  assert.equal(band(0.4, { pass: 0.5, review: 3 }), 'pass');
  assert.equal(band(3.5, { pixelDiff: { pass: 0.5, review: 3 } }), 'fail', 'accepts config.tolerances shape');
});

test('parity counts FIX_CODE, SYNC_FIGMA and UNCLASSIFIED as open', () => {
  assert.equal(parity([]), 100);
  const f = [
    finding('DQ-001', 'WARNING', 'FIX_CODE'),
    finding('DQ-002', 'WARNING', 'SYNC_FIGMA'),
    finding('DQ-003', 'WARNING', 'UNCLASSIFIED'),
    finding('DQ-004', 'WARNING', 'INTENTIONAL'),
    finding('DQ-005', 'PASS', 'NONE'),
    finding('DQ-006', 'WARNING', 'DATA'),
  ];
  assert.equal(parity(f), 50);
  assert.equal(parity(f.filter((x) => !['FIX_CODE', 'SYNC_FIGMA', 'UNCLASSIFIED'].includes(x.resolution))), 100);
});

test('parity is never 100 while something is open', () => {
  const many = Array.from({ length: 300 }, (_, i) => finding(`DQ-${String(i + 1).padStart(3, '0')}`, 'PASS', 'NONE'));
  many[0] = finding('DQ-001', 'WARNING', 'FIX_CODE');
  assert.equal(parity(many), 99);
});

test('scoreFinding: severity×100 + ledger×10 + (6 − effort); null when not rankable', () => {
  assert.equal(scoreFinding(finding('DQ-001', 'BLOCKER', 'FIX_CODE', 'structure', 2)), 334);
  assert.equal(scoreFinding(finding('DQ-002', 'WARNING', 'SYNC_FIGMA', 'style')), 223, 'missing fix → effort 3');
  assert.equal(scoreFinding(finding('DQ-003', 'DS_CANDIDATE', 'FIX_CODE', 'behavior', 5)), 121);
  assert.equal(scoreFinding(finding('DQ-004', 'WARNING', 'UNCLASSIFIED')), null);
  assert.equal(scoreFinding(finding('DQ-005', 'WARNING', 'INTENTIONAL')), null);
  assert.equal(scoreFinding(finding('DQ-006', 'PASS', 'NONE')), null);
  assert.equal(scoreFinding(finding('DQ-007', 'CANNOT_VERIFY', 'NONE')), null);
});

test('rankFindings: FIX_CODE fills fix-now then debt, SYNC_FIGMA goes to sync-figma, the rest none', () => {
  const report = loadFixture('report-valid.json');
  const input = structuredClone(report.findings);
  const ranked = rankFindings(report.findings, { topN: 2 });
  assert.deepEqual(report.findings, input, 'input not mutated');
  assert.deepEqual(ranked.map((f) => f.id), input.map((f) => f.id), 'same order as input');
  const byId = Object.fromEntries(ranked.map((f) => [f.id, f.rank]));
  assert.deepEqual(byId['DQ-001'], { score: 334, bucket: 'fix-now' });
  assert.deepEqual(byId['DQ-002'], { score: 225, bucket: 'fix-now' });
  assert.deepEqual(byId['DQ-004'], { score: 123, bucket: 'debt' });
  assert.deepEqual(byId['DQ-003'], { score: 233, bucket: 'sync-figma' }, 'SYNC_FIGMA never takes a fix-now slot, even with a higher score');
  for (const id of ['DQ-005', 'DQ-006', 'DQ-007']) assert.deepEqual(byId[id], { score: 0, bucket: 'none' });
  assert.deepEqual(findingsInBucket(ranked, 'fix-now').map((f) => f.id), ['DQ-001', 'DQ-002']);
  assert.deepEqual(findingsInBucket(ranked, 'debt').map((f) => f.id), ['DQ-004']);
  assert.deepEqual(findingsInBucket(ranked, 'sync-figma').map((f) => f.id), ['DQ-003']);
  assert.deepEqual(BUCKETS, ['fix-now', 'debt', 'sync-figma', 'none']);
});

test('rankFindings: ties by id ascending inside each list; sync-figma ordered by score', () => {
  const f = [
    finding('DQ-010', 'WARNING', 'FIX_CODE', 'style', 3),
    finding('DQ-002', 'WARNING', 'SYNC_FIGMA', 'style', 3),
    finding('DQ-009', 'WARNING', 'FIX_CODE', 'style', 3),
    finding('DQ-1000', 'WARNING', 'FIX_CODE', 'style', 3),
    finding('DQ-003', 'BLOCKER', 'SYNC_FIGMA', 'structure', 1),
    finding('DQ-001', 'WARNING', 'SYNC_FIGMA', 'style', 3),
  ];
  const ranked = rankFindings(f, { topN: 2 });
  assert.deepEqual(findingsInBucket(ranked, 'fix-now').map((x) => x.id), ['DQ-009', 'DQ-010']);
  assert.deepEqual(findingsInBucket(ranked, 'debt').map((x) => x.id), ['DQ-1000']);
  assert.deepEqual(findingsInBucket(ranked, 'sync-figma').map((x) => x.id), ['DQ-003', 'DQ-001', 'DQ-002']);
  assert.equal(ranked.find((x) => x.id === 'DQ-003').rank.score, 335, 'sync-figma keeps its score');
  assert.ok(compareIds('DQ-999', 'DQ-1000') < 0);
  assert.equal(bucketKind(finding('DQ-1', 'WARNING', 'FIX_CODE')), 'fix-code');
  assert.equal(bucketKind(finding('DQ-1', 'DS_CANDIDATE', 'SYNC_FIGMA')), 'sync-figma');
  assert.equal(bucketKind(finding('DQ-1', 'WARNING', 'UNCLASSIFIED')), 'none');
  assert.equal(bucketKind(finding('DQ-1', 'PASS', 'NONE')), 'none');
});

test('rankFindings: non-rankable findings are { score: 0, bucket: "none" }', () => {
  const ranked = rankFindings([
    finding('DQ-001', 'WARNING', 'UNCLASSIFIED'),
    finding('DQ-002', 'BLOCKER', 'INTENTIONAL'),
    finding('DQ-003', 'WARNING', 'DATA'),
    finding('DQ-004', 'PASS', 'NONE'),
    finding('DQ-005', 'CANNOT_VERIFY', 'NONE'),
  ]);
  for (const f of ranked) assert.deepEqual(f.rank, { score: 0, bucket: 'none' }, f.id);
});

test('ranking weights and topN come from config report.ranking / report.topN', () => {
  const f = [finding('DQ-001', 'WARNING', 'FIX_CODE', 'style', 3), finding('DQ-002', 'WARNING', 'FIX_CODE', 'component', 3)];
  const defaults = findingsInBucket(rankFindings(f), 'fix-now').map((x) => x.id);
  assert.deepEqual(defaults, ['DQ-002', 'DQ-001']);
  const config = { report: { topN: 1, ranking: { ledger: { style: 9 } } } };
  const ranked = rankFindings(f, config);
  assert.deepEqual(findingsInBucket(ranked, 'fix-now').map((x) => x.id), ['DQ-001']);
  assert.deepEqual(findingsInBucket(ranked, 'debt').map((x) => x.id), ['DQ-002']);
  assert.equal(resolveOptions(config).topN, 1);
  assert.equal(resolveOptions({ ...config, topN: 4 }).topN, 4, 'explicit topN wins');
});

test('verdict: PASS when nothing is open, pending or out of band', () => {
  const r = baseReport({
    findings: [finding('DQ-001', 'PASS', 'NONE'), finding('DQ-002', 'WARNING', 'INTENTIONAL')],
    stateMatrix: [{ state: 'with-data', result: 'PASS' }, { state: 'hover', result: 'NOT_SPECIFIED' }],
    scorecard: { pixelDiff: { 'with-data': { percent: 0.5, band: 'pass' } } },
  });
  assert.equal(deriveVerdict(r), 'PASS');
});

test('verdict: REVIEW triggers', () => {
  const cases = {
    'open warning': { findings: [finding('DQ-001', 'WARNING', 'FIX_CODE')] },
    'unclassified': { findings: [finding('DQ-001', 'WARNING', 'UNCLASSIFIED')] },
    'cannot verify finding': { findings: [finding('DQ-001', 'CANNOT_VERIFY', 'NONE')] },
    'open decision': { openDecisions: [{ id: 'OD-1' }] },
    'review band': { scorecard: { pixelDiff: { empty: { percent: 3, band: 'review' } } } },
    'state cannot verify': { stateMatrix: [{ state: 'error', result: 'CANNOT_VERIFY' }] },
    'missing in design': { stateMatrix: [{ state: 'disabled', result: 'MISSING_IN_DESIGN' }] },
  };
  for (const [name, over] of Object.entries(cases)) assert.equal(deriveVerdict(baseReport(over)), 'REVIEW', name);
});

test('verdict: FAIL triggers', () => {
  const cases = {
    'open blocker': { findings: [finding('DQ-001', 'BLOCKER', 'SYNC_FIGMA')] },
    'missing in code': { stateMatrix: [{ state: 'empty', result: 'MISSING_IN_CODE' }] },
    'fail band': { scorecard: { pixelDiff: { empty: { percent: 12, band: 'fail' } } } },
  };
  for (const [name, over] of Object.entries(cases)) assert.equal(deriveVerdict(baseReport(over)), 'FAIL', name);
  const signedOff = baseReport({ findings: [finding('DQ-001', 'BLOCKER', 'INTENTIONAL')] });
  assert.equal(deriveVerdict(signedOff), 'PASS', 'a signed-off blocker is not open');
  assert.match(explainVerdict(baseReport(cases['open blocker'])).reasons[0], /DQ-001 is an open BLOCKER/);
});

test('verdict uses bands derived from percent and the given tolerances', () => {
  const r = baseReport({ scorecard: { pixelDiff: { empty: { percent: 2, band: 'pass' } } } });
  assert.equal(deriveVerdict(r), 'REVIEW', 'stored band is ignored');
  assert.equal(deriveVerdict(r, { tolerances: { pass: 3, review: 5 } }), 'PASS');
  assert.equal(deriveVerdict(r, { tolerances: { pixelDiff: { pass: 0.5, review: 1 } } }), 'FAIL');
});

test('stateCoverage counts non-null designed/specified/implemented and PASS/FAIL as verified', () => {
  const report = loadFixture('report-valid.json');
  assert.deepEqual(stateCoverage(report.stateMatrix), { total: 5, designed: 4, specified: 3, implemented: 5, verified: 3 });
  assert.deepEqual(stateCoverage([]), { total: 0, designed: 0, specified: 0, implemented: 0, verified: 0 });
});

test('computeScorecard reproduces the fixture scorecard', () => {
  const report = loadFixture('report-valid.json');
  assert.deepEqual(computeScorecard(report), report.scorecard);
});
