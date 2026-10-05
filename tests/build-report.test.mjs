// build-report.mjs: report.json assembled from the evidence of a pass plus findings.json,
// valid with the evidence gates as errors, or a list of what to change in findings.json.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { SKILL, run, script, tmpDir } from './_helpers.mjs';
import { createPng, writePng } from '../skills/design-qa/scripts/lib/png.mjs';
import { auditCandidate, LOCAL_COMMIT, makePass, RUN_ID, titleFinding, worklistItem } from './fixtures/build-report-pass/make.mjs';
import * as wl from './fixtures/worklist-lib/make.mjs';
import { checkFindingsShape, matchKnownDrifts, normalizeSelector, parseKnownDrifts } from '../skills/design-qa/scripts/lib/build-report.mjs';

function workspace(t, opts) {
  const root = tmpDir('design-qa-build-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return makePass(root, opts);
}
const writeFindings = (ws, doc) => writeFileSync(ws.findingsFile, JSON.stringify(doc, null, 2));
const build = (ws, extra = []) => run(script('build-report.mjs'), ['--dir', 'qa-reports/abc-123', '--config', 'design-qa.config.json', ...extra], { cwd: ws.root, env: { DESIGN_QA_RUN_ID: RUN_ID } });
const readReport = (ws) => JSON.parse(readFileSync(path.join(ws.dir, 'report.json'), 'utf8'));
const validate = (ws) => run(script('validate.mjs'), ['qa-reports/abc-123/report.json', '--config', 'design-qa.config.json'], { cwd: ws.root });

const badgeFinding = (over = {}) => ({
  ref: 'badge',
  title: 'Status badge is a hand-styled span, not Acme Badge',
  ledger: 'component',
  state: 'with-data',
  severity: 'BLOCKER',
  region: 'Orders table',
  expected: { value: 'Badge (success)', token: 'Badge' },
  actual: { value: 'span.pill.pill-green' },
  fix: { summary: 'Render <Badge variant="success">', files: ['src/orders/StatusCell.tsx'], effort: 2 },
  pin: { grab: 'badge' },
  ...over,
});
const errorStateFinding = { title: 'Error state is not implemented: a failed fetch shows a blank table', ledger: 'state', state: 'error', severity: 'BLOCKER', region: 'Page', expected: { value: 'Error frame with Try again' }, actual: { value: 'blank table' }, fix: { summary: 'Render the error state' } };

test('a single-screen pass builds a report that validates (gates as errors) and renders', async (t) => {
  const ws = workspace(t);
  writeFindings(ws, { findings: [titleFinding(), badgeFinding(), errorStateFinding, { title: 'Empty state matches the design', ledger: 'state', state: 'empty', severity: 'PASS', region: 'Empty state', expected: { value: 'EmptyState' }, actual: { value: 'EmptyState' } }] });
  const res = await build(ws);
  assert.equal(res.code, 0, res.stderr + res.stdout);
  assert.match(res.stdout, /Wrote qa-reports\/abc-123\/report\.json/);
  assert.match(res.stdout, /FAIL · match \d+%( \(\d+ without a pin\))? · \d+ of \d+ findings? settled · 2 of 3 states verified/);
  assert.match(res.stdout, /Captured over the whole page \(the screenshot covers the full page; verified is the headline's count\): with-data 1440×2000 \(1 pin below the first screen\) · empty 1440×900/);
  assert.match(res.stdout, /Next: node \S+render-report\.mjs --in qa-reports\/abc-123\/report\.json .*--recompute --write-back/);
  assert.match(res.stdout, /Worklist: 0 item\(s\): 0 covered by 0 finding\(s\), 0 rejected/);
  const r = readReport(ws);
  assert.deepEqual(r.findings.map((f) => f.id), ['DQ-001', 'DQ-002', 'DQ-003', 'DQ-004']);
  // Derived, never typed: meta, the matrix with the whole-page facts, the pixel diff.
  assert.equal(r.meta.feature, 'abc-123');
  assert.deepEqual(r.meta.ticket, { provider: 'jira', key: 'ABC-123', url: 'https://acme.atlassian.net/browse/ABC-123', title: 'Orders list' });
  assert.equal(r.meta.figma.nodeId, '1:2');
  assert.deepEqual(r.meta.source.frame, { width: 1440, height: 2000 });
  assert.deepEqual(r.meta.target, { kind: 'local', localCommit: LOCAL_COMMIT, deployedCommit: LOCAL_COMMIT });
  assert.equal(r.meta.tools.dsAudit, 'none');
  const row = r.stateMatrix.find((s) => s.state === 'with-data');
  assert.equal(row.result, 'FAIL');
  assert.equal(row.note, null, 'the "pending capture" note is gone');
  assert.deepEqual(row.captured.page, { width: 1440, height: 2000, fullPage: true, clipped: 0, image: { width: 1440, height: 2000 } });
  assert.equal(r.stateMatrix.find((s) => s.state === 'empty').result, 'PASS');
  assert.equal(r.stateMatrix.find((s) => s.state === 'error').result, 'MISSING_IN_CODE');
  assert.deepEqual(r.scorecard.pixelDiff['with-data'], { percent: 3.2, band: 'review', image: 'evidence/diff/with-data.png', structuralPercent: 0, structuralBand: 'pass', designHeight: 2000, appHeight: 2000, designWidth: 1440, appWidth: 1440 });
  assert.deepEqual(r.ledgers.state.map((s) => s.result), ['FAIL', 'PASS', 'MISSING_IN_CODE']);
  // Pins: the selector and the grab, below the fold, on the app screenshot; defaults filled.
  const title = r.findings[0];
  assert.deepEqual(title.evidence[0], { type: 'screenshot', path: 'evidence/app/with-data.png', crop: { x: 120, y: 96, w: 400, h: 36 }, state: 'with-data' });
  assert.equal(title.evidence[1].type, 'computed');
  assert.equal(title.expected.source, 'figma');
  assert.deepEqual(title.fix, { patchHint: null, files: ['src/orders/OrdersPage.tsx'], effort: 3, summary: 'Use the heading/lg text style on the page title' }, 'files default to actual.source.file');
  assert.equal(title.element.selector, 'h1');
  assert.deepEqual(r.findings[1].evidence[0].crop, { x: 1300, y: 1700, w: 66, h: 23 });
  assert.equal(r.findings[3].resolution, 'NONE');
  assert.equal(r.scorecard.designSystem.components, 1);
  const v = await validate(ws);
  assert.equal(v.code, 0, v.stdout + v.stderr);
  const render = await run(script('render-report.mjs'), ['--in', 'qa-reports/abc-123/report.json', '--out', 'qa-reports/abc-123/report.html', '--fixplan', 'qa-reports/abc-123/report-fixplan.md', '--config', 'design-qa.config.json', '--recompute', '--write-back', '--run', RUN_ID], { cwd: ws.root });
  assert.equal(render.code, 0, render.stderr);
  assert.ok(existsSync(path.join(ws.dir, 'report.html')));
});

test('pins: grab with index, audit element, ambiguous selector (topmost, said so), clipped to the image', async (t) => {
  const ws = workspace(t, { audit: [] });
  writeFindings(ws, {
    findings: [
      titleFinding({ ref: 'row-3', title: 'Third row divider is a raw hex', property: 'border-color', expected: { value: '#E4E7EC', token: 'border/subtle' }, actual: { value: '#D1D5DB' }, pin: { grab: 'row', index: 2 } }),
      titleFinding({ ref: 'rows', title: 'Rows are 48px instead of 52px', property: 'height', expected: { value: '52px' }, actual: { value: '48px' }, pin: { selector: "[data-testid='order-row']" } }),
      titleFinding({ ref: 'export', title: 'Export is a raw button, not Acme Button', ledger: 'component', property: null, expected: { value: 'Button (secondary)' }, actual: { value: 'button.export' }, pin: { audit: 'button.export' } }),
      titleFinding({ ref: 'footer', title: 'Footer background is a raw hex', property: 'background-color', expected: { value: '#FFFFFF' }, actual: { value: '#FAFAFA' }, pin: { grab: 'footer' } }),
    ],
  });
  const res = await build(ws);
  assert.equal(res.code, 0, res.stderr + res.stdout);
  const r = readReport(ws);
  assert.deepEqual(r.findings[0].evidence[0].crop, { x: 120, y: 1500, w: 1200, h: 48 }, 'index 2 is the third row, far below the fold');
  assert.deepEqual(r.findings[1].evidence[0].crop, { x: 120, y: 300, w: 1200, h: 48 }, 'several matches: the topmost');
  assert.match(res.stdout, /findings\[1\]\.pin: 3 elements match selector "\[data-testid='order-row'\]"; pinned the topmost \(grab "row"\[0\] at 120,300\)\. Set "index" \(0–2/);
  assert.deepEqual(r.findings[2].evidence[0].crop, { x: 1200, y: 120, w: 120, h: 36 }, 'resolved from audit/with-data.json');
  assert.deepEqual(r.findings[3].evidence[0].crop, { x: 0, y: 1900, w: 1440, h: 100 }, 'clipped to the 1440 px image');
  assert.match(res.stdout, /findings\[3\]\.pin: grab "footer"\[0\] runs past the edge of evidence\/app\/with-data\.png; the crop was clipped/);
});

test('pins: no match, unknown grab, invisible element, index out of range and Figma-side pins', async (t) => {
  const ws = workspace(t);
  writeFindings(ws, {
    findings: [
      titleFinding({ ref: 'a', pin: { selector: '[data-testid=order-rows]' } }),
      titleFinding({ ref: 'b', pin: { grab: 'bagde' } }),
      titleFinding({ ref: 'c', pin: { grab: 'ghost' } }),
      titleFinding({ ref: 'd', pin: { grab: 'row', index: 5 } }),
      titleFinding({ ref: 'e', pin: { grab: 'missing' } }),
      titleFinding({ ref: 'f', pins: [{ selector: 'h1' }, { side: 'design', figmaNode: '1:10' }] }),
    ],
  });
  const res = await build(ws);
  assert.equal(res.code, 1, res.stdout);
  assert.match(res.stderr, /findings\[0\]\.pin: selector "\[data-testid=order-rows\]" matches no grabbed or audited element in state "with-data"; near: "\[data-testid=order-row\]"/);
  assert.match(res.stderr, /findings\[1\]\.pin: grab "bagde" is not in evidence\/computed\/with-data\.json; did you mean "badge"\?/);
  assert.match(res.stderr, /findings\[2\]\.pin: grab "ghost"\[0\] is not visible in "with-data"/);
  assert.match(res.stderr, /findings\[3\]\.pin: index 5 is out of range: 3 element\(s\) match/);
  assert.match(res.stderr, /findings\[4\]\.pin: grab "missing" matched no element in state "with-data" \(count 0\)/);
  assert.doesNotMatch(res.stderr, /findings\[5\]/, 'a Figma-side pin from the layer box is fine');
  assert.ok(!existsSync(path.join(ws.dir, 'report.json')), 'nothing written');
  writeFindings(ws, { findings: [titleFinding({ pins: [{ selector: 'h1' }, { side: 'design', figmaNode: '1:10' }] })] });
  const ok = await build(ws);
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(readReport(ws).findings[0].evidence[1], { type: 'figma', path: 'evidence/figma/with-data.png', crop: { x: 120, y: 96, w: 400, h: 36 }, state: 'with-data' }, 'layer box minus the frame origin');
});

test('an open finding without a pin needs an unpinnedReason; a MISSING_IN_CODE state needs none', async (t) => {
  const ws = workspace(t);
  writeFindings(ws, { findings: [titleFinding({ pin: undefined }), titleFinding({ ref: 'x', pin: undefined, unpinnedReason: 'too short' }), errorStateFinding] });
  const res = await build(ws);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /findings\[0\]\.pin: an open FIX_CODE finding needs a pin/);
  assert.match(res.stderr, /findings\[1\]\.unpinnedReason: must be at least 20 characters/);
  assert.doesNotMatch(res.stderr, /findings\[2\]/);
  writeFindings(ws, { findings: [titleFinding({ pin: undefined, unpinnedReason: 'The title is absent from every capture of this page.' }), errorStateFinding] });
  const ok = await build(ws);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(readReport(ws).scorecard.unpinned, 2);
});

test('whole page: a capture smaller than its page fails unless pass.degradations names the state; clipped panels become a degradation', async (t) => {
  const ws = workspace(t, { partial: true });
  writeFindings(ws, { findings: [titleFinding()] });
  const res = await build(ws);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /states\.with-data: the app capture of "with-data" is 1440×900 but its page is 1440×2000: only part of the page was captured/);
  // A routine degradation that names the state does not excuse it; one about its coverage does.
  writeFindings(ws, { pass: { degradations: [{ step: 'behaviour:with-data', reason: 'The export menu of with-data needs a flag.', impact: 'Export not checked.' }] }, findings: [titleFinding()] });
  assert.equal((await build(ws)).code, 1);
  writeFindings(ws, { pass: { degradations: [{ step: 'capture-coverage:with-data', reason: 'The page is a canvas taller than the browser can render.', impact: 'Below 900 px nothing is compared.' }] }, findings: [titleFinding()] });
  const ok = await build(ws);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /Only part of the page: with-data 1440×900 of 1440×2000 \(declared in pass\.degradations\)/);
  const page = readReport(ws).stateMatrix[0].captured.page;
  assert.deepEqual(page, { width: 1440, height: 2000, fullPage: false, clipped: 0, image: { width: 1440, height: 900 }, partial: true }, 'recorded as partial');

  const ws2 = workspace(t, { clipped: true });
  writeFindings(ws2, { findings: [titleFinding()] });
  const clipped = await build(ws2);
  assert.equal(clipped.code, 0, clipped.stderr);
  const r = readReport(ws2);
  assert.equal(r.stateMatrix[0].captured.page.clipped, 1);
  assert.ok(r.meta.degradations.some((d) => d.step === 'capture:with-data' && /div\.side-panel \(640 px down\)/.test(d.reason)));
  const v = await validate(ws2);
  assert.equal(v.code, 0);
  assert.doesNotMatch(v.stdout + v.stderr, /still hide/, 'the validator sees the clipped panel explained');
});

test('a state stopped by sign-in is CANNOT_VERIFY with the reason; a pass where every state failed is INCOMPLETE', async (t) => {
  const signIn = { kind: 'sign-in', finalUrl: 'https://login.acme.dev/sso', detail: 'a sign-in form at the same URL' };
  const ws = workspace(t, { failures: { empty: signIn } });
  writeFindings(ws, { findings: [titleFinding()] });
  const res = await build(ws);
  assert.equal(res.code, 0, res.stderr);
  const r = readReport(ws);
  const empty = r.stateMatrix.find((s) => s.state === 'empty');
  assert.equal(empty.result, 'CANNOT_VERIFY');
  assert.match(empty.note, /the capture landed on a sign-in page \(https:\/\/login\.acme\.dev\/sso\)/);
  assert.equal(empty.captured.app, null);
  assert.ok(r.meta.degradations.some((d) => d.step === 'capture:empty' && /sign-in page/.test(d.reason)));
  assert.match(res.stdout, /Not verified: empty CANNOT_VERIFY · error MISSING_IN_CODE/);

  const stopped = { kind: 'stopped', finalUrl: null, detail: 'capture stopped: state "with-data" landed on a sign-in page' };
  const all = workspace(t, { failures: { 'with-data': signIn, empty: stopped }, top: { ...signIn, state: 'with-data' } });
  const rows = JSON.parse(readFileSync(path.join(all.dir, 'state-matrix.json'), 'utf8')).filter((x) => x.state !== 'error');
  writeFileSync(path.join(all.dir, 'state-matrix.json'), JSON.stringify(rows));
  writeFindings(all, { findings: [] });
  const res2 = await build(all);
  assert.equal(res2.code, 0, res2.stderr);
  assert.match(res2.stdout, /INCOMPLETE · match not measured · \d+ of \d+ findings? settled · 0 of 2 states verified/);
  const r2 = readReport(all);
  assert.equal(r2.scorecard.verdict, 'INCOMPLETE');
  assert.match(r2.stateMatrix[1].note, /Not captured: capture stopped/);
  // A pin on a state that was not captured names the failure.
  writeFindings(all, { findings: [titleFinding()] });
  const pin = await build(all);
  assert.equal(pin.code, 1);
  assert.match(pin.stderr, /findings\[0\]\.pin: cannot pin on the app side of "with-data": Not compared: the capture landed on a sign-in page/);
});

test('design-system audit candidates are filed, rejected, or the build fails listing them', async (t) => {
  const ws = workspace(t, {
    audit: [
      auditCandidate('style:border-radius:999px'),
      auditCandidate('style:color:#3a3f47', { title: 'Logo tint #3A3F47 matches no colour token', property: 'color', expected: { value: '#374151', token: '--acme-text', source: 'design-rules' }, actual: { value: '#3a3f47', token: null, source: {} } }),
      auditCandidate('component:mui:button', { title: 'Export is a raw MUI Button', ledger: 'component', property: null, severity: 'BLOCKER', evidence: [{ type: 'screenshot', path: 'evidence/app/with-data.png', crop: { x: 1200, y: 120, w: 120, h: 36 }, state: 'with-data' }] }),
    ],
  });
  writeFindings(ws, {
    findings: [titleFinding(), { auditKey: 'style:border-radius:999px', severity: 'BLOCKER', fix: { summary: 'Render <Badge variant="success">', files: ['src/orders/StatusCell.tsx'] } }],
    rejected: [{ auditKey: 'style:color:#3a3f47', reason: 'DATA', detail: "The colour comes from the customer's logo upload." }],
  });
  const res = await build(ws);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /to decide: 1 design-system audit candidate\(s\) are neither filed nor rejected: "component:mui:button" \(with-data: Export is a raw MUI Button; main > section\.orders > span\[data-testid="status-badge"\] in with-data\)/);
  writeFindings(ws, {
    findings: [titleFinding(), { auditKey: 'style:border-radius:999px', severity: 'BLOCKER', fix: { summary: 'Render <Badge variant="success">', files: ['src/orders/StatusCell.tsx'] } }],
    rejected: [
      { auditKey: 'style:color:#3a3f47', reason: 'DATA', detail: "The colour comes from the customer's logo upload." },
      { auditKey: 'component:mui:button', reason: 'duplicate', duplicateOf: 'style:border-radius:999px', detail: 'Same hand-built control family as the badge; one fix covers both.' },
    ],
  });
  const ok = await build(ws);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /audit script \(1480 elements, 2 off-token, 1 non-system\); candidates 3: 1 filed, 2 rejected/);
  const r = readReport(ws);
  assert.equal(r.meta.tools.dsAudit, 'script');
  assert.deepEqual(r.meta.dsAudit, { elementsChecked: 1480, offTokenValues: 2, nonSystemComponents: 1, output: 'evidence/ds-audit.json', states: 1, candidates: 3 }, 'further summary counts carried');
  const filed = r.findings[1];
  assert.equal(filed.severity, 'BLOCKER', 'the override wins');
  assert.equal(filed.title, 'Status badge radius is a hardcoded 999px, not --acme-radius-md', 'the rest comes from the candidate');
  assert.deepEqual(filed.fix.files, ['src/orders/StatusCell.tsx']);
  assert.equal(filed.fix.patchHint, 'border-radius: var(--acme-radius-md)');
  assert.deepEqual(filed.evidence[0].crop, { x: 1300, y: 1700, w: 66, h: 23 });
  assert.equal('_audit' in filed || 'key' in filed, false);
  assert.equal(r.scorecard.designSystem.tokens, 2);
});

test('known drifts: a likely match must be cited or overridden; citing fills the sign-off', async (t) => {
  const weight = (over = {}) => titleFinding({ ref: 'weight', title: 'Page title weight is 600, not 700', property: 'font-weight', expected: { value: '700' }, actual: { value: '600' }, ...over });
  const ws = workspace(t);
  writeFindings(ws, { findings: [weight()] });
  const res = await build(ws);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /findings\[0\]\.knownDrift: this looks like KD-1 \(Page title weight is 600; Figma shows 700\): expected 700 is in its Design line, actual 600 in its Code line, and "(page|title|weight)/);
  assert.match(res.stderr, /"notKnownDrift": \{ "KD-1": "<why>" \}/);
  writeFindings(ws, { findings: [weight({ notKnownDrift: { 'KD-1': 'KD-1 covers list pages; this is the detail page, whose title uses another style.' } })] });
  const differs = await build(ws);
  assert.equal(differs.code, 0, differs.stderr);
  assert.match(differs.stdout, /Note: findings\[0\]: looks like KD-1 .* but differs: KD-1 covers list pages/);
  writeFindings(ws, { findings: [weight({ knownDrift: 'KD-1', fix: undefined })] });
  const cited = await build(ws);
  assert.equal(cited.code, 0, cited.stderr);
  const f = readReport(ws).findings[0];
  assert.equal(f.resolution, 'INTENTIONAL');
  assert.deepEqual(f.signoff, { by: 'Dana Lee (Design lead)', date: '2026-05-02', reason: 'the variable font renders 700 too heavy on Windows.' });
  writeFindings(ws, { findings: [weight({ knownDrift: 'KD-2' }), weight({ ref: 'w2', knownDrift: 'KD-9' })] });
  const bad = await build(ws);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /findings\[0\]\.knownDrift: KD-2 is retired/);
  assert.match(bad.stderr, /findings\[1\]\.knownDrift: KD-9 is not in design-qa\/known-drifts\.md/);
  // An unrelated finding with other values is never matched.
  assert.deepEqual(matchKnownDrifts({ title: 'Row padding', property: 'padding-top', expected: { value: '16px' }, actual: { value: '12px' } }, parseKnownDrifts(readFileSync(path.join(ws.root, 'design-qa', 'known-drifts.md'), 'utf8'))), []);
});

test('schema mistakes are reported with the findings-file path, never coerced', async (t) => {
  const ws = workspace(t);
  writeFindings(ws, {
    findings: [
      titleFinding({ actual: { value: '28px', source: { file: 'src/orders/OrdersPage.tsx', line: '12' } } }),
      titleFinding({ ref: 'b', titel: 'typo' }),
      titleFinding({ ref: 'c', severity: 'Blocker' }),
      titleFinding({ ref: 'd', id: 'DQ-007', expected: { value: 32 } }),
      titleFinding({ ref: 'e', resolution: 'DISMISSED' }),
    ],
    ledgers: { state: [] },
    scorecard: {},
  });
  const res = await build(ws);
  assert.equal(res.code, 1);
  const err = res.stderr;
  assert.match(err, /findings\[0\]\.actual\.source\.line: expected integer or null, got "12"/);
  assert.match(err, /findings\[1\]\.titel: unknown key; did you mean "title"\?/);
  assert.match(err, /findings\[2\]\.severity: expected one of BLOCKER, WARNING, PASS, CANNOT_VERIFY, DS_CANDIDATE \(got "Blocker"\)/);
  assert.match(err, /findings\[3\]\.id: is not written by hand: finding ids \(DQ-…\) are assigned by build-report\.mjs/);
  assert.match(err, /findings\[3\]\.expected\.value: expected string or null, got 32/);
  assert.match(err, /findings\[4\]\.resolution: DISMISSED is a person's decision/);
  assert.match(err, /ledgers\.state: is not written by hand: the state ledger is derived/);
  assert.match(err, /scorecard: is not written by hand: the scorecard is derived/);
  assert.ok(!existsSync(path.join(ws.dir, 'report.json')));
  // The template itself is a valid findings file.
  const template = JSON.parse(readFileSync(path.join(SKILL, 'references', 'templates', 'findings.template.json'), 'utf8'));
  assert.deepEqual(checkFindingsShape(template).errors, []);
});

test('a state that is not a matrix row, a missing fix and a missing required key are named', async (t) => {
  const ws = workspace(t);
  writeFindings(ws, { findings: [titleFinding({ state: 'with-dta' }), titleFinding({ ref: 'b', fix: undefined }), titleFinding({ ref: 'c', region: undefined })] });
  const res = await build(ws);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /findings\[0\]\.state: "with-dta" is not a row of state-matrix\.json; did you mean "with-data"\?/);
  assert.match(res.stderr, /findings\[1\]\.fix: is required for FIX_CODE/);
  assert.match(res.stderr, /findings\[2\]\.region: required key is missing/);
});

test('rebuilding keeps ids, dismissals, triage with ticket keys, fixLoop and backfill; says what was dropped', async (t) => {
  const ws = workspace(t, { backfill: [{ state: 'bulk-selected', label: 'Bulk selected', discoveredBy: 'source', detail: 'OrdersTable.tsx:88' }] });
  const radius = titleFinding({ ref: 'radius', title: 'Badge radius is 999px instead of radius/md', property: 'border-radius', expected: { value: '6px', token: 'radius/md' }, actual: { value: '999px' }, pin: { grab: 'badge' } });
  const rows = titleFinding({ ref: 'rows', title: 'Rows are 48px instead of 52px', property: 'height', expected: { value: '52px' }, actual: { value: '48px' }, pin: { grab: 'row', index: 0 } });
  writeFindings(ws, { findings: [titleFinding(), badgeFinding(), radius, rows] });
  assert.equal((await build(ws)).code, 0);
  const R = ['--report', 'qa-reports/abc-123/report.json'];
  const dismiss = await run(script('dismiss.mjs'), [...R, '--id', 'DQ-003', '--kind', 'not-an-issue', '--reason', 'The pill radius is the catalogue standard.', '--by', 'Dana', '--log', 'qa-reports/abc-123/dismissed.json', '--md', 'qa-reports/abc-123/dismissed.md', '--run', RUN_ID], { cwd: ws.root });
  assert.equal(dismiss.code, 0, dismiss.stderr);
  const triage = await run(script('triage.mjs'), [...R, '--fix', 'DQ-002', '--by', 'Dana', '--run', RUN_ID], { cwd: ws.root });
  assert.equal(triage.code, 0, triage.stderr);
  const r1 = readReport(ws);
  r1.triage.items.find((i) => i.findingId === 'DQ-004').ticket = { provider: 'jira', key: 'ABC-200', url: 'https://acme.atlassian.net/browse/ABC-200', createdAt: '2026-10-04T11:00:00Z' };
  r1.fixLoop = [{ iteration: 1, action: 'Fixed the title and the rows', findingIds: ['DQ-001', 'DQ-004'], testsRun: 'npm test', result: 'green', pixelDiffAfter: null }];
  assert.equal(r1.backfill.items[0].id, 'BF-001');
  r1.backfill.items[0].decision = 'not-needed';
  r1.backfill.items[0].reason = 'Transient: the bulk bar is a library pattern.';
  writeFileSync(path.join(ws.dir, 'report.json'), JSON.stringify(r1, null, 2));

  // A new finding first, the rows finding gone, the rest unchanged.
  const newOne = titleFinding({ ref: 'new', title: 'Footer background is a raw hex', property: 'background-color', expected: { value: '#FFFFFF' }, actual: { value: '#FAFAFA' }, pin: { grab: 'footer' } });
  writeFindings(ws, { findings: [newOne, titleFinding(), badgeFinding(), radius] });
  const res = await build(ws);
  assert.equal(res.code, 0, res.stderr + res.stdout);
  const r2 = readReport(ws);
  assert.deepEqual(r2.findings.map((f) => [f.id, f.title.slice(0, 12)]), [['DQ-005', 'Footer backg'], ['DQ-001', 'Page title i'], ['DQ-002', 'Status badge'], ['DQ-003', 'Badge radius']]);
  assert.equal(r2.findings[3].resolution, 'DISMISSED');
  assert.equal(r2.findings[3].dismissal.reason, 'The pill radius is the catalogue standard.');
  assert.deepEqual(r2.triage.items.map((i) => [i.findingId, i.decision]), [['DQ-001', 'debt'], ['DQ-002', 'fix-now'], ['DQ-005', 'fix-now']]);
  assert.equal(r2.triage.decidedBy, 'Dana');
  assert.deepEqual(r2.fixLoop[0].findingIds, ['DQ-001']);
  assert.equal(r2.backfill.items[0].decision, 'not-needed');
  assert.match(res.stdout, /Kept: DQ-003 dismissed \(not-an-issue\)/);
  assert.match(res.stdout, /Dropped from the existing report\.json: fixLoop iteration 1: DQ-004 \(no longer findings\) · triage DQ-004 \(ticket ABC-200\): the finding is gone/);
  assert.match(res.stdout, /triage: 1 new finding\(s\) added with the recommended split \(DQ-005 fix-now\)/);
  assert.equal((await validate(ws)).code, 0);
  // The dismissed finding gone: its dismissal is listed as dropped.
  writeFindings(ws, { findings: [newOne, titleFinding(), badgeFinding()] });
  const again = await build(ws);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /DQ-003 dismissal \(not-an-issue\): the finding is gone/);
});

test('a finding the cumulative dismissed log covers comes back dismissed (prior pass)', async (t) => {
  const ws = workspace(t);
  writeFindings(ws, { findings: [titleFinding(), badgeFinding()] });
  assert.equal((await build(ws)).code, 0);
  const d = await run(script('dismiss.mjs'), ['--report', 'qa-reports/abc-123/report.json', '--id', 'DQ-001', '--kind', 'remove', '--reason', 'Owned by the content team, out of this QA.', '--by', 'Dana', '--run', RUN_ID], { cwd: ws.root });
  assert.equal(d.code, 0, d.stderr);
  rmSync(path.join(ws.dir, 'report.json'));
  const res = await build(ws);
  assert.equal(res.code, 0, res.stderr);
  const f = readReport(ws).findings[0];
  assert.equal(f.resolution, 'DISMISSED');
  assert.equal(f.dismissal.source, 'prior-pass');
  assert.match(res.stdout, /Kept: DQ-001 dismissed in an earlier pass \(DS-0001, remove\)/);
});

test('a report.json of another run is never inherited; the lock must be this run\'s', async (t) => {
  const root = tmpDir('design-qa-build-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const start = await run(script('run.mjs'), ['start', '--dir', 'qa-reports/abc-123', '--json'], { cwd: root, env: { DESIGN_QA_RUN_ID: RUN_ID } });
  assert.equal(start.code, 0, start.stderr);
  const runId = JSON.parse(start.stdout).runId;
  const ws = makePass(root, { lock: false });
  writeFindings(ws, { findings: [titleFinding()] });
  const res = await run(script('build-report.mjs'), ['--dir', 'qa-reports/abc-123', '--config', 'design-qa.config.json', '--run', runId], { cwd: root });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(readReport(ws).meta.runId, runId);
  const v = await validate(ws);
  assert.equal(v.code, 0, v.stdout + v.stderr);
  assert.doesNotMatch(v.stdout + v.stderr, /runId/, 'meta.runId is part of the schema');
  // Another run's id: refused by the lock.
  const other = '20260101T000000Z-abcdef';
  const refused = await run(script('build-report.mjs'), ['--dir', 'qa-reports/abc-123', '--run', other], { cwd: root });
  assert.equal(refused.code, 5);
  assert.match(refused.stderr, /belongs to run/);
  // The folder re-locked by another run, the old report still there: never inherited.
  const lockFile = path.join(ws.dir, '.design-qa-run.json');
  const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
  writeFileSync(lockFile, JSON.stringify({ ...lock, runId: other }));
  const fresh = await run(script('build-report.mjs'), ['--dir', 'qa-reports/abc-123', '--run', other], { cwd: root });
  assert.equal(fresh.code, 5);
  assert.match(fresh.stderr, new RegExp(`report\\.json belongs to run ${runId}, but qa-reports/abc-123 is locked by run ${other}: a fresh pass inherits nothing.*run\\.mjs start`));
});

test('a multi-screen pass: states per screen, screens with variantOf, pins per screen', async (t) => {
  const root = tmpDir('design-qa-build-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ws = makePass(root, { multi: true });
  writeFindings(ws, {
    findings: [
      titleFinding({ state: 'orders/with-data' }),
      badgeFinding({ state: 'with-data', screen: 'details' }),
      titleFinding({ ref: 'bad', state: 'with-data' }),
    ],
  });
  const res = await build(ws);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /findings\[2\]\.state: this is a multi-screen pass: write the state as "<screen>\/<state>" \(screens: orders, details\)/);
  writeFindings(ws, { findings: [titleFinding({ state: 'orders/with-data' }), badgeFinding({ state: 'with-data', screen: 'details' })] });
  const ok = await build(ws);
  assert.equal(ok.code, 0, ok.stderr + ok.stdout);
  const r = readReport(ws);
  assert.deepEqual(r.meta.screens.map((s) => [s.id, s.name, s.appRoute, s.variantOf ?? null]), [['orders', 'Orders', '/orders', null], ['details', 'Order details', '/orders/1', 'orders']]);
  assert.deepEqual(r.findings.map((f) => [f.state, f.screen]), [['orders/with-data', 'orders'], ['details/with-data', 'details']]);
  assert.equal(r.findings[1].evidence[0].path, 'evidence/screens/details/app/with-data.png');
  assert.deepEqual(Object.keys(r.scorecard.pixelDiff), ['orders/with-data', 'orders/empty', 'details/with-data', 'details/empty']);
  assert.equal(r.stateMatrix.find((s) => s.state === 'details/with-data').captured.page.height, 2000);
  assert.equal((await validate(ws)).code, 0);
});

test('a deployed target: meta.target is remote and the unknown local commit is a degradation', async (t) => {
  const ws = workspace(t, { url: 'https://staging.acme.dev/orders' });
  writeFindings(ws, { findings: [titleFinding()] });
  const res = await build(ws);
  assert.equal(res.code, 0, res.stderr);
  const r = readReport(ws);
  assert.deepEqual(r.meta.target, { kind: 'remote', localCommit: null, deployedCommit: null }, 'capture.json\'s commit is the checkout\'s, not the deployed one');
  assert.equal(r.meta.app.commit, null);
  assert.equal(r.meta.app.kind, 'staging');
  assert.deepEqual(r.meta.degradations.find((d) => d.step === 'source trace'), { step: 'source trace', reason: "the local checkout's commit is unknown", impact: 'file references in findings are hints from the local checkout; findings come from the captured page' });
  const v = await validate(ws);
  assert.equal(v.code, 0, v.stdout + v.stderr);
  assert.doesNotMatch(v.stdout + v.stderr, /meta\.target/);
  writeFindings(ws, { pass: { target: { localCommit: LOCAL_COMMIT, deployedCommit: LOCAL_COMMIT.slice(0, 12) } }, findings: [titleFinding()] });
  assert.equal((await build(ws)).code, 0);
  assert.equal(readReport(ws).meta.degradations.some((d) => d.step === 'source trace'), false, 'same commit: no degradation');
});

test('compare.json FAIL rows must be covered by a finding or rejected; covered rows join the ledgers', async (t) => {
  const style = (cls, selector, property, design, app, result) => ({ state: 'with-data', elementClass: cls, index: 0, selector, property, design, app, delta: null, result });
  const ws = workspace(t, {
    compare: {
      'with-data': {
        style: [style('title', 'h1', 'font-size', '32px', '28px', 'FAIL'), style('title', 'h1', 'color', 'rgb(0, 0, 0)', 'rgb(0, 0, 0)', 'PASS'), style('row', 'div.row', 'height', '52px', '48px', 'FAIL')],
        tokens: [{ state: 'with-data', elementClass: 'title', index: 0, selector: 'h1', property: 'font-size', expectedToken: '--acme-font-lg', expectedValue: '32px', actualToken: null, actualValue: '28px', result: 'FAIL' }],
        components: [],
        motion: [],
        structure: [{ state: 'with-data', source: 'dom', elementClass: null, index: null, selector: null, role: 'button', name: 'Export', design: 'missing', app: 'present', result: 'FAIL', note: 'extra in app' }],
      },
    },
  });
  writeFindings(ws, { findings: [titleFinding()] });
  const res = await build(ws);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /compare\.json with-data: FAIL row covered by no finding \(design 52px → app 48px\): add "covers": \[\{"kind":"style","state":"with-data","elementClass":"row","property":"height"\}\] to the finding about this element, or reject it: \{ "compare": \{"kind":"style"/);
  assert.match(res.stderr, /compare\.json with-data: FAIL row covered by no finding \(design missing → app present \(extra in app\)\): add "covers": \[\{"kind":"structure","state":"with-data","role":"button","name":"Export"\}\]/);
  writeFindings(ws, {
    findings: [titleFinding(), { ref: 'export', title: 'App renders an extra Export button not in the design', ledger: 'structure', state: 'with-data', severity: 'WARNING', region: 'Toolbar', expected: { value: 'absent' }, actual: { value: 'Export button' }, fix: { summary: 'Remove the Export button' }, pin: { crop: { x: 1200, y: 120, w: 120, h: 36 } }, covers: [{ kind: 'structure', role: 'button', name: 'Export' }] }],
    rejected: [{ compare: { kind: 'style', state: 'with-data', elementClass: 'row', property: 'height' }, reason: 'DATA', detail: 'Rows grow with the customer name length, which is data.' }],
  });
  const ok = await build(ws);
  assert.equal(ok.code, 0, ok.stderr);
  const r = readReport(ws);
  const fontRow = r.ledgers.style.find((s) => s.property === 'font-size');
  assert.deepEqual([fontRow.result, fontRow.token, fontRow.findingIds], ['FAIL', '--acme-font-lg', ['DQ-001']]);
  assert.equal(r.ledgers.style.find((s) => s.property === 'color').result, 'PASS');
  assert.deepEqual(r.ledgers.structure[0].findingIds, ['DQ-002']);
  assert.equal(r.evidence.compare, 'evidence/compare.json');
  assert.match(ok.stdout, /compare\.json: 5 rows, 4 FAIL, every FAIL row covered or rejected/, 'style, token and structure rows');
});

test('a coded-prototype source: design images and pins from the prototype capture', async (t) => {
  const ws = workspace(t);
  const ev = path.join(ws.dir, 'evidence');
  rmSync(path.join(ev, 'figma-spec.json'));
  rmSync(path.join(ev, 'figma'), { recursive: true });
  for (const [state, h] of [['with-data', 2000], ['empty', 900]]) {
    mkdirSync(path.join(ev, 'design'), { recursive: true });
    writePng(path.join(ev, 'design', `${state}.png`), createPng(1440, h));
  }
  mkdirSync(path.join(ev, 'design-computed'), { recursive: true });
  writeFileSync(path.join(ev, 'design-computed', 'with-data.json'), JSON.stringify({ title: { selector: 'h1', count: 1, samples: [{ __rect: { x: 120, y: 90, w: 420, h: 40 }, __visible: true }] } }));
  const source = { kind: 'prototype', url: 'https://orders-proto.framer.website/orders', label: 'Framer prototype', tool: 'framer', frame: { width: 1440, height: 2000 } };
  writeFileSync(path.join(ev, 'design-capture.json'), JSON.stringify({
    side: 'design', source, url: source.url, frame: source.frame, viewport: { width: 1440, height: 1440 }, dpr: 1, fullPage: true,
    states: { 'with-data': { screenshot: 'design/with-data.png', computed: 'design-computed/with-data.json' }, empty: { screenshot: 'design/empty.png', computed: null } },
  }));
  writeFindings(ws, { findings: [titleFinding({ pins: [{ selector: 'h1' }, { side: 'design', grab: 'title' }] }), titleFinding({ ref: 'b', pins: [{ side: 'design', figmaNode: '1:10' }] })] });
  const bad = await build(ws);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /findings\[1\]\.pins\[0\]: "figmaNode" pins the Figma export/);
  writeFindings(ws, { findings: [titleFinding({ pins: [{ selector: 'h1' }, { side: 'design', grab: 'title' }] })] });
  const res = await build(ws);
  assert.equal(res.code, 0, res.stderr);
  const r = readReport(ws);
  assert.deepEqual(r.meta.source, source);
  assert.equal(r.meta.figma, undefined);
  assert.equal(r.meta.tools.figmaAccess, 'none');
  assert.equal(r.meta.tools.prototypeCapture, 'script');
  assert.equal(r.findings[0].expected.source, 'prototype');
  assert.deepEqual(r.findings[0].evidence[1], { type: 'design', path: 'evidence/design/with-data.png', crop: { x: 120, y: 90, w: 420, h: 40 }, state: 'with-data' });
  assert.equal(r.stateMatrix[0].captured.design, 'evidence/design/with-data.png');
  assert.equal(r.evidence.states['with-data'].designComputed, 'evidence/design-computed/with-data.json');
  assert.equal(r.evidence.prototypeCapture, 'evidence/design-capture.json');
  assert.equal((await validate(ws)).code, 0);
});

test('worklist items are covered by a finding (which they pin) or rejected, in bulk too', async (t) => {
  const ws = workspace(t, {
    worklist: [
      worklistItem('w-rows'),
      worklistItem('w-noise-1', { crop: { x: 0, y: 0, w: 40, h: 40 }, percentOfPage: 0.1 }),
      worklistItem('w-noise-2', { state: 'empty', crop: { x: 0, y: 0, w: 40, h: 40 }, image: 'evidence/app/empty.png', percentOfPage: 0.2 }),
      worklistItem('w-rows-2', { crop: { x: 100, y: 1580, w: 1240, h: 90 } }),
    ],
  });
  const rows = { ref: 'rows', worklist: 'w-rows', title: 'Rows are 48px instead of 52px', ledger: 'style', severity: 'WARNING', region: 'Orders table', property: 'height', expected: { value: '52px' }, actual: { value: '48px' }, fix: { summary: 'Use the table row height token' } };
  writeFindings(ws, { findings: [rows], rejected: [{ worklist: ['w-noise-1', 'w-noise-2'], reason: 'same', detail: 'Anti-aliasing on the icon edges only; nothing a person would call different.' }] });
  const res = await build(ws);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /to decide: 1 worklist item\(s\) are neither covered by a finding nor rejected: "w-rows-2" \(with-data: region, 3\.9% of the page\)/);
  writeFindings(ws, {
    findings: [rows],
    rejected: [
      { worklist: ['w-noise-1', 'w-noise-2'], reason: 'same', detail: 'Anti-aliasing on the icon edges only; nothing a person would call different.' },
      { worklist: 'w-rows-2', reason: 'duplicate', duplicateOf: 'w-rows', detail: 'The next rows, with the same row-height difference.' },
    ],
  });
  const ok = await build(ws);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /Worklist: 4 item\(s\): 1 covered by 1 finding\(s\), 3 rejected/);
  assert.match(ok.stdout, /Rejected: worklist items same 2, duplicate 1/);
  const f = readReport(ws).findings[0];
  assert.equal(f.state, 'with-data', 'the state comes from the item');
  assert.deepEqual(f.evidence[0], { type: 'screenshot', path: 'evidence/app/with-data.png', crop: { x: 100, y: 1480, w: 1240, h: 90 }, state: 'with-data' }, 'pinned on the item');
  assert.match(ok.stdout, /Captured over the whole page \([^)]*\): with-data 1440×2000 \(1 pin below the first screen\)/);
  assert.equal((await validate(ws)).code, 0);
});

test('a worklist.json from the real worklist.mjs: region with alsoIn, missing-in-app, unlisted', async (t) => {
  const root = tmpDir('design-qa-build-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'qa-reports', 'abc-123');
  // with-data: the heading reads differently (also in empty), Section 2 is missing, the footer text differs.
  const d = wl.page({ width: 1280, rows: 4, extraSections: 3 });
  const a = wl.clone(d);
  wl.find(a.boxes, 'Title').text = 'All orders';
  wl.find(a.boxes, 'Footer text').text = 'Acme Ltd';
  wl.removeSection(a, 'Section 2');
  const e = wl.page({ width: 1280, rows: 0 });
  const ea = wl.clone(e);
  wl.find(ea.boxes, 'Title').text = 'All orders';
  const rows = wl.writePass(dir, { 'with-data': { design: d, app: a }, empty: { design: e, app: ea } });
  rows[0].designed.frame = { width: 1280, height: d.height };
  rows[1].designed.frame = { width: 1280, height: e.height };
  wl.writeMatrix(dir, rows);
  const gen = await run(script('worklist.mjs'), ['--dir', dir, '--max-total', '2', '--quiet']);
  assert.equal(gen.code, 0, gen.stderr);
  const worklist = JSON.parse(readFileSync(path.join(dir, 'evidence', 'worklist.json'), 'utf8'));
  const missing = worklist.items.find((it) => it.kind === 'missing-in-app');
  const title = worklist.items.find((it) => it.alsoIn.length);
  assert.ok(missing && title && worklist.unlisted.length === 1, JSON.stringify(worklist.items.map((it) => it.key)));
  assert.equal(missing.rect, null);
  writeFileSync(path.join(dir, 'evidence', 'diff.json'), JSON.stringify({ results: {
    'with-data': { percent: 20.5, band: 'fail', structuralPercent: 0, structuralBand: 'pass', designWidth: 1280, appWidth: 1280, designHeight: d.height, appHeight: a.height, padded: { side: 'app', rows: d.height - a.height }, paddedRight: null },
    empty: { percent: 0.4, band: 'pass', structuralPercent: 0, structuralBand: 'pass', designWidth: 1280, appWidth: 1280, designHeight: e.height, appHeight: ea.height, padded: null, paddedRight: null },
  } }));
  const pass = { app: { url: 'http://localhost:5173/orders' } };
  writeFileSync(path.join(dir, '.design-qa-run.json'), JSON.stringify({ kind: 'design-qa-run', version: 1, runId: RUN_ID, status: 'active', startedAt: '2026-10-04T10:00:00.000Z' }));
  const buildIt = () => run(script('build-report.mjs'), ['--dir', 'qa-reports/abc-123'], { cwd: root, env: { DESIGN_QA_RUN_ID: RUN_ID } });

  // No decisions: the two listed items are named, the unlisted one is not.
  writeFileSync(path.join(dir, 'findings.json'), JSON.stringify({ pass, findings: [] }));
  const none = await buildIt();
  assert.equal(none.code, 1);
  assert.match(none.stderr, /2 worklist item\(s\) are neither covered by a finding nor rejected/);
  assert.ok(none.stderr.includes(missing.key) && none.stderr.includes(title.key));
  assert.ok(!none.stderr.includes(worklist.unlisted[0].key), 'unlisted items need no decision');

  writeFileSync(path.join(dir, 'findings.json'), JSON.stringify({
    pass,
    findings: [
      { ref: 'heading', worklist: title.key, title: 'Page heading reads "All orders" instead of "Orders"', ledger: 'structure', severity: 'WARNING', region: 'Header', expected: { value: 'Orders' }, actual: { value: 'All orders' }, fix: { summary: 'Use the designed heading copy' } },
      { ref: 'section-2', worklist: [missing.key], title: 'Section 2 is not rendered', ledger: 'structure', severity: 'BLOCKER', region: 'Section 2', expected: { value: 'Section 2 with its body copy' }, actual: { value: 'absent' }, fix: { summary: 'Render Section 2 between Section 1 and Section 3' } },
    ],
  }));
  const res = await buildIt();
  assert.equal(res.code, 0, res.stderr + res.stdout);
  assert.match(res.stdout, /Worklist: 2 item\(s\): 2 covered by 2 finding\(s\), 0 rejected/);
  assert.match(res.stdout, /Not on the worklist: 1 difference\(s\) \(with-data [\d.]+% of the page\) that nobody decided: they count against match and make the verdict at least REVIEW; list them with node \S*worklist\.mjs --dir <dir> --max-per-state 3 --max-total 3 --run 20261004T100000Z-abc123, then file or reject each/);
  const r = JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8'));
  // The unlisted difference is evidence too: it stays open in the state's match (review B3).
  const wd = r.differences['with-data'];
  assert.equal(wd.unlisted.count, 1);
  assert.ok(wd.differing > 0 && r.scorecard.matchByState['with-data'] <= 100 - Math.floor(wd.differing), JSON.stringify(wd));
  const [heading, section] = r.findings;
  // The difference shows in every state it occurs in; the finding keeps its primary state.
  assert.equal(heading.state, 'with-data');
  assert.deepEqual(heading.evidence.filter((x) => x.crop).map((x) => [x.type, x.state]), [['screenshot', 'with-data'], ['figma', 'with-data'], ['screenshot', 'empty'], ['figma', 'empty']]);
  assert.deepEqual(heading.evidence[2].crop, title.occurrences[0].crop);
  const empty = r.stateMatrix.find((s) => s.state === 'empty');
  assert.equal(empty.result, 'FAIL', 'the difference occurs in empty too');
  assert.deepEqual(empty.findings, [heading.id]);
  // Missing in the app: the band where it belongs on the app, the real content on the design.
  assert.deepEqual(section.evidence[0], { type: 'screenshot', path: 'evidence/app/with-data.png', crop: missing.crop, state: 'with-data' });
  assert.deepEqual(section.evidence[1], { type: 'figma', path: 'evidence/figma/with-data.png', crop: missing.designCrop, state: 'with-data' });
  const v = await run(script('validate.mjs'), ['qa-reports/abc-123/report.json'], { cwd: root });
  assert.equal(v.code, 0, v.stdout + v.stderr);

  // An unlisted area may still be referenced (or rejected), never required.
  const doc = JSON.parse(readFileSync(path.join(dir, 'findings.json'), 'utf8'));
  doc.rejected = [{ worklist: worklist.unlisted[0].key, reason: 'DATA', detail: 'The company name in the footer comes from the account settings.' }];
  writeFileSync(path.join(dir, 'findings.json'), JSON.stringify(doc));
  const withUnlisted = await buildIt();
  assert.equal(withUnlisted.code, 0, withUnlisted.stderr);
  assert.match(withUnlisted.stdout, /Rejected: worklist items DATA 1/);
});

test('rejections: reasons per target, bulk audit keys and compare rows, both covered and rejected', async (t) => {
  const style = (cls, property) => ({ state: 'with-data', elementClass: cls, index: 0, selector: `.${cls}`, property, design: '1px', app: '2px', delta: 1, result: 'FAIL' });
  const ws = workspace(t, {
    audit: [auditCandidate('a1'), auditCandidate('a2', { property: 'color' }), auditCandidate('a3', { property: 'padding' })],
    worklist: [worklistItem('w1'), worklistItem('w2')],
    compare: { 'with-data': { style: [style('row', 'height'), style('row', 'gap'), style('footer', 'height')], tokens: [], components: [], motion: [], structure: [] } },
  });
  writeFindings(ws, {
    findings: [titleFinding({ worklist: ['w1'] }), { auditKey: 'a1' }],
    rejected: [
      { worklist: 'w1', reason: 'same', detail: 'Rendering noise only, nothing a person would call different.' },
      { worklist: 'w2', reason: 'false-positive', detail: 'Rendering noise only, nothing a person would call different.' },
      { auditKeys: ['a2', 'a3'], reason: 'same', detail: 'Rendering noise only, nothing a person would call different.' },
      { worklist: 'w2', reason: 'covered-by-audit', coveredBy: 'a2', detail: 'The audit candidate a2 reports this region already.' },
    ],
  });
  const bad = await build(ws);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /rejected\[0\]\.worklist: "w1" is both covered \(findings\[0\]\) and rejected: keep one/);
  assert.match(bad.stderr, /rejected\[1\]\.reason: "false-positive" does not apply to a worklist region: use one of DATA, same, duplicate, known-drift, covered-by-audit, intentional, out-of-scope/);
  assert.match(bad.stderr, /rejected\[2\]\.reason: "same" does not apply to an audit candidate/);
  assert.match(bad.stderr, /rejected\[3\]\.coveredBy: audit candidate "a2" is not filed as a finding/);
  writeFindings(ws, {
    findings: [titleFinding({ worklist: ['w1'] }), { auditKey: 'a1' }],
    rejected: [
      { auditKeys: ['a2', 'a3'], reason: 'DATA', detail: 'Both values come from the customer theme, which is data.' },
      { worklist: 'w2', reason: 'covered-by-audit', coveredBy: 'a1', detail: 'The audit candidate a1 reports this region already.' },
      { compare: [{ kind: 'style', state: 'with-data', elementClass: 'row' }, { kind: 'style', state: 'with-data', elementClass: 'footer' }], reason: 'DATA', detail: 'Row and footer heights follow the data length.' },
    ],
  });
  const ok = await build(ws);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /Rejected: audit candidates DATA 2 · worklist items covered-by-audit 1 · compare rows DATA 3/);
  assert.match(ok.stdout, /candidates 3: 1 filed, 2 rejected/);
});

test('--check validates and prints what would be built, writing nothing', async (t) => {
  const ws = workspace(t);
  writeFindings(ws, { findings: [titleFinding()], openDecisions: [{ question: 'Which title size ships?', options: [{ label: 'Design', consequence: 'Matches the frame.' }], relatedFindings: ['title-size'] }] });
  const res = await build(ws, ['--check']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Check passed: qa-reports\/abc-123\/findings\.json would build qa-reports\/abc-123\/report\.json\. Nothing written\./);
  assert.match(res.stdout, /REVIEW|FAIL/);
  assert.ok(!existsSync(path.join(ws.dir, 'report.json')));
  assert.ok(!existsSync(path.join(ws.dir, 'report.json.lock')));
  writeFindings(ws, { findings: [titleFinding()], openDecisions: [{ question: 'Which?', options: [], relatedFindings: ['nope'] }] });
  const bad = await build(ws, ['--check']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /openDecisions\[0\]\.relatedFindings\[0\]: "nope" is not the ref \(or auditKey\) of a finding/);
  assert.match(bad.stderr, /the report would not be valid/);
});

test('bad arguments exit 2', async (t) => {
  const ws = workspace(t);
  assert.equal((await run(script('build-report.mjs'), [], { cwd: ws.root })).code, 2);
  assert.equal((await build(ws, ['--mode', 'sync'])).code, 2);
  assert.equal((await build(ws, ['--out', 'elsewhere.json'])).code, 2);
  const missing = await build(ws);
  assert.equal(missing.code, 2, 'no findings.json');
  assert.match(missing.stderr, /cannot read findings file/);
});

test('selectors compare without quote style', () => {
  assert.equal(normalizeSelector("[data-testid='a b']"), '[data-testid=a b]');
  assert.equal(normalizeSelector('div  >  span[data-x="1"]'), 'div > span[data-x=1]');
});
