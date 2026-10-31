import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildRunResult } from '../skills/design-qa/scripts/lib/run-result.mjs';
import { buildPayload, consentFile, sendPayload, telemetryState, telemetryUrl } from '../skills/design-qa/scripts/lib/telemetry.mjs';
import { loadFixture, run, script, tmpDir } from './_helpers.mjs';

const TELEMETRY = script('telemetry.mjs');
const ALLOWED_KEYS = ['v', 'plugin_version', 'runs', 'issues_by_type', 'fixed', 'dismissed'];
const SECRETS = ['acme-secret-repo', 'feat/top-secret', '/Users/alice/work', 'alice@example.com', 'deadbeefcafe', 'Checkout Screen', '.secret-selector', 'Secret Layer/Name', 'Confidential title'];

/** A run result whose every free-text field carries something that must never leave the machine. */
function leakyResult() {
  const report = loadFixture('../../examples/sample/sample-report.json');
  for (const [n, f] of report.findings.entries()) {
    f.title = `${SECRETS[8]} ${n}`;
    f.region = SECRETS[5];
    f.element = { selector: SECRETS[6], figmaLayerPath: SECRETS[7] };
    f.screen = 'checkout-screen';
    f.state = `checkout-screen/${f.state}`;
    if (f.actual?.source) f.actual.source.file = `${SECRETS[2]}/src/Card.tsx`;
  }
  report.meta.feature = SECRETS[0];
  return buildRunResult(report, { context: { repo: `${SECRETS[0]}/web`, branch: SECRETS[1], commit_sha: SECRETS[4], pr_number: 99 } }).result;
}

const env = (dir, extra = {}) => ({ XDG_CONFIG_HOME: dir, HOME: dir, DO_NOT_TRACK: '', DESIGN_QA_TELEMETRY: '', DESIGN_QA_TELEMETRY_URL: '', ...extra });

test('the payload holds only the allowed keys, counts and the version', () => {
  const result = leakyResult();
  const payload = buildPayload(result, '0.3.0');
  assert.deepEqual(Object.keys(payload).sort(), [...ALLOWED_KEYS].sort());
  assert.equal(payload.v, 1);
  assert.equal(payload.runs, 1);
  assert.equal(payload.plugin_version, '0.3.0');
  for (const [k, v] of Object.entries(payload.issues_by_type)) {
    assert.match(k, /^[a-z-]+$/);
    assert.ok(Number.isInteger(v) && v >= 0);
  }
  assert.equal(Object.values(payload.issues_by_type).reduce((a, b) => a + b, 0), result.totals.flagged);
  const text = JSON.stringify(payload);
  for (const s of [...SECRETS, 'checkout', 'iss_', 'DQ-', result.run_id]) assert.ok(!text.includes(s), `payload leaks ${s}`);
});

test('the payload ignores unknown categories and odd versions', () => {
  const payload = buildPayload({ issues: [{ status: 'open', category: '/etc/passwd' }], diff: { fixed: ['a'], dismissed: [] } }, 'v1; rm -rf /');
  assert.deepEqual(payload.issues_by_type, {});
  assert.equal(payload.plugin_version, 'unknown');
  assert.equal(payload.fixed, 1);
});

test('state: off until decided; DO_NOT_TRACK and DESIGN_QA_TELEMETRY=0 always win', () => {
  const dir = tmpDir();
  assert.deepEqual(telemetryState(env(dir)), { enabled: false, reason: 'undecided' });
  writeFileSync(path.join(dir, 'x'), '');
  const file = consentFile(env(dir));
  assert.equal(file, path.join(dir, 'design-qa', 'telemetry.json'));
  assert.deepEqual(telemetryState(env(dir, { DESIGN_QA_TELEMETRY: '1' })), { enabled: true, reason: 'env-on' });
  assert.deepEqual(telemetryState(env(dir, { DESIGN_QA_TELEMETRY: '1', DO_NOT_TRACK: '1' })), { enabled: false, reason: 'do-not-track' });
  assert.deepEqual(telemetryState(env(dir, { DO_NOT_TRACK: '0' })), { enabled: false, reason: 'undecided' });
});

test('only https endpoints are used', () => {
  assert.equal(telemetryUrl({ DESIGN_QA_TELEMETRY_URL: 'http://example.com/t' }), null);
  assert.equal(telemetryUrl({ DESIGN_QA_TELEMETRY_URL: 'not a url' }), null);
  assert.equal(telemetryUrl({ DESIGN_QA_TELEMETRY_URL: 'https://x.supabase.co/functions/v1/telemetry-ingest' }), 'https://x.supabase.co/functions/v1/telemetry-ingest');
});

test('sendPayload posts only the JSON body and never throws', async () => {
  const calls = [];
  const ok = await sendPayload({ v: 1 }, 'https://t.example/ingest', async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 202, statusText: 'Accepted' };
  });
  assert.equal(ok.sent, true);
  assert.deepEqual(Object.keys(calls[0].init.headers), ['Content-Type']);
  assert.equal(calls[0].init.body, '{"v":1}');
  const down = await sendPayload({ v: 1 }, 'https://t.example/ingest', async () => {
    throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
  });
  assert.deepEqual(down, { sent: false, reason: 'cannot reach t.example: ECONNREFUSED' });
});

test('CLI: status, enable, disable round-trip through the consent file', async () => {
  const dir = tmpDir();
  assert.match((await run(TELEMETRY, ['status'], { env: env(dir) })).stdout, /^undecided/);
  assert.equal((await run(TELEMETRY, ['enable'], { env: env(dir) })).code, 0);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'design-qa', 'telemetry.json'), 'utf8')).enabled, true);
  assert.match((await run(TELEMETRY, ['status'], { env: env(dir) })).stdout, /^enabled/);
  assert.match((await run(TELEMETRY, ['status'], { env: env(dir, { DO_NOT_TRACK: '1' }) })).stdout, /^do-not-track/);
  await run(TELEMETRY, ['disable'], { env: env(dir) });
  assert.match((await run(TELEMETRY, ['status'], { env: env(dir) })).stdout, /^disabled/);
});

test('CLI send: never fails a run, and sends nothing unless enabled with an endpoint', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'run-result.json');
  writeFileSync(file, JSON.stringify(leakyResult()));
  const undecided = await run(TELEMETRY, ['send', '--result', file], { env: env(dir, { DESIGN_QA_TELEMETRY_URL: 'https://127.0.0.1:1/x' }) });
  assert.equal(undecided.code, 0);
  assert.match(undecided.stdout, /not sent: undecided/);

  await run(TELEMETRY, ['enable'], { env: env(dir) });
  const noEndpoint = await run(TELEMETRY, ['send', '--result', file], { env: env(dir) });
  assert.match(noEndpoint.stdout, /no endpoint/);
  const unreachable = await run(TELEMETRY, ['send', '--result', file], { env: env(dir, { DESIGN_QA_TELEMETRY_URL: 'https://127.0.0.1:1/x' }) });
  assert.equal(unreachable.code, 0);
  assert.match(unreachable.stdout, /not sent: cannot reach/);

  const printed = await run(TELEMETRY, ['print', '--result', file], { env: env(dir) });
  assert.deepEqual(Object.keys(JSON.parse(printed.stdout)).sort(), [...ALLOWED_KEYS].sort());
  for (const s of SECRETS) assert.ok(!printed.stdout.includes(s));
});

test('CLI: bad commands exit 2', async () => {
  const dir = tmpDir();
  assert.equal((await run(TELEMETRY, [], { env: env(dir) })).code, 2);
  assert.equal((await run(TELEMETRY, ['upload'], { env: env(dir) })).code, 2);
  assert.equal((await run(TELEMETRY, ['send'], { env: env(dir) })).code, 2);
});
