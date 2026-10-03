import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { renderDebtLog, updateDebtLog, whereOf } from '../skills/design-qa/scripts/debt-log.mjs';
import { computeScorecard } from '../skills/design-qa/scripts/lib/ranking.mjs';
import { applyTriage, buildTriage } from '../skills/design-qa/scripts/lib/triage.mjs';
import { loadFixture, run, script, tmpDir } from './_helpers.mjs';

const DEBT_LOG = script('debt-log.mjs');
const TICKET = { provider: 'jira', key: 'ABC-99', url: 'https://example.atlassian.net/browse/ABC-99', createdAt: '2026-09-24T09:05:00Z' };

/** The fixture report triaged: DQ-001/DQ-002 fixed now, DQ-003, DQ-004 (ticketed) and DQ-008 debt. */
function triaged(generatedAt = '2026-09-24T09:00:00Z') {
  const r = loadFixture('report-valid.json');
  r.meta.generatedAt = generatedAt;
  const { triage } = buildTriage(r, { fixIds: ['DQ-002'], decidedBy: 'Dana', decidedAt: '2026-09-24T09:00:00Z' });
  triage.items.find((i) => i.findingId === 'DQ-004').ticket = TICKET;
  return applyTriage(r, triage);
}

/** Write the report to <root>/qa-reports/<slug>/report.json like the skill does. */
function place(root, report, slug = 'ABC-12') {
  const dir = path.join(root, 'qa-reports', slug);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'report.json');
  writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

test('first run: one open entry per debt item, next to the feature folder, and a Markdown table', async () => {
  const root = tmpDir();
  const file = place(root, triaged());
  const res = await run(DEBT_LOG, ['--report', file]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Debt log for ABC-12: 3 added, 0 updated, 0 reopened, 0 resolved — open 3 · resolved 0/);
  const logFile = path.join(root, 'qa-reports', 'design-debt.json');
  const log = JSON.parse(readFileSync(logFile, 'utf8'));
  assert.equal(log.version, 1);
  assert.deepEqual(log.entries.map((e) => [e.findingId, e.owner, e.status, e.ticket?.key ?? null]), [
    ['DQ-003', 'engineering', 'open', null],
    ['DQ-004', 'engineering', 'open', 'ABC-99'],
    ['DQ-008', 'engineering', 'open', null],
  ], 'debt is always owned by engineering; dismissed and intentional findings are never debt');
  const e = log.entries[1];
  assert.deepEqual(
    { since: e.since, slug: e.slug, parentTicket: e.parentTicket, severity: e.severity, resolution: e.resolution, title: e.title, where: e.where, reportPath: e.reportPath },
    {
      since: '2026-09-24T09:00:00Z',
      slug: 'ABC-12',
      parentTicket: 'ABC-12',
      severity: 'DS_CANDIDATE',
      resolution: 'FIX_CODE',
      title: 'Hard-coded grey could be a design-system token',
      where: 'src/Row.css:12 · .row .meta',
      reportPath: 'ABC-12/report.json',
    },
  );
  assert.equal(log.entries[0].where, 'src/Items.tsx:61 · .row:hover');
  const md = readFileSync(path.join(root, 'qa-reports', 'design-debt.md'), 'utf8');
  const lines = md.split('\n');
  assert.deepEqual(lines.slice(0, 6), [
    '# Design debt log',
    '',
    'open 3 · resolved 0',
    '',
    '| Status | Since | Feature | Finding | Severity | Owner | Title | Where | Ticket |',
    '|---|---|---|---|---|---|---|---|---|',
  ]);
  assert.equal(
    lines[7],
    '| open | 2026-09-24 | Items list (ABC-12) | DQ-004 | DS_CANDIDATE | engineering | Hard-coded grey could be a design-system token | src/Row.css:12 · .row .meta | [ABC-99](https://example.atlassian.net/browse/ABC-99) |',
  );
});

test('re-running with the same report changes nothing (idempotent)', async () => {
  const root = tmpDir();
  const file = place(root, triaged());
  assert.equal((await run(DEBT_LOG, ['--report', file])).code, 0);
  const json = readFileSync(path.join(root, 'qa-reports', 'design-debt.json'), 'utf8');
  const md = readFileSync(path.join(root, 'qa-reports', 'design-debt.md'), 'utf8');
  const again = await run(DEBT_LOG, ['--report', file]);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /0 added, 0 updated, 0 reopened, 0 resolved/);
  assert.equal(readFileSync(path.join(root, 'qa-reports', 'design-debt.json'), 'utf8'), json);
  assert.equal(readFileSync(path.join(root, 'qa-reports', 'design-debt.md'), 'utf8'), md);
});

test('a newer report resolves debt that is no longer open; an older report changes nothing', async () => {
  const root = tmpDir();
  const file = place(root, triaged('2026-09-24T09:00:00Z'));
  assert.equal((await run(DEBT_LOG, ['--report', file])).code, 0);

  const newer = triaged('2026-09-30T12:00:00Z');
  const f = newer.findings.find((x) => x.id === 'DQ-004');
  Object.assign(f, { severity: 'PASS', resolution: 'NONE', fix: null });
  newer.triage.items = newer.triage.items.filter((i) => i.findingId !== 'DQ-004');
  newer.findings = newer.findings.map((x) => (x.id === 'DQ-004' ? { ...x, rank: { score: 0, bucket: 'none' } } : x));
  newer.scorecard = computeScorecard(newer);
  place(root, newer);
  const res = await run(DEBT_LOG, ['--report', file]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /0 added, 0 updated, 0 reopened, 1 resolved — open 2 · resolved 1/);
  const log = JSON.parse(readFileSync(path.join(root, 'qa-reports', 'design-debt.json'), 'utf8'));
  const resolved = log.entries.find((e) => e.findingId === 'DQ-004');
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolvedAt, '2026-09-30T12:00:00Z');
  assert.equal(log.entries[0].findingId, 'DQ-003', 'open entries first');
  assert.match(readFileSync(path.join(root, 'qa-reports', 'design-debt.md'), 'utf8'), /\| resolved 2026-09-30 \| 2026-09-24 \| Items list \(ABC-12\) \| DQ-004 \|/);

  place(root, triaged('2026-09-20T00:00:00Z'));
  const older = await run(DEBT_LOG, ['--report', file]);
  assert.equal(older.code, 0);
  assert.match(older.stderr, /updated by a newer report and left unchanged/);
  assert.equal(JSON.parse(readFileSync(path.join(root, 'qa-reports', 'design-debt.json'), 'utf8')).entries.find((e) => e.findingId === 'DQ-004').status, 'resolved');
});

test('updateDebtLog: reopen, config and explicit paths, reports without triage', async () => {
  const first = updateDebtLog(null, triaged('2026-09-24T09:00:00Z'), { reportPath: 'r.json' }).log;
  const gone = triaged('2026-09-25T09:00:00Z');
  gone.findings = gone.findings.filter((f) => f.id !== 'DQ-003');
  gone.triage.items = gone.triage.items.filter((i) => i.findingId !== 'DQ-003');
  const second = updateDebtLog(first, gone, { reportPath: 'r.json' });
  assert.equal(second.stats.resolved, 1, 'a finding that disappeared is resolved');
  const back = updateDebtLog(second.log, triaged('2026-09-26T09:00:00Z'), { reportPath: 'r.json' });
  assert.equal(back.stats.reopened, 1);
  const reopened = back.log.entries.find((e) => e.findingId === 'DQ-003');
  assert.equal(reopened.status, 'open');
  assert.equal('resolvedAt' in reopened, false);
  assert.equal(reopened.since, '2026-09-24T09:00:00Z', 'since is kept');
  assert.equal(back.log.updatedAt, '2026-09-26T09:00:00Z');
  assert.match(renderDebtLog({ entries: [] }), /open 0 · resolved 0/);
  assert.equal(whereOf({ resolution: 'FIX_CODE', element: { figmaNodeId: '1:2' }, actual: { source: {} } }), 'Figma: 1:2', 'the design layer when there is no code location');
  assert.equal(whereOf({ resolution: 'FIX_CODE', element: { selector: '.a', figmaLayerPath: 'A/B' }, actual: { source: { file: 'a.css', line: 3 } } }), 'a.css:3 · .a');
  assert.equal(whereOf({ resolution: 'FIX_CODE', element: {}, actual: { source: {} } }), '–');

  const root = tmpDir();
  const file = place(root, triaged());
  const config = path.join(root, 'design-qa.config.json');
  const cfg = loadFixture('config.json');
  cfg.report.debtLog = 'docs/design-debt.md';
  writeFileSync(config, JSON.stringify(cfg));
  assert.equal((await run(DEBT_LOG, ['--report', file, '--config', config, '--quiet'])).code, 0);
  assert.ok(existsSync(path.join(root, 'docs', 'design-debt.md')));
  assert.ok(existsSync(path.join(root, 'docs', 'design-debt.json')));
  assert.equal((await run(DEBT_LOG, ['--report', file, '--log', path.join(root, 'x', 'log.json'), '--quiet'])).code, 0);
  assert.ok(existsSync(path.join(root, 'x', 'log.md')), '--log alone puts the Markdown next to it');

  const plain = place(root, loadFixture('report-valid.json'), 'plain');
  const res = await run(DEBT_LOG, ['--report', plain, '--log', path.join(root, 'plain.json')]);
  assert.equal(res.code, 0);
  assert.match(res.stderr, /no triage block/);
  assert.equal((await run(DEBT_LOG, [])).code, 2);
});
