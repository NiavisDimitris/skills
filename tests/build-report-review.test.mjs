// What an agent cutting corners got through build-report before (an independent review):
// a pass that compared nothing scored 100%, DATA and made-up drifts closed findings,
// rejections vanished, a hand-edited report validated, ids followed array order, fake pins
// counted, a designed state could be overridden away. Each test fails on the old builder.
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { run, script, tmpDir } from './_helpers.mjs';
import { auditCandidate, makePass, RUN_ID, titleFinding, worklistItem } from './fixtures/build-report-pass/make.mjs';
import { buildReport, verifyBuiltReport } from '../skills/design-qa/scripts/lib/build-report.mjs';

function workspace(t, opts) {
  const root = tmpDir('design-qa-review-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return makePass(root, opts);
}
const rd = (f) => JSON.parse(readFileSync(f, 'utf8'));
const wr = (f, d) => writeFileSync(f, JSON.stringify(d, null, 2));
const dropErrorRow = (ws) => wr(path.join(ws.dir, 'state-matrix.json'), rd(path.join(ws.dir, 'state-matrix.json')).filter((r) => r.state !== 'error'));
function build(ws, doc, extra = {}) {
  wr(ws.findingsFile, doc);
  return buildReport({
    dir: ws.dir, doc, findingsFile: ws.findingsFile, config: rd(ws.config), configDir: path.dirname(ws.config), configFile: ws.config,
    now: new Date('2026-10-04T12:00:00Z'), skillVersion: '0.2.2', localCommit: null, runId: RUN_ID, ...extra,
  });
}
const problems = (r) => r.problems.map((p) => `${p.where}: ${p.message}`).join('\n');

test('item 1: a captured state is PASS or FAIL only when it was compared; a lazy pass is INCOMPLETE', (t) => {
  const ws = workspace(t);
  dropErrorRow(ws);
  rmSync(path.join(ws.dir, 'evidence', 'figma'), { recursive: true });
  rmSync(path.join(ws.dir, 'evidence', 'diff.json'));
  const r = build(ws, { findings: [] });
  assert.ok(r.report, problems(r));
  assert.equal(r.report.scorecard.verdict, 'INCOMPLETE');
  assert.equal(r.report.scorecard.match, null);
  assert.equal(r.report.scorecard.loopClosed, false);
  const row = r.report.stateMatrix[0];
  assert.equal(row.result, 'CANNOT_VERIFY');
  assert.match(row.note, /^Captured, not compared: no design image \(export the frame at 1x\)\.$/);
  assert.deepEqual(row.captured.comparison, { pixelDiff: false, worklist: true, compareRows: 0 });

  // Both images but no worklist.json: a build error naming the command.
  const ws2 = workspace(t, { worklist: false });
  const r2 = build(ws2, { findings: [titleFinding()] });
  assert.equal(r2.report, null);
  assert.match(problems(r2), /evidence\/worklist\.json: is missing, so "with-data", "empty" were not walked region by region: run node \S*worklist\.mjs --dir <dir>/);

  // The worklist did not compare a state: it is not verified.
  const ws3 = workspace(t);
  const wl = rd(path.join(ws3.dir, 'evidence', 'worklist.json'));
  wl.coverage.empty = { state: 'empty', compared: false, reason: 'no design image' };
  wr(path.join(ws3.dir, 'evidence', 'worklist.json'), wl);
  const r3 = build(ws3, { findings: [titleFinding()] });
  assert.ok(r3.report, problems(r3));
  const empty = r3.report.stateMatrix.find((x) => x.state === 'empty');
  assert.equal(empty.result, 'CANNOT_VERIFY');
  assert.equal(empty.note, 'Captured, not compared: the worklist did not compare it (no design image).');
  assert.deepEqual(r3.report.stateMatrix[0].captured.comparison, { pixelDiff: true, worklist: true, compareRows: 0 });
  assert.deepEqual(r3.report.differences['with-data'], { differing: null, regions: [], unlisted: { count: 0, percent: 0 } });
});

test('item 2: DATA needs a dataReason; a known drift must resolve to an active, signed-off entry of a configured file', (t) => {
  const ws = workspace(t);
  let r = build(ws, { findings: [titleFinding({ severity: 'BLOCKER', resolution: 'DATA' })] });
  assert.equal(r.report, null);
  assert.match(problems(r), /findings\[0\]\.dataReason: is required when resolution is DATA/);
  const signoff = { by: 'Dana (design lead)', date: '2026-10-04', reason: 'The title is the tenant name from the API.' };
  r = build(ws, { findings: [titleFinding({ expected: { value: '32px' }, resolution: 'DATA', dataReason: 'The page title comes from the tenant name in the API.', signoff })] });
  assert.ok(r.report, problems(r));
  assert.equal(r.report.findings[0].dataReason, 'The page title comes from the tenant name in the API.');
  r = build(ws, { findings: [titleFinding({ dataReason: 'The page title comes from the tenant name in the API.' })] });
  assert.match(problems(r), /findings\[0\]\.dataReason: only applies when resolution is DATA \(got FIX_CODE\)/);

  // No known-drifts file configured: citing one is refused, not just warned about.
  r = build(ws, { findings: [titleFinding({ severity: 'BLOCKER', knownDrift: 'KD-77' })] }, { config: null, configDir: null, configFile: null });
  assert.equal(r.report, null);
  assert.match(problems(r), /findings\[0\]\.knownDrift: cites KD-77, but no known-drifts file is configured/);
  // An entry nobody signed off cannot make a finding INTENTIONAL.
  writeFileSync(path.join(ws.root, 'design-qa', 'known-drifts.md'), '# Known drifts\n\n## Entries\n\n### KD-1 — Title weight\n\n- **Scope**: page title.\n- **Design**: 700.\n- **Code**: 600.\n- **Status**: active.\n');
  r = build(ws, { findings: [titleFinding({ knownDrift: 'KD-1', fix: undefined })] });
  assert.equal(r.report, null);
  assert.match(problems(r), /KD-1 in design-qa\/known-drifts\.md has no "Signed off: <name>, <YYYY-MM-DD>" line/);
  r = build(ws, { findings: [titleFinding({ knownDrift: 'KD-1', fix: undefined, signoff: { by: 'Dana Lee', date: '2026-05-02', reason: 'Accepted in the design review.' } })] });
  assert.ok(r.report, problems(r));
  assert.equal(r.report.findings[0].signoff.by, 'Dana Lee');
});

test('item 3: rejections reach the report; vague compare matchers and large "same" regions are refused; the rejected area is printed', async (t) => {
  const style = (cls, property) => ({ state: 'with-data', elementClass: cls, index: 0, selector: `.${cls}`, property, design: '1px', app: '2px', delta: 1, result: 'FAIL' });
  const ws = workspace(t, {
    audit: [auditCandidate('a1')],
    worklist: [worklistItem('w-big', { percentOfPage: 22 }), worklistItem('w-small', { percentOfPage: 0.4, crop: { x: 10, y: 10, w: 40, h: 40 } })],
    compare: { 'with-data': { style: [style('row', 'height')], tokens: [], components: [], motion: [], structure: [] } },
  });
  let r = build(ws, {
    findings: [titleFinding()],
    rejected: [
      { worklist: ['w-big', 'w-small'], reason: 'same', detail: 'Rendering differences only, nothing to report.' },
      { auditKey: 'a1', reason: 'DATA', detail: 'Values come from the API data in the fixture.' },
      { compare: [{ kind: 'style' }], reason: 'DATA', detail: 'Everything comes from fixture data, not code.' },
    ],
  });
  assert.equal(r.report, null);
  const text = problems(r);
  assert.match(text, /rejected\[0\]\.worklist\[0\]: "w-big" covers 22% of the page: too large to be rendering noise \(over 2%\): file it or give another reason/);
  assert.match(text, /rejected\[2\]\.compare\[0\]: names too little: a compare matcher gives "state" and "elementClass"/);
  r = build(ws, {
    findings: [titleFinding()],
    rejected: [
      { worklist: 'w-small', reason: 'same', detail: 'Rendering differences only, nothing to report.' },
      { worklist: 'w-big', reason: 'DATA', detail: 'The order table holds 30 rows of API data here, 3 in the frame.' },
      { auditKey: 'a1', reason: 'DATA', detail: 'Values come from the API data in the fixture.' },
      { compare: { kind: 'style', state: 'with-data', elementClass: 'row', property: 'height' }, reason: 'DATA', detail: 'Rows grow with the customer name length.' },
    ],
  });
  assert.ok(r.report, problems(r));
  const byKey = Object.fromEntries(r.report.rejections.map((x) => [x.key, x]));
  assert.deepEqual(byKey['w-small'], { kind: 'worklist', key: 'w-small', state: 'with-data', screen: null, reason: 'same', detail: 'Rendering differences only, nothing to report.', percentOfPage: 0.4, crop: { x: 10, y: 10, w: 40, h: 40 }, knownDrift: null, duplicateOf: null, coveredBy: null });
  assert.equal(byKey.a1.kind, 'audit');
  assert.deepEqual(byKey.a1.crop, { x: 1300, y: 1700, w: 66, h: 23 });
  assert.equal(byKey['style:with-data:row:height'].kind, 'compare');
  assert.equal(r.report.rejections.length, 4);
  // The CLI prints the share of the page that was rejected.
  const cli = await run(script('build-report.mjs'), ['--dir', 'qa-reports/abc-123', '--config', 'design-qa.config.json', '--check'], { cwd: ws.root, env: { DESIGN_QA_RUN_ID: RUN_ID } });
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stdout, /Rejected area: with-data 22\.4% of the page/);
});

test('item 4: meta.build records the inputs; verifyBuiltReport catches a hand edit and a changed input, allows later decisions', async (t) => {
  const ws = workspace(t);
  const doc = { findings: [titleFinding(), titleFinding({ ref: 'rows', title: 'Rows are 48px instead of 52px', property: 'height', expected: { value: '52px' }, actual: { value: '48px' }, pin: { grab: 'row', index: 0 } })] };
  wr(ws.findingsFile, doc);
  const res = await run(script('build-report.mjs'), ['--dir', 'qa-reports/abc-123', '--config', 'design-qa.config.json'], { cwd: ws.root, env: { DESIGN_QA_RUN_ID: RUN_ID } });
  assert.equal(res.code, 0, res.stderr);
  const file = path.join(ws.dir, 'report.json');
  const report = rd(file);
  const b = report.meta.build;
  assert.equal(b.tool, 'build-report');
  assert.equal(b.findings.path, 'findings.json');
  assert.match(b.findings.sha256, /^[0-9a-f]{64}$/);
  assert.equal(b.config.path, '../../design-qa.config.json');
  assert.deepEqual(b.evidence.map((e) => e.path).sort(), ['../../design-qa/known-drifts.md', 'evidence/capture.json', 'evidence/diff.json', 'evidence/figma-spec.json', 'evidence/worklist.json', 'state-matrix.json']);
  assert.deepEqual(b.identities, { 'DQ-001': 'ref:title-size', 'DQ-002': 'ref:rows' });
  assert.deepEqual(verifyBuiltReport(file, report).errors, []);

  // A dismissal and a triage made after the build are what other scripts legitimately do.
  assert.equal((await run(script('dismiss.mjs'), ['--report', file, '--id', 'DQ-002', '--kind', 'not-an-issue', '--reason', 'Row height follows the density setting.', '--by', 'Dana'], { cwd: ws.root, env: { DESIGN_QA_RUN_ID: RUN_ID } })).code, 0);
  assert.equal((await run(script('triage.mjs'), ['--report', file, '--fix', 'DQ-001'], { cwd: ws.root, env: { DESIGN_QA_RUN_ID: RUN_ID } })).code, 0);
  assert.deepEqual(verifyBuiltReport(file, rd(file)).errors, []);

  // Hand edits are named by path.
  const edited = rd(file);
  edited.findings[0].title = 'Something nicer';
  edited.findings[0].resolution = 'DATA';
  edited.stateMatrix.find((x) => x.state === 'error').result = 'PASS';
  edited.scorecard.pixelDiff['with-data'].percent = 0.1;
  edited.rejections = [];
  edited.findings.push({ ...edited.findings[0], id: 'DQ-099' });
  const errs = verifyBuiltReport(file, edited).errors.map((e) => `${e.path}: ${e.message}`).join('\n');
  assert.match(errs, /findings\[0\]\.title: differs from what build-report\.mjs builds/);
  assert.match(errs, /findings\[0\]\.resolution: differs/);
  assert.match(errs, /stateMatrix\[2\]\.result: differs/);
  assert.match(errs, /scorecard\.pixelDiff\["with-data"\]\.percent: differs/);
  assert.match(errs, /findings\[2\]: DQ-099 is not built from findings\.json/);

  // Inputs changed since the build: "rebuild", without a rebuild in memory.
  writeFileSync(ws.findingsFile, JSON.stringify({ findings: [titleFinding()] }));
  assert.match(verifyBuiltReport(file, rd(file)).errors[0].message, /findings\.json changed since the report was built: rebuild it/);
  wr(ws.findingsFile, doc);
  wr(path.join(ws.dir, 'evidence', 'compare.json'), { states: {} });
  assert.match(verifyBuiltReport(file, rd(file)).errors.map((e) => e.message).join('\n'), /evidence\/compare\.json appeared since the report was built/);
  rmSync(path.join(ws.dir, 'evidence', 'compare.json'));
  const noBuild = rd(file);
  delete noBuild.meta.build;
  assert.deepEqual(verifyBuiltReport(file, noBuild).errors, [{ path: 'meta.build', message: 'not built by build-report.mjs: write findings.json and run build-report.mjs (report.json is never written by hand)' }]);
});

test('item 6: a states override cannot hide a designed, captured state', (t) => {
  const ws = workspace(t);
  let r = build(ws, { findings: [titleFinding()], states: { 'with-data': { result: 'NOT_SPECIFIED', note: 'Not in the ticket scope.' } } });
  assert.equal(r.report, null);
  assert.match(problems(r), /states\.with-data\.result: NOT_SPECIFIED is for a state the design defines only in part; "with-data" is designed/);
  r = build(ws, { findings: [titleFinding()], states: { empty: { result: 'CANNOT_VERIFY', note: 'The empty fixture shows stale cached rows.' } } });
  assert.ok(r.report, problems(r));
  assert.equal(r.report.stateMatrix.find((x) => x.state === 'empty').result, 'CANNOT_VERIFY');
  // MISSING_IN_CODE on a captured state keeps its capture and its findings' pin requirement.
  r = build(ws, { findings: [titleFinding({ state: 'empty', pin: undefined })], states: { empty: { result: 'MISSING_IN_CODE', note: 'The capture shows the loading spinner forever.' } } });
  assert.equal(r.report, null);
  assert.match(problems(r), /findings\[0\]\.pin: an open FIX_CODE finding needs a pin/);
});

test('items 8 and 9: ids follow ref, auditKey or worklist key, never the order; an ambiguous identity asks for a ref', (t) => {
  const ws = workspace(t, { audit: [auditCandidate('style:radius:999px')] });
  const A = { ref: 'a', title: 'Totals row is missing the divider', ledger: 'structure', state: 'with-data', severity: 'WARNING', region: 'Orders table', expected: { value: 'divider' }, actual: { value: 'none' }, fix: { summary: 'add divider' }, pin: { crop: { x: 100, y: 400, w: 300, h: 40 } } };
  const B = { ...A, ref: 'b', title: 'Pagination is missing', expected: { value: 'pagination' }, actual: { value: 'absent' }, pin: { crop: { x: 100, y: 1600, w: 300, h: 40 } } };
  const first = build(ws, { findings: [A, B, { auditKey: 'style:radius:999px' }] }).report;
  first.triage = { decidedAt: '2026-10-04T12:00:00Z', decidedBy: 'Dana', source: 'report-ui', items: [
    { findingId: 'DQ-001', decision: 'debt', reason: 'later', ticket: { provider: 'jira', key: 'ABC-900', url: 'https://acme.atlassian.net/browse/ABC-900', createdAt: '2026-10-04T12:00:00Z' } },
    { findingId: 'DQ-002', decision: 'fix-now', reason: null, ticket: null },
    { findingId: 'DQ-003', decision: 'debt', reason: 'later', ticket: { provider: 'jira', key: 'ABC-901', url: 'https://acme.atlassian.net/browse/ABC-901', createdAt: '2026-10-04T12:00:00Z' } },
  ] };
  // Reordered, and the audit candidate's selector changed on a re-capture.
  const audit = rd(path.join(ws.dir, 'evidence', 'ds-audit.json'));
  audit.candidates[0].element.selector = 'main > div.wrap > section.orders > span[data-testid="status-badge"]';
  wr(path.join(ws.dir, 'evidence', 'ds-audit.json'), audit);
  const r = build(ws, { findings: [{ auditKey: 'style:radius:999px' }, B, A] }, { previous: first });
  assert.ok(r.report, problems(r));
  assert.deepEqual(r.report.findings.map((f) => [f.id, f.title.slice(0, 12)]), [['DQ-003', 'Status badge'], ['DQ-002', 'Pagination i'], ['DQ-001', 'Totals row i']]);
  assert.deepEqual(r.report.triage.items.map((i) => [i.findingId, i.decision, i.ticket?.key ?? null]).sort(), [['DQ-001', 'debt', 'ABC-900'], ['DQ-002', 'fix-now', null], ['DQ-003', 'debt', 'ABC-901']]);
  // Two findings without refs that the build cannot tell apart.
  const same = { ...A };
  delete same.ref;
  const r2 = build(ws, { findings: [same, { ...same }] });
  assert.match(problems(r2), /findings\[1\]\.ref: findings\[1\] and findings\[0\] are the same finding to the build \(same ledger, state, element, property, title and values\): give each a distinct "ref"/);
});

test('item 10: evidence the agent types is checked: a row state, a crop on that state\'s own image, a real size', (t) => {
  const ws = workspace(t);
  const base = titleFinding();
  delete base.pin;
  const r = build(ws, {
    findings: [
      { ...base, ref: 'f1', evidence: [{ type: 'screenshot', path: 'state-matrix.json', crop: { x: 0, y: 0, w: 20, h: 20 }, state: 'with-data' }] },
      { ...base, ref: 'f2', property: 'padding', evidence: [{ type: 'screenshot', path: 'evidence/app/empty.png', crop: { x: 5, y: 5, w: 40, h: 40 }, state: 'no-such-state' }] },
      { ...base, ref: 'f3', property: 'margin', evidence: [{ type: 'screenshot', path: 'evidence/app/empty.png', crop: { x: 5, y: 5, w: 40, h: 40 }, state: 'with-data' }] },
      { ...base, ref: 'f4', property: 'gap', evidence: [{ type: 'screenshot', path: 'evidence/app/with-data.png', crop: { x: 5, y: 5, w: 1, h: 1 }, state: 'with-data' }] },
      { ...base, ref: 'f5', property: 'width', pin: { crop: { x: 0, y: 0, w: 1440, h: 2000 } } },
      { ...base, ref: 'f6', property: 'color', evidence: [{ type: 'computed', path: 'evidence/computed/with-data.json', crop: { x: 5, y: 5, w: 40, h: 40 }, state: 'with-data' }] },
    ],
  });
  assert.equal(r.report, null);
  const text = problems(r);
  assert.match(text, /findings\[0\]\.evidence\[0\]\.path: a "screenshot" entry names an image; "state-matrix\.json" is not a PNG/);
  assert.match(text, /findings\[1\]\.evidence\[0\]\.state: "no-such-state" is not a row of state-matrix\.json/);
  assert.match(text, /findings\[2\]\.evidence\[0\]\.crop: a crop goes on the app capture of "with-data" \(evidence\/app\/with-data\.png\); "evidence\/app\/empty\.png" is not it/);
  assert.match(text, /findings\[3\]\.evidence\[0\]\.crop: 1×1 is too small to point at anything: a pin crop is at least 8×8 px/);
  assert.match(text, /findings\[4\]\.pin\.crop: covers 100% of the 1440×2000 image: pin the element the finding is about/);
  assert.match(text, /findings\[5\]\.evidence\[0\]\.crop: a crop goes on an image \(type screenshot, design, figma or diff\), not on a "computed" file/);
  // A whole-state finding may cover the whole image.
  const ok = build(ws, { findings: [{ ...base, ref: 'whole', ledger: 'state', title: 'The with-data state renders the legacy page', pin: { crop: { x: 0, y: 0, w: 1440, h: 2000 } } }] });
  assert.ok(ok.report, problems(ok));
});

test('item 11: a state captured on purpose as its first screen is compared with its frame and recorded so', (t) => {
  const ws = workspace(t);
  const c = rd(path.join(ws.dir, 'evidence', 'capture.json'));
  Object.assign(c.states.empty, { fullPage: false, page: { width: 1440, height: 2600 }, size: { width: 1440, height: 900 }, driver: { query: '?modal=1', viewportOnly: true } });
  wr(path.join(ws.dir, 'evidence', 'capture.json'), c);
  const r = build(ws, { findings: [titleFinding()] });
  // The builder's own whole-page check passes it; the validator's per-state rule is the gates' side.
  assert.doesNotMatch(problems(r), /^states\.empty: the app capture/m);
  if (r.report) assert.equal(r.report.stateMatrix.find((x) => x.state === 'empty').captured.page.viewportOnly, true);
  else t.diagnostic(`validator still rejects the first-screen state: ${problems(r)}`);
});

test('item 13: pass overrides are checked against the evidence; data files are attached only where real', (t) => {
  const ws = workspace(t, { url: 'https://staging.acme.dev/orders' });
  const unpinned = titleFinding({ pin: undefined, unpinnedReason: 'The title is absent from every capture of this page.' });
  let r = build(ws, { findings: [unpinned], pass: { app: { url: 'http://localhost:5173/orders' }, tools: { dsAudit: 'script' } } });
  assert.equal(r.report, null);
  assert.match(problems(r), /pass\.app\.url: http:\/\/localhost:5173\/orders is not where the app was captured \(https:\/\/staging\.acme\.dev, capture\.json\)/);
  assert.match(problems(r), /pass\.tools\.dsAudit: "script" needs the audit's output, evidence\/ds-audit\.json, and there is none/);
  // A deployed target: a finding grounded only in a source file is refused (no computed file glued on).
  r = build(ws, { findings: [unpinned] });
  assert.equal(r.valid, false);
  assert.match(problems(r), /findings\[0\]\.pin: the target is a deployed build/);
  r = build(ws, { findings: [{ ...unpinned, evidence: [{ type: 'dom', path: 'evidence/dom/with-data.json', state: 'with-data' }] }] });
  assert.ok(r.report, problems(r));
  // A selector pin brings the computed styles it was read from.
  r = build(ws, { findings: [titleFinding()] });
  assert.deepEqual(r.report.findings[0].evidence.map((e) => e.type), ['screenshot', 'computed']);
});

test('items 17 and 18: a figmaNode pin needs the state\'s frame; a non-style finding never auto-covers style rows', (t) => {
  const ws = workspace(t, { compare: { 'with-data': { style: ['font-size', 'color'].map((property) => ({ state: 'with-data', elementClass: 'title', index: 0, selector: 'h1', property, design: '1', app: '2', result: 'FAIL' })), tokens: [], components: [], motion: [], structure: [] } } });
  let r = build(ws, { findings: [titleFinding({ state: 'empty', pin: { side: 'design', figmaNode: '1:10' } })] });
  assert.match(problems(r), /findings\[0\]\.pin: the frame of "empty" \("1:3"\) is not a layer of the figma-spec\.json/);
  r = build(ws, { findings: [{ title: 'Title text comes from the CMS', ledger: 'behavior', state: 'with-data', severity: 'WARNING', resolution: 'DATA', dataReason: 'The title is the tenant name from the CMS.', region: 'Header', expected: { value: 'x' }, actual: { value: 'y' }, pin: { grab: 'title' } }] });
  assert.equal(r.report, null);
  assert.match(problems(r), /compare\.json with-data: FAIL row covered by no finding \(design 1 → app 2\): add "covers": \[\{"kind":"style","state":"with-data","elementClass":"title","property":"font-size"\}\]/);
  assert.match(problems(r), /"elementClass":"title","property":"color"/);
});

test('item 20: a report.json not provably from this run is refused; --fresh replaces it', async (t) => {
  const ws = workspace(t, { lock: false });
  wr(ws.findingsFile, { findings: [titleFinding()] });
  const cli = (args = []) => run(script('build-report.mjs'), ['--dir', 'qa-reports/abc-123', '--config', 'design-qa.config.json', ...args], { cwd: ws.root, env: { DESIGN_QA_RUN_ID: '' } });
  assert.equal((await cli()).code, 0, 'no report yet: nothing to inherit');
  const again = await cli();
  assert.equal(again.code, 5);
  assert.match(again.stderr, /report\.json is not provably from this run \(qa-reports\/abc-123 has no run lock\).*or pass --fresh/);
  const fresh = await cli(['--fresh']);
  assert.equal(fresh.code, 0, fresh.stderr);
  // A lock, but the earlier report records no run id.
  const r = rd(path.join(ws.dir, 'report.json'));
  delete r.meta.runId;
  wr(path.join(ws.dir, 'report.json'), r);
  wr(path.join(ws.dir, '.design-qa-run.json'), { kind: 'design-qa-run', version: 1, runId: RUN_ID, status: 'active', startedAt: '2026-10-04T10:00:00.000Z' });
  const noId = await run(script('build-report.mjs'), ['--dir', 'qa-reports/abc-123', '--config', 'design-qa.config.json'], { cwd: ws.root, env: { DESIGN_QA_RUN_ID: RUN_ID } });
  assert.equal(noId.code, 5);
  assert.match(noId.stderr, /records no run id \(meta\.runId\)/);
});
