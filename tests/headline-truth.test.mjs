// The headline and the verdict describe the evidence, not how findings were filed (review
// 0.2.2, section B): one compare row is not a comparison, a DATA finding explains only the
// area it names, differences beyond the worklist caps and blanket rejections are not a
// match, and a design-system check that did not run never prints 0.
import assert from 'node:assert/strict';
import { readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tmpDir } from './_helpers.mjs';
import { auditCandidate, makePass, RUN_ID, titleFinding, worklistItem } from './fixtures/build-report-pass/make.mjs';
import { buildReport, summaryLines, verifyBuiltReport } from '../skills/design-qa/scripts/lib/build-report.mjs';
import { explainVerdict, scorecardHeadline } from '../skills/design-qa/scripts/lib/ranking.mjs';

function workspace(t, opts) {
  const root = tmpDir('design-qa-headline-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return makePass(root, opts);
}
const rd = (f) => JSON.parse(readFileSync(f, 'utf8'));
const wr = (f, d) => writeFileSync(f, JSON.stringify(d, null, 2));
function build(ws, doc) {
  wr(ws.findingsFile, doc);
  return buildReport({
    dir: ws.dir, doc, findingsFile: ws.findingsFile, config: rd(ws.config), configDir: path.dirname(ws.config), configFile: ws.config,
    now: new Date('2026-10-04T12:00:00Z'), skillVersion: '0.2.2', localCommit: null, runId: RUN_ID,
  });
}
const problems = (r) => r.problems.map((p) => `${p.where}: ${p.message}`).join('\n');
const setDiff = (ws, percents) => {
  const f = path.join(ws.dir, 'evidence', 'diff.json');
  const d = rd(f);
  for (const [s, p] of Object.entries(percents)) Object.assign(d.results[s], { percent: p, band: p > 5 ? 'fail' : p >= 1 ? 'review' : 'pass', pixelBand: p > 5 ? 'fail' : p >= 1 ? 'review' : 'pass' });
  wr(f, d);
};
const NO_ERROR_STATE = { error: { result: 'CANNOT_VERIFY', note: 'No error branch can be reached on this fixture.' } };

test('B5: one compare row without a design image or a diff verifies nothing (was PASS)', (t) => {
  const row = { state: 'with-data', elementClass: 'title', index: 0, selector: 'h1', property: 'color', design: 'rgb(0, 0, 0)', app: 'rgb(0, 0, 0)', delta: null, result: 'PASS' };
  const ws = workspace(t, { worklist: false, compare: { 'with-data': { style: [row], tokens: [], components: [], motion: [], structure: [] } } });
  for (const s of ['with-data', 'empty', 'error']) unlinkSync(path.join(ws.dir, 'evidence', 'figma', `${s}.png`));
  unlinkSync(path.join(ws.dir, 'evidence', 'diff.json'));
  const r = build(ws, { findings: [], states: NO_ERROR_STATE });
  assert.ok(r.report, problems(r));
  const wd = r.report.stateMatrix.find((x) => x.state === 'with-data');
  assert.deepEqual([wd.result, wd.note], ['CANNOT_VERIFY', 'Captured, not compared: no design image (export the frame at 1x).']);
  assert.equal(scorecardHeadline(r.report.scorecard), 'INCOMPLETE · match not measured · 0 of 0 findings settled · 0 of 3 states verified');
});

test('B5: a DATA finding explains only the area it names; a 40% difference stays open (was REVIEW · match 100%)', (t) => {
  // A 1% region with a computed "likely DATA" hint: the DATA finding settles that 1%, nothing more.
  const ws = workspace(t, { worklist: [worklistItem('wl:with-data:rows', { percentOfPage: 1, hints: [{ kind: 'data', text: 'likely DATA: more rows' }] })] });
  setDiff(ws, { 'with-data': 40 });
  const r = build(ws, { findings: [titleFinding({ expected: { value: '32px' }, worklist: 'wl:with-data:rows', resolution: 'DATA', dataReason: 'staging data differs from the design mock' })], states: NO_ERROR_STATE });
  assert.ok(r.report, problems(r));
  const sc = r.report.scorecard;
  assert.equal(sc.verdict, 'FAIL');
  assert.equal(sc.matchByState['with-data'], 61);
  assert.match(explainVerdict(r.report).reasons[0], /^pixel diff for "with-data" is in the fail band: 39% of the page differs/);
});

test('B3: differences beyond the worklist caps count against match and hold the verdict at REVIEW (was PASS · match 100%)', (t) => {
  const ws = workspace(t);
  setDiff(ws, { 'with-data': 0.5, empty: 0.2 });
  const file = path.join(ws.dir, 'evidence', 'worklist.json');
  const wl = rd(file);
  Object.assign(wl.coverage['with-data'], { percentDiffering: 3, unlistedItems: 1, unlistedPercentOfPage: 2.5 });
  wl.unlisted = [worklistItem('wl:with-data:1480,100', { percentOfPage: 2.5, hints: [] })];
  wr(file, wl);
  const matrix = path.join(ws.dir, 'state-matrix.json');
  wr(matrix, rd(matrix).filter((x) => x.state !== 'error'));
  const r = build(ws, { findings: [] });
  assert.ok(r.report, problems(r));
  assert.deepEqual(r.report.differences['with-data'].unlisted, { count: 1, percent: 2.5 });
  assert.equal(r.report.scorecard.matchByState['with-data'], 97);
  assert.equal(r.report.scorecard.verdict, 'REVIEW');
  assert.deepEqual(explainVerdict(r.report).reasons, ['"with-data": 1 difference(s), 2.5% of the page, were not on the worklist and nobody decided them: list them with worklist.mjs --dir <report folder> --max-per-state 1 --max-total 1 --run 20261004T100000Z-abc123, then file or reject each']);
  assert.ok(summaryLines(r.report, r.info).some((l) => /^Not on the worklist: 1 difference\(s\) \(with-data 2\.5% of the page\) that nobody decided: they count against match/.test(l)));
  // The differences are rebuilt from the evidence on validate: a hand edit is refused.
  const out = path.join(ws.dir, 'report.json');
  wr(out, r.report);
  assert.deepEqual(verifyBuiltReport(out, rd(out)).errors, []);
  const edited = rd(out);
  edited.differences['with-data'].unlisted = { count: 0, percent: 0 };
  assert.match(verifyBuiltReport(out, edited).errors.map((e) => `${e.path}: ${e.message}`).join('\n'), /^differences: differs from what build-report\.mjs builds/m);
});

test('B4: blanket rejection is refused; a rejection counts as matching only when a computed hint supports it', (t) => {
  const items = (n, hints) => Array.from({ length: n }, (_, i) => worklistItem(`wl:with-data:${i}`, { rect: { x: 100, y: 100 * i, w: 300, h: 50 }, crop: { x: 100, y: 100 * i, w: 300, h: 50 }, percentOfPage: 1, hints }));
  const stock = 'Not a real difference, checked by eye.';
  // Five regions, one stock sentence, nothing computed behind it: a build error asking for a reason each.
  const ws = workspace(t, { worklist: items(5, [{ kind: 'size', text: 'rows are 4 px shorter' }]) });
  let r = build(ws, { findings: [], rejected: [{ worklist: items(5).map((w) => w.key), reason: 'intentional', detail: stock }], states: NO_ERROR_STATE });
  assert.equal(r.report, null);
  assert.match(problems(r), /^rejected\[0\]\.detail: the same detail is given for 5 worklist regions that no computed hint supports \("wl:with-data:0", .*\): look at each one and say why it is not a finding, one rejection per reason$/m);

  // Supported (rendering, likely DATA) rejections settle their area; unsupported ones stay different.
  const ws2 = workspace(t, { worklist: [
    ...items(1, [{ kind: 'rendering', text: 'same text and boxes on both sides' }]),
    worklistItem('wl:with-data:data', { percentOfPage: 1, hints: [{ kind: 'data', text: 'likely DATA: more rows' }] }),
    worklistItem('wl:with-data:other', { percentOfPage: 1, hints: [{ kind: 'size', text: 'rows are 4 px shorter' }] }),
  ] });
  setDiff(ws2, { 'with-data': 3, empty: 0.2 });
  r = build(ws2, { findings: [], states: NO_ERROR_STATE, rejected: [
    { worklist: 'wl:with-data:0', reason: 'same', detail: 'Same text, values and boxes; only the glyph rendering differs.' },
    { worklist: 'wl:with-data:data', reason: 'DATA', detail: 'The fixture has more orders than the design mock.' },
    { worklist: 'wl:with-data:other', reason: 'intentional', detail: 'The rows were made shorter on purpose.' },
  ] });
  assert.ok(r.report, problems(r));
  const regions = r.report.differences['with-data'].regions.map((x) => [x.key, x.rejected, x.supported]);
  assert.deepEqual(regions, [['wl:with-data:0', 'same', true], ['wl:with-data:data', 'DATA', true], ['wl:with-data:other', 'intentional', false]]);
  assert.equal(r.report.scorecard.matchByState['with-data'], 99, '3% differs, 2% settled by supported rejections: the unsupported 1% stays open');
  assert.ok(explainVerdict(r.report).reasons.includes('1% of "with-data" was rejected as intentional with no computed hint behind it: it still counts as different; check those regions'));
});

test('B4: "matches-design" is refused for an audit candidate whose design value is known and differs', (t) => {
  const cand = auditCandidate('style:radius:999px', { _audit: { kind: 'off-token', count: 3, designCheck: 'different', designValue: '6px' } });
  const ws = workspace(t, { audit: [cand] });
  let r = build(ws, { findings: [titleFinding()], rejected: [{ auditKey: 'style:radius:999px', reason: 'matches-design', detail: 'The design uses a pill radius here.' }], states: NO_ERROR_STATE });
  assert.equal(r.report, null);
  assert.match(problems(r), /rejected\[0\]\.auditKey: "style:radius:999px": the audit read the design's value, "6px", and it differs from the app's "999px", so "matches-design" does not apply: file it or give another reason/);
  const ws2 = workspace(t, { audit: [{ ...cand, _audit: { ...cand._audit, designCheck: 'unknown', designValue: 'unknown' } }] });
  r = build(ws2, { findings: [titleFinding()], rejected: [{ auditKey: 'style:radius:999px', reason: 'matches-design', detail: 'The design uses a pill radius here.' }], states: NO_ERROR_STATE });
  assert.ok(r.report, problems(r));
});

test('a design-system check that did not run says so and why, never 0', (t) => {
  // The audit was skipped (ds-audit.json says why): tokens and components not checked, with the reason, never "script, 0".
  const ws = workspace(t);
  wr(path.join(ws.dir, 'evidence', 'ds-audit.json'), { tool: 'ds-audit', skipped: { reason: 'no token source found (designSystem.tokens is empty)', fix: 'set designSystem.tokens' }, candidates: [], summary: { elementsChecked: 0, offTokenValues: 0, nonSystemComponents: 0 } });
  let r = build(ws, { findings: [titleFinding({ expected: { value: '32px' } })], states: NO_ERROR_STATE });
  assert.ok(r.report, problems(r));
  const why = 'the design-system audit was skipped: no token source found (designSystem.tokens is empty)';
  assert.deepEqual([r.report.meta.tools.dsAudit, r.report.meta.notChecked], ['none', { tokens: why, components: why }]);
  assert.deepEqual(r.report.scorecard.designSystem, { tokens: null, components: null, motion: 0 });
  assert.ok(summaryLines(r.report, r.info).includes(`Design system: tokens not checked · components not checked · motion 0 · no design-system audit (not checked: ${why})`));
  // The audit ran but no component library is configured: components not checked.
  const ws2 = workspace(t, { audit: [auditCandidate('style:radius:999px')] });
  r = build(ws2, { findings: [titleFinding(), { auditKey: 'style:radius:999px' }], states: NO_ERROR_STATE });
  assert.ok(r.report, problems(r));
  assert.deepEqual(r.report.scorecard.designSystem, { tokens: 2, components: null, motion: 0 });
  assert.match(r.report.meta.notChecked.components, /^no component library is configured: set designSystem\.libraries/);
});

test('B6: on a deployed target a finding\'s actual value must be what the capture computed for its pinned element', (t) => {
  const ws = workspace(t, { url: 'https://staging.acme.example/orders' });
  let r = build(ws, { findings: [titleFinding({ actual: { value: '99px', token: null, source: { file: 'src/orders/OrdersPage.tsx', line: 12 } } })], states: NO_ERROR_STATE });
  assert.equal(r.report, null);
  assert.match(problems(r), /^findings\[0\]\.actual\.value: is "99px", but the captured page shows "28px" for font-size on grab "title"\[0\] in "with-data": on a deployed target the capture is the truth, not the local source/m);
  r = build(ws, { findings: [titleFinding()], states: NO_ERROR_STATE });
  assert.ok(r.report, problems(r));
  // A local target reads values from the source it runs: not compared.
  const local = workspace(t);
  assert.ok(build(local, { findings: [titleFinding({ actual: { value: '99px', token: null } })], states: NO_ERROR_STATE }).report);
});

test('a page taller than the design: the part only one image has is a REVIEW reason, not in match (never 100%, never all different)', (t) => {
  const ws = workspace(t, { worklist: [
    worklistItem('wl:with-data:band', { kind: 'extra-in-app', rect: { x: 0, y: 1800, w: 1440, h: 200 }, crop: { x: 0, y: 1800, w: 1440, h: 200 }, pixels: 288000, percentOfPage: 10, hints: [] }),
    worklistItem('wl:with-data:title', { pixels: 4320, percentOfPage: 0.15 }),
  ] });
  // diff.mjs: the design is 200 px shorter; only the area both images have is compared.
  const f = path.join(ws.dir, 'evidence', 'diff.json');
  const d = rd(f);
  Object.assign(d.results['with-data'], {
    designHeight: 1800, padded: { side: 'design', rows: 200 }, percent: 0.3, band: 'review', pixelBand: 'pass',
    paddedRegions: [{ x: 0, y: 1800, w: 1440, h: 200, pixels: 288000, padded: true, side: 'design', sizeDiff: { axis: 'height', px: 200 } }],
    masks: [{ label: 'clock', x: 1300, y: 20, w: 100, h: 24, pixels: 2400 }],
  });
  wr(f, d);
  const wl = path.join(ws.dir, 'evidence', 'worklist.json');
  const w = rd(wl);
  Object.assign(w.coverage['with-data'], { differingPixels: 292320, pageArea: 2880000, percentDiffering: 10.15 });
  wr(wl, w);
  const r = build(ws, { findings: [
    titleFinding({ worklist: 'wl:with-data:title', pin: undefined }),
    { ref: 'taller', worklist: 'wl:with-data:band', title: 'The page has 200 px the design does not', ledger: 'structure', severity: 'WARNING', region: 'Footer', expected: { value: '1800 px tall' }, actual: { value: '2000 px tall' }, fix: { summary: 'Remove the extra block' } },
  ], states: NO_ERROR_STATE });
  assert.ok(r.report, problems(r));
  assert.deepEqual(r.report.differences['with-data'].regions.map((x) => [x.key, x.percent]), [['wl:with-data:title', 0.17]], 'the band is no region; shares are of the compared area');
  assert.equal(r.report.differences['with-data'].differing, 0.17);
  assert.equal(r.report.scorecard.matchByState['with-data'], 99);
  assert.deepEqual(r.report.scorecard.pixelDiff['with-data'].masks, [{ label: 'clock', x: 1300, y: 20, w: 100, h: 24, pixels: 2400 }]);
  assert.ok(explainVerdict(r.report).reasons.includes('"with-data": the app page is 200 px taller than the design; that part is not compared: check it against the design'));
  assert.ok(!explainVerdict(r.report).reasons.includes('pixel diff for "with-data" is in the review band'), 'the size reason replaces the generic band reason');
  assert.deepEqual(r.warnings.filter((w) => /unknown key/.test(w)), []);
});

test('a page capture.mjs cut itself counts as declared (REVIEW with its reason), and what preCapture hid is in the report', (t) => {
  const ws = workspace(t, { partial: true });
  const f = path.join(ws.dir, 'evidence', 'capture.json');
  const c = rd(f);
  const why = 'the page grows as it scrolls (infinite list): captured down to 900 px';
  c.states['with-data'].partial = [why];
  c.states['with-data'].preCapture = { clicked: [], removed: [], matched: [{ selector: '.chat-widget', kind: 'hide', count: 1, areaPx: 14400, rects: [] }, { selector: '.gone', kind: 'remove', count: 0, areaPx: 0, rects: [] }] };
  c.degradations = [{ step: 'capture-coverage:with-data', reason: why, impact: 'below 900 px not compared' }];
  wr(f, c);
  const r = build(ws, { findings: [titleFinding()], states: NO_ERROR_STATE });
  assert.ok(r.report, problems(r));
  assert.equal(r.report.stateMatrix[0].captured.page.partial, true);
  assert.equal(r.report.scorecard.stateCoverage.partial, 1);
  assert.ok(explainVerdict(r.report).reasons.includes(`"with-data" was captured only in part: ${why}`));
  assert.deepEqual(r.report.evidence.states['with-data'].hidden, [{ selector: '.chat-widget', kind: 'hide', count: 1, areaPx: 14400 }]);
  assert.ok(summaryLines(r.report, r.info).includes(`Only part of the page: with-data (capture: ${why})`));
  assert.deepEqual(r.warnings.filter((w) => /unknown key/.test(w)), []);
});
