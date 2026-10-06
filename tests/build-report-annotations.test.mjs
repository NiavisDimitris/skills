// The reviewer's annotations (annotations.json, written by apply-decisions.mjs) as a build
// input: every annotation is filed by exactly one findings entry and never rejected; a filed
// one becomes a finding with the reviewer's state, severity, box and words; ids stay put
// across rebuilds; fix now / later follows the reviewer; verifyBuiltReport watches the file;
// the fix plan marks these findings "(from the review)".
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { run, script, tmpDir } from './_helpers.mjs';
import { ANNOTATED_AT, annotationItem, makePass, RUN_ID, titleFinding, writeAnnotations } from './fixtures/build-report-pass/make.mjs';
import { annotationTitle } from '../skills/design-qa/scripts/lib/annotations.mjs';
import { buildReport, verifyBuiltReport } from '../skills/design-qa/scripts/lib/build-report.mjs';
import { parseDebtItems, renderFixplan } from '../skills/design-qa/scripts/lib/fixplan.mjs';
import { validateReport } from '../skills/design-qa/scripts/lib/schema-check.mjs';

function workspace(t, opts) {
  const root = tmpDir('design-qa-annotations-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return makePass(root, opts);
}
const rd = (f) => JSON.parse(readFileSync(f, 'utf8'));
const wr = (f, d) => writeFileSync(f, JSON.stringify(d, null, 2));
function build(ws, doc, extra = {}) {
  wr(ws.findingsFile, doc);
  return buildReport({
    dir: ws.dir, doc, findingsFile: ws.findingsFile, config: rd(ws.config), configDir: path.dirname(ws.config), configFile: ws.config,
    now: new Date('2026-10-06T12:00:00Z'), skillVersion: '0.2.2', localCommit: null, runId: RUN_ID, ...extra,
  });
}
const problems = (r) => r.problems.map((p) => `${p.where}: ${p.message}`).join('\n');

const DATE = ANNOTATED_AT;
const NOTE = annotationItem().note;
const item = annotationItem;
/** annotations.json as apply-decisions.mjs writes it (records AN-001, AN-002, …). */
const annotate = (ws, items) => writeAnnotations(ws.dir, items);
/** The agent's filing of one annotation. */
const filing = (id, over = {}) => ({
  annotation: id, ledger: 'structure', region: 'Promo form',
  expected: { value: 'An error message under the field' }, actual: { value: 'No message' },
  fix: { summary: 'Render the field error under the promo code input' }, ...over,
});

test('an annotation nobody filed stops the build, one problem each, with what to add', (t) => {
  const ws = workspace(t);
  annotate(ws, [item(), item({ severity: 'WARNING', decision: 'debt', side: 'design', note: '  Totals row "Subtotal" is misaligned  ' })]);
  const r = build(ws, { findings: [titleFinding()] });
  assert.equal(r.report, null);
  const filed = r.problems.filter((p) => p.where === 'to file').map((p) => p.message);
  assert.deepEqual(filed, [
    'the reviewer\'s annotation AN-001 (BLOCKER, with-data: "Promo code field is missing its error message") is not filed: investigate it and add { "annotation": "AN-001", "ledger", "region", "expected", "actual", "fix" } to findings.json; only a person can dismiss it',
    'the reviewer\'s annotation AN-002 (WARNING, with-data: "Totals row \\"Subtotal\\" is misaligned") is not filed: investigate it and add { "annotation": "AN-002", "ledger", "region", "expected", "actual", "fix" } to findings.json; only a person can dismiss it',
  ]);
  // Unknown ids, a second filing of the same annotation, an unreadable annotations.json.
  const twice = build(ws, { findings: [filing('AN-001'), filing('AN-001', { region: 'Header' }), filing('AN-002'), filing('AN-009')] });
  assert.match(problems(twice), /^findings\[1\]\.annotation: AN-001 is already filed by findings\[0\]: one findings entry per annotation$/m);
  assert.match(problems(twice), /^findings\[3\]\.annotation: AN-009 is not an annotation of annotations\.json; did you mean "AN-001"/m);
  assert.doesNotMatch(problems(twice), /^to file:/m);
  writeFileSync(path.join(ws.dir, 'annotations.json'), '{ "kind": "design-qa-annotations", "version": 1, "annotations": [{ "id": "AN-001" }] }');
  const bad = build(ws, { findings: [titleFinding()] });
  assert.match(problems(bad), /^annotations\.json: annotations\[0\]\.state must name a state of the report .* \(apply-decisions\.mjs writes it from the review; never edit it by hand\)$/m);
  rmSync(path.join(ws.dir, 'annotations.json'));
  const none = build(ws, { findings: [titleFinding(), filing('AN-001')] });
  assert.match(problems(none), /^findings\[1\]\.annotation: AN-001 is not an annotation of the review \(there is no annotations\.json: annotations come only from a person, through apply-decisions\.mjs\)$/m);
  assert.match(problems(build(ws, { findings: [filing('AN-1')] })), /^findings\[0\]\.annotation: must be the id of an annotation from the review in annotations\.json \(e\.g\. "AN-001"\) \(got "AN-1"\)$/m);
});

test('a filed annotation is a finding: the reviewer\'s state, severity, box and words; the title from the note; a record of the file', (t) => {
  const ws = workspace(t);
  const [a1, a2] = annotate(ws, [item(), item({ severity: 'DS_CANDIDATE', decision: 'debt', side: 'design', box: { x: 300, y: 1200, w: 200, h: 80 }, note: 'Badge is a one-off, not the DS Tag', by: 'Dana' })]);
  const r = build(ws, { findings: [titleFinding(), filing('AN-001'), filing('AN-002', { ref: 'badge', title: 'Status badge is not the DS Tag', ledger: 'component', pin: { selector: 'h1' } })] });
  assert.ok(r.report, problems(r));
  const [f1, f2] = ['AN-001', 'AN-002'].map((id) => r.report.findings.find((f) => f.annotation?.id === id));
  assert.equal(f1.state, 'with-data');
  assert.equal(f1.severity, 'BLOCKER');
  assert.equal(f1.resolution, 'FIX_CODE');
  assert.equal(f1.title, annotationTitle(NOTE));
  assert.equal(f1.title, 'Promo code field is missing its error message');
  assert.deepEqual(f1.evidence, [{ type: 'screenshot', path: 'evidence/app/with-data.png', crop: { x: 120, y: 340, w: 48, h: 24 }, state: 'with-data' }]);
  assert.deepEqual(f1.annotation, { id: 'AN-001', note: a1.note, by: 'A. Lee', date: DATE, side: 'app', box: { x: 120, y: 340, w: 48, h: 24 }, decision: 'fix-now', source: 'report-ui' });
  // The reviewer's box first, then the entry's own pins; the entry's title wins.
  assert.equal(f2.title, 'Status badge is not the DS Tag');
  assert.equal(f2.severity, 'DS_CANDIDATE');
  assert.deepEqual(f2.evidence.slice(0, 2).map((e) => [e.type, e.path, e.crop]), [['design', 'evidence/figma/with-data.png', a2.box], ['screenshot', 'evidence/app/with-data.png', { x: 120, y: 96, w: 400, h: 36 }]]);
  assert.equal(f2.annotation.by, 'Dana');
  const b = r.report.meta.build;
  assert.deepEqual(b.annotations, { path: 'annotations.json', sha256: b.annotations.sha256 });
  assert.match(b.annotations.sha256, /^[0-9a-f]{64}$/);
  assert.equal(b.identities[f1.id], 'annotation:AN-001');
  assert.equal(b.identities[f2.id], 'annotation:AN-002', 'the annotation, not the ref, is the identity');
  assert.deepEqual(r.info.annotations.map((x) => x.id), ['AN-001', 'AN-002']);
  // The annotation id names the finding in open decisions and fixLoop, like a ref.
  const od = build(ws, { findings: [titleFinding(), filing('AN-001', { resolution: 'UNCLASSIFIED' }), filing('AN-002')], openDecisions: [{ question: 'Is the expired-code message in scope?', options: [{ label: 'Yes', consequence: 'Build it now' }, { label: 'No', consequence: 'Dismiss it in the review' }], relatedFindings: ['AN-001'] }] });
  assert.ok(od.report, problems(od));
  const unclassified = od.report.findings.find((f) => f.annotation?.id === 'AN-001');
  assert.equal(unclassified.resolution, 'UNCLASSIFIED', 'the agent may disagree with the reviewer only through an open decision');
  assert.deepEqual(od.report.openDecisions[0].relatedFindings, [unclassified.id]);
  // No annotations.json: recorded as null.
  rmSync(path.join(ws.dir, 'annotations.json'));
  assert.equal(build(ws, { findings: [titleFinding()] }).report.meta.build.annotations, null);
});

test('the severity is the reviewer\'s (PASS once fixed); data, intentional, dismissed, a known drift and a different state are refused; UNCLASSIFIED is allowed', (t) => {
  const ws = workspace(t);
  annotate(ws, [item({ severity: 'WARNING', decision: 'debt' })]);
  const one = (over) => build(ws, { findings: [titleFinding(), filing('AN-001', over)] });
  let r = one({ severity: 'BLOCKER' });
  assert.equal(r.report, null);
  assert.match(problems(r), /^findings\[1\]\.severity: the reviewer set the severity of AN-001 to WARNING: leave "severity" out \(it comes from the annotation\), or write "PASS" once the fix is verified \(references\/fix-loop\.md\)$/m);
  assert.ok(one({ severity: 'WARNING' }).report, 'restating the reviewer\'s severity is fine');
  r = one({ severity: 'PASS', fix: undefined });
  assert.ok(r.report, problems(r));
  const fixed = r.report.findings.find((f) => f.annotation);
  assert.deepEqual([fixed.severity, fixed.resolution, fixed.evidence[0].type], ['PASS', 'NONE', 'screenshot']);
  for (const [resolution, as] of [['DATA', 'data'], ['INTENTIONAL', 'intentional']]) {
    r = one({ resolution, dataReason: 'The promo message comes from the API, not the design.', signoff: { by: 'Agent', date: '2026-10-06', reason: 'Looks deliberate to me.' } });
    assert.equal(r.report, null);
    assert.match(problems(r), new RegExp(`^findings\\[1\\]\\.resolution: AN-001 is the reviewer's: only a person can accept it as ${as} \\(or dismiss it\\)\\. File it FIX_CODE, or UNCLASSIFIED with an open decision when you believe the reviewer is wrong$`, 'm'));
  }
  r = one({ resolution: 'DISMISSED' });
  assert.equal(r.report, null);
  assert.match(problems(r), /findings\[1\]\.resolution: .*DISMISSED is a person's decision/);
  assert.doesNotMatch(problems(r), /^to file:/m, 'the entry with shape problems still counts as the filing');
  r = one({ resolution: 'NONE', fix: undefined });
  assert.match(problems(r), /^findings\[1\]\.resolution: NONE would close AN-001, the reviewer's: file it FIX_CODE \(or UNCLASSIFIED with an open decision\); it closes with "severity": "PASS" once the fix is verified$/m);
  r = one({ knownDrift: 'KD-1' });
  assert.match(problems(r), /^findings\[1\]\.knownDrift: AN-001 is the reviewer's: a known drift would close it, and only a person can dismiss it\./m);
  r = one({ state: 'empty' });
  assert.match(problems(r), /^findings\[1\]\.state: AN-001 is on "with-data", where the reviewer marked it: leave "state" out \(it comes from the annotation\) or write "with-data"$/m);
  r = one({ resolution: 'UNCLASSIFIED' });
  assert.ok(r.report, problems(r));
  assert.equal(r.report.findings.find((f) => f.annotation).resolution, 'UNCLASSIFIED');
  // Required like any finding.
  r = build(ws, { findings: [titleFinding(), { annotation: 'AN-001' }] });
  assert.match(problems(r), /^findings\[1\]\.ledger: required key is missing \(filing AN-001: say what you found like any finding: "ledger", "region", "expected", "actual" and "fix"\)$/m);
  r = one({ fix: undefined });
  assert.match(problems(r), /^findings\[1\]\.fix: is required for FIX_CODE/m);
});

test('an annotation is never rejected: a rejection naming one is refused', (t) => {
  const ws = workspace(t, { annotations: [item()] });
  let r = build(ws, { findings: [titleFinding()], rejected: [{ annotation: 'AN-001', reason: 'false-positive', detail: 'The promo field shows its error on submit only.' }] });
  assert.equal(r.report, null);
  assert.match(problems(r), /^rejected\[0\]\.annotation: an annotation from the review cannot be rejected: only a person can dismiss it\. Investigate it and file it .*UNCLASSIFIED with an open decision$/m);
  assert.match(problems(r), /^to file: the reviewer's annotation AN-001 /m);
  r = build(ws, { findings: [titleFinding()], rejected: [{ worklist: 'AN-001', reason: 'same', detail: 'Rendering differences only, nothing to report.' }] });
  assert.match(problems(r), /^rejected\[0\]\.worklist: AN-001 is an annotation from the review: it cannot be rejected, only a person can dismiss it\./m);
});

test('the reviewer\'s box on a changed image: clipped when it runs past an edge, moved inside when it no longer fits, never a failure', (t) => {
  const ws = workspace(t);
  // empty is 1440×900 now.
  annotate(ws, [
    item({ state: 'empty', box: { x: 1400, y: 880, w: 100, h: 60 }, note: 'Runs past the corner' }),
    item({ state: 'empty', box: { x: 100, y: 1500, w: 200, h: 50 }, note: 'Below the page now' }),
    item({ state: 'empty', box: { x: 1436, y: 10, w: 40, h: 40 }, note: 'A sliver is left' }),
    item({ state: 'empty', box: { x: 0, y: 0, w: 3000, h: 3000 }, note: 'The whole page is wrong' }),
    item({ state: 'error', side: 'app', box: { x: 10, y: 10, w: 40, h: 40 }, note: 'Error state is not built' }),
  ]);
  const r = build(ws, { findings: ['AN-001', 'AN-002', 'AN-003', 'AN-004', 'AN-005'].map((id) => filing(id)) });
  assert.ok(r.report, problems(r));
  const crop = (id) => r.report.findings.find((f) => f.annotation.id === id).evidence[0]?.crop ?? null;
  assert.deepEqual(crop('AN-001'), { x: 1400, y: 880, w: 40, h: 20 });
  assert.deepEqual(crop('AN-002'), { x: 100, y: 850, w: 200, h: 50 });
  assert.deepEqual(crop('AN-003'), { x: 1400, y: 10, w: 40, h: 40 });
  assert.deepEqual(crop('AN-004'), { x: 0, y: 0, w: 1440, h: 900 }, 'a large box is the reviewer\'s choice: no share limit');
  assert.equal(crop('AN-005'), null, 'no app capture of error: no reviewer pin');
  const box = r.report.findings.find((f) => f.annotation.id === 'AN-002').annotation.box;
  assert.deepEqual(box, { x: 100, y: 1500, w: 200, h: 50 }, 'the annotation keeps the box as recorded');
  const notes = r.notes.join('\n');
  assert.match(notes, /findings\[0\] \(AN-001\): the reviewer's box \(1400,880 100×60\) runs past the edge of evidence\/app\/empty\.png; the crop was clipped to the image/);
  assert.match(notes, /findings\[1\] \(AN-002\): the reviewer's box \(100,1500 200×50\) no longer fits the 1440×900 app capture of "empty"; pinned at 100,850 200×50 instead/);
  assert.match(notes, /findings\[2\] \(AN-003\): the reviewer's box \(1436,10 40×40\) no longer fits .*pinned at 1400,10 40×40 instead/);
  assert.match(notes, /findings\[4\] \(AN-005\): "error" has no app capture any more, so the reviewer's box \(app 10,10 40×40\) is not pinned; pin the finding yourself \("pin"\)/);
});

test('ids follow the annotation across rebuilds; fix now or later follows the reviewer (a blocker always now)', (t) => {
  const ws = workspace(t);
  const first = build(ws, { findings: [titleFinding()] }).report;
  first.triage = { decidedAt: '2026-10-06T11:00:00Z', decidedBy: 'Dana', source: 'report-ui', items: [{ findingId: 'DQ-001', decision: 'debt', reason: 'later', ticket: null }] };
  annotate(ws, [
    item({ severity: 'WARNING', decision: 'debt', note: 'Totals row is misaligned' }),
    item({ severity: 'BLOCKER', decision: 'fix-now', note: 'Promo code field has no error' }),
    item({ severity: 'WARNING', decision: 'fix-now', note: 'Header shadow is missing', box: { x: 0, y: 0, w: 1440, h: 80 } }),
  ]);
  const doc = { findings: [titleFinding(), filing('AN-001'), filing('AN-002', { ledger: 'behavior' }), filing('AN-003', { ledger: 'style', property: 'box-shadow' })] };
  const second = build(ws, doc, { previous: first });
  assert.ok(second.report, problems(second));
  const idOf = (rep, an) => rep.findings.find((f) => f.annotation?.id === an).id;
  const items = Object.fromEntries(second.report.triage.items.map((i) => [i.findingId, i]));
  assert.equal(items['DQ-001'].decision, 'debt', 'the recorded triage is kept');
  assert.deepEqual([items[idOf(second.report, 'AN-001')].decision, items[idOf(second.report, 'AN-001')].reason], ['debt', 'Added in the review as debt (AN-001).']);
  assert.deepEqual([items[idOf(second.report, 'AN-002')].decision, items[idOf(second.report, 'AN-002')].reason], ['fix-now', 'Added in the review as fix now (AN-002).']);
  assert.deepEqual([items[idOf(second.report, 'AN-003')].decision, items[idOf(second.report, 'AN-003')].reason], ['fix-now', 'Added in the review as fix now (AN-003).']);
  assert.match(second.notes.join('\n'), /triage: 3 finding\(s\) from the review's annotations added as the reviewer chose \(DQ-\d+ debt \(AN-001\), DQ-\d+ fix-now \(AN-002\), DQ-\d+ fix-now \(AN-003\)\)/);
  // Reordered, retitled and with a ref: the same ids; a person's later triage change stands.
  second.report.triage.items.find((i) => i.findingId === idOf(second.report, 'AN-001')).decision = 'fix-now';
  const third = build(ws, { findings: [filing('AN-003', { ledger: 'style', property: 'box-shadow', title: 'Header has no shadow' }), filing('AN-002', { ledger: 'behavior', ref: 'promo-error' }), filing('AN-001'), titleFinding()] }, { previous: second.report });
  assert.ok(third.report, problems(third));
  for (const an of ['AN-001', 'AN-002', 'AN-003']) assert.equal(idOf(third.report, an), idOf(second.report, an), an);
  assert.equal(third.report.triage.items.find((i) => i.findingId === idOf(third.report, 'AN-001')).decision, 'fix-now');
  // Fixed and verified (PASS): out of the triage.
  const fixed = build(ws, { findings: [titleFinding(), filing('AN-001'), filing('AN-002', { ledger: 'behavior', severity: 'PASS', fix: undefined }), filing('AN-003', { ledger: 'style', property: 'box-shadow' })] }, { previous: third.report });
  assert.ok(fixed.report, problems(fixed));
  assert.equal(fixed.report.triage.items.some((i) => i.findingId === idOf(third.report, 'AN-002')), false);
  // Without a recorded triage there is none to follow: the recommended split stands (no triage block).
  assert.equal(build(ws, doc).report.triage, undefined);
});

test('verifyBuiltReport: annotations.json changed, gone or new since the build means rebuild; a hand-edited annotation differs', async (t) => {
  const ws = workspace(t);
  const file = path.join(ws.dir, 'report.json');
  const cli = (args = []) => run(script('build-report.mjs'), ['--dir', 'qa-reports/abc-123', '--config', 'design-qa.config.json', ...args], { cwd: ws.root, env: { DESIGN_QA_RUN_ID: RUN_ID } });
  wr(ws.findingsFile, { findings: [titleFinding()] });
  assert.equal((await cli()).code, 0);
  assert.deepEqual(verifyBuiltReport(file, rd(file)).errors, []);
  annotate(ws, [item()]);
  assert.deepEqual(verifyBuiltReport(file, rd(file)).errors.map((e) => `${e.path}: ${e.message}`), ['meta.build.annotations: annotations.json appeared since the report was built: rebuild it: node scripts/build-report.mjs --dir <dir> (or pass.mjs report)']);

  // --check lists what is still to file, one line each; filed, it says where each went.
  const check = await cli(['--check']);
  assert.equal(check.code, 1);
  assert.match(check.stderr, /^ {2}to file: the reviewer's annotation AN-001 \(BLOCKER, with-data: "Promo code field is missing its error message"\) is not filed: /m);
  wr(ws.findingsFile, { findings: [titleFinding(), filing('AN-001')] });
  const ok = await cli(['--check']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /^Annotations from the review: 1 filed \(AN-001 → DQ-002\)$/m);
  assert.equal((await cli()).code, 0);
  const built = rd(file);
  assert.deepEqual(verifyBuiltReport(file, built).errors, []);
  assert.deepEqual(validateReport(built, { evidenceGates: 'error' }).errors, []);

  const edited = structuredClone(built);
  edited.findings.find((f) => f.annotation).annotation.note = 'Something else';
  assert.match(verifyBuiltReport(file, edited).errors.map((e) => `${e.path}: ${e.message}`).join('\n'), /^findings\[\d\]\.annotation: differs from what build-report\.mjs builds/m);

  const saved = readFileSync(path.join(ws.dir, 'annotations.json'));
  annotate(ws, [item(), item({ note: 'Another one', box: { x: 10, y: 10, w: 20, h: 20 } })]);
  assert.match(verifyBuiltReport(file, built).errors[0].message, /^annotations\.json changed since the report was built: rebuild it/);
  rmSync(path.join(ws.dir, 'annotations.json'));
  assert.match(verifyBuiltReport(file, built).errors[0].message, /^annotations\.json is gone since the report was built: rebuild it/);
  writeFileSync(path.join(ws.dir, 'annotations.json'), saved);
  assert.deepEqual(verifyBuiltReport(file, built).errors, []);
});

test('validate: a finding added in the review keeps a reviewer severity or PASS, and one annotation is one finding', (t) => {
  const ws = workspace(t);
  annotate(ws, [item()]);
  const r = build(ws, { findings: [titleFinding(), filing('AN-001')] });
  assert.ok(r.report, problems(r));
  const report = structuredClone(r.report);
  const i = report.findings.findIndex((f) => f.annotation);
  report.findings[i].severity = 'CANNOT_VERIFY';
  report.findings[i].resolution = 'NONE';
  const other = report.findings.findIndex((f) => !f.annotation);
  report.findings[other].annotation = structuredClone(report.findings[i].annotation);
  const errs = validateReport(report).errors.map((e) => `${e.path}: ${e.message}`).join('\n');
  assert.match(errs, new RegExp(`^findings\\[${i}\\]\\.severity: is "CANNOT_VERIFY", but the finding was added in the review \\(AN-001\\): its severity is the reviewer's \\(BLOCKER, WARNING or DS_CANDIDATE\\), or PASS once the fix is verified$`, 'm'));
  assert.match(errs, new RegExp(`^findings\\[${Math.max(i, other)}\\]\\.annotation\\.id: AN-001 is also findings\\[${Math.min(i, other)}\\]: one finding per annotation from the review$`, 'm'));
});

test('multi-screen: the annotation names its screen; an entry naming another state is refused', (t) => {
  const ws = workspace(t, { multi: true });
  annotate(ws, [item({ state: 'details/with-data' })]);
  let r = build(ws, { findings: [titleFinding({ state: 'orders/with-data' }), filing('AN-001')] });
  assert.ok(r.report, problems(r));
  const f = r.report.findings.find((x) => x.annotation);
  assert.deepEqual([f.state, f.screen, f.evidence[0].path], ['details/with-data', 'details', 'evidence/screens/details/app/with-data.png']);
  r = build(ws, { findings: [titleFinding({ state: 'orders/with-data' }), filing('AN-001', { state: 'with-data', screen: 'details' })] });
  assert.ok(r.report, `the screen and the local state name the same state: ${problems(r)}`);
  r = build(ws, { findings: [titleFinding({ state: 'orders/with-data' }), filing('AN-001', { state: 'orders/with-data' })] });
  assert.match(problems(r), /^findings\[1\]\.state: AN-001 is on "details\/with-data", where the reviewer marked it/m);
});

test('fix plan: findings added in the review are marked "(from the review)" in Fix now and Debt; the debt parser reads the title without the mark', (t) => {
  const ws = workspace(t);
  const first = build(ws, { findings: [titleFinding()] }).report;
  first.triage = { decidedAt: '2026-10-06T11:00:00Z', decidedBy: 'Dana', source: 'report-ui', items: [{ findingId: 'DQ-001', decision: 'fix-now', reason: null, ticket: null }] };
  annotate(ws, [item(), item({ severity: 'WARNING', decision: 'debt', note: 'Totals row is misaligned', box: { x: 100, y: 1480, w: 600, h: 40 } })]);
  const r = build(ws, { findings: [titleFinding(), filing('AN-001'), filing('AN-002', { ledger: 'style', property: 'text-align' })] }, { previous: first });
  assert.ok(r.report, problems(r));
  const plan = renderFixplan(r.report);
  const id = (an) => r.report.findings.find((f) => f.annotation?.id === an).id;
  assert.match(plan, new RegExp(`^\\d\\. \\*\\*${id('AN-001')} — Promo code field is missing its error message\\*\\* \\(from the review\\) \\(BLOCKER, structure, state with-data\\)$`, 'm'));
  assert.match(plan, /^\d\. \*\*DQ-001 — Page title is 28px instead of heading\/lg \(32px\)\*\* \(WARNING, style, state with-data\)$/m, 'the agent\'s own findings are not marked');
  assert.match(plan, new RegExp(`^- ${id('AN-002')} — Totals row is misaligned \\(from the review\\) \\(WARNING, owner engineering\\) — no ticket yet — Render the field error under the promo code input$`, 'm'));
  assert.match(plan, /^Reported in the review by A\. Lee: Promo code field is missing its error message It should say the code has expired\.$/m);
  const debt = parseDebtItems(plan);
  assert.deepEqual(debt.map((d) => [d.id, d.title, d.severity, d.fromReview]), [[id('AN-002'), 'Totals row is misaligned', 'WARNING', true]]);
});
