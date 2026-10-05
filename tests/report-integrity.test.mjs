// Report integrity against a lazy agent: rows marked PASS without a comparison, DATA
// without a reason, rejections the reviewer cannot see, a hand-edited report.json, PASS
// findings that explain a fail band, a free-text excuse for a partial
// capture, crops checked against the wrong image, stale rows after a dismissal, fake pins.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { computeScorecard, explainVerdict, hasPin, isLoopClosed, matrixStates, pinProblem, stateCoverage } from '../skills/design-qa/scripts/lib/ranking.mjs';
import { validateReport } from '../skills/design-qa/scripts/lib/schema-check.mjs';
import { renderFixplan } from '../skills/design-qa/scripts/lib/fixplan.mjs';
import { RUN_ID, makePass, titleFinding } from './fixtures/build-report-pass/make.mjs';
import { fixture, loadFixture, run, script } from './_helpers.mjs';

const GATES = { evidenceGates: 'error' };
const errorsOf = (r, opts = GATES) => validateReport(r, opts).errors.map((e) => `${e.path}: ${e.message}`);
const has = (list, re) => list.some((x) => re.test(x));
const recomputed = (r) => ({ ...r, scorecard: computeScorecard(r) });

// --- 1. PASS with nothing compared ----------------------------------------------------------

test('a PASS or FAIL row that was captured but not compared is a gate error and does not count as verified', () => {
  const r = loadFixture('report-valid.json');
  r.stateMatrix[0].captured.comparison = { pixelDiff: false, worklist: true, compareRows: 0 };
  delete r.scorecard.pixelDiff['with-data']; // and no pixel-diff entry either
  const errors = errorsOf(recomputed(r));
  assert.ok(has(errors, /^stateMatrix\[0\]\.result: state "with-data" is marked FAIL but was captured, not compared: no pixel diff against a design image \(stateMatrix\[0\]\.captured\.comparison; compare rows alone are not a comparison\)\. Export or capture its design, run diff\.mjs for it and build again, or mark it CANNOT_VERIFY with a note saying why it could not be compared$/), errors.join('\n'));
  assert.equal(stateCoverage(r.stateMatrix, r).verified, 2, 'only the two compared rows count');
  assert.equal(stateCoverage(r.stateMatrix).verified, 3, 'without the report (old callers) every PASS / FAIL row counts');
  // Every row captured, none compared: nothing was verified, whatever the rows say.
  const lazy = loadFixture('report-valid.json');
  lazy.scorecard.pixelDiff = {};
  for (const row of lazy.stateMatrix) if (row.captured) row.captured.comparison = { pixelDiff: false, worklist: false, compareRows: 0 };
  lazy.stateMatrix = lazy.stateMatrix.filter((row) => row.result === 'PASS' || row.result === 'FAIL').map((row) => ({ ...row, result: 'PASS' }));
  const sc = computeScorecard(lazy);
  assert.deepEqual([sc.verdict, sc.match, sc.stateCoverage.verified], ['INCOMPLETE', null, 0]);
  // Neither compare rows nor a worklist alone are a comparison (review B5): only a pixel diff against a design image.
  r.stateMatrix[0].captured.comparison = { pixelDiff: false, worklist: true, compareRows: 4 };
  assert.ok(has(errorsOf(recomputed(r)), /captured, not compared/));
  r.stateMatrix[0].captured.comparison = { pixelDiff: true, worklist: true, compareRows: 0 };
  assert.ok(!has(errorsOf(recomputed(r)), /captured, not compared/));
});

// --- 2. DATA without a reason ---------------------------------------------------------------

test('a DATA finding needs dataReason; the fix plan prints it next to the finding', () => {
  const r = loadFixture('ui-report.json');
  const i = r.findings.findIndex((f) => f.resolution === 'DATA');
  delete r.findings[i].dataReason;
  assert.ok(has(errorsOf(r), new RegExp(`^findings\\[${i}\\]\\.dataReason: is required when resolution is DATA: say which data differs and why it is not a code problem \\(at least 20 characters, got 0\\)$`)));
  assert.ok(validateReport(r).warnings.some((w) => w.path === `findings[${i}].dataReason`), 'a warning where gates are warnings');
  r.findings[i].dataReason = 'too short';
  assert.ok(has(errorsOf(r), /got 9\)$/));
  const ok = loadFixture('ui-report.json');
  const md = renderFixplan(ok);
  const f = ok.findings[i];
  assert.ok(md.includes(`## Data differences (1)\n- ${f.id} — ${f.title} (WARNING, state ${f.state}) — "${f.dataReason}"`), md);
  // INTENTIONAL with signoff null stays an error everywhere (not only with the gates).
  const intentional = loadFixture('ui-report.json');
  const j = intentional.findings.findIndex((x) => x.resolution === 'INTENTIONAL');
  intentional.findings[j].signoff = null;
  intentional.findings[j].knownDrift = null;
  assert.ok(has(errorsOf(intentional, {}), new RegExp(`^findings\\[${j}\\]\\.signoff: is required when resolution is INTENTIONAL`)));
});

// --- 3. Rejections are visible --------------------------------------------------------------

const rejections = [
  { kind: 'worklist', key: 'wl-1', state: 'with-data', screen: null, reason: 'same', detail: 'rendering differences only', percentOfPage: 7.5, crop: { x: 0, y: 600, w: 1440, h: 300 }, knownDrift: null, duplicateOf: null, coveredBy: null },
  { kind: 'worklist', key: 'wl-2', state: 'with-data', reason: 'DATA', detail: 'order rows come from the fixture', percentOfPage: 4.5, crop: { x: 0, y: 200, w: 1440, h: 120 } },
  { kind: 'audit', key: 'a-1', state: 'with-data', reason: 'known-drift', detail: 'KD-2 header spacing', knownDrift: 'KD-2' },
  { kind: 'compare', key: 'title#0|h1|color', state: 'hover', reason: 'false-positive', detail: 'anti-aliasing on the 1px edge' },
];

test('rejections: derived counts, a REVIEW reason when a state page share is above the review band, a fix-plan section', () => {
  const r = loadFixture('report-valid.json');
  r.rejections = rejections;
  const sc = computeScorecard(r);
  assert.deepEqual(sc.rejected, { worklist: 2, audit: 1, compare: 1, pageShare: 12 });
  assert.equal('rejected' in computeScorecard(loadFixture('report-valid.json')), false);
  // A REVIEW reason, not hidden behind the FAIL of the fixture: check it on a report that would otherwise PASS.
  const clean = loadFixture('report-multiscreen.json');
  clean.findings = clean.findings.filter((f) => f.resolution !== 'FIX_CODE');
  clean.ledgers.style = []; clean.ledgers.motion = [];
  for (const row of clean.stateMatrix) { row.findings = row.findings.filter((id) => clean.findings.some((f) => f.id === id)); row.result = 'PASS'; }
  clean.scorecard.pixelDiff = {};
  clean.rejections = [{ kind: 'worklist', key: 'wl-1', state: 'cart/with-data', reason: 'same', percentOfPage: 12 }];
  const why = explainVerdict(clean).reasons;
  assert.equal(explainVerdict(clean).verdict, 'REVIEW');
  assert.ok(why.includes('12% of "cart/with-data" was rejected by the agent as same: check the rejected regions'), why.join('\n'));
  clean.rejections[0].percentOfPage = 5; // at the band: not loud
  assert.equal(explainVerdict(clean).verdict, 'PASS');
  // Validator: derived scorecard.rejected must match.
  r.scorecard = { ...sc, rejected: { ...sc.rejected, pageShare: 0 } };
  assert.ok(has(errorsOf(r, {}), /^scorecard\.rejected\.pageShare: expected 12 \(derived from report\.rejections\), got 0$/));
  // Fix plan: a header line and the section grouped by reason.
  r.scorecard = sc;
  const md = renderFixplan(r);
  assert.match(md, /^Rejected by the agent: 2 worklist regions \(largest share 12% of With data\), 1 audit candidate, 1 compare row$/m);
  assert.ok(md.includes('## Rejected by the agent (4)\n### same (1)\n- wl-1 (worklist) — With data — 7.5% of the page — "rendering differences only"\n### DATA (1)\n- wl-2 (worklist) — With data — 4.5% of the page — "order rows come from the fixture"\n### known-drift (1)\n- a-1 (audit) — With data — known drift KD-2 — "KD-2 header spacing"'), md);
});

// --- 4. A hand-edited report does not validate ----------------------------------------------

test('validate.mjs: a built report validates; deleting a finding or forcing rows to PASS afterwards does not; no meta.build is refused', { timeout: 120000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'design-qa-integrity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ws = makePass(root);
  writeFileSync(path.join(ws.dir, 'findings.json'), JSON.stringify({ findings: [titleFinding()] }, null, 2));
  const built = await run(script('build-report.mjs'), ['--dir', 'qa-reports/abc-123', '--config', 'design-qa.config.json'], { cwd: root, env: { DESIGN_QA_RUN_ID: RUN_ID } });
  assert.equal(built.code, 0, built.stderr + built.stdout);
  const file = path.join(ws.dir, 'report.json');
  // Build verification is what this test is about: switch the test-mode skip off.
  const validate = () => run(script('validate.mjs'), [file, '--config', path.join(root, 'design-qa.config.json')], { cwd: root, env: { DESIGN_QA_TEST_SKIP_BUILD_VERIFY: '' } });
  const ok = await validate();
  assert.equal(ok.code, 0, ok.stderr);

  const report = JSON.parse(readFileSync(file, 'utf8'));
  const edited = structuredClone(report);
  edited.findings = [];
  for (const row of edited.stateMatrix) { row.findings = []; if (row.result === 'FAIL') row.result = 'PASS'; }
  for (const e of Object.values(edited.scorecard.pixelDiff)) e.percent = 0.1;
  writeFileSync(file, JSON.stringify(recomputed(edited), null, 2));
  const refused = await validate();
  assert.equal(refused.code, 1, 'a hand edit after the build is refused');
  assert.match(refused.stderr, /ERROR findings: DQ-001 is missing: it is built from findings\.json/);
  assert.match(refused.stderr, /ERROR scorecard\.pixelDiff\["with-data"\]\.percent: differs from what build-report\.mjs builds from findings\.json and the evidence \(0\.1, built/);

  const unbuilt = structuredClone(report);
  delete unbuilt.meta.build;
  writeFileSync(file, JSON.stringify(unbuilt, null, 2));
  const missing = await validate();
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /ERROR meta\.build: is missing: this report was not built by build-report\.mjs\. Write findings\.json and build it/);
  // Elsewhere (triage, dismiss, apply) a missing build record is a warning: older reports are still processed.
  assert.ok(validateReport(unbuilt).warnings.some((w) => w.path === 'meta.build'));
  assert.ok(!validateReport(unbuilt).errors.some((e) => e.path === 'meta.build'));
});

// --- 5. PASS findings and unnamed settled findings do not explain a fail band ---------------

test('a fail band is explained only by settled BLOCKER / WARNING / DS_CANDIDATE findings naming its area; loopClosed waits for it', () => {
  const finding = (id, severity, resolution, state = 'with-data') => ({ id, title: id, ledger: 'style', state, severity, resolution });
  const passes = Array.from({ length: 9 }, (_, i) => finding(`DQ-${String(i + 2).padStart(3, '0')}`, 'PASS', 'NONE'));
  const base = {
    findings: [],
    stateMatrix: [{ state: 'with-data', result: 'PASS', captured: { comparison: { pixelDiff: true, worklist: false, compareRows: 0 } } }],
    openDecisions: [],
    scorecard: { pixelDiff: { 'with-data': { percent: 40, band: 'fail' } } },
  };
  const onePass = { ...base, findings: [passes[0]] };
  assert.equal(explainVerdict(onePass).verdict, 'FAIL', 'a PASS finding does not explain a 40% diff');
  assert.match(explainVerdict(onePass).reasons[0], /pixel diff for "with-data" is in the fail band: 40% of the page differs with no settled finding/);
  assert.equal(isLoopClosed(onePass), false);
  const unnamed = { ...base, findings: [finding('DQ-001', 'WARNING', 'DATA')] };
  assert.equal(explainVerdict(unnamed).verdict, 'FAIL', 'one DATA finding naming no region does not explain 40%');
  const regions = [{ key: 'wl:a', percent: 38, findings: ['DQ-001'] }];
  const explained = { ...unnamed, differences: { 'with-data': { differing: 40, regions, unlisted: { count: 0, percent: 0 } } } };
  assert.equal(explainVerdict(explained).verdict, 'REVIEW');
  assert.equal(isLoopClosed(explained), true);
  assert.equal(computeScorecard(explained).matchByState['with-data'], 98);
});

// --- 7. Partial captures: only the exact step excuses them, and they hold the verdict -------

test('a partial capture is excused only by step "capture-coverage:<state>", and then counts as partial (REVIEW, coverage text)', () => {
  const r = loadFixture('report-valid.json');
  r.stateMatrix[0].captured.page = { width: 1440, height: 2000, fullPage: false, clipped: 0, image: { width: 1440, height: 900 } };
  r.meta.degradations = [{ step: 'motion', reason: 'hover transitions in with-data were read from a full-page capture', impact: 'durations are approximate' }];
  const gate = /^stateMatrix\[0\]\.captured\.page: the app capture of state "with-data" is 1440×900 but the page is 1440×2000: only the top 900 px were captured; .* \{ "step": "capture-coverage:with-data"/;
  assert.ok(has(errorsOf(r), gate), 'an unrelated note that names the state and says "full-page" no longer excuses it');
  r.meta.degradations.push({ step: 'capture-coverage:with-data', reason: 'the list streams rows forever', impact: 'below 900 px not compared' });
  assert.ok(!has(errorsOf(r), gate));
  const sc = computeScorecard(r);
  assert.equal(sc.stateCoverage.partial, 1);
  assert.match(renderFixplan({ ...r, scorecard: sc }).split('\n')[1], /3 of 5 states verified, 1 only in part/);
  // On a report that would otherwise PASS, the partial state holds it at REVIEW.
  const m = loadFixture('report-multiscreen.json');
  m.findings = m.findings.filter((f) => f.resolution !== 'FIX_CODE');
  m.ledgers.style = []; m.ledgers.motion = [];
  for (const row of m.stateMatrix) { row.findings = row.findings.filter((id) => m.findings.some((f) => f.id === id)); row.result = 'PASS'; }
  m.scorecard.pixelDiff = {};
  assert.equal(explainVerdict(m).verdict, 'PASS');
  m.stateMatrix[0].captured.page.partial = true;
  assert.deepEqual(explainVerdict(m), { verdict: 'REVIEW', reasons: ['"cart/with-data" was captured only in part'] });
});

// --- 12. Crops are measured against the state's own image -----------------------------------

test('crops: a state captured wider than the first viewport is checked against its own image size', () => {
  const r = loadFixture('report-valid.json');
  r.stateMatrix[4].captured.page = { width: 1920, height: 900, fullPage: true, clipped: 0, image: { width: 1920, height: 900 } }; // hover, a breakpoint
  r.findings[2].evidence[0].crop = { x: 1700, y: 100, w: 120, h: 40 };
  assert.ok(!has(errorsOf(r), /past its width/), errorsOf(r).join('\n'));
  r.findings[2].evidence[0].crop = { x: 1950, y: 100, w: 20, h: 40 };
  assert.ok(has(errorsOf(r), /^findings\[2\]\.evidence\[0\]\.crop: lies outside the app image of state "hover": x 1950 is past its width 1920 \(stateMatrix\[4\]\.captured\.page\.image\)/), errorsOf(r).join('\n'));
});

// --- 15. Rows follow the findings after a dismissal -----------------------------------------

test('after every finding of a FAIL state is dismissed, --recompute moves the row to PASS; a stale row is a gate error', async () => {
  const r = loadFixture('ui-report.json');
  const hover = r.stateMatrix.findIndex((row) => row.state === 'hover');
  for (const f of r.findings.filter((x) => x.state === 'hover' && (x.resolution === 'FIX_CODE' || x.resolution === 'UNCLASSIFIED'))) {
    f.resolution = 'DISMISSED';
    f.dismissal = { kind: 'not-an-issue', reason: 'Rendering noise only', by: 'Dana', date: '2026-10-03T10:00:00Z', source: 'cli' };
  }
  const stale = recomputed(r);
  assert.equal(stale.stateMatrix[hover].result, 'FAIL');
  assert.ok(has(errorsOf(stale), new RegExp(`^stateMatrix\\[${hover}\\]\\.result: is FAIL but none of its findings is open: it must be PASS\\. Re-render with render-report\\.mjs --recompute --write-back`)));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'design-qa-integrity-'));
  try {
    const file = path.join(dir, 'report.json');
    writeFileSync(file, JSON.stringify(stale));
    const res = await run(script('render-report.mjs'), ['--in', file, '--out', path.join(dir, 'r.html'), '--template', fixture('template.html'), '--recompute', '--write-back']);
    assert.equal(res.code, 0, res.stderr);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.stateMatrix[hover].result, 'PASS');
    assert.equal(saved.ledgers.state.find((x) => x.state === 'hover')?.result ?? 'PASS', 'PASS');
    assert.ok(!has(errorsOf(saved), /^stateMatrix\[\d+\]\.result/));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Fake pins ------------------------------------------------------------------------------

test('a pin needs a matrix state, a crop on an image file and at least 64 px²', () => {
  const states = new Set(['with-data']);
  const ok = { type: 'screenshot', path: 'app/with-data.png', state: 'with-data', crop: { x: 0, y: 0, w: 8, h: 8 } };
  assert.equal(pinProblem(ok, states), null);
  assert.equal(pinProblem({ ...ok, crop: { x: 0, y: 0, w: 1, h: 1 } }, states), 'the crop is 1×1: smaller than 64 px² (an 8×8 area) is not a pin');
  assert.equal(pinProblem({ ...ok, crop: { x: 0, y: 0, w: 1200, h: 1 } }, states), null, 'a 1 px divider is a real element');
  assert.match(pinProblem({ ...ok, type: 'computed', path: 'computed/with-data.json' }, states), /not on an image/);
  assert.equal(pinProblem({ ...ok, state: 'hover' }, states), 'state "hover" is not a stateMatrix row');
  const r = loadFixture('report-valid.json');
  r.findings[2].evidence[0].crop = { x: 24, y: 240, w: 1, h: 1 };
  assert.equal(hasPin(r.findings[2], matrixStates(r)), false);
  assert.ok(has(errorsOf(recomputed(r)), /^findings\[2\]\.evidence: an open FIX_CODE finding needs a pin: .* \(the crop is 1×1: smaller than 64 px² \(an 8×8 area\) is not a pin\)/));
});
