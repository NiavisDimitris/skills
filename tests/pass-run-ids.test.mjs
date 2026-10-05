// Run ownership (--run <id> / DESIGN_QA_RUN_ID) in the scripts that write into a report
// folder: another run's folder is refused with exit 5 and left exactly as it was, and so is
// a call without a run id while the run is not finished; with the folder's own id, or no id
// once the run finished, every script works as before.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPng, writePng } from '../skills/design-qa/scripts/lib/png.mjs';
import { fixture, loadFixture, run, script, startServer, tmpDir } from './_helpers.mjs';

const RUN_A = '20261004T113201Z-a1b2c3';
const RUN_B = '20261004T113202Z-bbbbbb';
const TEMPLATE = fixture('template.html');
const NO_ENV = { DESIGN_QA_RUN_ID: '' };

const LOCK = { kind: 'design-qa-run', version: 1, runId: RUN_A, label: null, status: 'active', startedAt: '2026-10-04T11:32:01Z', finishedAt: null };

/** <root>/qa-reports/acme/ locked by run A, holding report.json. */
function lockedFolder(report = loadFixture('report-valid.json')) {
  const root = tmpDir();
  const dir = path.join(root, 'qa-reports', 'acme');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '.design-qa-run.json'), JSON.stringify(LOCK, null, 2));
  const reportFile = path.join(dir, 'report.json');
  writeFileSync(reportFile, JSON.stringify(report, null, 2));
  return { root, dir, reportFile };
}

/** Every file under `root` with its content: equal snapshots mean nothing was written. */
function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[path.relative(root, full)] = readFileSync(full).toString('base64');
    }
  };
  walk(root);
  return out;
}

/** The call with run B (flag or env), or with no id, exits 5 and changes nothing; with run A, or no id once A finished, it works. */
async function assertOwnership(name, setup, args, { okCode = 0, check } = {}) {
  const refused = setup();
  const before = snapshot(refused.root);
  const byFlag = await run(script(name), [...args(refused), '--run', RUN_B], { env: NO_ENV });
  assert.equal(byFlag.code, 5, `${name} --run B: ${byFlag.stderr}`);
  assert.match(byFlag.stderr, new RegExp(`belongs to run ${RUN_A}.*you are run ${RUN_B}`));
  const byEnv = await run(script(name), args(refused), { env: { DESIGN_QA_RUN_ID: RUN_B } });
  assert.equal(byEnv.code, 5, `${name} DESIGN_QA_RUN_ID=B: ${byEnv.stderr}`);
  assert.deepEqual(snapshot(refused.root), before, `${name}: nothing written for another run`);

  const plain = setup();
  const untouched = snapshot(plain.root);
  const res = await run(script(name), args(plain), { env: NO_ENV });
  assert.equal(res.code, 5, `${name} without a run id: ${res.stderr}`);
  assert.doesNotMatch(res.stderr, new RegExp(RUN_A), 'the holder\'s id is never printed');
  assert.deepEqual(snapshot(plain.root), untouched, `${name}: nothing written without a run id`);
  const done = setup();
  writeFileSync(path.join(done.dir, '.design-qa-run.json'), JSON.stringify({ ...LOCK, status: 'finished', finishedAt: '2026-10-04T12:00:00Z' }));
  const after = await run(script(name), args(done), { env: NO_ENV });
  assert.equal(after.code, okCode, `${name} without a run id after the run finished: ${after.stderr}`);
  check?.(done, after);
  const own = setup();
  const mine = await run(script(name), [...args(own), '--run', RUN_A], { env: NO_ENV });
  assert.equal(mine.code, okCode, `${name} --run A: ${mine.stderr}`);
  check?.(own, mine);
}

test('triage.mjs: another run (or no id while the run is open) is refused (exit 5); the own id still triages', async () => {
  await assertOwnership('triage.mjs', () => lockedFolder(), (f) => ['--report', f.reportFile, '--fix', 'none'], {
    check: (f) => assert.ok(JSON.parse(readFileSync(f.reportFile, 'utf8')).triage),
  });
});

test('dismiss.mjs: another run is refused (exit 5), the dismissed log is not written', async () => {
  await assertOwnership('dismiss.mjs', () => lockedFolder(), (f) => ['--report', f.reportFile, '--id', 'DQ-002', '--kind', 'not-an-issue', '--reason', 'noise', '--quiet'], {
    check: (f) => assert.ok(statSync(path.join(f.root, 'qa-reports', 'dismissed.json')).isFile()),
  });
});

test('backfill.mjs: another run (or no id while the run is open) is refused (exit 5); the own id still adds the candidate', async () => {
  await assertOwnership('backfill.mjs', () => lockedFolder(), (f) => ['--report', f.reportFile, '--add', 'bulk-select', '--detail', 'Acme.tsx:12 renders a bulk bar', '--quiet'], {
    check: (f) => assert.equal(JSON.parse(readFileSync(f.reportFile, 'utf8')).backfill.items.length, 1),
  });
});

test('apply-decisions.mjs: another run is refused (exit 5) before the pending decisions are claimed', async () => {
  const withPending = () => {
    const f = lockedFolder();
    writeFileSync(path.join(f.dir, 'decisions.json'), '{"kind":"design-qa-decisions"}');
    return f;
  };
  const refused = withPending();
  const before = snapshot(refused.root);
  const res = await run(script('apply-decisions.mjs'), ['--report', refused.reportFile, '--run', RUN_B], { env: NO_ENV });
  assert.equal(res.code, 5, res.stderr);
  assert.deepEqual(snapshot(refused.root), before, 'decisions.json is still pending, nothing renamed');
  // Without pending decisions: "No pending decisions" (exit 0) as before.
  await assertOwnership('apply-decisions.mjs', () => lockedFolder(), (f) => ['--report', f.reportFile], {
    check: (_, out) => assert.match(out.stdout, /No pending decisions/),
  });
});

test('render-report.mjs: another run is refused for --in and for an --out into its folder', async () => {
  await assertOwnership('render-report.mjs', () => lockedFolder(), (f) => ['--in', f.reportFile, '--template', TEMPLATE, '--fixplan', path.join(f.dir, 'report-fixplan.md')], {
    check: (f, out) => {
      assert.ok(statSync(path.join(f.dir, 'report.html')).isFile());
      assert.doesNotMatch(out.stdout, /Review server open/, 'no server registered: no line');
    },
  });
  // --in outside any locked folder, --out into run A's folder.
  const f = lockedFolder();
  const before = snapshot(f.root);
  const res = await run(script('render-report.mjs'), ['--in', fixture('report-valid.json'), '--template', TEMPLATE, '--out', path.join(f.dir, 'report.html'), '--run', RUN_B], { env: NO_ENV });
  assert.equal(res.code, 5, res.stderr);
  assert.deepEqual(snapshot(f.root), before);
});

test('render-report.mjs: a live review server registered for the folder gets one reload line (probed on /health)', async (t) => {
  const f = lockedFolder();
  const id = 'reg-0123456789abcdef';
  const server = await startServer((req, res) => {
    res.writeHead(req.url === '/health' && req.headers['x-design-qa-registration'] === id ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, kind: 'design-qa-review', id, pid: process.pid }));
  });
  t.after(() => server.close());
  const reg = { kind: 'design-qa-review', id, pid: process.pid, port: server.port, host: os.hostname(), startedAt: '2026-10-04T11:40:00Z', runId: RUN_A };
  writeFileSync(path.join(f.dir, '.design-qa-review.json'), JSON.stringify(reg));
  const res = await run(script('render-report.mjs'), ['--in', f.reportFile, '--template', TEMPLATE, '--quiet', '--run', RUN_A], { env: NO_ENV });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout.trim(), `Review server open (port ${server.port}): ask the reviewer to reload report.html in their browser to see this version.`);
  assert.equal(server.requests.length, 1, 'probed once');

  // A registration whose port nobody listens on (the server is gone): no line.
  const gone = await startServer(() => {});
  const port = gone.port;
  await gone.close();
  writeFileSync(path.join(f.dir, '.design-qa-review.json'), JSON.stringify({ ...reg, port }));
  const stale = await run(script('render-report.mjs'), ['--in', f.reportFile, '--template', TEMPLATE, '--quiet', '--run', RUN_A], { env: NO_ENV });
  assert.equal(stale.code, 0, stale.stderr);
  assert.equal(stale.stdout, '');
});

function auditPage() {
  const rect = { x: 0, y: 0, w: 800, h: 600 };
  const base = { p: -1, d: 2, tag: 'div', id: null, cls: [], role: null, type: null, attrs: {}, text: null, control: null, own: false, rect, vis: rect, partial: false, clip: null, r: -1, sel: null, v: null, inh: null };
  const elements = [
    { ...base, i: 0, path: 'body', tag: 'body', s: {} },
    { ...base, i: 1, p: 0, path: 'div:nth-of-type(1)', own: true, text: 'Card', rect: { x: 0, y: 100, w: 800, h: 50 }, vis: { x: 0, y: 100, w: 800, h: 50 }, s: { 'padding-top': '13px', color: 'rgb(58, 63, 71)' } },
  ];
  return { version: 1, fullPage: true, scroll: { x: 0, y: 0 }, viewport: { w: 800, h: 600 }, page: { w: 800, h: 600 }, rootFontSize: 16, bodyText: null, rootTokens: {}, regions: [], selectors: [], stats: {}, truncated: null, elements };
}

function withEvidence() {
  const f = lockedFolder();
  const ev = path.join(f.dir, 'evidence');
  mkdirSync(path.join(ev, 'audit'), { recursive: true });
  mkdirSync(path.join(ev, 'app'), { recursive: true });
  writeFileSync(path.join(ev, 'audit', 'default.json'), JSON.stringify(auditPage()));
  writePng(path.join(ev, 'app', 'default.png'), createPng(800, 600));
  writeFileSync(path.join(ev, 'capture.json'), JSON.stringify({ states: { default: { screenshot: 'app/default.png', audit: 'audit/default.json' } } }));
  return f;
}

test('ds-audit.mjs: another run is refused (exit 5) before ds-audit.json is written', async () => {
  await assertOwnership('ds-audit.mjs', withEvidence, (f) => ['--evidence', path.join(f.dir, 'evidence'), '--tokens', fixture('ds-audit-tokens.json'), '--quiet'], {
    check: (f) => assert.ok(statSync(path.join(f.dir, 'evidence', 'ds-audit.json')).isFile()),
  });
});

function withImages() {
  const f = lockedFolder();
  mkdirSync(path.join(f.dir, 'evidence'), { recursive: true });
  const a = path.join(f.dir, 'evidence', 'design.png');
  const b = path.join(f.dir, 'evidence', 'app.png');
  writePng(a, createPng(20, 20));
  writePng(b, createPng(20, 20));
  writeFileSync(path.join(f.dir, 'pairs.json'), JSON.stringify({ default: { a, b } }));
  return { ...f, a, b };
}

test('diff.mjs: writing into another run\'s folder is refused (exit 5); a stdout-only comparison is not checked', async () => {
  await assertOwnership('diff.mjs', withImages, (f) => [f.a, f.b, '--out', path.join(f.dir, 'diff', 'default.png'), '--json'], {
    check: (f) => assert.ok(statSync(path.join(f.dir, 'diff', 'default.png')).isFile()),
  });
  await assertOwnership('diff.mjs', withImages, (f) => ['--pairs', path.join(f.dir, 'pairs.json'), '--out-dir', path.join(f.dir, 'diff'), '--json'], {
    check: (f) => assert.ok(statSync(path.join(f.dir, 'diff', 'default.png')).isFile()),
  });
  const f = withImages();
  const res = await run(script('diff.mjs'), [f.a, f.b, '--json', '--run', RUN_B], { env: NO_ENV });
  assert.equal(res.code, 0, res.stderr);
  // --json-out writes a file: checked like --out.
  await assertOwnership('diff.mjs', withImages, (g) => [g.a, g.b, '--json', '--json-out', path.join(g.dir, 'evidence', 'diff.json')], {
    check: (g) => assert.equal(JSON.parse(readFileSync(path.join(g.dir, 'evidence', 'diff.json'), 'utf8')).out, null),
  });
});
