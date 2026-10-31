import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  buildRunResult,
  reportIssues,
  repoFromRemote,
  resolveRunContext,
  summaryMarkdown,
} from '../skills/design-qa/scripts/lib/run-result.mjs';
import { loadSchema, validateAgainstSchema } from '../skills/design-qa/scripts/lib/schema-check.mjs';
import { loadFixture, run, script, tmpDir } from './_helpers.mjs';

const RUN_RESULT = script('run-result.mjs');
const CTX = { repo: 'acme/web', branch: 'feat/orders', commit_sha: 'abc1234', pr_number: 7 };
const valid = (result) => assert.deepEqual(validateAgainstSchema(result, loadSchema('run-result')).errors, []);

test('the sample report becomes a valid run result', () => {
  const { result } = buildRunResult(loadFixture('../../examples/sample/sample-report.json'), { context: CTX });
  valid(result);
  assert.equal(result.repo, 'acme/web');
  assert.equal(result.pr_number, 7);
  assert.equal(result.diff.first_run, true);
  assert.ok(result.issues.every((i) => /^iss_[0-9a-f]{16}$/.test(i.issue_id)));
  assert.equal(result.totals.flagged, result.issues.length);
  // DATA, PASS and CANNOT_VERIFY findings are not issues.
  const report = loadFixture('../../examples/sample/sample-report.json');
  const notIssues = report.findings.filter((f) => ['DATA', 'NONE'].includes(f.resolution)).map((f) => f.id);
  assert.ok(notIssues.length > 0);
  assert.ok(result.issues.every((i) => !notIssues.includes(i.dq_id)));
});

test('the multi-screen fixture keeps screens apart', () => {
  const { result } = buildRunResult(loadFixture('report-multiscreen.json'), { context: CTX });
  valid(result);
  assert.deepEqual([...new Set(result.issues.map((i) => i.screen))].sort(), ['cart', 'checkout']);
  assert.ok(result.checked.every((c) => c.verified));
});

test('a MISSING_IN_CODE state with no open finding becomes a missing-state issue', () => {
  const report = {
    meta: { feature: 'x' },
    findings: [],
    stateMatrix: [{ state: 'empty', label: 'Empty', result: 'MISSING_IN_CODE', findings: [] }],
  };
  const [issue] = reportIssues(report);
  assert.equal(issue.category, 'missing-state');
  assert.equal(issue.status, 'open');
});

test('duplicate findings with the same issue_id collapse; open wins over dismissed', () => {
  const base = { ledger: 'style', property: 'gap', state: 'with-data', region: 'R', element: { selector: '.a' } };
  const issues = reportIssues({
    findings: [
      { ...base, id: 'DQ-001', severity: 'WARNING', resolution: 'DISMISSED' },
      { ...base, id: 'DQ-002', severity: 'WARNING', resolution: 'FIX_CODE' },
    ],
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].status, 'open');
  assert.equal(issues[0].dq_id, 'DQ-002');
});

test('two runs: fixed before merge, dismissed, not re-checked', () => {
  const r1 = loadFixture('../../examples/sample/sample-report.json');
  const first = buildRunResult(r1, { context: CTX }).result;

  const r2 = structuredClone(r1);
  const open = r2.findings.filter((f) => f.resolution === 'FIX_CODE');
  const fixed = open.find((f) => f.state === 'with-data');
  const dismissed = open.find((f) => f !== fixed && f.state === 'with-data');
  const unverified = open.find((f) => f.state === 'hover');
  r2.findings = r2.findings.filter((f) => f !== fixed && f !== unverified);
  dismissed.resolution = 'DISMISSED';
  for (const row of r2.stateMatrix) if (row.state === 'hover') row.result = 'CANNOT_VERIFY';

  const second = buildRunResult(r2, { previous: first, context: CTX }).result;
  valid(second);
  const idOf = (f) => first.issues.find((i) => i.dq_id === f.id).issue_id;
  assert.equal(second.previous_run_id, first.run_id);
  assert.ok(second.diff.fixed.includes(idOf(fixed)));
  assert.ok(second.diff.dismissed.includes(idOf(dismissed)));
  assert.ok(second.diff.not_rechecked.includes(idOf(unverified)));
  assert.ok(!second.diff.fixed.includes(idOf(unverified)));
  assert.deepEqual(second.diff.new, []);
  assert.equal(second.totals.by_status.fixed, second.diff.fixed.length);
});

test('a previous run from another branch is not compared', () => {
  const report = loadFixture('../../examples/sample/sample-report.json');
  const first = buildRunResult(report, { context: { ...CTX, branch: 'main' } }).result;
  const { result, warnings } = buildRunResult({ ...report, findings: [] }, { previous: first, context: CTX });
  assert.equal(result.diff.first_run, true);
  assert.deepEqual(result.diff.fixed, []);
  assert.match(warnings[0], /branch main/);
});

test('repoFromRemote handles https, ssh and scp forms and drops credentials', () => {
  assert.equal(repoFromRemote('https://github.com/acme/web.git'), 'acme/web');
  assert.equal(repoFromRemote('https://x-access-token:ghs_SECRET@github.com/acme/web'), 'acme/web');
  assert.equal(repoFromRemote('git@github.com:acme/web.git'), 'acme/web');
  assert.equal(repoFromRemote('ssh://git@gitlab.example.com:2222/group/sub/web.git'), 'sub/web');
  assert.equal(repoFromRemote(''), null);
  assert.equal(repoFromRemote(null), null);
});

test('GitHub pull_request events supply head branch, head sha and PR number', () => {
  const dir = tmpDir();
  const eventPath = path.join(dir, 'event.json');
  writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 42, head: { ref: 'feat/x', sha: 'deadbeef1' } } }));
  const ctx = resolveRunContext({
    env: { GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: 'acme/web', GITHUB_SHA: 'mergesha00', GITHUB_REF_NAME: '42/merge' },
    cwd: dir,
  });
  assert.deepEqual(ctx, { repo: 'acme/web', branch: 'feat/x', commit_sha: 'deadbeef1', pr_number: 42 });
});

test('the PR summary escapes titles and neutralises mentions', () => {
  const { result } = buildRunResult(
    {
      meta: { feature: 'x' },
      findings: [{ id: 'DQ-001', title: 'ping @octocat <img src=x>\n# heading', ledger: 'style', property: 'gap', state: 's', region: 'r', severity: 'WARNING', resolution: 'FIX_CODE', element: {} }],
      stateMatrix: [],
    },
    { context: CTX },
  );
  const md = summaryMarkdown(result);
  assert.ok(!md.includes('@octocat'));
  assert.ok(!/(^|[^\\])<img/.test(md), 'raw HTML is escaped');
  assert.ok(!md.includes('\n# heading'));
});

test('CLI: writes the result and history, then diffs against it on the next run', async () => {
  const dir = tmpDir();
  const feature = path.join(dir, 'qa-reports', 'orders');
  mkdirSync(feature, { recursive: true });
  const report = loadFixture('../../examples/sample/sample-report.json');
  writeFileSync(path.join(feature, 'report.json'), JSON.stringify(report));
  const args = ['--report', path.join(feature, 'report.json'), '--branch', 'feat/x', '--repo', 'acme/web'];

  const r1 = await run(RUN_RESULT, [...args, '--comment-md', path.join(dir, 'summary.md')]);
  assert.equal(r1.code, 0, r1.stderr);
  const first = JSON.parse(readFileSync(path.join(feature, 'run-result.json'), 'utf8'));
  assert.ok(existsSync(path.join(dir, 'qa-reports', 'runs', `${first.run_id}.json`)));
  assert.match(readFileSync(path.join(dir, 'summary.md'), 'utf8'), /First run/);

  const fixedFinding = report.findings.find((f) => f.resolution === 'FIX_CODE' && f.state === 'with-data');
  report.findings = report.findings.filter((f) => f !== fixedFinding);
  writeFileSync(path.join(feature, 'report.json'), JSON.stringify(report));
  const r2 = await run(RUN_RESULT, args);
  assert.equal(r2.code, 0, r2.stderr);
  assert.match(r2.stdout, /1 fixed/);
  const second = JSON.parse(readFileSync(path.join(feature, 'run-result.json'), 'utf8'));
  assert.equal(second.previous_run_id, first.run_id);
  assert.equal(readdirSync(path.join(dir, 'qa-reports', 'runs')).length, 2);
});

test('CLI: bad arguments exit 2', async () => {
  assert.equal((await run(RUN_RESULT, [])).code, 2);
  assert.equal((await run(RUN_RESULT, ['--report', '/nonexistent/report.json'])).code, 2);
  assert.equal((await run(RUN_RESULT, ['--report', 'x', '--sha', 'not-hex!'])).code, 2);
});
