import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { injectContext } from '../skills/design-qa/scripts/review.mjs';
import { ROOT, loadFixture, run, script, tmpDir } from './_helpers.mjs';

const REVIEW = script('review.mjs');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

const PAGE = `<!doctype html>
<html><head><title>Orders list</title></head>
<body>
<main>Acme report</main>
<script id="design-qa-data" type="application/json">{}</script>
<script id="design-qa-context" type="application/json">{"live":false,"token":null,"note":"kept </script-safe"}</script>
<script>/* app */</script>
</body></html>`;

/** <tmp>/qa-reports/ACME-482/{report.json, report.html, evidence/app.png} and a file outside it. */
function workspace(t, { html = PAGE } = {}) {
  const root = tmpDir('design-qa-review-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'qa-reports', 'ACME-482');
  mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  writeFileSync(path.join(dir, 'report.json'), JSON.stringify(loadFixture('ui-report.json'), null, 2));
  if (html !== null) writeFileSync(path.join(dir, 'report.html'), html);
  writeFileSync(path.join(dir, 'evidence', 'app.png'), PNG);
  writeFileSync(path.join(dir, 'notes.txt'), 'not served');
  writeFileSync(path.join(root, 'secret.png'), PNG);
  try {
    symlinkSync(path.join(root, 'secret.png'), path.join(dir, 'evidence', 'escape.png'));
  } catch {
    // Symlinks may be unavailable (Windows without privileges); the escape check is skipped then.
  }
  return { root, dir, reportFile: path.join(dir, 'report.json'), htmlFile: path.join(dir, 'report.html') };
}

/** Start review.mjs; resolves once it printed its URL. */
function startReview(t, args, { cwd = ROOT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [REVIEW, ...args, '--no-open'], { cwd, env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let started = false;
    const exited = new Promise((done) => child.on('close', (code) => done({ code, stdout, stderr })));
    t.after(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });
    child.stdout.on('data', (d) => {
      stdout += d;
      const m = /Review open: (http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]+))/.exec(stdout);
      if (m && !started) {
        started = true;
        resolve({ child, url: m[1], port: Number(m[2]), token: m[3], exited, output: () => stdout });
      }
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    exited.then((r) => {
      if (!started) reject(new Error(`review.mjs exited ${r.code} before starting:\n${r.stdout}\n${r.stderr}`));
    });
  });
}

/** A raw HTTP request (lets the test set Host and Origin). */
function request(port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...headers }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

const post = (srv, body, headers = {}) =>
  request(srv.port, {
    method: 'POST',
    path: '/decisions',
    headers: { 'Content-Type': 'application/json', 'X-Design-QA-Token': srv.token, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const contextOf = (html) => {
  const m = /<script id="design-qa-context" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  return m ? JSON.parse(m[1]) : null;
};

test('injectContext: replaces the element, keeps other keys, escapes for a script element; inserts it when absent', () => {
  const out = injectContext(PAGE, { token: 'abc', reportPath: 'qa-reports/ACME-482/report.json' });
  const raw = /<script id="design-qa-context" type="application\/json">([\s\S]*?)<\/script>/.exec(out)[1];
  assert.ok(raw.startsWith('{"live":true,"token":"abc","reportPath":"qa-reports/ACME-482/report.json"'), raw);
  assert.ok(raw.includes('<\\/script-safe'), 'the closing-tag sequence is escaped');
  assert.deepEqual(JSON.parse(raw), { live: true, token: 'abc', reportPath: 'qa-reports/ACME-482/report.json', note: 'kept </script-safe' });
  assert.equal(out.match(/design-qa-context/g).length, 1);

  const old = '<html><body><p>x</p><script>run()</script></body></html>';
  const inserted = injectContext(old, { token: 't', reportPath: 'r.json' });
  assert.equal(inserted, '<html><body><p>x</p><script id="design-qa-context" type="application/json">{"live":true,"token":"t","reportPath":"r.json"}</script>\n<script>run()</script></body></html>');
  assert.match(injectContext('<p>no scripts</p></body>', { token: 't', reportPath: 'r' }), /<script id="design-qa-context"[^>]*>\{"live":true[^<]*<\/script>\n<\/body>/);
  const empty = injectContext('<script id="design-qa-context" type="application/json"></script>', { token: 't', reportPath: 'r' });
  assert.equal(empty, '<script id="design-qa-context" type="application/json">{"live":true,"token":"t","reportPath":"r"}</script>');
  assert.match(injectContext('<script id="design-qa-context" type="application/json">x\u2028</script>', { token: 't', reportPath: 'r\u2028' }), /"reportPath":"r\\u2028"/);
});

test('review.mjs: token, Host and Origin guards, static files, rejected documents keep it running, Send saves decisions.json and exits 0', async (t) => {
  const ws = workspace(t);
  const srv = await startReview(t, ['--report', path.join('qa-reports', 'ACME-482', 'report.json')], { cwd: ws.root });

  // The page.
  assert.equal((await request(srv.port, { path: '/' })).status, 403);
  assert.match(srv.output(), /^Review open: http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32}\nWaiting for the reviewer to click Send \(Ctrl\+C to stop\)\.\n/);
  assert.equal((await request(srv.port, { path: '/?t=0123456789abcdef0123456789abcdef' })).status, 403);
  const page = await request(srv.port, { path: `/?t=${srv.token}` });
  assert.equal(page.status, 200);
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['access-control-allow-origin'], undefined, 'no CORS headers');
  assert.ok(page.text.includes(`"live":true,"token":"${srv.token}"`));
  assert.deepEqual(contextOf(page.text), { live: true, token: srv.token, reportPath: 'qa-reports/ACME-482/report.json', configPath: null, note: 'kept </script-safe' });
  assert.ok(page.text.includes('<main>Acme report</main>'));

  // The HTML is re-read on every request; an older page without the element gets one.
  writeFileSync(ws.htmlFile, '<html><body><h1>Old report</h1><script>start()</script></body></html>');
  const old = await request(srv.port, { path: `/?t=${srv.token}` });
  assert.equal(old.status, 200);
  assert.ok(old.text.includes('<h1>Old report</h1><script id="design-qa-context" type="application/json">{"live":true'), old.text);
  assert.equal(contextOf(old.text).token, srv.token);

  // DNS-rebinding guard.
  assert.equal((await request(srv.port, { path: `/?t=${srv.token}`, headers: { Host: `evil.example:${srv.port}` } })).status, 403);
  assert.equal((await request(srv.port, { path: `/?t=${srv.token}`, headers: { Host: '127.0.0.1:1' } })).status, 403);
  assert.equal((await request(srv.port, { path: `/?t=${srv.token}`, headers: { Host: `localhost:${srv.port}` } })).status, 200);

  // Health.
  assert.equal((await request(srv.port, { path: '/health' })).status, 403);
  assert.deepEqual((await request(srv.port, { path: `/health?t=${srv.token}` })).json, { ok: true });

  // Static files: images and .json inside the report folder only.
  const img = await request(srv.port, { path: '/evidence/app.png' });
  assert.equal(img.status, 200);
  assert.equal(img.headers['content-type'], 'image/png');
  assert.equal((await request(srv.port, { path: '/report.json' })).status, 200);
  for (const p of [
    '/..%2f..%2fpackage.json',
    '/..%2f..%2f..%2fsecret.png',
    '/../../secret.png',
    '/evidence/..%2f..%2f..%2fsecret.png',
    `/${encodeURIComponent(path.join(ws.root, 'secret.png'))}`,
    `//${ws.root.replace(/^\/+/, '')}/secret.png`,
    '/notes.txt',
    '/report.html',
    '/evidence/missing.png',
    '/evidence/escape.png',
    '/%E0%A4%A',
  ]) {
    const res = await request(srv.port, { path: p });
    assert.ok([400, 403, 404].includes(res.status), `${p} → ${res.status}`);
  }

  // POST guards.
  const d = loadFixture('decisions.json');
  assert.equal((await post(srv, d, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await post(srv, d, { Origin: `http://127.0.0.1:${srv.port + 1}` })).status, 403);
  assert.equal((await post(srv, d, { 'X-Design-QA-Token': 'nope' })).status, 403);
  assert.equal((await post(srv, d, { 'X-Design-QA-Token': '' })).status, 403);
  assert.equal((await post(srv, d, { Host: `evil.example:${srv.port}` })).status, 403);
  assert.equal((await post(srv, d, { 'Content-Type': 'text/plain' })).status, 415);
  const big = await post(srv, `{"pad":"${'x'.repeat(1024 * 1024)}"}`);
  assert.equal(big.status, 413);
  assert.equal(big.json.ok, false);
  assert.equal((await request(srv.port, { path: '/decisions' })).status, 405);

  const invalid = await post(srv, { ...d, triage: { fixNow: ['DQ-001'], debt: ['DQ-001'] } });
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.json, { ok: false, error: 'triage lists DQ-001 as both fix now and debt' });
  assert.equal((await post(srv, 'not json')).status, 400);
  const stale = await post(srv, { ...d, reportGeneratedAt: '2026-09-30T08:00:00Z' });
  assert.equal(stale.status, 409);
  assert.match(stale.json.error, /Reopen the current report\.html/);
  assert.equal((await post(srv, { ...d, slug: 'ACME-999' })).status, 409);
  const unknown = structuredClone(d);
  unknown.triage.debt.push('DQ-404');
  assert.equal((await post(srv, unknown)).status, 409);
  assert.ok(!existsSync(path.join(ws.dir, 'decisions.json')), 'nothing is saved for a rejected document');
  assert.equal((await request(srv.port, { path: `/health?t=${srv.token}` })).status, 200, 'still running');
  assert.equal(srv.child.exitCode, null);

  // Send (same-origin, as the page does).
  const ok = await post(srv, d, { Origin: `http://127.0.0.1:${srv.port}` });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true, path: 'qa-reports/ACME-482/decisions.json', summary: 'fix now 4 · later 3 · dismissed 2 · tickets: yes' });
  const result = await srv.exited;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(ws.dir, 'decisions.json'), 'utf8')), d);
  assert.deepEqual(readdirSync(ws.dir).filter((f) => f.endsWith('.tmp')), [], 'no temp file left behind');
  const lines = result.stdout.trimEnd().split('\n').slice(-3);
  assert.equal(lines[0], 'Decisions received from Dana: fix now 4 · later 3 · dismissed 2 · tickets: yes');
  assert.equal(lines[1], 'Saved: qa-reports/ACME-482/decisions.json');
  assert.match(lines[2], /^Next: node \S*apply-decisions\.mjs --report qa-reports\/ACME-482\/report\.json$/);

  // The saved document applies cleanly.
  const apply = await run(script('apply-decisions.mjs'), ['--report', ws.reportFile], { cwd: ws.root });
  assert.equal(apply.code, 0, apply.stderr);
  assert.ok(existsSync(path.join(ws.dir, 'decisions.applied.json')));
});

test('review.mjs: a timeout or a signal with nothing received exits 3', async (t) => {
  const ws = workspace(t);
  const srv = await startReview(t, ['--report', ws.reportFile, '--timeout-min', '0.005']);
  const timedOut = await srv.exited;
  assert.equal(timedOut.code, 3);
  assert.match(timedOut.stdout, /No decisions were sent\. The reviewer can still use "Copy for your agent" in the report\./);

  if (process.platform !== 'win32') {
    const again = await startReview(t, ['--report', ws.reportFile, '--timeout-min', '0']);
    assert.equal((await request(again.port, { path: `/health?t=${again.token}` })).status, 200);
    again.child.kill('SIGTERM');
    const stopped = await again.exited;
    assert.equal(stopped.code, 3);
    assert.match(stopped.stdout, /No decisions were sent/);
  }
});

test('review.mjs: bad arguments exit 2; a taken port exits 1', async (t) => {
  const ws = workspace(t, { html: null });
  assert.equal((await run(REVIEW, ['--help'])).code, 0);
  assert.equal((await run(REVIEW, ['--no-open'])).code, 2);
  const noHtml = await run(REVIEW, ['--report', ws.reportFile, '--no-open']);
  assert.equal(noHtml.code, 2);
  assert.match(noHtml.stderr, /report\.html not found: render it first: node \S*render-report\.mjs --in/);
  writeFileSync(ws.htmlFile, PAGE);
  assert.equal((await run(REVIEW, ['--report', ws.reportFile, '--no-open', '--port', 'abc'])).code, 2);
  assert.equal((await run(REVIEW, ['--report', path.join(ws.root, 'missing.json'), '--no-open'])).code, 2);

  const blocker = http.createServer();
  await new Promise((done) => blocker.listen(0, '127.0.0.1', done));
  t.after(() => blocker.close());
  const taken = await run(REVIEW, ['--report', ws.reportFile, '--no-open', '--port', String(blocker.address().port)]);
  assert.equal(taken.code, 1);
  assert.match(taken.stderr, /already in use/);
});

test('review.mjs: carry the rendered config through live context and the apply command from another cwd', async (t) => {
  const ws = workspace(t);
  const configFile = path.join(ws.root, 'review settings.json');
  writeFileSync(configFile, JSON.stringify({ ...loadFixture('config.json'), tolerances: { pixelDiff: { pass: 4, review: 10 } }, report: { debtLog: 'custom/debt.md' } }));
  const rendered = await run(script('render-report.mjs'), ['--in', ws.reportFile, '--config', configFile, '--recompute', '--write-back'], { cwd: ws.root });
  assert.equal(rendered.code, 0, rendered.stderr);
  const bands = JSON.parse(readFileSync(ws.reportFile, 'utf8')).scorecard.pixelDiff;
  const srv = await startReview(t, ['--report', ws.reportFile], { cwd: ROOT });
  const page = await request(srv.port, { path: `/?t=${srv.token}` });
  assert.equal(contextOf(page.text).configPath, configFile);
  assert.equal((await post(srv, loadFixture('decisions.json'))).status, 200);
  const result = await srv.exited;
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes(`--config '${configFile}'`), result.stdout);
  const applied = await run(script('apply-decisions.mjs'), ['--report', ws.reportFile, '--config', configFile], { cwd: ROOT });
  assert.equal(applied.code, 0, applied.stderr);
  assert.deepEqual(JSON.parse(readFileSync(ws.reportFile, 'utf8')).scorecard.pixelDiff, bands);
  assert.ok(existsSync(path.join(ws.root, 'custom', 'debt.json')));
});
