// pass.mjs with annotations from the review (annotations.json, written by apply-decisions.mjs):
// the report is stale when the file changes; status says which annotations are still to file
// (Do:) and rebuilds next; report --check and a refused build list them; once filed and
// rebuilt, the fix-now set includes them as the reviewer chose. Real child scripts on a coded
// prototype; skipped when Chromium cannot launch.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { comparisonFixtureRecords, fixture, run, script, startServer, tmpDir } from './_helpers.mjs';
import { emptyAnnotationsFile, mergeAnnotations } from '../skills/design-qa/scripts/lib/annotations.mjs';
import { fileAnnotationsDo, unfiledAnnotations } from '../skills/design-qa/scripts/lib/pass.mjs';

const ENV = { DESIGN_QA_COMMIT: 'test-commit', DESIGN_QA_BRANCH: 'test-branch', DESIGN_QA_RUN_ID: '', FIGMA_TOKEN: '', DESIGN_QA_APP_STORAGE_STATE: '', DESIGN_QA_NO_DISPLAY: '1' };
const pass = (cwd, args) => run(script('pass.mjs'), args, { cwd, env: ENV, timeout: 180000 });
const nextLine = (out) => out.trim().split('\n').filter((l) => l.startsWith('Next: ')).pop() ?? '';
const doLines = (out) => out.trim().split('\n').filter((l) => l.startsWith('Do: '));
const runIdOf = (out) => /Run id: (\S+)/.exec(out)?.[1];
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));

async function chromiumLaunches() {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}
const CHROMIUM = await chromiumLaunches();
const SKIP = 'Chromium is not installed (run `npx playwright install chromium`)';

/** One pinned finding; every audit candidate, compare FAIL row and worklist item rejected (a fixture pass). */
function writeFindings(dir, extra = []) {
  const ev = path.join(dir, 'evidence');
  const rd = (f) => (existsSync(f) ? read(f) : null);
  const rows = [];
  for (const [state, v] of Object.entries(rd(path.join(ev, 'compare.json'))?.states ?? {})) {
    for (const [kind, list] of Object.entries(v)) if (Array.isArray(list)) for (const r of list.filter((x) => x.result === 'FAIL')) rows.push({ kind, state, ...((r.elementClass ?? r._compare?.elementClass) ? { elementClass: r.elementClass ?? r._compare.elementClass } : {}), ...(r.property ? { property: r.property } : {}), ...(r.role ? { role: r.role, name: r.name } : {}) });
  }
  const keys = new Set();
  const compare = rows.filter((r) => !keys.has(JSON.stringify(r)) && keys.add(JSON.stringify(r)));
  const audit = rd(path.join(ev, 'ds-audit.json'))?.candidates ?? [];
  const items = rd(path.join(ev, 'worklist.json'))?.items ?? [];
  writeFileSync(path.join(dir, 'findings.json'), JSON.stringify({
    kind: 'design-qa-findings',
    version: 1,
    comparisons: comparisonFixtureRecords(dir),
    findings: [
      {
        ref: 'save-colour', title: 'Save button background is a hardcoded colour instead of --color-primary', ledger: 'style', state: 'with-data', severity: 'WARNING', region: 'Profile form', property: 'background-color',
        expected: { value: 'rgb(37, 99, 235)', token: '--color-primary' }, actual: { value: 'rgb(29, 78, 216)', token: null }, fix: { summary: 'Use var(--color-primary) for the button background.' }, pin: { selector: 'button' },
      },
      ...extra,
    ],
    rejected: [
      ...(audit.length ? [{ auditKeys: audit.map((c) => c.key), reason: 'out-of-scope', detail: 'Test fixture: the audit candidates are not what this test checks.' }] : []),
      ...compare.map((c) => ({ compare: c, reason: 'false-positive', detail: 'Test fixture: these rows are not what this test checks.' })),
      ...(items.length ? [{ worklist: items.map((w) => w.key), reason: 'out-of-scope', detail: 'Test fixture: these regions are not what this test checks.' }] : []),
    ],
  }, null, 2));
}

test('unfiledAnnotations and the Do: sentence: what annotations.json holds that no findings entry files', () => {
  const root = tmpDir('design-qa-pass-annotations-');
  try {
    assert.deepEqual(unfiledAnnotations(root), [], 'no annotations.json');
    const { annotations } = mergeAnnotations([], [
      { state: 'with-data', side: 'app', box: { x: 0, y: 0, w: 10, h: 10 }, severity: 'WARNING', note: 'One', decision: 'debt' },
      { state: 'with-data', side: 'app', box: { x: 0, y: 0, w: 10, h: 10 }, severity: 'BLOCKER', note: 'Two', decision: 'fix-now' },
    ], { by: 'A. Lee', date: '2026-10-06T10:00:00.000Z' });
    writeFileSync(path.join(root, 'annotations.json'), JSON.stringify({ ...emptyAnnotationsFile(), annotations }));
    assert.deepEqual(unfiledAnnotations(root).map((a) => a.id), ['AN-001', 'AN-002'], 'no findings.json: all of them');
    writeFileSync(path.join(root, 'findings.json'), JSON.stringify({ findings: [{ annotation: 'AN-002' }, { ref: 'x' }] }));
    assert.deepEqual(unfiledAnnotations(root).map((a) => a.id), ['AN-001']);
    writeFileSync(path.join(root, 'annotations.json'), '{ "kind": "nope" }');
    assert.deepEqual(unfiledAnnotations(root), [], 'unreadable: the build says why');
    assert.equal(
      fileAnnotationsDo(['AN-001', 'AN-003'], 'qa-reports/abc/findings.json'),
      'Investigate each annotation from the review (AN-001, AN-003) on the page and in the design, and file it in qa-reports/abc/findings.json as { "annotation": "AN-001", "ledger", "region", "expected", "actual", "fix" } (references/review.md, "Annotations from the review"). Never edit annotations.json, and never reject an annotation: only a person can dismiss it.',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('after the review sent annotations: status rebuilds (Do: file them), the build lists them, the rebuilt report fixes them as the reviewer chose', { timeout: 600000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP);
  const html = readFileSync(fixture('app-drift.html'));
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  t.after(() => server.close());
  const root = tmpDir('design-qa-pass-annotations-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'design-qa.config.json'), JSON.stringify({
    app: { baseUrl: server.url },
    surfaces: { profile: { route: '/profile', prototype: pathToFileURL(fixture('prototype.html')).href, states: { hover: { action: 'hover', selector: 'button', wait: 'h1' } } } },
    designSystem: { name: 'Acme UI' },
    report: { commit: false },
  }));
  const rel = 'qa-reports/abc-700';
  const dir = path.join(root, rel);
  const s = await pass(root, ['start', '--feature', 'abc-700', '--agent', 'figma-mcp=no', '--agent', 'ticket-mcp=no', '--quick']);
  assert.equal(s.code, 0, s.stdout + s.stderr);
  const id = runIdOf(s.stdout);
  const e = await pass(root, ['evidence', '--dir', rel, '--run', id]);
  assert.equal(e.code, 0, e.stdout + e.stderr);
  writeFindings(dir);
  const r = await pass(root, ['report', '--dir', rel, '--run', id]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(read(path.join(dir, 'pass.json')).stages.report.annotationsStamp, null, 'no annotations.json when built');

  // The review was sent and applied (apply-decisions.mjs): a triage, the applied record, annotations.json.
  const reportFile = path.join(dir, 'report.json');
  const tr = await run(script('triage.mjs'), ['--report', reportFile, '--fix', 'DQ-001', '--run', id], { cwd: root, env: ENV });
  assert.equal(tr.code, 0, tr.stdout + tr.stderr);
  writeFileSync(path.join(dir, 'decisions.applied.json'), JSON.stringify({ kind: 'design-qa-decisions', version: 1 }));
  const { annotations } = mergeAnnotations([], [{ state: 'with-data', side: 'app', box: { x: 20, y: 20, w: 120, h: 40 }, severity: 'BLOCKER', note: 'The page heading is missing its subtitle', decision: 'fix-now' }], { by: 'A. Lee', date: '2026-10-06T10:00:00.000Z' });
  writeFileSync(path.join(dir, 'annotations.json'), JSON.stringify({ ...emptyAnnotationsFile(), annotations }));

  const st = await pass(root, ['status', '--dir', rel, '--run', id]);
  assert.equal(st.code, 0, st.stdout + st.stderr);
  assert.match(st.stdout, /^ {2}report {4}stale \(findings, annotations or evidence changed\)$/m);
  assert.match(st.stdout, /^ {2}annotations from the review to file: AN-001$/m);
  assert.deepEqual(doLines(st.stdout), [`Do: ${fileAnnotationsDo(['AN-001'], `${rel}/findings.json`)}`]);
  assert.match(nextLine(st.stdout), new RegExp(`pass\\.mjs report --dir ${rel} --run ${id}$`));

  // The build refuses and lists what is still to file (with and without --check).
  for (const args of [[], ['--check']]) {
    const b = await pass(root, ['report', '--dir', rel, '--run', id, ...args]);
    assert.equal(b.code, 3, b.stdout + b.stderr);
    assert.match(b.stdout, /^ {2}to file: the reviewer's annotation AN-001 \(BLOCKER, with-data: "The page heading is missing its subtitle"\) is not filed: investigate it and add \{ "annotation": "AN-001", "ledger", "region", "expected", "actual", "fix" \} to findings\.json; only a person can dismiss it$/m);
    assert.deepEqual(doLines(b.stdout), [`Do: Fix these in ${rel}/findings.json.`, `Do: ${fileAnnotationsDo(['AN-001'], `${rel}/findings.json`)}`]);
  }

  // Filed: the rebuild makes it a finding, fixed now as the reviewer chose.
  writeFindings(dir, [{ annotation: 'AN-001', ledger: 'structure', region: 'Header', expected: { value: 'A subtitle under the heading' }, actual: { value: 'No subtitle' }, fix: { summary: 'Render the subtitle under the page heading.' } }]);
  const ok = await pass(root, ['report', '--dir', rel, '--run', id]);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  const rep = read(reportFile);
  const added = rep.findings.find((f) => f.annotation?.id === 'AN-001');
  assert.ok(added, 'the annotation is a finding');
  assert.match(ok.stdout, new RegExp(`^ {2}fix now ${added.id} BLOCKER: The page heading is missing its subtitle$`, 'm'));
  assert.deepEqual(rep.triage.items.find((i) => i.findingId === added.id), { findingId: added.id, decision: 'fix-now', reason: 'Added in the review as fix now (AN-001).', ticket: null });
  assert.match(read(path.join(dir, 'pass.json')).stages.report.annotationsStamp, /^\d+:\d+$/);
  assert.match(readFileSync(path.join(dir, 'report-fixplan.md'), 'utf8'), new RegExp(`\\*\\*${added.id} — The page heading is missing its subtitle\\*\\* \\(from the review\\)`));
  // The decisions are applied: the fix loop follows the rebuild (through status), not another review.
  assert.match(ok.stdout, new RegExp(`^The decisions from the review are applied: the next command gives the step after this rebuild \\(references/fix-loop\\.md\\)\\. To show the person this report again instead: .*pass\\.mjs review --dir ${rel} --run ${id}$`, 'm'));
  assert.match(nextLine(ok.stdout), new RegExp(`pass\\.mjs status --dir ${rel} --run ${id}$`));

  const after = await pass(root, ['status', '--dir', rel, '--run', id]);
  assert.match(after.stdout, /^ {2}report {4}valid/m);
  assert.match(after.stdout, new RegExp(`^ {2}fix now {3}(DQ-\\d+, )*${added.id}(, DQ-\\d+)*$`, 'm'));
  assert.doesNotMatch(after.stdout, /annotations from the review to file/);
  assert.match(nextLine(after.stdout), /pass\.mjs evidence --dir \S+ --run \S+ --recapture$/);
});
