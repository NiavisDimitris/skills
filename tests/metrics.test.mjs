import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { computeMetrics, weekOf } from '../skills/design-qa/scripts/lib/metrics.mjs';
import { buildRunResult } from '../skills/design-qa/scripts/lib/run-result.mjs';
import { loadFixture, run, script, tmpDir } from './_helpers.mjs';

const METRICS = script('metrics.mjs');

/**
 * PR #9 on feat/orders: run 1 (sample report), run 2 on the next day with one issue
 * fixed and one dismissed. Plus a main-branch run a week later with no PR.
 */
function simulatedRuns() {
  const report = loadFixture('../../examples/sample/sample-report.json');
  const pr = { repo: 'acme/web', branch: 'feat/orders', commit_sha: 'aaaaaaa', pr_number: 9 };
  const r1 = buildRunResult(report, { context: pr, now: new Date('2026-10-05T10:00:00Z') }).result;

  const second = structuredClone(report);
  const open = second.findings.filter((f) => f.resolution === 'FIX_CODE' && f.state === 'with-data');
  second.findings = second.findings.filter((f) => f !== open[0]);
  open[1].resolution = 'DISMISSED';
  const r2 = buildRunResult(second, { previous: r1, context: pr, now: new Date('2026-10-06T10:00:00Z') }).result;

  const r3 = buildRunResult(report, { context: { ...pr, branch: 'main', pr_number: null }, now: new Date('2026-10-13T10:00:00Z') }).result;
  return [r1, r2, r3];
}

test('weekOf is the Monday of the UTC week', () => {
  assert.equal(weekOf('2026-10-05T10:00:00Z'), '2026-10-05'); // a Monday
  assert.equal(weekOf('2026-10-11T23:59:00Z'), '2026-10-05'); // the Sunday after
  assert.equal(weekOf('2026-10-12T00:00:00Z'), '2026-10-12');
});

test('the four metrics over a simulated history', () => {
  const [r1, r2, r3] = simulatedRuns();
  const m = computeMetrics([r3, r1, r2]);

  const caughtR1 = m.issues_per_run_by_type.filter((r) => r.run_id === r1.run_id).reduce((n, r) => n + r.issues, 0);
  assert.equal(caughtR1, r1.totals.flagged);

  assert.deepEqual(m.fixed_before_merge_monthly, [{ month: '2026-10-01', repo: 'acme/web', fixed_before_merge: 1, pull_requests: 1 }]);

  // Week of 10-05: feat/orders uses its last run (r2), one fewer open than r1.
  const openIn = (week, branch) => m.open_drift_weekly.filter((r) => r.week === week && r.branch === branch).reduce((n, r) => n + r.open_issues, 0);
  assert.equal(openIn('2026-10-05', 'feat/orders'), r2.totals.by_status.open);
  assert.equal(openIn('2026-10-12', 'main'), r3.totals.by_status.open);

  const all = m.false_positive_rate.find((r) => r.is_total);
  // Issues are keyed by repo + feature + issue_id across branches; the main run (latest) has the
  // sample's own dismissals, so the latest flagged status wins.
  const dismissedNow = r3.issues.filter((i) => i.status === 'dismissed').length;
  assert.equal(all.dismissed, dismissedNow);
  assert.equal(all.flagged, r1.issues.length);
  assert.equal(all.false_positive_rate, Math.round((dismissedNow / r1.issues.length) * 10000) / 10000);
});

test('runs without a PR never count as fixed before merge', () => {
  const [r1, r2] = simulatedRuns().map((r) => ({ ...r, pr_number: null }));
  assert.deepEqual(computeMetrics([r1, r2]).fixed_before_merge_monthly, []);
});

test('CLI --source local prints all four sections, and --json the rows', async () => {
  const dir = tmpDir();
  const runsDir = path.join(dir, 'qa-reports', 'runs');
  mkdirSync(runsDir, { recursive: true });
  for (const r of simulatedRuns()) writeFileSync(path.join(runsDir, `${r.run_id}.json`), JSON.stringify(r));
  writeFileSync(path.join(runsDir, 'not-a-run.json'), '{"hello": 1}');

  const res = await run(METRICS, ['--dir', path.join(dir, 'qa-reports')]);
  assert.equal(res.code, 0, res.stderr);
  for (const heading of ['1. Issues caught per run', '2. Design defects fixed before merge', '3. Drift', '4. False positive rate']) {
    assert.ok(res.stdout.includes(heading), heading);
  }
  assert.match(res.stdout, /Headline: 1 design defect\(s\) caught and fixed before merge/);

  const json = await run(METRICS, ['--dir', path.join(dir, 'qa-reports'), '--json', '--repo', 'acme/web']);
  assert.equal(JSON.parse(json.stdout).fixed_before_merge_monthly[0].fixed_before_merge, 1);
});

test('CLI: bad arguments exit 2', async () => {
  assert.equal((await run(METRICS, ['--source', 'bigquery'])).code, 2);
  assert.equal((await run(METRICS, ['--dir', '/nonexistent/qa-reports'])).code, 2);
  const unset = await run(METRICS, ['--source', 'supabase'], { env: { SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_SECRET_KEY: '' } });
  assert.equal(unset.code, 2);
  assert.match(unset.stderr, /Supabase is not configured/);
});
