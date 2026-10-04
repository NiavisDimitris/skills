import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUCKETS,
  backfillSummary,
  band,
  bucketKind,
  compareIds,
  debtSummary,
  unexplainedFindings,
  computeScorecard,
  deriveVerdict,
  designSystemGroups,
  explainVerdict,
  findingsInBucket,
  isBackfillReady,
  isDismissed,
  isLoopClosed,
  parity,
  pixelDiffBand,
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
const dismissed = (id, severity = 'WARNING') => ({
  ...finding(id, severity, 'DISMISSED'),
  dismissal: { kind: 'not-an-issue', reason: 'noise', by: null, date: '2026-09-24T00:00:00Z', source: 'cli' },
});

// One verified state by default: a pass that verified nothing is REVIEW (tested below).
const baseReport = (over = {}) => ({
  findings: [],
  stateMatrix: [{ state: 'with-data', result: 'PASS' }],
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

test('band: 0% always passes, also with a pass tolerance of 0 (identical images, as diff.mjs)', () => {
  assert.equal(band(0, { pass: 0, review: 5 }), 'pass');
  assert.equal(band(0, { pass: 0, review: 0 }), 'pass');
  assert.equal(band(0.01, { pass: 0, review: 5 }), 'review', 'any difference is review with pass 0');
  assert.equal(band(0.01, { pass: 0, review: 0 }), 'fail');
  assert.equal(pixelDiffBand({ percent: 0 }, { pass: 0, review: 5 }), 'pass');
  const r = baseReport({ scorecard: { pixelDiff: { 'with-data': { percent: 0, band: 'pass' } } } });
  assert.equal(computeScorecard(r, { tolerances: { pass: 0, review: 5 } }).pixelDiff['with-data'].band, 'pass');
  assert.equal(deriveVerdict(r, { tolerances: { pass: 0, review: 5 } }), 'PASS');
});

test('parity counts FIX_CODE and UNCLASSIFIED as open', () => {
  assert.equal(parity([]), 100);
  const f = [
    finding('DQ-001', 'WARNING', 'FIX_CODE'),
    finding('DQ-002', 'WARNING', 'UNCLASSIFIED'),
    finding('DQ-003', 'WARNING', 'INTENTIONAL'),
    finding('DQ-004', 'PASS', 'NONE'),
  ];
  assert.equal(parity(f), 50);
  assert.equal(parity(f.filter((x) => !['FIX_CODE', 'UNCLASSIFIED'].includes(x.resolution))), 100);
});

test('parity: dismissed findings leave the denominator (they are not diffs)', () => {
  const f = [
    finding('DQ-001', 'WARNING', 'FIX_CODE'),
    finding('DQ-002', 'PASS', 'NONE'),
    dismissed('DQ-003'),
    dismissed('DQ-004', 'BLOCKER'),
  ];
  assert.equal(parity(f), 50, '1 open of 2 counted findings');
  assert.equal(parity([dismissed('DQ-001')]), 100, 'only dismissed findings: nothing open');
  assert.equal(parity([finding('DQ-001', 'WARNING', 'FIX_CODE'), dismissed('DQ-002')]), 0);
  assert.equal(isDismissed(dismissed('DQ-001')), true);
  assert.equal(isDismissed(finding('DQ-001', 'WARNING', 'INTENTIONAL')), false);
});

test('parity is never 100 while something is open', () => {
  const many = Array.from({ length: 300 }, (_, i) => finding(`DQ-${String(i + 1).padStart(3, '0')}`, 'PASS', 'NONE'));
  many[0] = finding('DQ-001', 'WARNING', 'FIX_CODE');
  assert.equal(parity(many), 99);
});

test('scoreFinding: severity×100 + ledger×10 + (6 − effort); null when not rankable', () => {
  assert.equal(scoreFinding(finding('DQ-001', 'BLOCKER', 'FIX_CODE', 'structure', 2)), 334);
  assert.equal(scoreFinding(finding('DQ-002', 'WARNING', 'FIX_CODE', 'style')), 223, 'missing fix → effort 3');
  assert.equal(scoreFinding(finding('DQ-008', 'WARNING', 'FIX_CODE', 'motion', 1)), 225, 'motion weighs 2 by default');
  assert.equal(scoreFinding(dismissed('DQ-009')), null);
  assert.equal(scoreFinding(finding('DQ-003', 'DS_CANDIDATE', 'FIX_CODE', 'behavior', 5)), 121);
  assert.equal(scoreFinding(finding('DQ-004', 'WARNING', 'UNCLASSIFIED')), null);
  assert.equal(scoreFinding(finding('DQ-005', 'WARNING', 'INTENTIONAL')), null);
  assert.equal(scoreFinding(finding('DQ-006', 'PASS', 'NONE')), null);
  assert.equal(scoreFinding(finding('DQ-007', 'CANNOT_VERIFY', 'NONE')), null);
});

test('rankFindings: FIX_CODE fills fix-now then debt, everything else is none', () => {
  const report = loadFixture('report-valid.json');
  const input = structuredClone(report.findings);
  const ranked = rankFindings(report.findings, { topN: 2 });
  assert.deepEqual(report.findings, input, 'input not mutated');
  assert.deepEqual(ranked.map((f) => f.id), input.map((f) => f.id), 'same order as input');
  const byId = Object.fromEntries(ranked.map((f) => [f.id, f.rank]));
  assert.deepEqual(byId['DQ-001'], { score: 334, bucket: 'fix-now' });
  assert.deepEqual(byId['DQ-003'], { score: 233, bucket: 'fix-now' });
  assert.deepEqual(byId['DQ-002'], { score: 225, bucket: 'debt' });
  assert.deepEqual(byId['DQ-008'], { score: 225, bucket: 'debt' });
  assert.deepEqual(byId['DQ-004'], { score: 123, bucket: 'debt' });
  for (const id of ['DQ-005', 'DQ-006', 'DQ-007', 'DQ-009']) assert.deepEqual(byId[id], { score: 0, bucket: 'none' }, id);
  assert.deepEqual(findingsInBucket(ranked, 'fix-now').map((f) => f.id), ['DQ-001', 'DQ-003']);
  assert.deepEqual(findingsInBucket(ranked, 'debt').map((f) => f.id), ['DQ-002', 'DQ-008', 'DQ-004']);
  assert.deepEqual(BUCKETS, ['fix-now', 'debt', 'none']);
});

test('rankFindings: ties by id ascending', () => {
  const f = [
    finding('DQ-010', 'WARNING', 'FIX_CODE', 'style', 3),
    finding('DQ-009', 'WARNING', 'FIX_CODE', 'style', 3),
    finding('DQ-1000', 'WARNING', 'FIX_CODE', 'style', 3),
    finding('DQ-003', 'BLOCKER', 'FIX_CODE', 'structure', 1),
  ];
  const ranked = rankFindings(f, { topN: 2 });
  assert.deepEqual(findingsInBucket(ranked, 'fix-now').map((x) => x.id), ['DQ-003', 'DQ-009']);
  assert.deepEqual(findingsInBucket(ranked, 'debt').map((x) => x.id), ['DQ-010', 'DQ-1000']);
  assert.ok(compareIds('DQ-999', 'DQ-1000') < 0);
  assert.equal(bucketKind(finding('DQ-1', 'WARNING', 'FIX_CODE')), 'fix-code');
  assert.equal(bucketKind(dismissed('DQ-1')), 'none');
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
    dismissed('DQ-006', 'BLOCKER'),
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
  };
  for (const [name, over] of Object.entries(cases)) assert.equal(deriveVerdict(baseReport(over)), 'REVIEW', name);
});

test('verdict: REVIEW when no state was verified (an empty pass is not full parity)', () => {
  const empty = baseReport({ stateMatrix: [] });
  assert.equal(parity(empty.findings), 100, 'parity alone would read 100');
  assert.equal(deriveVerdict(empty), 'REVIEW');
  assert.deepEqual(explainVerdict(empty).reasons, ['no state was verified: the state matrix is empty']);
  const unverified = baseReport({ stateMatrix: [{ state: 'hover', result: 'NOT_SPECIFIED' }, { state: 'focus', result: 'NOT_SPECIFIED' }] });
  assert.equal(deriveVerdict(unverified), 'REVIEW');
  assert.deepEqual(explainVerdict(unverified).reasons, ['no state was verified (0 of 2 captured and compared)']);
  assert.equal(deriveVerdict(baseReport({ stateMatrix: [{ state: 'hover', result: 'FAIL' }] })), 'PASS', 'a compared state counts, whatever its result');
  assert.equal(deriveVerdict(baseReport({ stateMatrix: [], findings: [finding('DQ-001', 'BLOCKER', 'FIX_CODE')] })), 'FAIL', 'FAIL still wins');
  const sc = computeScorecard(empty);
  assert.deepEqual([sc.verdict, sc.parity, sc.stateCoverage.total], ['REVIEW', 100, 0]);
});

test('verdict: FAIL triggers', () => {
  const cases = {
    'open blocker': { findings: [finding('DQ-001', 'BLOCKER', 'FIX_CODE')] },
    'unclassified blocker': { findings: [finding('DQ-001', 'BLOCKER', 'UNCLASSIFIED')] },
    'missing in code': { stateMatrix: [{ state: 'empty', result: 'MISSING_IN_CODE' }] },
    'fail band': { scorecard: { pixelDiff: { empty: { percent: 12, band: 'fail' } } } },
  };
  for (const [name, over] of Object.entries(cases)) assert.equal(deriveVerdict(baseReport(over)), 'FAIL', name);
  const signedOff = baseReport({ findings: [finding('DQ-001', 'BLOCKER', 'INTENTIONAL')] });
  assert.equal(deriveVerdict(signedOff), 'PASS', 'a signed-off blocker is not open');
  assert.equal(deriveVerdict(baseReport({ findings: [dismissed('DQ-001', 'BLOCKER')] })), 'PASS', 'a dismissed blocker is not open');
  assert.match(explainVerdict(baseReport(cases['open blocker'])).reasons[0], /DQ-001 is an open BLOCKER/);
});

test('verdict uses bands derived from percent and the given tolerances', () => {
  const r = baseReport({ scorecard: { pixelDiff: { empty: { percent: 2, band: 'pass' } } } });
  assert.equal(deriveVerdict(r), 'REVIEW', 'stored band is ignored');
  assert.equal(deriveVerdict(r, { tolerances: { pass: 3, review: 5 } }), 'PASS');
  assert.equal(deriveVerdict(r, { tolerances: { pixelDiff: { pass: 0.5, review: 1 } } }), 'FAIL');
});

test('pixel-diff band: a structural difference (diff.mjs structuralBand) raises pass to review, never to fail', () => {
  assert.equal(pixelDiffBand({ percent: 0.44, structuralBand: 'review' }), 'review');
  assert.equal(pixelDiffBand({ percent: 0.44, structuralBand: 'pass' }), 'pass');
  assert.equal(pixelDiffBand({ percent: 0.44 }), 'pass', 'entries without the field keep the percent band');
  assert.equal(pixelDiffBand({ percent: 7, structuralBand: 'review' }), 'fail');
  const r = baseReport({ scorecard: { pixelDiff: { 'review/with-data': { percent: 0.44, band: 'review', structuralPercent: 3.11, structuralBand: 'review' } } } });
  assert.equal(deriveVerdict(r), 'REVIEW');
  assert.equal(computeScorecard(r).pixelDiff['review/with-data'].band, 'review');
  assert.equal(computeScorecard(r).pixelDiff['review/with-data'].structuralPercent, 3.11);
});

test('stateCoverage counts non-null designed/specified/implemented and PASS/FAIL as verified', () => {
  const report = loadFixture('report-valid.json');
  assert.deepEqual(stateCoverage(report.stateMatrix), { total: 5, designed: 5, specified: 3, implemented: 4, verified: 3 });
  assert.deepEqual(stateCoverage([]), { total: 0, designed: 0, specified: 0, implemented: 0, verified: 0 });
});

test('computeScorecard reproduces the fixture scorecards', () => {
  for (const name of ['report-valid.json', 'report-multiscreen.json']) {
    const report = loadFixture(name);
    assert.deepEqual(computeScorecard(report), report.scorecard, name);
  }
});

test('designSystemGroups: open token, component and motion mismatches', () => {
  const report = loadFixture('report-valid.json');
  const groups = designSystemGroups(report);
  const ids = (list) => list.map((f) => f.id);
  assert.deepEqual(ids(groups.tokens), ['DQ-002', 'DQ-004'], 'style findings whose expected token the code does not use');
  assert.deepEqual(ids(groups.components), ['DQ-003']);
  assert.deepEqual(ids(groups.motion), ['DQ-008']);
  assert.deepEqual(Object.keys(groups), ['tokens', 'components', 'motion']);
  assert.deepEqual(designSystemGroups(report.findings).tokens.map((f) => f.id), ['DQ-002', 'DQ-004'], 'accepts a findings array');

  const token = (id, expected, actual, resolution = 'FIX_CODE') => ({
    ...finding(id, 'WARNING', resolution, 'style'),
    expected: { value: '16px', token: expected, source: 'figma' },
    actual: { value: '12px', token: actual, source: {} },
  });
  const g = designSystemGroups([
    token('DQ-001', 'space.4', null),
    token('DQ-002', 'space.4', 'space.3'),
    token('DQ-003', 'space.4', 'space.4'), // same token, value differs: not a token mismatch
    token('DQ-004', null, null),
    token('DQ-005', '  ', null),
    token('DQ-006', 'space.4', null, 'INTENTIONAL'),
    { ...token('DQ-007', 'space.4', null, 'DISMISSED') },
    finding('DQ-008', 'WARNING', 'UNCLASSIFIED', 'motion'),
    finding('DQ-009', 'WARNING', 'DATA', 'component'),
  ]);
  assert.deepEqual(ids(g.tokens), ['DQ-001', 'DQ-002']);
  assert.deepEqual(ids(g.motion), ['DQ-008'], 'UNCLASSIFIED is open too');
  assert.deepEqual(ids(g.components), []);
  assert.deepEqual(designSystemGroups(null), { tokens: [], components: [], motion: [] });
});

// ---------------------------------------------------------------------------
// Triage: unexplained findings, debt, loopClosed
// ---------------------------------------------------------------------------

const TICKET = { provider: 'jira', key: 'ABC-1', url: 'https://example.atlassian.net/browse/ABC-1', createdAt: '2026-09-24T00:00:00Z' };
const withState = (f, state) => ({ ...f, state });
const triaged = (findings, items, over = {}) =>
  baseReport({ schemaVersion: '2.0', findings, triage: { decidedBy: null, decidedAt: '2026-09-24T00:00:00Z', source: 'cli', items }, ...over });

test('unexplained = open findings that are not ticketed debt; without triage it is the open set', () => {
  const f = [
    finding('DQ-001', 'WARNING', 'FIX_CODE'),
    finding('DQ-002', 'WARNING', 'FIX_CODE'),
    finding('DQ-003', 'WARNING', 'UNCLASSIFIED'),
    finding('DQ-004', 'WARNING', 'FIX_CODE'),
    finding('DQ-005', 'WARNING', 'INTENTIONAL'),
    dismissed('DQ-006'),
  ];
  assert.deepEqual(unexplainedFindings(baseReport({ findings: f })).map((x) => x.id), ['DQ-001', 'DQ-002', 'DQ-003', 'DQ-004']);
  const r = triaged(f, [
    { findingId: 'DQ-001', decision: 'debt', ticket: TICKET },
    { findingId: 'DQ-002', decision: 'debt', ticket: null },
    { findingId: 'DQ-004', decision: 'fix-now', ticket: TICKET },
  ]);
  assert.deepEqual(unexplainedFindings(r).map((x) => x.id), ['DQ-002', 'DQ-003', 'DQ-004'], 'only ticketed debt is explained');
  assert.deepEqual(debtSummary(r), { count: 2, ticketed: 1 });
  assert.deepEqual(debtSummary(baseReport()), { count: 0, ticketed: 0 });
  assert.equal(parity(r.findings), 20, 'parity is unchanged: debt is still a mismatch (the dismissed one is not counted)');
});

test('verdict: ticketed debt no longer causes REVIEW; unticketed debt does', () => {
  const f = [finding('DQ-001', 'WARNING', 'FIX_CODE')];
  assert.equal(deriveVerdict(triaged(f, [{ findingId: 'DQ-001', decision: 'debt', ticket: TICKET }])), 'PASS');
  assert.equal(deriveVerdict(triaged(f, [{ findingId: 'DQ-001', decision: 'debt', ticket: null }])), 'REVIEW');
  assert.equal(deriveVerdict(triaged(f, [{ findingId: 'DQ-001', decision: 'fix-now', ticket: null }])), 'REVIEW');
  assert.match(explainVerdict(triaged(f, [{ findingId: 'DQ-001', decision: 'debt', ticket: null }])).reasons[0], /1 unexplained finding\(s\): DQ-001/);
});

test('verdict: a fail band only fails when its state has an unexplained finding or no findings', () => {
  const band = { pixelDiff: { empty: { percent: 12, band: 'fail' } } };
  const debtOnly = triaged([withState(finding('DQ-001', 'WARNING', 'FIX_CODE'), 'empty')], [{ findingId: 'DQ-001', decision: 'debt', ticket: TICKET }], { scorecard: band });
  assert.equal(deriveVerdict(debtOnly), 'REVIEW', 'ticketed debt explains the diff');
  assert.match(explainVerdict(debtOnly).reasons.join(' '), /fail band, but every finding there is explained/);
  const intentional = baseReport({ findings: [withState(finding('DQ-001', 'WARNING', 'INTENTIONAL'), 'empty')], scorecard: band });
  assert.equal(deriveVerdict(intentional), 'REVIEW');
  const fixed = baseReport({ findings: [withState(finding('DQ-001', 'PASS', 'NONE'), 'empty'), withState(finding('DQ-002', 'WARNING', 'DATA'), 'empty')], scorecard: band });
  assert.equal(deriveVerdict(fixed), 'REVIEW', 'fixed (PASS) and DATA findings explain it too');
  const nothing = baseReport({ findings: [withState(finding('DQ-001', 'WARNING', 'INTENTIONAL'), 'hover')], scorecard: band });
  assert.equal(deriveVerdict(nothing), 'FAIL', 'no finding in that state explains the diff');
  const mixed = triaged(
    [withState(finding('DQ-001', 'WARNING', 'FIX_CODE'), 'empty'), withState(finding('DQ-002', 'WARNING', 'INTENTIONAL'), 'empty')],
    [{ findingId: 'DQ-001', decision: 'debt', ticket: null }],
    { scorecard: band },
  );
  assert.equal(deriveVerdict(mixed), 'FAIL', 'unticketed debt leaves the diff unexplained');
});

test('computeScorecard 2.0: unexplained, debt, loopClosed, dismissed and designSystem', () => {
  const f = [finding('DQ-001', 'WARNING', 'FIX_CODE', 'motion'), finding('DQ-002', 'PASS', 'NONE'), dismissed('DQ-003')];
  const closed = computeScorecard(triaged(f, [{ findingId: 'DQ-001', decision: 'debt', ticket: TICKET }]));
  assert.equal(closed.unexplained, 0);
  assert.deepEqual(closed.debt, { count: 1, ticketed: 1 });
  assert.equal(closed.loopClosed, true);
  assert.equal(closed.verdict, 'PASS');
  assert.equal(closed.dismissed, 1);
  assert.deepEqual(closed.designSystem, { tokens: 0, components: 0, motion: 1 }, 'ticketed debt is still an open mismatch');
  assert.equal(closed.parity, 50, '1 open of 2 counted');
  assert.deepEqual(closed.byResolution, { FIX_CODE: 1, INTENTIONAL: 0, DATA: 0, DISMISSED: 1, NONE: 1, UNCLASSIFIED: 0 });
  assert.deepEqual(Object.keys(closed), [
    'parity', 'verdict', 'bySeverity', 'byResolution', 'pixelDiff', 'stateCoverage', 'unexplained', 'debt', 'loopClosed', 'dismissed', 'designSystem',
  ]);
  const decision = computeScorecard(triaged(f, [{ findingId: 'DQ-001', decision: 'debt', ticket: TICKET }], { openDecisions: [{ id: 'OD-1' }] }));
  assert.equal(decision.loopClosed, false, 'an open decision keeps the loop open');
  const untriaged = computeScorecard(baseReport({ findings: f }));
  assert.equal(untriaged.unexplained, 1, 'every report gets the 2.0 fields');
  assert.deepEqual(untriaged.debt, { count: 0, ticketed: 0 });
});

test('design backfill never changes step 1: parity, verdict, unexplained, loopClosed, ranks and designSystem', () => {
  const plain = loadFixture('report-valid.json');
  const withBackfill = loadFixture('report-backfill.json');
  const a = computeScorecard(plain);
  const { backfill, ...b } = computeScorecard(withBackfill);
  assert.deepEqual(b, a);
  assert.deepEqual(backfill, { candidates: 3, toBuild: 1, built: 1, notNeeded: 1, pending: 0, ready: true });
  assert.equal(explainVerdict(withBackfill).verdict, explainVerdict(plain).verdict);
  assert.deepEqual(explainVerdict(withBackfill).reasons, explainVerdict(plain).reasons);
  assert.deepEqual(rankFindings(withBackfill.findings), rankFindings(plain.findings));
  assert.deepEqual(designSystemGroups(withBackfill), designSystemGroups(plain));
  assert.equal(isLoopClosed(withBackfill), false, 'an override never closes step 1');
  assert.equal('backfill' in computeScorecard(plain), false, 'no backfill block, no scorecard.backfill');
  assert.equal('backfill' in computeScorecard({ ...plain, backfill: null }), false);
});

test('backfillSummary and isBackfillReady: counts and the gate (loopClosed or an override)', () => {
  const item = (id, decision, figma = null) => ({ id, state: id.toLowerCase(), label: id, discoveredBy: 'source', decision, figma });
  const built = { nodeId: '1:2', url: 'https://www.figma.com/design/A/B?node-id=1-2', builtAt: '2026-10-01T00:00:00Z' };
  const items = [item('BF-001', 'pending'), item('BF-002', 'build'), item('BF-003', 'build', built), item('BF-004', 'not-needed')];
  const open = baseReport({ findings: [finding('DQ-001', 'WARNING', 'FIX_CODE')], backfill: { gate: { override: null }, items } });
  assert.equal(backfillSummary(baseReport()), null);
  assert.deepEqual(backfillSummary(open), { candidates: 4, toBuild: 1, built: 1, notNeeded: 1, pending: 1, ready: false });
  assert.equal(isBackfillReady(open), false);
  open.backfill.gate.override = { by: 'Dana', date: '2026-10-01T00:00:00Z', reason: 'review on Friday' };
  assert.equal(isBackfillReady(open), true);
  const closed = baseReport({ findings: [finding('DQ-001', 'WARNING', 'DATA')], backfill: { gate: { override: null }, items: [] } });
  assert.equal(isLoopClosed(closed), true);
  assert.deepEqual(backfillSummary(closed), { candidates: 0, toBuild: 0, built: 0, notNeeded: 0, pending: 0, ready: true });
  const decision = baseReport({ openDecisions: [{ id: 'OD-1' }], backfill: { gate: { override: null }, items: [] } });
  assert.equal(isBackfillReady(decision), false, 'an open decision keeps step 1 open');
});
