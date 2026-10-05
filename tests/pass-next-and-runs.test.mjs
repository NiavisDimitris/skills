// Every printed Next: runs as printed (sh -c); the CI gate checks the report it reads; one run
// never acts on another run's folder (status, --resume, writes without --run, a review server,
// dismissals); secrets never reach a printed command or the tracked config.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { applyPriorDismissals } from '../skills/design-qa/scripts/lib/dismissals.mjs';
import { fixture, run, script, startServer, tmpDir } from './_helpers.mjs';

const PASS = script('pass.mjs');
const ENV = { DESIGN_QA_RUN_ID: '', FIGMA_TOKEN: '', DESIGN_QA_APP_STORAGE_STATE: '', DESIGN_QA_NO_DISPLAY: '1', CI: '1' };
const pass = (cwd, args, env = {}) => run(PASS, args, { cwd, env: { ...ENV, ...env }, timeout: 240000 });
const sh = (cwd, line, env = {}) =>
  new Promise((resolve) => {
    const child = spawn('sh', ['-c', line], { cwd, env: { ...process.env, NO_COLOR: '1', ...ENV, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
const nextCmd = (out) => (out.trim().split('\n').filter((l) => l.startsWith('Next: ')).pop() ?? '').replace(/^Next: /, '');
const doLines = (out) => out.trim().split('\n').filter((l) => l.startsWith('Do: ')).join('\n');
const runIdOf = (out) => /Run id: (\S+)/.exec(out)?.[1];
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
const LOCK = (runId, extra = {}) => JSON.stringify({ kind: 'design-qa-run', version: 1, runId, label: null, status: 'active', startedAt: new Date().toISOString(), finishedAt: null, ...extra });

async function chromiumLaunches() {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}
const CHROMIUM = await chromiumLaunches();

function project(t, config = null) {
  const root = tmpDir('design-qa-next-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (config) writeFileSync(path.join(root, 'design-qa.config.json'), JSON.stringify(config));
  return root;
}

test('gate: a report edited by hand fails the check; the verdict is read only from a report validate.mjs accepts', async (t) => {
  const root = project(t);
  const dir = path.join(root, 'qa-reports', 'abc-1');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'report.json');
  copyFileSync(fixture('report-valid.json'), file);
  const ok = await pass(root, ['gate', '--dir', 'qa-reports/abc-1']);
  assert.match(ok.stdout, /^design-qa: (PASS|REVIEW|FAIL|INCOMPLETE) · /);
  const edited = read(file);
  edited.findings = [];
  edited.scorecard.verdict = 'PASS';
  writeFileSync(file, JSON.stringify(edited));
  const bad = await pass(root, ['gate', '--dir', 'qa-reports/abc-1']);
  assert.equal(bad.code, 4, bad.stdout);
  assert.match(bad.stdout, /^design-qa: report\.json is not the report the build makes from the evidence and findings\.json \(\d+ problems?; first: .*\): run pass\.mjs report again · fails the check$/m);
  // Build verification on: the fixture was not built from findings.json and evidence, so it fails too.
  copyFileSync(fixture('report-valid.json'), file);
  const unbuilt = await pass(root, ['gate', '--dir', 'qa-reports/abc-1', '--json'], { DESIGN_QA_TEST_SKIP_BUILD_VERIFY: '' });
  assert.equal(unbuilt.code, 4);
  assert.equal(JSON.parse(unbuilt.stdout).valid, false);
});

test('status: the holder\'s run id is printed only to the holder; following it as another run starts a pass of its own', async (t) => {
  const root = project(t, { app: { baseUrl: 'http://127.0.0.1:9' }, report: { commit: false } });
  const s = await pass(root, ['start', '--feature', 'abc-2', '--prototype', 'http://127.0.0.1:9/proto', '--agent', 'figma-mcp=no', '--agent', 'ticket-mcp=no', '--quick']);
  const id = runIdOf(s.stdout);
  assert.ok(id, s.stdout + s.stderr);
  const other = await pass(root, ['status', '--dir', 'qa-reports/abc-2']);
  assert.doesNotMatch(other.stdout, new RegExp(id));
  assert.match(doLines(other.stdout), /belongs to another run/);
  const r = await sh(root, `${nextCmd(other.stdout)} --quick`);
  assert.ok([0, 3].includes(r.code), r.stdout + r.stderr);
  assert.notEqual(runIdOf(r.stdout), id);
  assert.equal(read(path.join(root, 'qa-reports', 'abc-2', '.design-qa-run.json')).runId, id, 'the holder keeps its folder');
  const own = await pass(root, ['status', '--dir', 'qa-reports/abc-2', '--run', id]);
  assert.match(nextCmd(own.stdout), new RegExp(`--run ${id}$`));
  // A locked folder without pass.json: the same.
  const sib = '20261004T120000Z-abcdef';
  const sdir = path.join(root, 'qa-reports', 'abc-3');
  mkdirSync(sdir, { recursive: true });
  writeFileSync(path.join(sdir, '.design-qa-run.json'), LOCK(sib));
  const bare = await pass(root, ['status', '--dir', 'qa-reports/abc-3']);
  assert.doesNotMatch(bare.stdout, new RegExp(sib));
  assert.match(nextCmd(bare.stdout), /pass\.mjs start --feature abc-3$/);
});

test('writes without --run: refused while the run is open (dismiss, worklist); worklist takes --run; a dry run needs none', async (t) => {
  const root = project(t);
  const dir = path.join(root, 'qa-reports', 'abc-4');
  mkdirSync(dir, { recursive: true });
  copyFileSync(fixture('report-valid.json'), path.join(dir, 'report.json'));
  const held = '20261004T113201Z-a1b2c3';
  writeFileSync(path.join(dir, '.design-qa-run.json'), LOCK(held));
  const args = ['--report', path.join(dir, 'report.json'), '--id', 'DQ-002', '--kind', 'not-an-issue', '--reason', 'noise'];
  const anon = await run(script('dismiss.mjs'), args, { env: ENV });
  assert.equal(anon.code, 5, anon.stderr);
  assert.doesNotMatch(anon.stderr, new RegExp(held));
  assert.equal(existsSync(path.join(root, 'qa-reports', 'dismissed.json')), false, 'no lasting dismissal');
  assert.equal((await run(script('dismiss.mjs'), [...args, '--dry-run'], { env: ENV })).code, 0, 'a dry run writes nothing');
  const mine = await run(script('dismiss.mjs'), [...args, '--run', held], { env: ENV });
  assert.equal(mine.code, 0, mine.stderr);
  const render = /^Next: (.+)$/m.exec(mine.stdout)[1];
  assert.match(render, new RegExp(`--recompute --write-back --run ${held}$`), 'the printed render carries the run');
  for (const extra of [[], ['--run', '20261004T113202Z-bbbbbb']]) {
    const w = await run(script('worklist.mjs'), ['--dir', dir, ...extra], { env: ENV });
    assert.equal(w.code, 5, w.stderr);
  }
  assert.match((await run(script('worklist.mjs'), ['--help'])).stdout, /--run <id>/);
});

test('dismissals: an entry with no values never hides a different finding on the same element', () => {
  const entry = { id: 'DS-0001', feature: 'Orders', fingerprint: 'structure|with-data|.row|', ledger: 'structure', property: null, title: 'Row badge missing', expectedValue: null, actualValue: null, kind: 'not-an-issue', reason: 'Badge comes later.', by: null, date: '2026-10-01T10:00:00Z', status: 'active' };
  const finding = (title) => ({ id: 'DQ-001', ledger: 'structure', state: 'with-data', severity: 'WARNING', resolution: 'FIX_CODE', element: { selector: '.row' }, property: null, title, expected: null, actual: null });
  const report = (title) => ({ meta: { feature: 'Orders' }, findings: [finding(title)] });
  assert.equal(applyPriorDismissals(report('Row badge missing'), { entries: [entry] }).applied.length, 1, 'the same finding again');
  assert.equal(applyPriorDismissals(report('Row is not clickable'), { entries: [entry] }).applied.length, 0, 'another finding on the same element');
  assert.equal(applyPriorDismissals(report('Row badge missing'), { entries: [{ ...entry, ledger: 'style' }] }).applied.length, 0, 'another ledger as recorded');
});

test('start: first run with --url and questions chains apply with --url; sign-in chains apply, save-session --url, start', async (t) => {
  const root = project(t);
  const s = await pass(root, ['start', '--feature', 'abc-5', '--url', 'http://127.0.0.1:9/profile', '--prototype', 'http://127.0.0.1:9/proto', '--agent', 'figma-mcp=no', '--agent', 'ticket-mcp=no', '--quick']);
  assert.equal(s.code, 3, s.stdout + s.stderr);
  const cmd = nextCmd(s.stdout);
  assert.match(cmd, /setup\.mjs apply --accept-assumed .*--url http:\/\/127\.0\.0\.1:9\/profile --no-next && /);
  mkdirSync(path.join(root, 'qa-reports', 'abc-5'), { recursive: true });
  writeFileSync(path.join(root, 'qa-reports', 'abc-5', 'answers.json'), JSON.stringify({ 'ds-components': ['none'] }));
  const r = await sh(root, cmd);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(existsSync(path.join(root, 'design-qa.config.json')));
  assert.equal(runIdOf(r.stdout), runIdOf(s.stdout), 'the same run continues');

  const server = await startServer((req, res) => {
    if (!req.url.startsWith('/login')) {
      res.writeHead(302, { location: '/login?next=/profile' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Sign in</title><form><input name="email"><input type="password" name="password"><button>Sign in</button></form>');
  });
  t.after(() => server.close());
  const fresh = project(t);
  const si = await pass(fresh, ['start', '--feature', 'abc-6', '--url', `${server.url}/profile`, '--prototype', `${server.url}/proto`, '--agent', 'figma-mcp=no', '--agent', 'ticket-mcp=no']);
  assert.equal(si.code, 3, si.stdout + si.stderr);
  const parts = nextCmd(si.stdout).split(' && ');
  assert.equal(parts.length, 3, nextCmd(si.stdout));
  // The other questions are asked in the same stop: the chained apply saves their answers too.
  assert.match(si.stdout, /^Question \(ds-components\): /m);
  assert.match(parts[0], /setup\.mjs apply --accept-assumed --answers qa-reports\/abc-6\/answers\.json --url \S+\/profile --no-next$/);
  assert.match(parts[1], /setup\.mjs save-session --url \S+\/profile$/);
  assert.match(parts[2], /pass\.mjs start --feature abc-6 --dir qa-reports\/abc-6 /);
  assert.doesNotMatch(si.stdout, /--agent signed-in-element/, 'only checks --agent takes');
  writeFileSync(path.join(fresh, 'qa-reports', 'abc-6', 'answers.json'), JSON.stringify({ 'ds-components': ['none'] }));
  const applied = await sh(fresh, parts[0]);
  assert.equal(applied.code, 0, applied.stdout + applied.stderr);
});

test('a secret URL is never printed: a failing start prints "${DESIGN_QA_URL}" and a Do: line; set, the command runs', async (t) => {
  const root = project(t, { app: { baseUrl: 'http://127.0.0.1:9' }, report: { commit: false } });
  const s = await pass(root, ['start', '--feature', 'abc-7', '--prototype', 'http://127.0.0.1:9/proto', '--agent', 'figma-mcp=no', '--agent', 'ticket-mcp=no', '--quick']);
  const id = runIdOf(s.stdout);
  const priv = path.join(root, 'qa-reports', 'abc-7', '.design-qa-pass-private.json');
  rmSync(priv, { force: true });
  symlinkSync(path.join(root, 'nowhere.json'), priv);
  const url = 'http://127.0.0.1:9/profile?token=s3cr3tValue0123456789';
  const failed = await pass(root, ['start', '--feature', 'abc-7', '--dir', 'qa-reports/abc-7', '--run', id, '--url', url, '--quick']);
  assert.equal(failed.code, 1, failed.stdout + failed.stderr);
  assert.doesNotMatch(failed.stdout + failed.stderr, /s3cr3tValue/);
  assert.match(doLines(failed.stdout), /Set DESIGN_QA_URL in the shell that runs the next command/);
  const cmd = nextCmd(failed.stdout);
  assert.match(cmd, /--url "\$\{DESIGN_QA_URL\}"/);
  rmSync(priv);
  const r = await sh(root, cmd, { DESIGN_QA_URL: url });
  assert.ok([0, 3].includes(r.code), r.stdout + r.stderr);
  assert.equal(runIdOf(r.stdout), id);
  assert.doesNotMatch(r.stdout, /s3cr3tValue/);
});

test('design unknown: the restart keeps --dir, --agent, --ticket and --url; with the link set it takes the MCP path', async (t) => {
  const root = project(t, { app: { baseUrl: 'http://127.0.0.1:9' }, surfaces: {}, report: { commit: false }, designSystem: { tokens: [], libraries: [] } });
  const s = await pass(root, ['start', '--feature', 'abc-8', '--url', 'http://127.0.0.1:9/orders', '--ticket', 'ABC-8', '--agent', 'figma-mcp=yes', '--agent', 'ticket-mcp=no', '--quick']);
  assert.equal(s.code, 0, s.stdout + s.stderr);
  assert.match(s.stdout, /^Design: unknown$/m);
  const cmd = nextCmd(s.stdout);
  for (const part of ['--dir qa-reports/abc-8', '--url http://127.0.0.1:9/orders', '--design "${DESIGN_QA_DESIGN_URL}"', '--ticket ABC-8', '--agent figma-mcp=yes', '--agent ticket-mcp=no', `--run ${runIdOf(s.stdout)}`]) assert.ok(cmd.includes(part), `${part} in ${cmd}`);
  const r = await sh(root, cmd, { DESIGN_QA_DESIGN_URL: 'https://www.figma.com/design/AbCdEf123/Acme?node-id=12-300' });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(nextCmd(r.stdout), /figma-mcp-spec\.mjs --metadata qa-reports\/abc-8\/evidence\/metadata\.xml /);
  assert.deepEqual(readdirSync(path.join(root, 'qa-reports')), ['abc-8'], 'the same folder');
});

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>Plain</title><style>body{margin:0;font:16px Arial}h1{margin:24px}</style></head><body><h1>Profile</h1><p style="margin:24px">Nothing to see.</p></body></html>';

test('skipped audit: evidence says why and how to turn it on, status moves on; --resume by the same label builds its own report, another label is refused', { timeout: 300000 }, async (t) => {
  if (!CHROMIUM) return t.skip('Chromium is not installed (run `npx playwright install chromium`)');
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  t.after(() => server.close());
  const root = project(t, { app: { baseUrl: server.url }, surfaces: { profile: { route: '/profile', prototype: `${server.url}/proto` } }, designSystem: { libraries: [] }, report: { commit: false } });
  const rel = 'qa-reports/abc-9';
  const dir = path.join(root, rel);
  const s = await pass(root, ['start', '--feature', 'abc-9', '--label', 'agent-a', '--agent', 'figma-mcp=no', '--agent', 'ticket-mcp=no', '--quick']);
  const id = runIdOf(s.stdout);
  const e = await pass(root, ['evidence', '--dir', rel, '--run', id]);
  assert.equal(e.code, 0, e.stdout + e.stderr);
  const skipped = /^Design-system audit skipped: (.+)$/m.exec(e.stdout);
  assert.ok(skipped && !skipped[1].endsWith('…'), e.stdout);
  assert.equal(skipped[1], read(path.join(dir, 'evidence', 'ds-audit.json')).skipped.reason, 'the reason in full');
  assert.match(doLines(e.stdout), /^Do: Turn it on: /m);
  const st = await pass(root, ['status', '--dir', rel, '--run', id]);
  assert.match(st.stdout, /evidence\s+up to date/);
  assert.match(nextCmd(st.stdout), /pass\.mjs report --dir qa-reports\/abc-9 --run \S+ --check$/, 'a recorded skip, not a missing step');
  writeFileSync(path.join(dir, 'findings.json'), JSON.stringify({ kind: 'design-qa-findings', version: 1, findings: [] }));
  const r1 = await pass(root, ['report', '--dir', rel, '--run', id]);
  assert.equal(r1.code, 0, r1.stdout + r1.stderr);
  assert.match(r1.stdout, /^Design system mismatches: token: not checked \(.+\) · component: not checked \(.+\) · 0 motion$/m);

  // The run is abandoned (idle 0): only its own agent may continue it.
  const idle = { DESIGN_QA_RUN_IDLE_MIN: '0' };
  const refused = await pass(root, ['start', '--feature', 'abc-9', '--resume', '--label', 'agent-b', '--agent', 'figma-mcp=no', '--agent', 'ticket-mcp=no', '--quick'], idle);
  assert.equal(refused.code, 5, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /--resume continues a pass only for the agent that started it/);
  assert.doesNotMatch(nextCmd(refused.stdout), /--resume/);
  assert.equal(read(path.join(dir, '.design-qa-run.json')).runId, id, 'nothing changed');
  const resumed = await pass(root, ['start', '--feature', 'abc-9', '--resume', '--label', 'agent-a', '--agent', 'figma-mcp=no', '--agent', 'ticket-mcp=no', '--quick'], idle);
  assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
  const id2 = runIdOf(resumed.stdout);
  assert.notEqual(id2, id);
  assert.equal(read(path.join(dir, 'pass.json')).resumedFrom.runId, id);
  assert.ok(existsSync(path.join(dir, 'logs', `report.${id}.json`)), 'the earlier run\'s report is kept aside');
  const r2 = await pass(root, ['report', '--dir', rel, '--run', id2]);
  assert.equal(r2.code, 0, r2.stdout + r2.stderr);
  assert.equal(read(path.join(dir, 'report.json')).meta.runId, id2);
  const st2 = await pass(root, ['status', '--dir', rel, '--run', id2]);
  assert.doesNotMatch(nextCmd(st2.stdout), /pass\.mjs report /, 'no report loop');
  // Another agent, as printed: a fresh pass that inherits nothing.
  const fresh = await sh(root, nextCmd(refused.stdout), idle);
  assert.ok([0, 3].includes(fresh.code), fresh.stdout + fresh.stderr);
  assert.match(fresh.stdout, /^Report folder: qa-reports\/abc-9 \(new; the earlier pass was moved to archive\/\)$/m);
});
