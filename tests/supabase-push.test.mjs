import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildRunResult } from '../skills/design-qa/scripts/lib/run-result.mjs';
import { rowsFor, supabaseConfig } from '../skills/design-qa/scripts/lib/supabase.mjs';
import { loadFixture, run, script, sendJson, startServer, tmpDir } from './_helpers.mjs';

const PUSH = script('supabase-push.mjs');
const KEY = 'test-service-role-key-not-real';

function resultFile() {
  const { result } = buildRunResult(loadFixture('../../examples/sample/sample-report.json'), {
    context: { repo: 'acme/web', branch: 'feat/x', commit_sha: 'abc1234', pr_number: 3 },
  });
  const file = path.join(tmpDir(), 'run-result.json');
  writeFileSync(file, JSON.stringify(result));
  return { file, result };
}

test('rows: one run row, one issue row per issue', () => {
  const { result } = resultFile();
  const { run: r, issues } = rowsFor(result);
  assert.equal(r.run_id, result.run_id);
  assert.equal(r.flagged, result.totals.flagged);
  assert.equal(issues.length, result.issues.length);
  assert.ok(issues.every((i) => i.run_id === result.run_id && typeof i.carried === 'boolean'));
});

test('config: env only, https unless localhost, errors name what is missing', () => {
  assert.throws(() => supabaseConfig({}), /set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/);
  assert.throws(() => supabaseConfig({ SUPABASE_URL: 'http://evil.example.com', SUPABASE_SERVICE_ROLE_KEY: 'k' }), /must use https/);
  assert.deepEqual(supabaseConfig({ SUPABASE_URL: 'https://p.supabase.co/', SUPABASE_SECRET_KEY: 'k' }), { url: 'https://p.supabase.co', key: 'k' });
});

test('CLI: upserts runs then issues with the key in headers, idempotently', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(201);
    res.end();
  });
  try {
    const { file, result } = resultFile();
    const res = await run(PUSH, ['--result', file], { env: { SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: KEY } });
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(
      server.requests.map((r) => r.url),
      ['/rest/v1/design_qa_runs?on_conflict=run_id', '/rest/v1/design_qa_issues?on_conflict=run_id%2Cissue_id'],
    );
    for (const r of server.requests) {
      assert.equal(r.headers.apikey, KEY);
      assert.equal(r.headers.authorization, `Bearer ${KEY}`);
      assert.match(r.headers.prefer, /resolution=merge-duplicates/);
    }
    assert.equal(JSON.parse(server.requests[1].body).length, result.issues.length);
    assert.ok(!res.stdout.includes(KEY) && !res.stderr.includes(KEY));
  } finally {
    await server.close();
  }
});

test('CLI: a refusal names the HTTP status and PostgREST message, never the key', async () => {
  const server = await startServer((req, res) => sendJson(res, 404, { message: 'relation "public.design_qa_runs" does not exist' }));
  try {
    const { file } = resultFile();
    const res = await run(PUSH, ['--result', file], { env: { SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: KEY } });
    assert.equal(res.code, 1);
    assert.match(res.stderr, /HTTP 404 .*does not exist.*migration/);
    assert.ok(!res.stderr.includes(KEY));
  } finally {
    await server.close();
  }
});

test('CLI: missing credentials exit 2; --dry-run needs none', async () => {
  const { file } = resultFile();
  const env = { SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_SECRET_KEY: '' };
  const missing = await run(PUSH, ['--result', file], { env });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /Supabase is not configured/);
  const dry = await run(PUSH, ['--result', file, '--dry-run'], { env });
  assert.equal(dry.code, 0, dry.stderr);
  assert.ok(JSON.parse(dry.stdout).design_qa_runs.length === 1);
});
