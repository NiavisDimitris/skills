// A capture must never pass a sign-in page off as the app: redirects to another host or
// to /login, client-side redirects, a sign-in wall at the same URL, the signed-in
// selector and sign-in URL pattern, allowSignIn / allowNavigation, and capture --probe.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { classifySignIn, compileSignInPattern, looksLikeSignInUrl, signInHelp } from '../skills/design-qa/scripts/lib/capture-helpers.mjs';
import { fixture, run, script, scriptLiteral, sendJson, startServer, tmpDir } from './_helpers.mjs';

const CAPTURE = script('capture.mjs');
const SIGN_IN_HTML = readFileSync(fixture('signin-form.html'), 'utf8');
const SPA_HTML = readFileSync(fixture('signin-spa.html'), 'utf8');
const captureEnv = { DESIGN_QA_COMMIT: 'test-commit', DESIGN_QA_BRANCH: 'test-branch' };
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('looksLikeSignInUrl: sign-in words as whole host, path or fragment segments only', () => {
  for (const u of [
    'http://h.test/login',
    'http://h.test/auth/sign-in?next=/x',
    'https://login.idp.test/',
    'https://idp.test/oauth2/v1/authorize?client_id=1',
    'https://idp.test/u/saml/sso',
    'http://h.test/#/login',
    'http://h.test/account/session/new',
  ]) assert.equal(looksLikeSignInUrl(u), true, u);
  for (const u of ['http://h.test/authors', 'http://h.test/blogin', 'http://h.test/orders', 'http://h.test/catalog?q=login']) {
    assert.equal(looksLikeSignInUrl(u), false, u);
  }
});

test('classifySignIn: precedence of allowSignIn, the URL pattern, the signed-in selector and the heuristics', () => {
  const app = 'http://h.test/orders';
  const form = { loginPasswordFields: 1, newPasswordFields: 0, textInputs: 2, usernameField: true, signInTitle: true, signInButton: true, interactive: 4 };
  const plain = { loginPasswordFields: 0, newPasswordFields: 0, textInputs: 0, usernameField: false, signInTitle: false, signInButton: false, interactive: 30 };
  const c = (o) => classifySignIn({ plannedUrl: app, finalUrl: app, ...o });
  // 5. heuristics
  assert.equal(c({ signals: form }).signIn, true, 'a sign-in form at the planned URL');
  assert.equal(c({ signals: plain }).signIn, false);
  assert.equal(c({ signals: plain }).signedIn, null, 'no selector: signed-in state unknown');
  assert.equal(c({ finalUrl: 'http://h.test/login', signals: plain }).signIn, true, 'moved to a sign-in URL');
  assert.equal(c({ finalUrl: 'http://h.test/orders#/login', signals: plain }).signIn, true, 'a hash route counts');
  assert.equal(c({ finalUrl: 'https://idp.test/u/start', signals: { ...plain, usernameField: true, signInTitle: true, interactive: 3 } }).signIn, true, 'identifier-first page on another host');
  assert.equal(c({ finalUrl: 'http://h.test/archive', signals: plain }).signIn, false, 'another route is navigation, not sign-in');
  assert.equal(c({ signals: { ...form, newPasswordFields: 2 } }).signIn, false, 'a change-password form is not a sign-in form');
  assert.equal(c({ signals: { ...form, interactive: 40 } }).signIn, false, 'a big page with one password field is not flagged');
  assert.equal(c({ signals: null }).signIn, false, 'unreadable page: no verdict from content');
  // 4. the planned URL is a sign-in page: QA of the sign-in screen
  assert.equal(classifySignIn({ plannedUrl: 'http://h.test/login', finalUrl: 'http://h.test/login', signals: form }).signIn, false);
  // 3. the signed-in selector wins over the heuristics, both ways
  assert.deepEqual(c({ signals: form, signedInSelector: 'nav', signedInVisible: true }), { signIn: false, signedIn: true, detail: null });
  const missing = c({ signals: plain, signedInSelector: 'nav', signedInVisible: false });
  assert.equal(missing.signIn, true);
  assert.match(missing.detail, /signed-in selector "nav" is not visible/);
  // 2. the URL pattern wins over the selector
  const pattern = compileSignInPattern('/u/continue');
  assert.equal(c({ finalUrl: 'https://idp.test/u/continue', signals: plain, signInPattern: pattern, signedInSelector: 'nav', signedInVisible: true }).signIn, true);
  assert.equal(c({ signals: plain, signInPattern: compileSignInPattern('orders') }).signIn, false, 'the planned URL matching the pattern is not a move');
  // 1. allowSignIn wins over everything
  assert.equal(c({ finalUrl: 'http://h.test/login', signals: form, allowSignIn: true }).signIn, false);
  assert.throws(() => compileSignInPattern('(', '--sign-in-url'), (err) => err.exitCode === 2 && /--sign-in-url is not a valid regular expression/.test(err.message));
  assert.equal(compileSignInPattern(null), null);
});

test('signInHelp names the variable and the steps, never a value', () => {
  const help = signInHelp({ auth: 'none', prefix: 'SHOP', url: 'https://shop.test/orders' });
  assert.match(help, /needs a signed-in session/);
  assert.match(help, /npx playwright codegen --save-storage=<file outside the repository> https:\/\/shop\.test\/orders/);
  assert.match(help, /SHOP_STORAGE_STATE=<that file>/);
  assert.match(help, /--auth storage-state/);
  assert.match(help, /--probe/);
  assert.match(help, /allowSignIn/);
  assert.match(signInHelp({ auth: 'storage-state', prefix: 'SHOP' }), /The session in SHOP_STORAGE_STATE did not sign in \(expired/);
  assert.match(signInHelp({ auth: 'cookie', prefix: 'SHOP' }), /The cookie in SHOP_COOKIE was not accepted/);
});

// ---------------------------------------------------------------------------
// Browser tests (skipped when Chromium cannot launch)
// ---------------------------------------------------------------------------

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

const SKIP_REASON = 'Chromium is not installed (run `npx playwright install chromium`)';
const CHROMIUM = await chromiumLaunches();
const browserTest = (name, fn) =>
  test(name, { timeout: 180000 }, async (t) => {
    if (!CHROMIUM) {
      t.skip(SKIP_REASON);
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
const APP_PAGE = '<!doctype html><title>Orders</title><nav data-testid="app-nav"><a href="/orders">Orders</a></nav><h1>Orders</h1><p class="row">Order 1</p>';
const listFiles = (dir) =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)])) : [];
const writeStates = (dir, states) => {
  const file = path.join(dir, `states-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(states));
  return file;
};
const capture = (dir, name, args, env = {}) =>
  run(CAPTURE, ['--width', '480', '--height', '360', '--timeout', '8000', '--out', path.join(dir, name), ...args], { env: { ...captureEnv, ...env }, cwd: dir });

/** Assert a run stopped on a sign-in page: exit 6, no screenshot, a sign-in failure and the plain-words message. */
function assertSignIn(res, out, state, finalUrlPattern) {
  assert.equal(res.code, 6, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, new RegExp(`state "${state}" landed on a sign-in page, not the app`));
  assert.match(res.stderr, /The target needs a signed-in session/);
  assert.match(res.stderr, /DESIGN_QA_APP_STORAGE_STATE=<that file>/);
  const manifest = json(path.join(out, 'capture.json'));
  const entry = manifest.states[state];
  assert.equal(entry.screenshot, null);
  assert.equal(entry.failure.kind, 'sign-in');
  assert.match(entry.failure.finalUrl, finalUrlPattern);
  assert.equal(typeof entry.failure.detail, 'string');
  assert.deepEqual({ kind: manifest.failure.kind, state: manifest.failure.state }, { kind: 'sign-in', state });
  assert.ok(!listFiles(path.join(out, 'app')).length, 'no screenshot left under any state name');
  return manifest;
}

browserTest('capture (a): a server redirect to a sign-in page on another host exits 6; no stale evidence is left', async () => {
  const TOKEN = 'tok_S3CRET-signin-1';
  const idp = await startServer((req, res) => html(res, SIGN_IN_HTML));
  const app = await startServer((req, res) => redirect(res, `${idp.url}/authorize?return=${encodeURIComponent(`http://app${req.url}`)}`));
  try {
    const dir = tmpDir();
    const out = path.join(dir, 'evidence');
    // Evidence from an earlier, signed-in run must not survive as these states.
    for (const rel of ['app/with-data.png', 'app/empty.png', 'computed/empty.json']) {
      mkdirSync(path.join(out, path.dirname(rel)), { recursive: true });
      writeFileSync(path.join(out, rel), 'stale');
    }
    const states = writeStates(dir, { 'with-data': {}, empty: { query: 'state=empty' } });
    const res = await capture(dir, 'evidence', ['--url', `${app.url}/orders?t=\${TOKEN}`, '--states', states], { TOKEN });
    const manifest = assertSignIn(res, out, 'with-data', new RegExp(`^${idp.url}/authorize\\?return=.*\\$\\{TOKEN\\}`));
    assert.match(manifest.states['with-data'].failure.detail, /moved to a sign-in URL/);
    assert.equal(manifest.states.empty.failure.kind, 'stopped', 'later states are listed as not captured');
    assert.match(manifest.states.empty.error, /not captured: capture stopped: state "with-data" landed on a sign-in page/);
    assert.ok(!existsSync(path.join(out, 'computed', 'empty.json')), 'stale evidence of later states is removed');
    for (const file of listFiles(out)) assert.ok(!readFileSync(file).includes(TOKEN), `${path.relative(out, file)} leaks the secret`);
    assert.ok(!res.stdout.includes(TOKEN) && !res.stderr.includes(TOKEN), 'the secret is never printed');
  } finally {
    await app.close();
    await idp.close();
  }
});

browserTest('capture (b) and (c): a redirect to /login, a client-side redirect, a pushState route and a hash route all exit 6', async () => {
  const server = await startServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/login' || u.pathname === '/signin') return html(res, SIGN_IN_HTML);
    if (u.pathname === '/server') return redirect(res, '/login?next=/server');
    if (u.pathname === '/client') return html(res, '<!doctype html><h1>Loading</h1><script>setTimeout(() => location.replace("/signin"), 300)</script>');
    if (u.pathname === '/pushstate') {
      return html(res, `<!doctype html><h1>Loading</h1><script>setTimeout(() => { history.pushState({}, '', '/login'); document.body.innerHTML = ${scriptLiteral(SIGN_IN_HTML.replace(/<!doctype[\s\S]*<body>|<\/body>[\s\S]*/gi, ''))}; }, 300)</script>`);
    }
    if (u.pathname === '/hash') return html(res, '<!doctype html><title>App</title><h1>Loading</h1><script>setTimeout(() => { location.hash = "#/login"; }, 200)</script>');
    return html(res, APP_PAGE);
  });
  try {
    const dir = tmpDir();
    for (const [name, route, pattern] of [
      ['server', '/server', /\/login\?next=\/server$/],
      ['client', '/client', /\/signin$/],
      ['pushstate', '/pushstate', /\/login$/],
      ['hash', '/hash', /\/hash#\/login$/],
    ]) {
      const res = await capture(dir, name, ['--url', `${server.url}${route}`]);
      assertSignIn(res, path.join(dir, name), 'with-data', pattern);
    }
    // --allow-navigation (an app that always redirects) never lets a sign-in page through.
    const lenient = await capture(dir, 'lenient', ['--url', `${server.url}/server`, '--allow-navigation']);
    assertSignIn(lenient, path.join(dir, 'lenient'), 'with-data', /\/login/);
  } finally {
    await server.close();
  }
});

browserTest('capture (d): a sign-in wall at the same URL exits 6; the signed-in selector decides over the heuristics', async () => {
  const server = await startServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/me') {
      return (req.headers.cookie || '').includes('session=ok') ? sendJson(res, 200, { name: 'QA' }) : sendJson(res, 401, { error: 'signed out' });
    }
    if (u.pathname === '/expired') return html(res, '<!doctype html><title>Acme</title><h1>Your session has expired</h1>');
    return html(res, SPA_HTML);
  });
  try {
    const dir = tmpDir();
    const signedIn = { DESIGN_QA_APP_COOKIE: 'session=ok' };
    // Signed out: the SPA renders a sign-in form at the planned URL.
    const wall = await capture(dir, 'wall', ['--url', `${server.url}/app`]);
    const manifest = assertSignIn(wall, path.join(dir, 'wall'), 'with-data', new RegExp(`^${server.url}/app$`));
    assert.match(manifest.states['with-data'].failure.detail, /sign-in form/);

    // Signed in: captured; with the selector, signedIn is recorded.
    const ok = await capture(dir, 'ok', ['--url', `${server.url}/app`, '--auth', 'cookie', '--signed-in-selector', '[data-testid=app-nav]'], signedIn);
    assert.equal(ok.code, 0, ok.stderr);
    const okManifest = json(path.join(dir, 'ok', 'capture.json'));
    assert.equal(okManifest.states['with-data'].signedIn, true);
    assert.deepEqual(okManifest.signInChecks, { signedInSelector: '[data-testid=app-nav]', signInUrlPattern: null });

    // A settings page with an e-mail and one current-password field: the heuristic alone
    // flags it; a visible signed-in selector overrides the heuristic.
    const account = await capture(dir, 'account', ['--url', `${server.url}/app?page=account`, '--auth', 'cookie'], signedIn);
    assert.equal(account.code, 6, 'without the selector the heuristic flags it (documented)');
    const accountOk = await capture(dir, 'account-ok', ['--url', `${server.url}/app?page=account`, '--auth', 'cookie', '--signed-in-selector', '[data-testid=app-nav]'], signedIn);
    assert.equal(accountOk.code, 0, accountOk.stderr);
    assert.equal(json(path.join(dir, 'account-ok', 'capture.json')).states['with-data'].screenshot, 'app/with-data.png');
    // A change-password form (new-password fields) is never a sign-in form.
    const security = await capture(dir, 'security', ['--url', `${server.url}/app?page=security`, '--auth', 'cookie'], signedIn);
    assert.equal(security.code, 0, security.stderr);

    // No form at all, but the signed-in app shell is missing: the selector catches it.
    const expired = await capture(dir, 'expired', ['--url', `${server.url}/expired`, '--signed-in-selector', '[data-testid=app-nav]', '--timeout', '1500']);
    const expiredManifest = assertSignIn(expired, path.join(dir, 'expired'), 'with-data', /\/expired$/);
    assert.match(expiredManifest.states['with-data'].failure.detail, /signed-in selector "\[data-testid=app-nav\]" is not visible/);
    const blind = await capture(dir, 'blind', ['--url', `${server.url}/expired`]);
    assert.equal(blind.code, 6, 'without a selector, "session has expired" wording on a small page is a sign-in page');
    assert.match(json(path.join(dir, 'blind', 'capture.json')).states['with-data'].failure.detail, /session ended/);
  } finally {
    await server.close();
  }
});

browserTest('capture: app.auth config knobs, an expired storage state, allowSignIn and allowNavigation', async () => {
  const server = await startServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const session = (req.headers.cookie || '').includes('session=ok');
    if (u.pathname === '/u/continue') return html(res, '<!doctype html><title>Acme</title><h1>One moment</h1>');
    if (u.pathname === '/sso-start') return redirect(res, '/u/continue');
    if (u.pathname === '/login') return html(res, SIGN_IN_HTML);
    if (u.pathname === '/orders' && !session) return redirect(res, '/login');
    return html(res, `${APP_PAGE}<a id="signout" href="/login">Sign out</a><a id="archive" href="/archive">Archive</a>`);
  });
  try {
    const dir = tmpDir();
    const config = path.join(dir, 'design-qa.config.json');
    writeFileSync(config, JSON.stringify({
      app: { baseUrl: server.url, auth: { type: 'storageState', signInUrlPattern: '/u/continue', signedInSelector: '[data-testid=app-nav]' } },
      surfaces: { orders: { route: '/orders' }, start: { route: '/sso-start' } },
    }));
    const expiredState = path.join(dir, 'expired-state.json');
    writeFileSync(expiredState, JSON.stringify({ cookies: [], origins: [] }));
    const goodState = path.join(dir, 'good-state.json');
    writeFileSync(goodState, JSON.stringify({ cookies: [{ name: 'session', value: 'ok', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] }));

    // The pattern from config flags a page the built-in heuristic would miss.
    const pattern = await capture(dir, 'pattern', ['--config', config, '--surface', 'start'], { DESIGN_QA_APP_STORAGE_STATE: goodState });
    const pm = assertSignIn(pattern, path.join(dir, 'pattern'), 'with-data', /\/u\/continue$/);
    assert.match(pm.states['with-data'].failure.detail, /matches the sign-in URL pattern/);

    // An expired storage state: the message says to save a fresh one.
    const expired = await capture(dir, 'expired', ['--config', config, '--surface', 'orders'], { DESIGN_QA_APP_STORAGE_STATE: expiredState });
    assertSignIn(expired, path.join(dir, 'expired'), 'with-data', /\/login$/);
    assert.match(expired.stderr, /The session in DESIGN_QA_APP_STORAGE_STATE did not sign in \(expired/);

    // A fresh one works; a sign-out state is captured on purpose with allowSignIn; an
    // allowNavigation click still navigates; an allowNavigation click into a sign-in page does not pass.
    const states = writeStates(dir, {
      'with-data': {},
      archived: { action: 'click', selector: '#archive', allowNavigation: true },
      'signed-out': { action: 'click', selector: '#signout', allowNavigation: true, allowSignIn: true },
    });
    const good = await capture(dir, 'good', ['--config', config, '--surface', 'orders', '--states', states], { DESIGN_QA_APP_STORAGE_STATE: goodState });
    assert.equal(good.code, 0, good.stderr);
    const goodManifest = json(path.join(dir, 'good', 'capture.json'));
    for (const state of ['with-data', 'archived', 'signed-out']) assert.equal(goodManifest.states[state].screenshot, `app/${state}.png`, state);
    assert.deepEqual(goodManifest.states['signed-out'].warnings, [], 'allowSignIn is a known driver key');

    const trap = writeStates(dir, { 'with-data': {}, 'signed-out': { action: 'click', selector: '#signout', allowNavigation: true } });
    const trapped = await capture(dir, 'trap', ['--config', config, '--surface', 'orders', '--states', trap], { DESIGN_QA_APP_STORAGE_STATE: goodState });
    assert.equal(trapped.code, 1, 'a sign-in page in a later state marks that state; exit 6 is for the base state');
    const trappedManifest = json(path.join(dir, 'trap', 'capture.json'));
    assert.equal(trappedManifest.states['signed-out'].failure.kind, 'sign-in');
    assert.ok(!existsSync(path.join(dir, 'trap', 'app', 'signed-out.png')));
    assert.equal(json(path.join(dir, 'trap', 'capture.json')).states['with-data'].screenshot, 'app/with-data.png', 'states captured before it are kept');

    // QA of the sign-in screen itself: the planned URL is the sign-in page.
    const screen = await capture(dir, 'screen', ['--url', `${server.url}/login`]);
    assert.equal(screen.code, 0, screen.stderr);
  } finally {
    await server.close();
  }
});

browserTest('capture --probe: reachable and signed in · sign-in needed · unreachable, and nothing is written', async () => {
  const TOKEN = 'tok_S3CRET-probe-9';
  const server = await startServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const session = (req.headers.cookie || '').includes('session=ok');
    if (u.pathname === '/login') return html(res, SIGN_IN_HTML);
    if (u.pathname === '/basic') return html(res, 'no', 401, { 'www-authenticate': 'Basic realm="x"' });
    if (u.pathname === '/broken') return html(res, 'boom', 500);
    if (!session) return redirect(res, `/login?next=${encodeURIComponent(req.url)}`);
    return html(res, APP_PAGE);
  });
  try {
    const dir = tmpDir();
    const probe = (args, env = {}) => run(CAPTURE, ['--probe', '--timeout', '8000', ...args], { env: { ...captureEnv, ...env }, cwd: dir });
    const stateFile = path.join(dir, 'state.json');
    writeFileSync(stateFile, JSON.stringify({ cookies: [{ name: 'session', value: 'ok', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] }));

    const signedOut = await probe(['--url', `${server.url}/orders?t=\${TOKEN}`], { TOKEN });
    assert.equal(signedOut.code, 6, signedOut.stderr);
    const so = JSON.parse(signedOut.stdout);
    assert.deepEqual(Object.keys(so), ['url', 'reachable', 'status', 'finalUrl', 'signIn', 'signedIn', 'title', 'detail']);
    assert.deepEqual([so.reachable, so.status, so.signIn, so.signedIn, so.title], [true, 200, true, false, 'Sign in']);
    assert.match(so.finalUrl, /\/login\?next=.*\$\{TOKEN\}/, 'the final URL is redacted');
    assert.match(signedOut.stderr, /shows a sign-in page .*needs a signed-in session/);
    assert.ok(!signedOut.stdout.includes(TOKEN) && !signedOut.stderr.includes(TOKEN));

    const signedIn = await probe(['--url', `${server.url}/orders`, '--auth', 'storage-state', '--signed-in-selector', '[data-testid=app-nav]'], { DESIGN_QA_APP_STORAGE_STATE: stateFile });
    assert.equal(signedIn.code, 0, signedIn.stderr);
    const si = JSON.parse(signedIn.stdout);
    assert.deepEqual([si.reachable, si.status, si.signIn, si.signedIn, si.finalUrl], [true, 200, false, true, `${server.url}/orders`]);
    assert.equal(signedIn.stderr, '');
    const noSelector = JSON.parse((await probe(['--url', `${server.url}/orders`, '--auth', 'storage-state'], { DESIGN_QA_APP_STORAGE_STATE: stateFile })).stdout);
    assert.equal(noSelector.signedIn, null, 'no selector: not a sign-in page, signed-in state unknown');

    const challenged = await probe(['--url', `${server.url}/basic`]);
    assert.equal(challenged.code, 6);
    assert.deepEqual([JSON.parse(challenged.stdout).status, JSON.parse(challenged.stdout).signIn], [401, true]);

    const broken = await probe(['--url', `${server.url}/broken`, '--quiet']);
    assert.equal(broken.code, 5);
    assert.deepEqual([JSON.parse(broken.stdout).reachable, JSON.parse(broken.stdout).status], [true, 500]);
    assert.equal(broken.stderr, '', '--quiet');

    const gone = await probe(['--url', 'http://127.0.0.1:9/', '--timeout', '3000']);
    assert.equal(gone.code, 5);
    const g = JSON.parse(gone.stdout);
    assert.deepEqual([g.reachable, g.status, g.signIn], [false, null, false]);
    assert.match(gone.stderr, /is not reachable/);

    // With a config: the URL comes from the surface; the with-data fixture fills {fixture}.
    const config = path.join(dir, 'design-qa.config.json');
    writeFileSync(config, JSON.stringify({ app: { baseUrl: server.url }, surfaces: { orders: { route: '/{fixture}', states: { 'with-data': { fixture: 'orders' } } } } }));
    const fromConfig = await probe(['--config', config]);
    assert.equal(fromConfig.code, 6);
    assert.equal(JSON.parse(fromConfig.stdout).url, `${server.url}/orders`);

    assert.equal((await probe(['--url', `${server.url}/orders`, '--out', path.join(dir, 'x')])).code, 2, '--probe captures nothing');
    assert.deepEqual(readdirSync(dir).sort(), ['design-qa.config.json', 'state.json'], 'nothing written');
  } finally {
    await server.close();
  }
});
