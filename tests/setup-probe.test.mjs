// setup.mjs with a real browser: check maps capture --probe (a sign-in page is "needs a
// signed-in session", never "unreachable"), and save-session saves a session a person
// signed in to (simulated by a page that signs itself in), verifies it and records only
// its path. Skipped when Chromium cannot launch.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { saveSession } from '../skills/design-qa/scripts/lib/setup.mjs';
import { fixture, run, script, startServer, tmpDir } from './_helpers.mjs';

const SETUP = script('setup.mjs');
const SIGN_IN_HTML = readFileSync(fixture('signin-form.html'), 'utf8');
const SPA_HTML = readFileSync(fixture('signin-spa.html'), 'utf8');
const SESSION_VALUE = 'sess-7Hq2Lm9Xw4Rt8Yp3Vb6Nc1';
const APP_PAGE = '<!doctype html><title>Orders</title><nav data-testid="app-nav"><a href="/orders">Orders</a></nav><h1>Orders</h1><p class="row">Order 1</p>';
const CLEAN_ENV = { FIGMA_TOKEN: '', JIRA_BASE_URL: '', JIRA_EMAIL: '', JIRA_API_TOKEN: '', DESIGN_QA_APP_STORAGE_STATE: '', CI: '', SSH_CONNECTION: '', SSH_CLIENT: '', SSH_TTY: '', DESIGN_QA_NO_DISPLAY: '' };

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
const browserTest = (name, fn) =>
  test(name, { timeout: 240000 }, async (t) => {
    if (!CHROMIUM) {
      t.skip('Chromium is not installed (run `npx playwright install chromium`)');
      return;
    }
    await fn(t);
  });

const html = (res, body, status = 200, headers = {}) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
};
const redirect = (res, location) => {
  res.writeHead(302, { location });
  res.end();
};
const signedIn = (req) => (req.headers.cookie || '').includes(`session=${SESSION_VALUE}`);

/**
 * The app under test, at neutral paths (nothing says "login"): /orders redirects to /gate
 * (a sign-in form) without the session cookie; /spa is a single-page app that renders a
 * sign-in form in place until /api/me accepts the cookie; /gate-auto signs itself in after
 * a moment and goes back to /orders (a person signing in, for save-session; /app sends
 * there when signed out); /broken answers 500.
 */
function appServer() {
  return startServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/gate') return html(res, SIGN_IN_HTML);
    if (u.pathname === '/gate-auto') {
      return html(res, `${SIGN_IN_HTML}<script>setTimeout(() => { document.cookie = 'session=${SESSION_VALUE}; path=/'; location.href = '/orders'; }, 400);</script>`);
    }
    if (u.pathname === '/broken') return html(res, 'boom', 500);
    if (u.pathname === '/spa') return html(res, SPA_HTML);
    if (u.pathname === '/api/me') {
      if (!signedIn(req)) return html(res, 'no', 401);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"name":"QA"}');
    }
    if (u.pathname === '/orders') return signedIn(req) ? html(res, APP_PAGE) : redirect(res, '/gate');
    if (u.pathname === '/app') return signedIn(req) ? html(res, APP_PAGE) : redirect(res, '/gate-auto');
    if (u.pathname === '/open') return html(res, APP_PAGE);
    return html(res, 'not found', 404);
  });
}

function sessionFile(dir, value, name = 'session.json') {
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify({ cookies: [{ name: 'session', value, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] }), { mode: 0o600 });
  return file;
}

function writeConfig(dir, config) {
  writeFileSync(path.join(dir, 'design-qa.config.json'), JSON.stringify(config, null, 2));
}

const check = async (dir, args = [], env = {}) => {
  const res = await run(SETUP, ['check', '--json', '--full', '--timeout', '8000', '--agent', 'figma-mcp=yes', ...args], { cwd: dir, env: { ...CLEAN_ENV, ...env } });
  return { ...res, out: JSON.parse(res.stdout) };
};
const rowOf = (out, id) => out.checks.find((c) => c.id === id);

browserTest('check maps the probe: sign-in needed is never "unreachable"; unreachable, HTTP errors and a working session', async () => {
  const server = await appServer();
  try {
    const dir = tmpDir('design-qa-setup-probe-');
    const base = { surfaces: { orders: { route: '/orders' } }, app: { baseUrl: server.url, preCapture: {} } };

    // A redirect to a sign-in form at a neutral URL: sign-in needed, reachable.
    writeConfig(dir, base);
    const gate = await check(dir);
    assert.equal(gate.code, 1, gate.stderr);
    assert.deepEqual([rowOf(gate.out, 'app-reachable').ok, rowOf(gate.out, 'sign-in').ok, rowOf(gate.out, 'sign-in').blocking], [true, false, true]);
    assert.match(rowOf(gate.out, 'sign-in').detail, /needs a signed-in session: .*It is reachable; this is not an outage/);
    assert.doesNotMatch(JSON.stringify(gate.out.checks), /cannot reach|unreachable/);
    const q = gate.out.questions.find((x) => x.id === 'sign-in');
    assert.equal(q.required, true);
    assert.equal(q.writes, 'action:save-session');
    assert.match(q.question, /shows a sign-in page first/);
    assert.ok(gate.out.agentChecks.some((a) => a.id === 'signed-in-element'), 'the agent is asked to find the signed-in element');

    // The same, in ci mode: no question, the variable named.
    const ci = await run(SETUP, ['check', '--ci', '--timeout', '8000'], { cwd: dir, env: CLEAN_ENV });
    assert.equal(ci.code, 1);
    assert.match(ci.stderr, /sign-in: the app needs a signed-in session.*set DESIGN_QA_APP_STORAGE_STATE to a session file/);

    // A single-page app showing a sign-in form in place (no redirect).
    writeConfig(dir, { ...base, surfaces: { orders: { route: '/spa' } } });
    const spa = await check(dir);
    assert.equal(rowOf(spa.out, 'sign-in').ok, false);

    // Unreachable: a closed port. Not a sign-in question.
    writeConfig(dir, { ...base, app: { ...base.app, baseUrl: 'http://127.0.0.1:9' } });
    const gone = await check(dir);
    assert.equal(gone.code, 1);
    const reach = rowOf(gone.out, 'app-reachable');
    assert.deepEqual([reach.ok, reach.blocking], [false, true]);
    assert.match(reach.detail, /^cannot reach http:\/\/127\.0\.0\.1:9/);
    assert.match(reach.fix, /Start the app/);
    assert.ok(!gone.out.questions.some((x) => x.id === 'sign-in'));

    // An HTTP error.
    writeConfig(dir, { ...base, surfaces: { x: { route: '/broken' } } });
    const broken = await check(dir);
    assert.match(rowOf(broken.out, 'app-reachable').detail, /answers with HTTP 500/);

    // A saved session through app.auth.storageState (no variable set): signed in, ready.
    const good = sessionFile(dir, SESSION_VALUE);
    writeConfig(dir, { ...base, app: { ...base.app, auth: { type: 'storageState', storageState: good, signedInSelector: '[data-testid=app-nav]' } } });
    const ok = await check(dir);
    assert.equal(rowOf(ok.out, 'sign-in').ok, true, JSON.stringify(ok.out.checks));
    assert.match(rowOf(ok.out, 'sign-in').detail, /signed in with the saved session .*"\[data-testid=app-nav\]" is visible/);
    assert.ok(!ok.out.questions.some((x) => x.id === 'sign-in'));
    assert.ok(!ok.stdout.includes(SESSION_VALUE), 'the session never reaches the output');

    // The variable wins over the config pointer: an expired session asks to sign in again.
    const stale = sessionFile(dir, 'expired-value-000', 'stale.json');
    const expired = await check(dir, [], { DESIGN_QA_APP_STORAGE_STATE: stale });
    assert.equal(rowOf(expired.out, 'sign-in').ok, false);
    assert.match(rowOf(expired.out, 'sign-in').detail, /the saved session \(DESIGN_QA_APP_STORAGE_STATE\) no longer signs in/);
    assert.match(expired.out.questions.find((x) => x.id === 'sign-in').question, /has expired/);

    // storageState with no session file yet: the app is loaded without one to learn it needs one.
    writeConfig(dir, { ...base, app: { ...base.app, auth: { type: 'storageState', storageState: path.join(dir, 'missing.json') } } });
    const missing = await check(dir);
    assert.match(rowOf(missing.out, 'session-file').detail, /app\.auth\.storageState points to a missing file/);
    assert.equal(rowOf(missing.out, 'sign-in').ok, false);
    assert.match(missing.out.questions.find((x) => x.id === 'sign-in').question, /shows a sign-in page first/);

    // No sign-in at all.
    writeConfig(dir, { ...base, surfaces: { x: { route: '/open' } } });
    const open = await check(dir);
    assert.deepEqual([rowOf(open.out, 'app-reachable').ok, rowOf(open.out, 'sign-in').ok], [true, true]);

    // A first run with no config probes the address it assumed from package.json.
    const fresh = tmpDir('design-qa-setup-fresh-');
    writeFileSync(path.join(fresh, 'package.json'), JSON.stringify({ scripts: { dev: `vite --port ${server.port}` }, devDependencies: { vite: '^6.0.0' } }));
    const first = await check(fresh);
    assert.equal(first.out.assumed.find((a) => a.id === 'app-url').value, `http://localhost:${server.port}`);
    assert.equal(rowOf(first.out, 'app-reachable').ok, false, 'the root path answers 404 here: checked, not assumed');
    assert.match(rowOf(first.out, 'app-reachable').detail, new RegExp(`^http://localhost:${server.port} answers with HTTP 404`));
  } finally {
    await server.close();
  }
});

browserTest('save-session: the person signs in, the session is verified, saved with mode 600 outside the repository and only its path recorded', async () => {
  const server = await appServer();
  try {
    const repo = tmpDir('design-qa-setup-save-');
    const configPath = path.join(repo, 'design-qa.config.json');
    const config = { app: { baseUrl: server.url, auth: { type: 'none', signedInSelector: '[data-testid=app-nav]' } }, surfaces: { orders: { route: '/orders' } } };
    writeConfig(repo, config);
    const sessions = tmpDir('design-qa-setup-sessions-');
    const out = path.join(sessions, 'acme.json');
    const logs = [];
    // A headless browser stands in for the headed window; /gate-auto signs itself in.
    const launch = (chromium) => chromium.launch({ headless: true });

    const result = await saveSession({ url: `${server.url}/app`, configPath, config, out, env: { ...process.env, ...CLEAN_ENV }, launch, display: true, log: (m) => logs.push(m), probeTimeoutMs: 8000 });
    assert.equal(result.code, 0, result.message);
    assert.equal(result.verified, true);
    assert.ok(existsSync(out));
    if (process.platform !== 'win32') assert.equal(statSync(out).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(sessions), ['acme.json'], 'no temp file left');
    assert.match(logs.join('\n'), /Sign in there yourself; I notice when "\[data-testid=app-nav\]" shows/);
    assert.match(result.message, /Saved the session to .*acme\.json \(only you can read it\) and checked it/);
    const exportCmd = result.message.split('\n').find((l) => l.includes('export DESIGN_QA_APP_STORAGE_STATE='));
    // Pasted: the shell reads the printed line from its input, as typed into a terminal.
    const pasted = execFileSync('sh', ['-s'], { input: `${exportCmd.slice(exportCmd.indexOf('export '))}\nprintf %s "$DESIGN_QA_APP_STORAGE_STATE"\n`, env: { HOME: process.env.HOME ?? '', PATH: process.env.PATH }, encoding: 'utf8' });
    assert.equal(pasted, out, 'the printed export line works when pasted');
    for (const text of [result.message, ...logs, JSON.stringify(result.changes)]) assert.ok(!text.includes(SESSION_VALUE), 'never prints the session');

    const saved = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(saved.app.auth.type, 'storageState');
    assert.equal(saved.app.auth.storageState, out, 'the path, never the content');
    assert.equal(saved.app.auth.signedInSelector, '[data-testid=app-nav]');
    assert.ok(!readFileSync(configPath, 'utf8').includes(SESSION_VALUE));
    assert.deepEqual(result.changes.map((c) => c.path), ['app.auth.storageState', 'app.auth.type', 'app.auth.envPrefix']);

    // A later check in a fresh shell (no variable) finds the session through the config.
    const later = await check(repo);
    assert.equal(rowOf(later.out, 'sign-in').ok, true, JSON.stringify(later.out.checks));

    // No signed-in element known: the person closes the window when done (simulated), --no-config.
    const closed = path.join(sessions, 'closed.json');
    const closeLater = async (chromium) => {
      const browser = await chromium.launch({ headless: true });
      setTimeout(() => {
        for (const c of browser.contexts()) for (const p of c.pages()) p.close().catch(() => {});
      }, 2500);
      return browser;
    };
    const bare = { app: { baseUrl: server.url }, surfaces: { orders: { route: '/orders' } } };
    const byClose = await saveSession({ url: `${server.url}/app`, configPath, config: bare, out: closed, env: { ...process.env, ...CLEAN_ENV }, launch: closeLater, display: true, log: (m) => logs.push(m), writeConfig: false, probeTimeoutMs: 8000 });
    assert.equal(byClose.code, 0, byClose.message);
    assert.match(logs.at(-1), /Sign in there yourself, then close the window/);
    assert.match(byClose.message, /The config was left as it is \(--no-config\)/);
    assert.deepEqual(byClose.changes, []);
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).app.auth.storageState, out, 'unchanged');

    // Nobody signs in: timed out, nothing saved.
    const none = path.join(sessions, 'none.json');
    const timedOut = await saveSession({ url: `${server.url}/gate`, configPath, config, out: none, env: { ...process.env, ...CLEAN_ENV }, launch, display: true, log: () => {}, timeoutMs: 2500 });
    assert.equal(timedOut.code, 1);
    assert.match(timedOut.message, /timed out .*nothing was saved/);
    assert.ok(!existsSync(none));
    assert.deepEqual(readdirSync(sessions).sort(), ['acme.json', 'closed.json']);
  } finally {
    await server.close();
  }
});

/** A printed command line, run as printed (async: the app server lives in this process). */
function sh(cwd, line, env) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', line], { cwd, env: { ...process.env, ...CLEAN_ENV, ...env } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

browserTest('a first start behind sign-in, no screen: the questions come in the same stop, Next applies the answers; the printed no-screen steps work as printed (fake HOME)', async () => {
  const server = await appServer();
  try {
    const repo = tmpDir('design-qa-setup-first-');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    // MUI and a wrapper most feature code imports: which library to check is a question.
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'acme', dependencies: { '@mui/material': '5.0.0', '@acme/kit': '1.0.0' } }));
    mkdirSync(path.join(repo, 'node_modules', '@acme', 'kit'), { recursive: true });
    writeFileSync(path.join(repo, 'node_modules', '@acme', 'kit', 'package.json'), JSON.stringify({ name: '@acme/kit', peerDependencies: { '@mui/material': '5.0.0' } }));
    mkdirSync(path.join(repo, 'src'), { recursive: true });
    for (const [f, from] of [['A', '@acme/kit'], ['B', '@acme/kit'], ['C', '@mui/material']]) writeFileSync(path.join(repo, 'src', `${f}.tsx`), `import { Button } from '${from}';\nexport const x = 1;\n`);
    const home = tmpDir('design-qa-setup-home-');
    // The browsers stay where they are installed; only the home folder is fake.
    const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : process.platform === 'win32' ? 'AppData/Local/ms-playwright' : '.cache/ms-playwright');
    const env = { HOME: home, USERPROFILE: home, DESIGN_QA_NO_DISPLAY: '1', PLAYWRIGHT_BROWSERS_PATH: browsers, DESIGN_QA_RUN_ID: '' };
    const start = await run(script('pass.mjs'), ['start', '--feature', 'abc-1', '--url', `${server.url}/orders`, '--prototype', `${server.url}/open`, '--agent', 'ticket-mcp=no'], { cwd: repo, env: { ...CLEAN_ENV, ...env }, timeout: 120000 });
    assert.equal(start.code, 3, start.stdout + start.stderr);
    assert.match(start.stdout, /^ {2}sign-in: the app needs a signed-in session/m);
    assert.match(start.stdout, /^Question \(ds-components\): /m, 'the other questions are printed in full in the same stop');
    assert.doesNotMatch(start.stdout, /^Question \(sign-in\)/m, 'sign-in is the save-session step, not an answer');
    assert.match(start.stdout, /^Do: Ask the person the questions above in the same round .*qa-reports\/abc-1\/answers\.json/m);
    const next = /^Next: (.+)$/m.exec(start.stdout)[1];
    assert.match(next, /setup\.mjs apply --accept-assumed --answers qa-reports\/abc-1\/answers\.json .*--no-next && \S+ \S+setup\.mjs save-session .*&& \S+ \S+pass\.mjs start /);

    // The person answers; Next applies the answers, then save-session finds no screen and prints the steps.
    writeFileSync(path.join(repo, 'qa-reports', 'abc-1', 'answers.json'), JSON.stringify({ 'ds-components': ['@mui/material'] }));
    const chained = await sh(repo, next, env);
    assert.equal(chained.code, 3, chained.out);
    assert.equal(JSON.parse(readFileSync(path.join(repo, 'design-qa.config.json'), 'utf8')).designSystem.libraries[0].package, '@mui/material', 'the answers were applied');
    assert.match(chained.out, /No screen is available here/);
    const dest = /copy session\.json to this machine as (\S+) /.exec(chained.out)[1].replace(/^~/, home);
    const record = chained.out.trim().split('\n').pop().trim();
    assert.match(record, /setup\.mjs save-session --existing --url /);

    // Run before the file is there: it says so; then the person copies it where the steps say.
    const early = await sh(repo, record, env);
    assert.equal(early.code, 1, early.out);
    assert.match(early.out, /no session file at ~\/\.design-qa\/sessions\/.*: copy it there first/);
    mkdirSync(path.dirname(dest), { recursive: true });
    sessionFile(path.dirname(dest), SESSION_VALUE, path.basename(dest));
    const done = await sh(repo, record, env);
    assert.equal(done.code, 0, done.out);
    assert.match(done.out, /Checked the session in ~\/\.design-qa\/sessions\/\S+ \(now only you can read it\): the app opens signed in/);
    assert.ok(!done.out.includes(SESSION_VALUE), 'never prints the session');
    assert.match(done.out, /^Next: node \S*setup\.mjs check$/m, 'it runs on its own: it says where to go on');
    if (process.platform !== 'win32') assert.equal(statSync(dest).mode & 0o777, 0o600);
    const saved = JSON.parse(readFileSync(path.join(repo, 'design-qa.config.json'), 'utf8'));
    assert.equal(saved.app.auth.type, 'storageState');
    assert.match(saved.app.auth.storageState, /^~\/\.design-qa\/sessions\//);

    // check (with a ticket key after --ticket, as an agent may write it) now finds the session.
    const later = await run(SETUP, ['check', '--json', '--full', '--timeout', '8000', '--url', `${server.url}/orders`, '--ticket', 'ABC-1', '--agent', 'figma-mcp=no', '--agent', 'ticket-mcp=no'], { cwd: repo, env: { ...CLEAN_ENV, ...env } });
    assert.notEqual(later.code, 2, later.stderr);
    assert.equal(JSON.parse(later.stdout).checks.find((c) => c.id === 'sign-in').ok, true, later.stdout);

    // A copied session that no longer signs in: nothing recorded, the file left as the person put it.
    sessionFile(path.dirname(dest), 'expired-value', path.basename(dest));
    const stale = await sh(repo, record, env);
    assert.equal(stale.code, 1, stale.out);
    assert.match(stale.out, /does not work: the app still shows a sign-in page.*nothing was recorded/);
    assert.ok(existsSync(dest));
  } finally {
    await server.close();
  }
});
