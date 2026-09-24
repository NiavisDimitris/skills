import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  buildJiraTicket,
  extractAcceptanceCriteria,
  extractBranches,
  extractExpectedBehaviors,
  extractTrigger,
  headingText,
} from '../skills/design-qa/scripts/lib/ticket-extract.mjs';
import { loadFixture, run, script, sendJson, startServer, tmpDir } from './_helpers.mjs';

const JIRA = script('jira-fetch.mjs');

test('acceptance criteria under an AC heading, until the next heading', () => {
  const text = [
    'Context paragraph that is not a criterion.',
    '## Acceptance criteria',
    '- Shows one row per item',
    '* When the list is empty, show "No items yet"',
    '1. Show a skeleton while loading',
    '',
    '## Notes',
    'Background only.',
  ].join('\n');
  assert.deepEqual(extractAcceptanceCriteria(text), [
    'Shows one row per item',
    'When the list is empty, show "No items yet"',
    'Show a skeleton while loading',
  ]);
});

test('AC headings can be bold paragraphs or "AC:" / "Definition of done:" lines', () => {
  assert.deepEqual(extractAcceptanceCriteria('**Acceptance Criteria**\nRows are 48px tall\nNotes:\nnot this'), ['Rows are 48px tall']);
  assert.deepEqual(extractAcceptanceCriteria('AC:\n- Title is Items'), ['Title is Items']);
  assert.deepEqual(extractAcceptanceCriteria('Definition of done:\n- Designs match'), ['Designs match']);
  assert.equal(headingText('h3. Acceptance criteria'), 'Acceptance criteria');
  assert.equal(headingText('- not: a heading:'), null);
});

test('checkboxes, Should/Must lines and Given/When/Then scenarios count anywhere', () => {
  const text = [
    'Some intro.',
    '- [ ] Disabled rows are greyed out',
    '- [x] Title uses the heading token',
    'Should keep focus on the first row after refresh',
    'Must not show the banner twice',
    'Given the user is offline',
    'When they open the page',
    'Then show the offline banner',
    'And disable the refresh button',
    'Given a second scenario',
    'Then it is separate',
    'An ordinary sentence.',
  ].join('\n');
  assert.deepEqual(extractAcceptanceCriteria(text), [
    'Disabled rows are greyed out',
    'Title uses the heading token',
    'Should keep focus on the first row after refresh',
    'Must not show the banner twice',
    'Given the user is offline When they open the page Then show the offline banner And disable the refresh button',
    'Given a second scenario Then it is separate',
  ]);
});

test('expected behaviours carry acRef, state and trigger', () => {
  const behaviors = extractExpectedBehaviors([
    'Shows one row per item',
    'When the list is empty, show "No items yet"',
    'Show a skeleton while the list is loading',
    'On hover, the row background changes to grey-50',
    'If the request fails, show an error banner with Retry',
    'Given the user is offline When they open the page Then show the offline banner',
    'Disabled rows are greyed out',
  ]);
  assert.deepEqual(behaviors, [
    { acRef: 'AC-1', text: 'Shows one row per item', state: null, trigger: null },
    { acRef: 'AC-2', text: 'When the list is empty, show "No items yet"', state: 'empty', trigger: 'the list is empty' },
    { acRef: 'AC-3', text: 'Show a skeleton while the list is loading', state: 'loading', trigger: 'the list is loading' },
    { acRef: 'AC-4', text: 'On hover, the row background changes to grey-50', state: 'hover', trigger: 'hover' },
    { acRef: 'AC-5', text: 'If the request fails, show an error banner with Retry', state: 'error', trigger: 'the request fails' },
    { acRef: 'AC-6', text: 'Given the user is offline When they open the page Then show the offline banner', state: 'error', trigger: 'they open the page' },
    { acRef: 'AC-7', text: 'Disabled rows are greyed out', state: 'disabled', trigger: null },
  ]);
  assert.equal(extractTrigger('The badge sits on the card'), null, '"on" needs an event word');
  assert.equal(extractTrigger('Underline on keyboard focus'), 'keyboard focus');
});

test('branches: prefixed tokens, "branch:" labels and GitHub tree links', () => {
  const text = 'Branch: feature/items-empty. Also fix/row-padding, and https://github.com/acme/web/tree/design-qa/items-v2 but not https://example.com/feature/page';
  assert.deepEqual(extractBranches(text), ['feature/items-empty', 'fix/row-padding', 'design-qa/items-v2']);
});

test('buildJiraTicket turns a REST v3 issue into ticket.json', () => {
  const ticket = buildJiraTicket(loadFixture('jira-issue.json'), {
    baseUrl: 'https://acme.atlassian.net/',
    remoteLinks: [{ object: { url: 'https://www.figma.com/design/OtherKey1/Spec?node-id=3-4', title: 'Figma' } }],
    now: new Date('2026-09-23T00:00:00Z'),
  });
  assert.equal(ticket.provider, 'jira');
  assert.equal(ticket.key, 'ABC-12');
  assert.equal(ticket.url, 'https://acme.atlassian.net/browse/ABC-12');
  assert.equal(ticket.title, 'Items list: empty and error states');
  assert.equal(ticket.status, 'In Review');
  assert.equal(ticket.parent, 'ABC-1');
  assert.match(ticket.description, /^Design: Figma \(https:\/\/www\.figma\.com\/design\/AbCdEf123456\/Items\?node-id=1-2\)\. Owner @Dana\nBranch: feature\/items-empty-state/);
  assert.match(ticket.description, /## Acceptance criteria\n\n- Shows one row per item/);
  assert.match(ticket.description, /Env \| URL\nStaging \| https:\/\/staging\.example\.com\/items/);
  assert.deepEqual(ticket.acceptanceCriteria, [
    'Shows one row per item',
    'When there are no items, show an empty state with a create button',
    'Show a skeleton while the list is loading',
    'If the request fails, show an error banner with Retry',
  ]);
  assert.deepEqual(ticket.expectedBehaviors.map((b) => [b.acRef, b.state]), [['AC-1', null], ['AC-2', 'empty'], ['AC-3', 'loading'], ['AC-4', 'error']]);
  assert.deepEqual(ticket.figmaUrls, [
    'https://www.figma.com/design/AbCdEf123456/Items?node-id=1-2',
    'https://www.figma.com/design/OtherKey1/Spec?node-id=3-4',
  ]);
  assert.deepEqual(ticket.previewUrls, ['https://staging.example.com/items', 'https://items-git-feature-empty.vercel.app']);
  assert.deepEqual(ticket.prUrls, ['https://github.com/acme/web/pull/42']);
  assert.deepEqual(ticket.otherUrls, []);
  assert.deepEqual(ticket.branches, ['feature/items-empty-state']);
  assert.deepEqual(ticket.attachments, [{ filename: 'empty-state.png', url: 'https://example.atlassian.net/rest/api/3/attachment/content/100', mimeType: 'image/png' }]);
  assert.equal(ticket.fetchedAt, '2026-09-23T00:00:00.000Z');
});

async function jiraServer({ status = 200 } = {}) {
  const issue = loadFixture('jira-issue.json');
  return startServer((req, res) => {
    if (status !== 200) return sendJson(res, status, { errorMessages: ['nope'] });
    if (req.method === 'GET' && req.url.startsWith('/rest/api/3/issue/ABC-12/remotelink')) return sendJson(res, 200, []);
    if (req.method === 'GET' && req.url.startsWith('/rest/api/3/issue/ABC-12')) {
      if (req.url.includes('fields=subtasks')) {
        return sendJson(res, 200, { key: 'ABC-12', fields: { subtasks: [{ key: 'ABC-13', fields: { summary: 'DQ-002 — Row padding' } }] } });
      }
      return sendJson(res, 200, issue);
    }
    if (req.method === 'GET' && req.url.startsWith('/rest/api/3/issue/')) return sendJson(res, 404, { errorMessages: ['Issue does not exist'] });
    if (req.method === 'POST' && req.url === '/rest/api/3/issue/ABC-12/comment') return sendJson(res, 201, { id: '10001' });
    if (req.method === 'POST' && req.url === '/rest/api/3/issue') return sendJson(res, 201, { key: 'ABC-99' });
    return sendJson(res, 404, {});
  });
}

const env = (server) => ({ JIRA_BASE_URL: server.url, JIRA_EMAIL: 'qa@example.com', JIRA_API_TOKEN: 'secret-token-value', DESIGN_QA_RETRY_BASE_MS: '5' });

test('jira-fetch CLI: fetches the issue and writes ticket.json (Basic auth, token never printed)', async () => {
  const server = await jiraServer();
  try {
    const dir = tmpDir();
    const res = await run(JIRA, ['--issue', 'abc-12', '--out', dir], { env: env(server) });
    assert.equal(res.code, 0, res.stderr);
    const ticket = JSON.parse(readFileSync(path.join(dir, 'ticket.json'), 'utf8'));
    assert.equal(ticket.key, 'ABC-12');
    assert.equal(ticket.url, `${server.url}/browse/ABC-12`);
    assert.equal(ticket.acceptanceCriteria.length, 4);
    const auth = server.requests[0].headers.authorization;
    assert.equal(auth, `Basic ${Buffer.from('qa@example.com:secret-token-value').toString('base64')}`);
    assert.ok(!res.stdout.includes('secret-token-value') && !res.stderr.includes('secret-token-value'));
    assert.match(res.stdout, /4 acceptance criteria · states: empty, loading, error/);
  } finally {
    await server.close();
  }
});

test('jira-fetch CLI: comments and sub-tasks are dry runs unless --write', async () => {
  const server = await jiraServer();
  try {
    const dir = tmpDir();
    const comment = path.join(dir, 'comment.txt');
    writeFileSync(comment, 'Design QA: FAIL\n\nParity 43%\n');
    const dry = await run(JIRA, ['--issue', 'ABC-12', '--comment', comment], { env: {} });
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /\[dry run\] would add a comment to ABC-12 \(2 paragraph\(s\)\)/);
    assert.equal(server.requests.length, 0, 'a dry run makes no requests and needs no credentials');

    const posted = await run(JIRA, ['--issue', 'ABC-12', '--comment', comment, '--write'], { env: env(server) });
    assert.equal(posted.code, 0, posted.stderr);
    const post = server.requests.find((r) => r.method === 'POST');
    assert.equal(post.url, '/rest/api/3/issue/ABC-12/comment');
    assert.deepEqual(JSON.parse(post.body).body.content.map((c) => c.content[0].text), ['Design QA: FAIL', 'Parity 43%']);

    const plan = path.join(dir, 'fixplan.md');
    writeFileSync(
      plan,
      [
        '# Design QA fix plan — Items',
        '## Debt (2) — log as tickets',
        '- DQ-002 — Row padding (WARNING, style, state with-data) — Use space.4 — evidence: computed/with-data.json',
        '- DQ-004 — Hard-coded grey (DS_CANDIDATE, style, state –) — – — evidence: –',
        '',
        '## Missing states / needs decision',
        '- None',
      ].join('\n'),
    );
    const dryTasks = await run(JIRA, ['--issue', 'ABC-12', '--subtasks', plan], { env: {} });
    assert.equal(dryTasks.code, 0, dryTasks.stderr);
    assert.match(dryTasks.stdout, /would create Sub-task under ABC-12: DQ-002 — Row padding/);
    assert.match(dryTasks.stdout, /would create Sub-task under ABC-12: DQ-004 — Hard-coded grey/);

    const before = server.requests.length;
    const created = await run(JIRA, ['--issue', 'ABC-12', '--subtasks', plan, '--write'], { env: env(server) });
    assert.equal(created.code, 0, created.stderr);
    assert.match(created.stdout, /skip DQ-002: a sub-task already mentions it/);
    const creates = server.requests.slice(before).filter((r) => r.method === 'POST');
    assert.equal(creates.length, 1);
    const fields = JSON.parse(creates[0].body).fields;
    assert.deepEqual(fields.parent, { key: 'ABC-12' });
    assert.deepEqual(fields.project, { key: 'ABC' });
    assert.deepEqual(fields.issuetype, { name: 'Sub-task' });
    assert.equal(fields.summary, 'DQ-004 — Hard-coded grey');
    assert.deepEqual(fields.labels, ['design-qa']);
  } finally {
    await server.close();
  }
});

test('jira-fetch CLI: exit 6 on rejected or missing credentials, 1 for unknown issues, 2 for bad keys', async () => {
  const denied = await jiraServer({ status: 401 });
  try {
    const res = await run(JIRA, ['--issue', 'ABC-12', '--out', tmpDir()], { env: env(denied) });
    assert.equal(res.code, 6);
    assert.match(res.stderr, /rejected the credentials \(HTTP 401\)/);
    assert.ok(!res.stderr.includes('secret-token-value'));
  } finally {
    await denied.close();
  }
  const server = await jiraServer();
  try {
    const missing = await run(JIRA, ['--issue', 'ABC-404', '--out', tmpDir()], { env: env(server) });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /ABC-404 was not found/);
  } finally {
    await server.close();
  }
  const noCreds = await run(JIRA, ['--issue', 'ABC-12', '--out', tmpDir()], { env: { JIRA_BASE_URL: '', JIRA_EMAIL: '', JIRA_API_TOKEN: '' } });
  assert.equal(noCreds.code, 6);
  assert.equal((await run(JIRA, ['--issue', 'not a key', '--out', tmpDir()])).code, 2);
  assert.equal((await run(JIRA, ['--issue', 'ABC-1'])).code, 2, 'nothing to do');
});
