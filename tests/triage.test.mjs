import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadFixture, run, script, tmpDir } from './_helpers.mjs';

const TRIAGE = script('triage.mjs');
const VALIDATE = script('validate.mjs');

function reportIn(dir, report = loadFixture('report-valid.json')) {
  const file = path.join(dir, 'report.json');
  writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const decisions = (report) => Object.fromEntries(report.triage.items.map((i) => [i.findingId, i.decision]));

test('--fix: listed ids are fixed now, every other triageable finding is debt, blockers are forced', async () => {
  const dir = tmpDir();
  const file = reportIn(dir);
  const res = await run(TRIAGE, ['--report', file, '--fix', 'dq-002', '--by', 'Dana']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /warning: DQ-001 is a BLOCKER: blockers cannot be deferred; kept in fix now/);
  assert.match(res.stdout, /Fix now \(2\): DQ-001, DQ-002/);
  assert.match(res.stdout, /Debt \(2\): DQ-003 \[design\], DQ-004 \[engineering\] — 0 ticketed, 2 need a ticket/);
  const r = read(file);
  assert.equal(r.schemaVersion, '1.1');
  assert.deepEqual(decisions(r), { 'DQ-001': 'fix-now', 'DQ-002': 'fix-now', 'DQ-003': 'debt', 'DQ-004': 'debt' });
  assert.equal(r.triage.decidedBy, 'Dana');
  assert.equal(r.triage.source, 'cli');
  assert.ok(!Number.isNaN(Date.parse(r.triage.decidedAt)));
  assert.deepEqual(
    { unexplained: r.scorecard.unexplained, debt: r.scorecard.debt, loopClosed: r.scorecard.loopClosed, verdict: r.scorecard.verdict },
    { unexplained: 4, debt: { count: 2, ticketed: 0 }, loopClosed: false, verdict: 'FAIL' },
  );
  assert.deepEqual(Object.keys(r).slice(0, 5), ['schemaVersion', 'meta', 'scorecard', 'triage', 'stateMatrix']);
  assert.equal((await run(VALIDATE, [file])).code, 0);
});

test('re-triage keeps tickets (and reasons) of items that stay debt', async () => {
  const dir = tmpDir();
  const file = reportIn(dir);
  assert.equal((await run(TRIAGE, ['--report', file, '--fix', 'none'])).code, 0);
  const r = read(file);
  const ticket = { provider: 'jira', key: 'ABC-99', url: 'https://example.atlassian.net/browse/ABC-99', createdAt: '2026-09-24T10:00:00Z' };
  for (const item of r.triage.items) {
    if (item.findingId === 'DQ-004') Object.assign(item, { ticket, reason: 'Batch with the token sweep.' });
    if (item.findingId === 'DQ-003') item.ticket = { ...ticket, key: 'ABC-98', url: 'https://example.atlassian.net/browse/ABC-98' };
  }
  writeFileSync(file, JSON.stringify(r));
  const res = await run(TRIAGE, ['--report', file, '--fix', 'DQ-003']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /DQ-003 moves to fix now but ABC-98 still tracks it as debt/);
  const next = read(file);
  const byId = Object.fromEntries(next.triage.items.map((i) => [i.findingId, i]));
  assert.deepEqual(byId['DQ-004'].ticket, ticket);
  assert.equal(byId['DQ-004'].reason, 'Batch with the token sweep.');
  assert.equal(byId['DQ-003'].decision, 'fix-now');
  assert.equal(next.scorecard.debt.ticketed, 1);
  assert.equal(next.scorecard.unexplained, 3, 'DQ-004 is ticketed debt now');
});

test('--default: the rank recommendation (fix-now and sync-figma buckets now, debt bucket later)', async () => {
  const dir = tmpDir();
  const file = reportIn(dir);
  const config = path.join(dir, 'design-qa.config.json');
  const cfg = loadFixture('config.json');
  cfg.report.topN = 1;
  cfg.tolerances.pixelDiff = { pass: 1, review: 5 };
  cfg.report.ranking = {};
  writeFileSync(config, JSON.stringify(cfg));
  const res = await run(TRIAGE, ['--report', file, '--default', '--config', config]);
  assert.equal(res.code, 0, res.stderr);
  const r = read(file);
  assert.deepEqual(decisions(r), { 'DQ-001': 'fix-now', 'DQ-002': 'debt', 'DQ-003': 'fix-now', 'DQ-004': 'debt' });
  assert.equal(r.triage.source, 'ci-default');
  assert.equal(r.triage.decidedBy, null);
});

test('--selection: decisions from report.html, with mismatch and coverage warnings', async () => {
  const dir = tmpDir();
  const file = reportIn(dir);
  const selection = path.join(dir, 'selection.json');
  writeFileSync(
    selection,
    JSON.stringify({
      feature: 'Items list',
      slug: 'OTHER-1',
      reportGeneratedAt: '2026-01-01T00:00:00Z',
      fixNow: ['DQ-001', 'DQ-004'],
      debt: ['DQ-002'],
      decidedBy: 'Maya',
      decidedAt: '2026-09-24T08:30:00Z',
    }),
  );
  const res = await run(TRIAGE, ['--report', file, '--selection', selection]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /selection is for "OTHER-1" but this report is "ABC-12"/);
  assert.match(res.stderr, /selection was made on the report generated 2026-01-01T00:00:00Z/);
  assert.match(res.stderr, /not in the selection, recorded as debt: DQ-003/);
  const r = read(file);
  assert.deepEqual(decisions(r), { 'DQ-001': 'fix-now', 'DQ-002': 'debt', 'DQ-003': 'debt', 'DQ-004': 'fix-now' });
  assert.deepEqual([r.triage.decidedBy, r.triage.decidedAt, r.triage.source], ['Maya', '2026-09-24T08:30:00Z', 'report-ui']);

  writeFileSync(selection, JSON.stringify({ fixNow: ['DQ-002'], debt: ['DQ-002'] }));
  const both = await run(TRIAGE, ['--report', file, '--selection', selection]);
  assert.equal(both.code, 2);
  assert.match(both.stderr, /lists DQ-002 as both fix now and debt/);
});

test('--dry-run prints the triage without writing', async () => {
  const dir = tmpDir();
  const file = reportIn(dir);
  const before = readFileSync(file, 'utf8');
  const res = await run(TRIAGE, ['--report', file, '--fix', 'DQ-002,DQ-003', '--dry-run']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /\[dry run\] report\.json not written/);
  assert.match(res.stdout, /Sync to Figma \(1\): DQ-003/);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('bad arguments exit 2; an invalid report exits 1', async () => {
  const dir = tmpDir();
  const file = reportIn(dir);
  assert.equal((await run(TRIAGE, ['--report', file])).code, 2, 'a mode is required');
  assert.equal((await run(TRIAGE, ['--report', file, '--fix', 'DQ-001', '--default'])).code, 2, 'only one mode');
  const unknown = await run(TRIAGE, ['--report', file, '--fix', 'DQ-001,DQ-777']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown finding id\(s\): DQ-777/);
  assert.equal((await run(TRIAGE, ['--report', file, '--fix', 'row-7'])).code, 2);
  assert.equal((await run(TRIAGE, ['--report', file, '--default', '--source', 'email'])).code, 2);
  assert.equal((await run(TRIAGE, ['--fix', 'DQ-001'])).code, 2, '--report is required');
  const ignored = await run(TRIAGE, ['--report', file, '--fix', 'DQ-005', '--dry-run']);
  assert.equal(ignored.code, 0);
  assert.match(ignored.stderr, /DQ-005 is not triageable \(PASS \/ NONE\); ignored/);

  const bad = loadFixture('report-valid.json');
  bad.findings[0].severity = 'CRITICAL';
  const invalid = await run(TRIAGE, ['--report', reportIn(tmpDir(), bad), '--default']);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /is not a valid report; fix it first/);
});
