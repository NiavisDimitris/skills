import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { applyTriage, buildTriage } from '../skills/design-qa/scripts/lib/triage.mjs';
import { loadFixture, run, script, sendJson, startServer, tmpDir } from './_helpers.mjs';

const JIRA = script('jira-fetch.mjs');
const TOKEN = 'secret-token-value';

/** The fixture triaged: DQ-001/DQ-002 fixed now, DQ-003 (design) and DQ-004 (engineering) debt without tickets. */
function triagedFile(dir, mutate = (r) => r) {
  const r = loadFixture('report-valid.json');
  const { triage } = buildTriage(r, { fixIds: ['DQ-002'], decidedBy: 'Dana', decidedAt: '2026-09-24T09:00:00Z' });
  const file = path.join(dir, 'report.json');
  writeFileSync(file, JSON.stringify(mutate(applyTriage(r, triage)), null, 2));
  return file;
}
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const env = (server) => ({ JIRA_BASE_URL: server.url, JIRA_EMAIL: 'qa@example.com', JIRA_API_TOKEN: TOKEN, DESIGN_QA_RETRY_BASE_MS: '5' });

function jiraServer({ failOn = null } = {}) {
  let next = 100;
  return startServer((req, res, body) => {
    if (req.method === 'POST' && req.url === '/rest/api/3/issue') {
      const n = next++;
      if (failOn === n) return sendJson(res, 400, { errors: { summary: 'Summary is too long' } });
      return sendJson(res, 201, { id: String(n), key: `ABC-${n}`, self: `/rest/api/3/issue/${n}`, echo: JSON.parse(body).fields.summary });
    }
    return sendJson(res, 404, {});
  });
}

test('--tickets-from dry run: one payload per untracked debt item, no credentials, no requests', async () => {
  const dir = tmpDir();
  const file = triagedFile(dir);
  const before = readFileSync(file, 'utf8');
  const res = await run(JIRA, ['--tickets-from', file], { env: { JIRA_BASE_URL: '', JIRA_EMAIL: '', JIRA_API_TOKEN: '' }, cwd: dir });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /\[dry run\] would create 2 Sub-task issue\(s\) under ABC-12/);
  assert.match(res.stdout, /# DQ-003 — \[Design debt\] Hover row uses the old highlight colour in Figma/);
  assert.match(res.stdout, /# DQ-004 — \[Design debt\] Hard-coded grey could be a design-system token/);
  const payload = JSON.parse(res.stdout.slice(res.stdout.indexOf('{'), res.stdout.indexOf('\n}\n') + 2));
  assert.deepEqual(payload.fields.project, { key: 'ABC' });
  assert.deepEqual(payload.fields.parent, { key: 'ABC-12' });
  assert.deepEqual(payload.fields.issuetype, { name: 'Sub-task' });
  assert.deepEqual(payload.fields.labels, ['design-qa', 'design-debt']);
  const text = payload.fields.description.content.map((p) => p.content[0].text);
  assert.deepEqual(text, [
    'Design debt deferred in design QA by Dana on 2026-09-24.',
    'Severity: WARNING · Owner: design · State: hover',
    'Where: selector .row:hover · Figma Row / Hover',
    'Expected: #EEF2FF (token color.row.hover) · Actual: #F0F4FF (token color.surface.hover)',
    'Fix: Update the Row/Hover variant to color.surface.hover',
    'Patch hint: –',
    'Evidence: –',
    'Finding DQ-003 · report report.json · feature ticket ABC-12',
  ]);
  assert.equal(readFileSync(file, 'utf8'), before, 'a dry run never writes');
});

test('--tickets-from --write creates the tickets and records them in report.json', async () => {
  const server = await jiraServer();
  try {
    const dir = tmpDir();
    const file = triagedFile(dir);
    assert.equal(read(file).scorecard.unexplained, 4);
    const res = await run(JIRA, ['--tickets-from', file, '--write', '--labels', 'design-qa,ux-debt'], { env: env(server) });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /Created ABC-100 under ABC-12 — \[Design debt\] Hover row/);
    assert.match(res.stdout, /Recorded 2 ticket\(s\) in .*report\.json — unexplained 2, debt 2\/2 ticketed, verdict FAIL/);
    assert.ok(!res.stdout.includes(TOKEN) && !res.stderr.includes(TOKEN), 'the token is never printed');
    const posts = server.requests.filter((r) => r.method === 'POST');
    assert.equal(posts.length, 2);
    assert.equal(posts[0].headers.authorization, `Basic ${Buffer.from(`qa@example.com:${TOKEN}`).toString('base64')}`);
    assert.deepEqual(JSON.parse(posts[0].body).fields.labels, ['design-qa', 'ux-debt']);

    const r = read(file);
    const tickets = Object.fromEntries(r.triage.items.filter((i) => i.ticket).map((i) => [i.findingId, i.ticket]));
    assert.deepEqual(Object.keys(tickets), ['DQ-003', 'DQ-004']);
    assert.equal(tickets['DQ-003'].provider, 'jira');
    assert.equal(tickets['DQ-003'].key, 'ABC-100');
    assert.equal(tickets['DQ-003'].url, `${server.url}/browse/ABC-100`);
    assert.ok(!Number.isNaN(Date.parse(tickets['DQ-003'].createdAt)));
    assert.deepEqual([r.scorecard.unexplained, r.scorecard.debt], [2, { count: 2, ticketed: 2 }]);
    assert.equal((await run(script('validate.mjs'), [file])).code, 0, 'the written report validates');

    const again = await run(JIRA, ['--tickets-from', file, '--write'], { env: env(server) });
    assert.equal(again.code, 0);
    assert.match(again.stdout, /Every debt item already has a ticket; nothing to create/);
    assert.equal(server.requests.filter((q) => q.method === 'POST').length, 2, 'no duplicates');
  } finally {
    await server.close();
  }
});

test('--tickets-from: a failure keeps the tickets already created', async () => {
  const server = await jiraServer({ failOn: 101 });
  try {
    const dir = tmpDir();
    const file = triagedFile(dir);
    const res = await run(JIRA, ['--tickets-from', file, '--write'], { env: env(server) });
    assert.equal(res.code, 1);
    assert.match(res.stderr, /creating the ticket for DQ-004 failed: Summary is too long/);
    const r = read(file);
    assert.equal(r.triage.items.find((i) => i.findingId === 'DQ-003').ticket.key, 'ABC-100');
    assert.equal(r.triage.items.find((i) => i.findingId === 'DQ-004').ticket, null);
    assert.equal(r.scorecard.debt.ticketed, 1);
  } finally {
    await server.close();
  }
});

test('--tickets-from: parent, project and issue type rules', async () => {
  const dir = tmpDir();
  const noTicket = triagedFile(dir, (r) => ({ ...r, meta: { ...r.meta, ticket: null } }));
  const none = await run(JIRA, ['--tickets-from', noTicket]);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /no parent issue \(meta\.ticket\.key\) and no project: pass --parent KEY or --project KEY/);
  const task = await run(JIRA, ['--tickets-from', noTicket, '--project', 'des']);
  assert.equal(task.code, 0, task.stderr);
  assert.match(task.stdout, /would create 2 Task issue\(s\) in project DES/);
  assert.ok(!task.stdout.includes('"parent"'));
  assert.equal((await run(JIRA, ['--tickets-from', noTicket, '--project', 'DES', '--issuetype', 'Sub-task'])).code, 2);
  const parent = await run(JIRA, ['--tickets-from', noTicket, '--parent', 'web-7']);
  assert.match(parent.stdout, /2 Sub-task issue\(s\) under WEB-7/);

  const config = path.join(dir, 'design-qa.config.json');
  const cfg = loadFixture('config.json');
  cfg.tolerances.pixelDiff = { pass: 1, review: 5 };
  cfg.ticket.debt = { project: 'OPS', issueType: 'Task', parent: null, labels: ['debt'] };
  writeFileSync(config, JSON.stringify(cfg));
  const fromConfig = await run(JIRA, ['--tickets-from', triagedFile(tmpDir()), '--config', config]);
  assert.equal(fromConfig.code, 0, fromConfig.stderr);
  assert.match(fromConfig.stdout, /2 Task issue\(s\) in project OPS/);
  assert.match(fromConfig.stdout, /"labels": \[\s*"debt"\s*\]/);

  assert.equal((await run(JIRA, ['--tickets-from', triagedFile(tmpDir()), '--labels', 'design qa'])).code, 2);
  assert.equal((await run(JIRA, ['--tickets-from', triagedFile(tmpDir()), '--issue', 'ABC-1'])).code, 2);
  assert.equal((await run(JIRA, ['--issue', 'ABC-1', '--out', tmpDir(), '--parent', 'ABC-2'])).code, 2);
  const plain = path.join(tmpDir(), 'report.json');
  writeFileSync(plain, JSON.stringify(loadFixture('report-valid.json')));
  const noTriage = await run(JIRA, ['--tickets-from', plain]);
  assert.equal(noTriage.code, 2);
  assert.match(noTriage.stderr, /has no triage block: run triage\.mjs first/);
});

test('--subtasks skips debt that the fix plan already shows as ticketed', async () => {
  const dir = tmpDir();
  const plan = path.join(dir, 'report-fixplan.md');
  writeFileSync(
    plan,
    [
      '## Debt (2) — tickets',
      '- DQ-004 — Card padding (WARNING, owner engineering) — ACME-511 — Use the spacing token.',
      '- DQ-009 — Bulk bar has no design (DS_CANDIDATE, owner design) — no ticket yet — Design it.',
      '',
      '## Missing states / needs decision',
    ].join('\n'),
  );
  const res = await run(JIRA, ['--issue', 'ABC-12', '--subtasks', plan], { env: { JIRA_BASE_URL: '', JIRA_EMAIL: '', JIRA_API_TOKEN: '' } });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /skip DQ-004: already tracked by ACME-511/);
  assert.match(res.stdout, /would create Sub-task under ABC-12: DQ-009 — Bulk bar has no design/);
  assert.ok(!res.stdout.includes('would create Sub-task under ABC-12: DQ-004'));
});
