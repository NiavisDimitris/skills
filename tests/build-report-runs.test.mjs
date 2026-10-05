// From measured end-to-end runs on the five-screen coded prototype: what agents did with
// values the design shares, findings filed from a worklist or audit key that the fix plan
// could not locate, one difference reported twice, guessed design values, hard-to-write
// "covers", a state captured identical to with-data, and confusing coverage counts.
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tmpDir } from './_helpers.mjs';
import { auditCandidate, makePass, RUN_ID, titleFinding, worklistItem } from './fixtures/build-report-pass/make.mjs';
import { buildReport, summaryLines } from '../skills/design-qa/scripts/lib/build-report.mjs';
import { renderFixplan } from '../skills/design-qa/scripts/lib/fixplan.mjs';

function workspace(t, opts) {
  const root = tmpDir('design-qa-runs-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return makePass(root, opts);
}
const rd = (f) => JSON.parse(readFileSync(f, 'utf8'));
const wr = (f, d) => writeFileSync(f, JSON.stringify(d, null, 2));
function build(ws, doc, extra = {}) {
  wr(ws.findingsFile, doc);
  return buildReport({
    dir: ws.dir, doc, findingsFile: ws.findingsFile, config: rd(ws.config), configDir: path.dirname(ws.config), configFile: ws.config,
    now: new Date('2026-10-05T12:00:00Z'), skillVersion: '0.2.2', localCommit: null, runId: RUN_ID, ...extra,
  });
}
const problems = (r) => r.problems.map((p) => `${p.where}: ${p.message}`).join('\n');
const wlItem = (key, over = {}) => worklistItem(key, {
  percentOfPage: 0.6,
  crop: { x: 1290, y: 1690, w: 90, h: 40 },
  app: [{ selector: 'span.pill.pill-green', path: 'main > section.orders > span[data-testid="status-badge"]', rect: { x: 1300, y: 1700, w: 66, h: 23 } }],
  design: [{ id: '1:20', name: 'Status badge', type: 'INSTANCE', rect: { x: 1300, y: 1700, w: 66, h: 23 } }],
  ...over,
});

test('matches-design rejects an audit candidate or a worklist item the design shares, never a compare row; designAlso needs nothing', (t) => {
  const ws = workspace(t, {
    audit: [auditCandidate('a1')],
    worklist: [wlItem('w1')],
    compare: { 'with-data': { style: [{ state: 'with-data', elementClass: 'badge', index: 0, selector: 'span.pill', property: 'border-radius', design: '6px', app: '999px', result: 'FAIL' }], tokens: [], components: [], motion: [], structure: [] } },
  });
  const audit = rd(path.join(ws.dir, 'evidence', 'ds-audit.json'));
  audit.summary.designAlso = 4;
  audit.designAlso = [{ key: 'style:color:#111', note: 'the design uses it too' }];
  wr(path.join(ws.dir, 'evidence', 'ds-audit.json'), audit);
  const md = { reason: 'matches-design', detail: 'The design binds the same 999px radius on its badge component.' };
  let r = build(ws, { findings: [titleFinding()], rejected: [{ auditKey: 'a1', ...md }, { worklist: 'w1', ...md }, { compare: { kind: 'style', state: 'with-data', elementClass: 'badge', property: 'border-radius' }, ...md }] });
  assert.match(problems(r), /rejected\[2\]\.reason: "matches-design" does not apply to a compare\.json FAIL row/);
  r = build(ws, { findings: [titleFinding()], rejected: [{ auditKey: 'a1', ...md }, { worklist: 'w1', ...md }, { compare: { kind: 'style', state: 'with-data', elementClass: 'badge', property: 'border-radius' }, reason: 'DATA', detail: 'The radius comes from the theme the tenant chose.' }] });
  assert.ok(r.report, problems(r));
  assert.deepEqual(r.report.rejections.filter((x) => x.reason === 'matches-design').map((x) => [x.kind, x.key]), [['audit', 'a1'], ['worklist', 'w1']]);
  assert.equal(r.report.meta.dsAudit.designAlso, 4, 'further audit counts are carried');
  assert.ok(summaryLines(r.report, r.info).some((l) => /^Rejected: .*audit candidates matches-design 1.*worklist items matches-design 1/.test(l)));
  assert.ok(!r.warnings.some((w) => /meta\.dsAudit/.test(w)), r.warnings.join('\n'));
});

test('a finding pinned by a worklist key or a grab gets the element it is pinned on, and the fix plan prints it', (t) => {
  const ws = workspace(t, { worklist: [wlItem('w1')] });
  const r = build(ws, {
    findings: [
      { ref: 'badge', worklist: 'w1', title: 'Status badge is a hand-styled pill', ledger: 'component', severity: 'WARNING', region: 'Orders table', expected: { value: 'Badge (success)' }, actual: { value: 'span.pill' }, fix: { summary: 'Render <Badge variant="success">' } },
      titleFinding({ ref: 'rows', title: 'Rows are 48px instead of 52px', property: 'height', expected: { value: '52px' }, actual: { value: '48px', source: { file: 'src/orders/Row.tsx', line: 4 } }, pin: { grab: 'row', index: 0 } }),
    ],
  });
  assert.ok(r.report, problems(r));
  const [badge, rows] = r.report.findings;
  assert.deepEqual(badge.element, { selector: 'span.pill.pill-green', figmaLayerPath: 'Status badge', figmaNodeId: '1:20' });
  assert.equal(rows.element.selector, '[data-testid=order-row]', 'the grab entry\'s selector');
  assert.deepEqual(rows.fix.files, ['src/orders/Row.tsx'], 'files default to actual.source.file');
  const plan = renderFixplan(r.report);
  assert.match(plan, /selector `span\.pill\.pill-green`/);
  assert.match(plan, /Element: span\.pill\.pill-green \(Figma: Status badge\)/);
  assert.match(plan, /Files: src\/orders\/Row\.tsx/);
});

test('one finding with auditKey and worklist covers both, takes the audit\'s fields and pins on the worklist crop; the duplicate route still works', (t) => {
  const ws = workspace(t, { audit: [auditCandidate('a1')], worklist: [wlItem('w1')] });
  let r = build(ws, { findings: [{ auditKey: 'a1', worklist: 'w1' }] });
  assert.ok(r.report, problems(r));
  const f = r.report.findings[0];
  assert.equal(f.title, 'Status badge radius is a hardcoded 999px, not --acme-radius-md');
  assert.deepEqual(f.evidence.filter((e) => e.crop).map((e) => [e.type, e.crop]), [['screenshot', { x: 1290, y: 1690, w: 90, h: 40 }]], 'the worklist crop, not the audit sample');
  assert.match(summaryLines(r.report, r.info).join('\n'), /Worklist: 1 item\(s\): 1 covered by 1 finding\(s\), 0 rejected/);
  assert.match(summaryLines(r.report, r.info).join('\n'), /candidates 1: 1 filed, 0 rejected/);
  r = build(ws, { findings: [{ ref: 'r1', auditKey: 'a1' }], rejected: [{ worklist: 'w1', reason: 'duplicate', duplicateOf: 'r1', detail: 'Same difference as the filed audit finding.' }] });
  assert.ok(r.report, problems(r));
});

test('an audit candidate whose design value is unknown is filed only with the finding\'s own expected', (t) => {
  const ws = workspace(t, { audit: [auditCandidate('a1', { expected: { value: '8px', token: '--acme-space-2', source: 'design-rules' }, _audit: { kind: 'off-token', count: 2, designValue: 'unknown' } })] });
  let r = build(ws, { findings: [{ auditKey: 'a1' }] });
  assert.equal(r.report, null);
  assert.match(problems(r), /findings\[0\]\.expected: audit candidate "a1" does not know the design's value \(its expected "8px" is the nearest token, a guess\): read the design value \(node scripts\/inspect\.mjs --dir <dir> --side design …\) and give "expected": \{ "value", "token" \}, or reject the candidate/);
  r = build(ws, { findings: [{ auditKey: 'a1', expected: { value: '12px', token: '--acme-space-3' } }] });
  assert.ok(r.report, problems(r));
  assert.equal(r.report.findings[0].expected.value, '12px');
});

test('covers: a pin crop covers the rows of the elements inside it (matching kind and property); paste-ready lines; redundant or empty entries warn', (t) => {
  const style = (cls, property, design, app) => ({ state: 'with-data', elementClass: cls, index: 0, selector: 'h1', property, design, app, delta: null, result: 'FAIL' });
  const ws = workspace(t, {
    compare: {
      'with-data': {
        style: [style('title', 'font-size', '32px', '28px'), style('title', 'color', 'rgb(0, 0, 0)', 'rgb(17, 17, 17)')],
        tokens: [], components: [], structure: [],
        motion: [{ state: 'with-data', selector: 'button.export', figmaNodeId: null, trigger: 'hover', property: 'background-color', expected: { type: 'transition', durationMs: 160, easing: 'ease-out', delayMs: 0 }, observed: null, result: 'FAIL' }],
      },
    },
  });
  const sized = titleFinding({ pin: { crop: { x: 100, y: 80, w: 500, h: 80 } } });
  let r = build(ws, { findings: [{ ...sized, covers: [{ kind: 'style', state: 'with-data', elementClass: 'title', property: 'font-size' }, { kind: 'style', state: 'with-data', elementClass: 'nothing' }] }] });
  const text = problems(r);
  assert.doesNotMatch(text, /"property":"font-size"/, 'the title is inside the crop: its font-size row is covered without "covers"');
  assert.match(text, /compare\.json with-data: FAIL row covered by no finding \(design rgb\(0, 0, 0\) → app rgb\(17, 17, 17\)\): add "covers": \[\{"kind":"style","state":"with-data","elementClass":"title","property":"color"\}\]/);
  assert.match(text, /compare\.json with-data: FAIL row covered by no finding \(background-color: expected 160ms ease-out → observed none\): add "covers": \[\{"kind":"motion","state":"with-data","selector":"button\.export","property":"background-color"\}\]/);
  assert.ok(r.warnings.some((w) => /findings\[0\]\.covers\[0\] is redundant/.test(w)), r.warnings.join('\n'));
  assert.ok(r.warnings.some((w) => /findings\[0\]\.covers\[1\] matches no compare\.json row/.test(w)));
  // Pasting the printed entries works.
  r = build(ws, { findings: [{ ...sized, property: 'font-size, color' }, { ref: 'hover', title: 'Export button has no hover transition', ledger: 'motion', state: 'with-data', severity: 'WARNING', region: 'Toolbar', expected: { value: '160ms ease-out' }, actual: { value: 'none' }, fix: { summary: 'Add the DS transition' }, pin: { crop: { x: 1200, y: 120, w: 120, h: 36 } }, covers: [{ kind: 'motion', state: 'with-data', selector: 'button.export', property: 'background-color' }] }] });
  assert.ok(r.report, problems(r));
});

test('a state captured identical to with-data needs a state finding or MISSING_IN_CODE', (t) => {
  const ws = workspace(t);
  const c = rd(path.join(ws.dir, 'evidence', 'capture.json'));
  c.states.empty.sameAs = 'with-data';
  wr(path.join(ws.dir, 'evidence', 'capture.json'), c);
  let r = build(ws, { findings: [titleFinding()] });
  assert.equal(r.report, null);
  assert.match(problems(r), /states\.empty: empty was captured identical to with-data: either the app does not implement it \(file a state finding or set MISSING_IN_CODE with a note\) or the driver is wrong \(fix it in states\.json and capture again\)/);
  r = build(ws, { findings: [titleFinding()], states: { empty: { result: 'MISSING_IN_CODE', note: 'No empty branch: the list renders with zero rows and no message.' } } });
  assert.ok(r.report, problems(r));
  const row = r.report.stateMatrix.find((x) => x.state === 'empty');
  assert.equal(row.captured.sameAs, 'with-data');
  assert.equal(row.result, 'MISSING_IN_CODE');
  assert.ok(r.report.meta.degradations.some((d) => d.step === 'capture:empty' && /looked exactly like "with-data"/.test(d.reason)));
  r = build(ws, { findings: [titleFinding(), { title: 'The empty state is not implemented: zero orders show the table header only', ledger: 'state', state: 'empty', severity: 'BLOCKER', region: 'Page', expected: { value: 'EmptyState' }, actual: { value: 'table header' }, fix: { summary: 'Render the empty state' }, pin: { crop: { x: 0, y: 0, w: 1440, h: 900 } } }] });
  assert.ok(r.report, problems(r));
  assert.equal(r.report.stateMatrix.find((x) => x.state === 'empty').result, 'FAIL');
});

test('captured states count as implemented; without a ticket the fix plan leaves out "0 specified"; coverage wording is not confusable', (t) => {
  const ws = workspace(t);
  rmSync(path.join(ws.dir, 'evidence', 'ticket.json'));
  wr(path.join(ws.dir, 'state-matrix.json'), rd(path.join(ws.dir, 'state-matrix.json')).map((row) => ({ ...row, implemented: null, specified: null })));
  const r = build(ws, { findings: [titleFinding()] });
  assert.ok(r.report, problems(r));
  const rows = Object.fromEntries(r.report.stateMatrix.map((x) => [x.state, x.implemented]));
  assert.deepEqual(rows, { 'with-data': { driver: 'fixture', detail: 'default render' }, empty: { driver: 'query', detail: 'query ?empty=1' }, error: null });
  assert.equal(r.report.scorecard.stateCoverage.implemented, 2);
  const header = renderFixplan(r.report).split('\n')[1];
  assert.match(header, /· 3 designed, 2 implemented$/);
  assert.ok(summaryLines(r.report, r.info).some((l) => l.startsWith("Captured over the whole page (the screenshot covers the full page; verified is the headline's count): ")));
});

test('a running animation on an element that was not grabbed: the --check line names its element and box, the covers entry its selector, and a pin around it covers it', (t) => {
  const target = { side: 'app', selector: 'main > section.card > div[data-testid="confirm-icon"]', rect: { x: 600, y: 300, w: 72, h: 72 } };
  const running = (selector, name) => ({
    state: 'with-data', selector, figmaNodeId: null, trigger: 'load', property: 'animation',
    expected: { type: 'animation', durationMs: 320, easing: 'cubic-bezier(0,0,0.58,1)', delayMs: 0, detail: `animation ${name}-in` },
    observed: { type: 'animation', durationMs: 600, easing: 'linear', delayMs: 0, detail: `animation ${name}` }, result: 'FAIL', findingIds: [],
    _compare: { elementClass: '(running)', index: 0, key: `(running)#0|${selector}|animation`, reasons: ['duration 600ms, expected 320ms'], ...(selector === 'div.confirm-icon' ? { target } : {}) },
  });
  const ws = workspace(t, { compare: { 'with-data': { style: [], tokens: [], components: [], structure: [], motion: [running('div.confirm-icon', 'pop'), running('div.toast', 'toast')] } } });
  const text = problems(build(ws, { findings: [titleFinding()] }));
  assert.match(text, /FAIL row covered by no finding \(animation on main > section\.card > div\[data-testid="confirm-icon"\] \(72×72 at 600,300\): expected animation 320ms cubic-bezier\(0,0,0\.58,1\) → observed animation 600ms linear\): add "covers": \[\{"kind":"motion","state":"with-data","selector":"div\.confirm-icon","property":"animation"\}\]/);
  assert.doesNotMatch(text, /"elementClass":"\(running\)"/, 'one entry per element, not every running animation of the state');
  // A motion finding pinned around the element covers its row; the toast's row stays to decide.
  const pop = { ref: 'pop', title: 'Confirmation icon animation is 600ms linear instead of 320ms ease-out', ledger: 'motion', state: 'with-data', severity: 'WARNING', region: 'Confirmation', expected: { value: '320ms cubic-bezier(0,0,0.58,1)' }, actual: { value: '600ms linear' }, fix: { summary: 'Use the design system pop-in animation.' }, pin: { crop: { x: 590, y: 290, w: 92, h: 92 } } };
  const covered = problems(build(ws, { findings: [titleFinding(), pop] }));
  assert.doesNotMatch(covered, /confirm-icon/, covered);
  assert.match(covered, /"selector":"div\.toast"/);
});
