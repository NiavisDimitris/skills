import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { issueBaseUrl, issueFromSaved, remoteLinksFromSaved } from '../skills/design-qa/scripts/lib/ticket-extract.mjs';
import { loadFixture, run, script, sendJson, startServer, tmpDir } from './_helpers.mjs';

const JIRA = script('jira-fetch.mjs');
const REMOTE = [{ id: 1, object: { url: 'https://www.figma.com/design/AbCdEfGhIjKlMnOp/Spec?node-id=27-100', title: 'Figma section' } }];
const envelope = (value) => JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const withoutTime = (t) => ({ ...t, fetchedAt: null });

test('jira-fetch --from-issue: a saved Atlassian MCP issue gives the same ticket.json as the REST fetch', async () => {
  const server = await startServer((req, res) => {
    if (req.url.startsWith('/rest/api/3/issue/ABC-12/remotelink')) return sendJson(res, 200, REMOTE);
    if (req.url.startsWith('/rest/api/3/issue/ABC-12')) return sendJson(res, 200, loadFixture('jira-issue.json'));
    return sendJson(res, 404, {});
  });
  try {
    const restDir = tmpDir();
    const rest = await run(JIRA, ['--issue', 'ABC-12', '--out', restDir], {
      env: { JIRA_BASE_URL: server.url, JIRA_EMAIL: 'qa@example.com', JIRA_API_TOKEN: 'secret-token-value' },
    });
    assert.equal(rest.code, 0, rest.stderr);

    const dir = tmpDir();
    const issueFile = path.join(dir, 'issue.json');
    writeFileSync(issueFile, envelope(loadFixture('jira-issue.json')));
    const linksFile = path.join(dir, 'links.json');
    writeFileSync(linksFile, JSON.stringify(REMOTE));
    const mcp = await run(JIRA, ['--from-issue', issueFile, '--remote-links', linksFile, '--site', server.url, '--issue', 'abc-12', '--out', dir], {
      env: { JIRA_BASE_URL: '', JIRA_EMAIL: '', JIRA_API_TOKEN: '' },
    });
    assert.equal(mcp.code, 0, mcp.stderr);
    assert.match(mcp.stdout, /ABC-12: Items list: empty and error states \[In Review\]/);
    const fromRest = JSON.parse(readFileSync(path.join(restDir, 'ticket.json'), 'utf8'));
    const fromMcp = JSON.parse(readFileSync(path.join(dir, 'ticket.json'), 'utf8'));
    assert.deepEqual(withoutTime(fromMcp), withoutTime(fromRest));
    assert.deepEqual(fromMcp.figmaUrls, [
      'https://www.figma.com/design/AbCdEf123456/Items?node-id=1-2',
      'https://www.figma.com/design/AbCdEfGhIjKlMnOp/Spec?node-id=27-100',
    ], 'Figma links from the description and the remote links, node ids kept');
  } finally {
    await server.close();
  }
});

test('jira-fetch --from-issue: the site comes from "self"; bad input is a usage error; no credentials needed', async () => {
  const dir = tmpDir();
  const issue = { ...loadFixture('jira-issue.json'), self: 'https://acme.atlassian.net/rest/api/3/issue/10001' };
  const file = path.join(dir, 'issue.json');
  writeFileSync(file, JSON.stringify({ issues: [issue] }));
  const res = await run(JIRA, ['--from-issue', file, '--out', dir]);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'ticket.json'), 'utf8')).url, 'https://acme.atlassian.net/browse/ABC-12');

  const junk = path.join(dir, 'junk.json');
  writeFileSync(junk, '{"content":[{"type":"text","text":"Issue not found"}]}');
  const bad = await run(JIRA, ['--from-issue', junk, '--out', dir]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /holds no Jira issue \(expected the getJiraIssue result/);
  assert.match((await run(JIRA, ['--from-issue', file, '--issue', 'ABC-99', '--out', dir])).stderr, /does not match the saved issue ABC-12/);
  assert.equal((await run(JIRA, ['--from-issue', file, '--out', dir, '--write'])).code, 2);
  assert.equal((await run(JIRA, ['--from-issue', file])).code, 2, '--out is required');
  assert.equal((await run(JIRA, ['--from-issue', file, '--out', dir, '--site', 'http://acme.example.com'])).code, 2, '--site must be https');
});

test('jira-fetch --issue without credentials says in one line to use the MCP path', async () => {
  const res = await run(JIRA, ['--issue', 'ABC-12', '--out', tmpDir()], { env: { JIRA_BASE_URL: '', JIRA_EMAIL: '', JIRA_API_TOKEN: '' } });
  assert.equal(res.code, 6);
  assert.equal(res.stderr.trim().split('\n').length, 1);
  assert.match(res.stderr, /no Jira credentials \(JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN not set\): read the issue with the Atlassian MCP \(getJiraIssue\) and run --from-issue <saved\.json> --out <dir>/);
});

test('issueFromSaved / remoteLinksFromSaved / issueBaseUrl unwrap what MCP hosts save', () => {
  const issue = { key: 'ABC-1', fields: { summary: 'x' } };
  assert.deepEqual(issueFromSaved(JSON.stringify(issue)), issue);
  assert.deepEqual(issueFromSaved(JSON.stringify(JSON.stringify({ issue }))), issue);
  assert.deepEqual(issueFromSaved(envelope(issue)), issue);
  assert.throws(() => issueFromSaved('not json'), /holds no Jira issue/);
  assert.deepEqual(remoteLinksFromSaved(envelope(REMOTE)), REMOTE);
  assert.throws(() => remoteLinksFromSaved('{}'), /no list of remote links/);
  assert.equal(issueBaseUrl({ self: 'https://acme.atlassian.net/rest/api/3/issue/1' }), 'https://acme.atlassian.net');
  assert.equal(issueBaseUrl({ self: 'http://acme.atlassian.net/x' }), null);
  assert.equal(issueBaseUrl({}), null);
});
