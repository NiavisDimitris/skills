// The evidence gates (pins, crops inside their image, grounding on a deployed target,
// full-length comparison) are errors only where a report is finished or put in front of a
// person: validate.mjs and the start of a review. A report written before these rules (an
// unpinned FIX_CODE finding, a finding on a deployed target backed only by a source file)
// still goes through dismiss.mjs, triage.mjs and apply-decisions.mjs, with warnings.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadFixture, run, script, tmpDir } from './_helpers.mjs';

/** ui-report.json as an older pass would have written it: no scorecard.unpinned, DQ-003 unpinned, DQ-001 source-only on a deployed target. */
function oldStyleReport() {
  const r = loadFixture('ui-report.json');
  delete r.scorecard.unpinned;
  r.meta.app.url = 'https://staging.acme.dev/orders';
  r.findings.find((f) => f.id === 'DQ-003').evidence = [{ type: 'computed', path: 'evidence/computed/hover.json', crop: null, state: 'hover' }];
  return r;
}
function workspace(t) {
  const root = tmpDir('design-qa-gates-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'qa-reports', 'ACME-482');
  mkdirSync(dir, { recursive: true });
  const reportFile = path.join(dir, 'report.json');
  writeFileSync(reportFile, JSON.stringify(oldStyleReport(), null, 2));
  return { root, dir, reportFile };
}
const GATE_ERRORS = [
  /findings\[2\]\.evidence: an open FIX_CODE finding needs a pin/,
  /findings\[0\]\.evidence: the target is a deployed build \("https:\/\/staging\.acme\.dev\/orders"\): ground the finding in the capture/,
];

test('an older report is still dismissed, triaged and applied (gates are warnings there)', async (t) => {
  const ws = workspace(t);
  const dismiss = await run(script('dismiss.mjs'), ['--report', ws.reportFile, '--id', 'DQ-004', '--kind', 'not-an-issue', '--reason', 'Rendering noise only', '--by', 'Dana']);
  assert.equal(dismiss.code, 0, dismiss.stderr);
  const triage = await run(script('triage.mjs'), ['--report', ws.reportFile, '--fix', 'DQ-001,DQ-002', '--by', 'Dana']);
  assert.equal(triage.code, 0, triage.stderr);
  assert.match(triage.stdout, /Verdict FAIL · match \d+%( \(\d+ without a pins?\))? · \d+ of \d+ findings settled · 4 of 6 states verified/, 'the headline, never "parity %"');
  // apply-decisions on a fresh copy (decisions.json is written against the untriaged report).
  const ws2 = workspace(t);
  writeFileSync(path.join(ws2.dir, 'decisions.json'), JSON.stringify(loadFixture('decisions.json'), null, 2));
  const apply = await run(script('apply-decisions.mjs'), ['--report', ws2.reportFile], { cwd: ws2.root });
  assert.equal(apply.code, 0, apply.stderr);
  assert.match(apply.stdout, /^Review decisions for Orders list \(ACME-482\)/);
  const saved = JSON.parse(readFileSync(ws2.reportFile, 'utf8'));
  assert.equal(saved.scorecard.unpinned, 1, 'the applied report carries the derived unpinned count');
});

test('validate.mjs and the start of a review reject the same report with the gate messages', async (t) => {
  const ws = workspace(t);
  const v = await run(script('validate.mjs'), [ws.reportFile], { env: { DESIGN_QA_TEST_SKIP_BUILD_VERIFY: '' } });
  assert.equal(v.code, 1);
  for (const re of GATE_ERRORS) assert.match(v.stderr, new RegExp(`ERROR ${re.source}`));

  writeFileSync(path.join(ws.dir, 'report.html'), '<!doctype html><title>r</title>');
  const review = await run(script('review.mjs'), ['--report', ws.reportFile, '--no-open', '--timeout-min', '1'], { cwd: ws.root, env: { DESIGN_QA_TEST_SKIP_BUILD_VERIFY: '' } });
  assert.equal(review.code, 1, review.stdout + review.stderr);
  assert.match(review.stderr, /report\.json fails the evidence gates, so it is not ready for a person to review:/);
  for (const re of GATE_ERRORS) assert.match(review.stderr, re);
  assert.match(review.stderr, /Fix the report, re-render, then open the review \(node \S*validate\.mjs \S*report\.json lists every problem\)\./);
  assert.doesNotMatch(review.stdout, /http:\/\/127\.0\.0\.1/, 'no server was started');

  // --status is not gated.
  const status = await run(script('review.mjs'), ['--status', '--report', ws.reportFile], { cwd: ws.root });
  assert.equal(status.code, 3, status.stderr);
});

test('render-report.mjs still renders the draft and says validate.mjs will reject it', async (t) => {
  const ws = workspace(t);
  const res = await run(script('render-report.mjs'), ['--in', ws.reportFile, '--out', path.join(ws.dir, 'report.html'), '--recompute']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /warning: findings\[2\]\.evidence: an open FIX_CODE finding needs a pin/);
  assert.match(res.stderr, /warning: validate\.mjs will reject this report: 2 evidence-gate problems above \(pins, crops, deployed-target grounding, full-length comparison\); fix them before handing the report over/);
});
