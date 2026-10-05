// Match: how much of the compared pages matches the design, from the evidence (the pixel diff
// and the worklist's regions), not from how findings are pinned (scripts/lib/ranking.mjs
// stateDifference / matchByState / scorecardMatch), next to the count of findings settled.
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeScorecard, matchByState, scorecardHeadline, scorecardMatch, settledCounts, stateDifference } from '../skills/design-qa/scripts/lib/ranking.mjs';
import { validateReport } from '../skills/design-qa/scripts/lib/schema-check.mjs';
import { loadFixture } from './_helpers.mjs';

// A row's worklist facts (differing, regions, unlisted) go to report.differences.<state> (report() moves them there).
const row = (state, result = 'FAIL', extra = {}, captured = {}) => ({ state, label: state, result, findings: [], _d: extra, captured: result === 'PASS' || result === 'FAIL' ? { comparison: { pixelDiff: true, worklist: true, compareRows: 0 }, ...captured } : null });
const diff = (percent = 30) => ({ percent, band: percent > 5 ? 'fail' : percent >= 1 ? 'review' : 'pass' });
let n = 0;
const finding = (state, { severity = 'WARNING', resolution = 'FIX_CODE', ledger = 'style', pins = [] } = {}) => ({
  id: `DQ-${String(++n).padStart(3, '0')}`, title: 't', ledger, state, severity, resolution, region: 'r',
  evidence: pins.map(([x, y, w, h]) => ({ type: 'screenshot', path: `app/${state}.png`, crop: { x, y, w, h }, state })),
});
const report = (findings, rows, pixelDiff = { 'with-data': diff() }) => ({
  findings,
  stateMatrix: rows.map(({ _d, ...r }) => r),
  differences: Object.fromEntries(rows.filter((r) => Object.keys(r._d ?? {}).length).map((r) => [r.state, { regions: [], unlisted: { count: 0, percent: 0 }, ...r._d }])),
  openDecisions: [],
  scorecard: { pixelDiff },
});

test('match is a property of the evidence: the same differences filed with any pins give the same number', () => {
  // The review's case: 12 wrong cards (a 30% pixel difference), one region each on the worklist.
  const regions = (ids) => Array.from({ length: 12 }, (_, i) => ({ key: `wl:${i}`, percent: 2.5, findings: ids(i) }));
  const cards = Array.from({ length: 12 }, (_, i) => [40 + (i % 4) * 340, 600 + Math.floor(i / 4) * 240, 300, 200]);
  n = 0;
  const tight = cards.map((c) => finding('with-data', { pins: [c] }));
  const a = report(tight, [row('with-data', 'FAIL', { differing: 30, regions: regions((i) => [tight[i].id]) })]);
  n = 0;
  const one = finding('with-data', { pins: cards });
  const b = report([one], [row('with-data', 'FAIL', { differing: 30, regions: regions(() => [one.id]) })]);
  n = 0;
  const page = finding('with-data', { pins: [[0, 0, 1440, 4000]] });
  const c = report([page], [row('with-data', 'FAIL', { differing: 30, regions: regions(() => [page.id]) })]);
  n = 0;
  const tiny = Array.from({ length: 5 }, (_, i) => finding('with-data', { severity: 'BLOCKER', pins: [[i * 10, 0, 8, 8]] }));
  const d = report(tiny, [row('with-data', 'FAIL', { differing: 30, regions: regions((i) => [tiny[i % 5].id]) })]);
  for (const r of [a, b, c, d]) assert.deepEqual(matchByState(r), { 'with-data': 70 });
});

test('match: a region stops counting only when what names it settles it', () => {
  const regions = [{ key: 'wl:a', percent: 10 }, { key: 'wl:b', percent: 5 }];
  const at = (findings, list, pd = diff(20)) => matchByState(report(findings, [row('with-data', 'FAIL', { differing: 20, regions: list })], { 'with-data': pd }))['with-data'];
  n = 0;
  const open = finding('with-data');
  const data = finding('with-data', { resolution: 'DATA' });
  const intentional = finding('with-data', { resolution: 'INTENTIONAL' });
  const pass = finding('with-data', { severity: 'PASS', resolution: 'NONE' });
  assert.equal(at([open], [{ ...regions[0], findings: [open.id] }]), 80, 'an open finding: still different');
  assert.equal(at([data, intentional], [{ ...regions[0], findings: [data.id] }, { ...regions[1], findings: [intentional.id] }]), 95, 'DATA and INTENTIONAL settle the 15% they name');
  assert.equal(at([data, open], [{ ...regions[0], findings: [data.id, open.id] }]), 80, 'every finding naming a region must be settled');
  assert.equal(at([pass], [{ ...regions[0], findings: [pass.id] }]), 80, 'a PASS finding does not settle a differing region');
  assert.equal(at([], [{ ...regions[0], rejected: 'DATA', supported: true }, { ...regions[1], rejected: 'out-of-scope', supported: false }]), 90, 'only a rejection a computed hint supports settles its region');
  // One DATA finding naming nothing does not explain a 40% difference (review B5).
  assert.equal(at([data], [], diff(40)), 60);
});

test('match: differences beyond the worklist caps count, and the verdict says so', () => {
  const r = report([], [row('with-data', 'PASS', { differing: 3, regions: [], unlisted: { count: 14, percent: 3 } })], { 'with-data': diff(0.5) });
  assert.deepEqual(matchByState(r), { 'with-data': 97 });
  assert.deepEqual(stateDifference(r, r.stateMatrix[0]).unlisted, { count: 14, percent: 3 });
  const sc = computeScorecard(r);
  assert.equal(sc.verdict, 'REVIEW');
});

test('match: a missing state and a sameAs state with an open state finding match 0%', () => {
  n = 0;
  const r = report([finding('error', { severity: 'BLOCKER', ledger: 'state' })], [row('with-data', 'PASS', { differing: 0 }), row('error', 'MISSING_IN_CODE')], { 'with-data': diff(0) });
  assert.deepEqual(matchByState(r), { 'with-data': 100, error: 0 });
  assert.equal(scorecardMatch(r), 50);
  const same = report([finding('empty', { ledger: 'state', severity: 'BLOCKER' })], [row('with-data', 'PASS', { differing: 0 }), row('empty', 'FAIL', { differing: 1 }, { sameAs: 'with-data' })], { 'with-data': diff(0), empty: diff(1) });
  assert.deepEqual(matchByState(same), { 'with-data': 100, empty: 0 });
});

test('match: only states compared against a design image count; nothing measured is "not measured"', () => {
  const r = report([], [row('with-data', 'FAIL', { differing: 10 }), row('loading', 'CANNOT_VERIFY'), row('hover', 'NOT_SPECIFIED')], { 'with-data': diff(10) });
  assert.deepEqual(matchByState(r), { 'with-data': 90 });
  // One compare row, no design image and no diff: not compared (review B5).
  const rowsOnly = report([], [{ state: 'with-data', label: 'w', result: 'PASS', findings: [], captured: { comparison: { pixelDiff: false, worklist: false, compareRows: 1 } } }], {});
  const sc = computeScorecard(rowsOnly);
  assert.deepEqual([sc.verdict, sc.match, sc.matchByState, sc.stateCoverage.verified], ['INCOMPLETE', null, {}, 0]);
});

test('match: the larger of the worklist and pixel-diff shares; never 100 while something is open, never 0 unless it is 0', () => {
  assert.deepEqual(matchByState(report([], [row('with-data', 'FAIL', { differing: 2 })], { 'with-data': diff(6) })), { 'with-data': 94 });
  assert.deepEqual(matchByState(report([], [row('with-data', 'FAIL', { differing: 0.01, regions: [{ key: 'wl:a', percent: 0.01 }] })], { 'with-data': diff(0.01) })), { 'with-data': 99 });
  assert.deepEqual(matchByState(report([], [row('with-data', 'FAIL', { differing: 99.6 })], { 'with-data': diff(99.6) })), { 'with-data': 1 });
  n = 0;
  const r = report([finding('loading')], [row('with-data', 'PASS', { differing: 0 }), row('loading', 'CANNOT_VERIFY')], { 'with-data': diff(0) });
  assert.equal(scorecardMatch(r), 99, 'an open divergence anywhere holds it at 99');
});

test('settled counts and the headline: "match N% · x of y findings settled · n of m states verified"; no parity', () => {
  n = 0;
  const f = [finding('with-data', { pins: [[0, 0, 100, 100]] }), finding('with-data', { resolution: 'INTENTIONAL' }), finding('with-data', { severity: 'PASS', resolution: 'NONE' })];
  assert.deepEqual(settledCounts(f), { count: 1, total: 2 });
  const sc = computeScorecard(report(f, [row('with-data', 'FAIL', { differing: 1 }), row('empty', 'CANNOT_VERIFY')], { 'with-data': diff(1) }));
  assert.equal(scorecardHeadline(sc), 'REVIEW · match 99% · 1 of 2 findings settled · 1 of 2 states verified');
  assert.equal('parity' in sc, false);
});

test('validator: match, matchByState and settled must equal the derived values', () => {
  const r = loadFixture('report-valid.json');
  r.scorecard.match = 99;
  r.scorecard.matchByState = { ...r.scorecard.matchByState, hover: 100, extra: 50 };
  r.scorecard.settled = { count: 6, total: 6 };
  const errors = validateReport(r).errors.map((e) => `${e.path}: ${e.message}`);
  assert.ok(errors.includes('scorecard.match: expected 73 (the mean of matchByState: each compared state is 100 minus the share of its page that differs and is not settled by a finding or a supported rejection naming it), got 99'), errors.join('\n'));
  assert.ok(errors.includes('scorecard.matchByState.hover: expected 99, got 100'));
  assert.ok(errors.includes('scorecard.matchByState.extra: expected (no entry: not a compared or MISSING_IN_CODE state), got 50'));
  assert.ok(errors.includes('scorecard.settled.count: expected 1 (of those, the ones not open), got 6'));
});
