// Regression tests for capture.mjs hardening: secrets kept out of the evidence,
// redirects, waits, mocks, loading states, manifest merges, file collisions,
// header scoping, blocked pages, stale files and symlinks.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  expandEnv,
  holdsMock,
  isDrivable,
  isLoadingState,
  isPlainLocation,
  loadStates,
  locationKey,
  makeRedactor,
  mergeManifest,
  redirectLocation,
  sameLocation,
  secretEnvEntries,
} from '../skills/design-qa/scripts/lib/capture-helpers.mjs';
import { fixture, run, script, sendJson, startServer, tmpDir } from './_helpers.mjs';

const CAPTURE = script('capture.mjs');
const APP_HTML = readFileSync(fixture('app.html'), 'utf8');
const ITEMS = [{ name: 'Alpha' }, { name: 'Beta' }, { name: 'Gamma' }];
const captureEnv = { DESIGN_QA_COMMIT: 'test-commit', DESIGN_QA_BRANCH: 'test-branch' };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('expandEnv records substituted variables; only non-location values are secrets', () => {
  const used = new Map();
  const env = { APP_URL: 'http://127.0.0.1:3000', TOKEN: 'tok_S3CRET', SHARE: 'https://x.vercel.app/?_vercel_share=abc', SHORT: 'on' };
  assert.equal(expandEnv('${APP_URL}/items', env, 'url', used), 'http://127.0.0.1:3000/items');
  expandEnv({ storage: { local: { t: '${TOKEN}' } }, q: ['${SHARE}', '${SHORT}'] }, env, 'state', used);
  assert.deepEqual([...used.keys()], ['APP_URL', 'TOKEN', 'SHARE', 'SHORT']);
  assert.equal(isPlainLocation('http://127.0.0.1:3000'), true);
  assert.equal(isPlainLocation('https://u:p@host/'), false, 'credentials in a URL are secret');
  assert.equal(isPlainLocation(env.SHARE), false, 'a URL with a query is secret');
  assert.deepEqual(secretEnvEntries(used), [['TOKEN', 'tok_S3CRET'], ['SHARE', env.SHARE]], 'base URLs and values under 3 chars are not redacted');
});

test('makeRedactor replaces env values (raw and URL-encoded) with ${NAME} and other secrets with ***', () => {
  const redact = makeRedactor({ secrets: ['hunter22'], envEntries: [['TOKEN', 'a+b/c=d9']] });
  assert.equal(redact('raw a+b/c=d9'), 'raw ${TOKEN}');
  assert.equal(redact('http://h/?t=a%2Bb%2Fc%3Dd9'), 'http://h/?t=${TOKEN}', 'encodeURIComponent form');
  assert.equal(redact('http://h/?t=a+b%2Fc%3Dd9'), 'http://h/?t=${TOKEN}', 'written into a query string: "+" is a space there');
  assert.equal(redact('login failed: hunter22'), 'login failed: ***');
  assert.equal(makeRedactor()('nothing to hide'), 'nothing to hide');
});

test('loading and with-data detection match state names exactly; mocks are held only for loading', () => {
  assert.equal(isLoadingState('Items / Loading', {}), true);
  assert.equal(isLoadingState('pending orders', {}), false);
  assert.equal(isLoadingState('Fetching done', {}), false);
  assert.equal(isLoadingState('Not loading', {}), false);
  assert.equal(isDrivable('Data table', {}), false, '"Data table" is not the default render');
  assert.equal(isDrivable('with data', {}), true);
  const mock = (m) => ({ mock: { urlPattern: '**/api/*', ...m } });
  assert.equal(holdsMock('loading', mock({ delayMs: 300 })), true, 'a loading state with a delay is held');
  assert.equal(holdsMock('loading', mock({ delayMs: 300, status: 200, body: [] })), true);
  assert.equal(holdsMock('loading', mock({ status: 200, body: [] })), false, 'no delay: answered at once');
  assert.equal(holdsMock('slow', mock({ delayMs: 1500 })), true, 'a delay-only mock of a second or more');
  assert.equal(holdsMock('empty', mock({ delayMs: 5000, status: 200, body: [] })), false, 'answered after its delay');
  assert.equal(holdsMock('loading', {}), false);
});

test('locationKey ignores query, fragment and trailing slashes', () => {
  assert.equal(locationKey('http://h:1/items/?a=1#x'), locationKey('http://h:1/items'));
  assert.notEqual(locationKey('http://h:1/items'), locationKey('http://h:1/login'));
  assert.notEqual(locationKey('http://h:1/items'), locationKey('https://h:1/items'));
  assert.equal(locationKey('http://h/a%20b'), locationKey('http://h/a b'));
});

test('sameLocation forgives an http → https upgrade of the same host and a trailing slash, nothing else', () => {
  assert.equal(sameLocation('http://h.test/items', 'https://h.test/items/'), true, 'upgraded to https');
  assert.equal(sameLocation('http://h.test/items', 'http://h.test/items/'), true, 'trailing slash');
  assert.equal(sameLocation('http://h.test/', 'http://h.test/#/login'), true, 'hash routes are not compared');
  assert.equal(sameLocation('https://h.test/items', 'http://h.test/items'), false, 'a downgrade');
  assert.equal(sameLocation('http://h.test/items', 'https://www.h.test/items'), false, 'another host');
  assert.equal(sameLocation('http://h.test:8080/items', 'https://h.test:8443/items'), false, 'another port');
  assert.equal(sameLocation('http://h.test/', 'http://h.test/en/'), false, 'a locale prefix is another page');
});

test('redirectLocation resolves a 3xx Location against the request URL', () => {
  assert.equal(redirectLocation(302, '/en/', 'http://h.test/a/b'), 'http://h.test/en/');
  assert.equal(redirectLocation(307, 'c', 'http://h.test/a/b'), 'http://h.test/a/c');
  assert.equal(redirectLocation(308, 'https://sso.test/login', 'http://h.test/'), 'https://sso.test/login');
  assert.equal(redirectLocation(200, '/x', 'http://h.test/'), null, 'not a redirect');
  assert.equal(redirectLocation(304, '/x', 'http://h.test/'), null, 'not modified is not a redirect');
  assert.equal(redirectLocation(302, undefined, 'http://h.test/'), null, 'no Location');
});

test('state names that write the same evidence files are rejected', () => {
  assert.throws(() => loadStates({ statesFile: { 'with data': {}, 'with-data': {} } }), (err) => err.exitCode === 2 && /would write the same evidence files \(with-data\.png\)/.test(err.message));
  assert.throws(() => loadStates({ statesFile: { Empty: { query: 'a=1' }, empty: { query: 'b=1' } } }), /"Empty" and "empty" would write the same evidence files/);
  assert.equal(loadStates({ statesFile: { empty: {}, 'empty-2': {} } }).length, 2);
});

test('mergeManifest keeps other states of the same capture and refuses a different one', () => {
  const base = { side: 'app', url: 'http://h/items', viewport: { width: 800, height: 600 }, fullPage: false, commit: 'a' };
  const previous = {
    ...base,
    states: { 'with-data': { screenshot: 'app/with-data.png' }, Empty: { screenshot: 'app/Empty.png' }, hover: { screenshot: 'app/hover.png' } },
    degradations: [{ step: 'motion:with-data', reason: 'x' }, { step: 'capture:hover', reason: 'old' }, { step: 'capture:login', reason: 'old login' }],
  };
  const next = { ...base, states: { hover: { screenshot: 'app/hover.png', fresh: true }, empty: { screenshot: 'app/empty.png' } }, degradations: [] };
  const merged = mergeManifest(previous, next, ['hover', 'empty']);
  assert.equal(merged.mismatch, null);
  assert.deepEqual(Object.keys(merged.manifest.states), ['with-data', 'hover', 'empty'], '"Empty" is replaced by "empty" (same file)');
  assert.equal(merged.manifest.states.hover.fresh, true);
  assert.deepEqual(merged.kept, ['with-data']);
  assert.deepEqual(merged.replaced, ['Empty']);
  assert.deepEqual(merged.manifest.degradations, [{ step: 'motion:with-data', reason: 'x' }], 'only kept states keep their degradations');
  const otherCommit = mergeManifest(previous, { ...next, commit: 'b' }, ['hover', 'empty']);
  assert.match(otherCommit.manifest.degradations.at(-1).reason, /kept with-data from a capture of commit a; re-captured hover, empty at b/);
  const wider = mergeManifest(previous, { ...next, viewport: { width: 1024, height: 600 } }, ['hover']);
  assert.match(wider.mismatch, /viewport \(800×600\)/);
  assert.deepEqual(Object.keys(wider.manifest.states), ['hover', 'empty'], 'a different capture: a fresh manifest');
  assert.match(mergeManifest({ ...previous, side: 'design' }, next, ['hover']).mismatch, /side/);
  assert.match(mergeManifest({ ...previous, url: 'http://h/other' }, next, ['hover']).mismatch, /url/);
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
  test(name, { timeout: 120000 }, async (t) => {
    if (!CHROMIUM) {
      t.skip(SKIP_REASON);
      return;
    }
    await fn(t);
  });

const html = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
};
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const listFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const writeStates = (dir, states) => {
  const file = path.join(dir, `states-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(states));
  return file;
};

browserTest('capture: ${ENV} secrets never reach capture.json, dom/, error messages, stdout or stderr', async () => {
  const TOKEN = 'tok_S3CRET-7f9a2c41';
  const server = await startServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/items') return sendJson(res, 200, ITEMS);
    if (u.pathname === '/elsewhere') return html(res, '<!doctype html><title>Elsewhere</title><h1>Elsewhere</h1>');
    if (u.searchParams.get('go') === 'away') {
      res.writeHead(302, { location: `/elsewhere?next=${encodeURIComponent(req.url)}` });
      return res.end();
    }
    return html(res, APP_HTML);
  });
  try {
    const dir = tmpDir();
    const states = writeStates(dir, {
      'with-data': { storage: { local: { authToken: '${TOKEN}' } }, wait: '.row' },
      empty: { query: 'token=${TOKEN}', mock: { urlPattern: '**/api/items*', status: 200, body: [] }, wait: '.empty' },
      error: { query: 'go=away&t=${TOKEN}' },
    });
    const out = path.join(dir, 'evidence');
    const res = await run(CAPTURE, ['--url', `${server.url}/app`, '--width', '400', '--height', '300', '--states', states, '--header', 'x-api-key=${TOKEN}', '--out', out], {
      env: { ...captureEnv, TOKEN },
      cwd: dir,
    });
    assert.equal(res.code, 1, `${res.stdout}\n${res.stderr}`);
    assert.ok(server.requests.some((r) => r.url.includes(TOKEN)), 'the secret was really used');
    for (const file of listFiles(out)) assert.ok(!readFileSync(file).includes(TOKEN), `${path.relative(out, file)} leaks the secret`);
    assert.ok(!res.stdout.includes(TOKEN) && !res.stderr.includes(TOKEN), 'nothing printed');
    assert.match(res.stderr, /state "error" failed: ended on .*\/elsewhere\?next=.*\$\{TOKEN\}/);

    const manifest = json(path.join(out, 'capture.json'));
    assert.deepEqual(manifest.states['with-data'].driver.storage, { local: { authToken: '${TOKEN}' } }, 'drivers are written as templates');
    assert.equal(manifest.states.empty.driver.query, 'token=${TOKEN}');
    assert.equal(manifest.states.empty.url, `${server.url}/app?token=\${TOKEN}`);
    assert.equal(manifest.url, `${server.url}/app`);
    assert.equal(json(path.join(out, 'dom', 'empty.json')).url, `${server.url}/app?token=\${TOKEN}`);
    assert.match(manifest.states.error.error, /\$\{TOKEN\}/);
  } finally {
    await server.close();
  }
});

browserTest('capture: a redirect or navigation away fails the state; every state redirected exits 5', async () => {
  // Redirects to another route that is not a sign-in page (those exit 6: capture-signin.test.mjs).
  const server = await startServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/protected') {
      res.writeHead(302, { location: '/elsewhere' });
      return res.end();
    }
    if (u.pathname === '/elsewhere') return html(res, '<!doctype html><title>Elsewhere</title><h1>Another page</h1>');
    if (u.pathname === '/away') return html(res, '<!doctype html><h1>Orders</h1><script>setTimeout(() => { location.href = "/elsewhere"; }, 200)</script>');
    return html(res, '<!doctype html><title>Orders</title><h1>Orders</h1><a id="next" href="/elsewhere">Archive</a>');
  });
  try {
    const dir = tmpDir();
    const both = writeStates(dir, { 'with-data': {}, empty: { query: 'state=empty' } });
    const denied = await run(CAPTURE, ['--url', `${server.url}/protected`, '--width', '400', '--height', '300', '--states', both, '--out', path.join(dir, 'denied')], { env: captureEnv, cwd: dir });
    assert.equal(denied.code, 5, denied.stderr);
    assert.match(denied.stderr, /every state ended on another page \(last: .*\/elsewhere\).*routing problem/);
    const deniedManifest = json(path.join(dir, 'denied', 'capture.json'));
    assert.match(deniedManifest.states['with-data'].error, /ended on .*\/elsewhere instead of .*\/protected .*the server redirected/);
    assert.equal(deniedManifest.states['with-data'].screenshot, null);
    assert.equal(deniedManifest.states['with-data'].failure.kind, 'navigation');
    assert.equal(deniedManifest.failure.kind, 'navigation');
    assert.ok(!existsSync(path.join(dir, 'denied', 'app', 'with-data.png')), 'no other page saved as with-data');

    const away = await run(CAPTURE, ['--url', `${server.url}/away`, '--width', '400', '--height', '300', '--wait', 'h1', '--out', path.join(dir, 'away')], { env: captureEnv, cwd: dir });
    assert.equal(away.code, 5, 'a script navigating away is caught too');
    assert.match(away.stderr, /the page navigated away/);

    const clicks = writeStates(dir, {
      'with-data': {},
      clicked: { action: 'click', selector: '#next' },
      'signed-out': { action: 'click', selector: '#next', allowNavigation: true },
    });
    const mixed = await run(CAPTURE, ['--url', `${server.url}/orders`, '--width', '400', '--height', '300', '--states', clicks, '--out', path.join(dir, 'mixed')], { env: captureEnv, cwd: dir });
    assert.equal(mixed.code, 1, mixed.stderr);
    const manifest = json(path.join(dir, 'mixed', 'capture.json'));
    assert.equal(manifest.states['with-data'].screenshot, 'app/with-data.png');
    assert.match(manifest.states.clicked.error, /navigated away .*"allowNavigation": true/);
    assert.equal(manifest.states['signed-out'].screenshot, 'app/signed-out.png', 'allowNavigation opts out');
    assert.deepEqual(manifest.states['signed-out'].warnings, [], 'allowNavigation is a known driver key');
  } finally {
    await server.close();
  }
});

browserTest('capture: --wait <selector> still waits for a slow API before the screenshot', async () => {
  const server = await startServer(async (req, res) => {
    if (req.url.startsWith('/api/items')) {
      await new Promise((r) => setTimeout(r, 1200));
      return sendJson(res, 200, ITEMS);
    }
    return html(res, APP_HTML);
  });
  try {
    const dir = tmpDir();
    const res = await run(CAPTURE, ['--url', `${server.url}/`, '--width', '400', '--height', '300', '--wait', 'h1', '--out', dir], { env: captureEnv, cwd: dir });
    assert.equal(res.code, 0, res.stderr);
    assert.ok(json(path.join(dir, 'dom', 'with-data.json')).texts.includes('Alpha'), 'with-data shows the data, not the spinner');
  } finally {
    await server.close();
  }
});

browserTest('capture: a mock that matches no request is a warning and a degradation', async () => {
  const page = APP_HTML.replace("fetch('/api/items')", "fetch('/api/items?page=1')");
  const server = await startServer((req, res) => (req.url.startsWith('/api/items') ? sendJson(res, 200, ITEMS) : html(res, page)));
  try {
    const dir = tmpDir();
    const states = writeStates(dir, {
      empty: { mock: { urlPattern: '**/api/items', status: 200, body: [] } },
      'empty-any-query': { mock: { urlPattern: '**/api/items{,?**}', status: 200, body: [] } },
    });
    const res = await run(CAPTURE, ['--url', `${server.url}/`, '--width', '400', '--height', '300', '--states', states, '--out', dir], { env: captureEnv, cwd: dir });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /captured empty .*mock urlPattern "\*\*\/api\/items" matched no request/);
    const manifest = json(path.join(dir, 'capture.json'));
    assert.deepEqual(manifest.states.empty.degradations.map((d) => d.step), ['mock:empty']);
    assert.ok(manifest.degradations.some((d) => d.step === 'mock:empty' && /matched no request/.test(d.reason)));
    assert.deepEqual(manifest.states['empty-any-query'].degradations, []);
    assert.ok(json(path.join(dir, 'dom', 'empty-any-query.json')).texts.includes('No items yet'));
  } finally {
    await server.close();
  }
});

browserTest('capture: a loading state holds its delayed request until the screenshot is taken', async () => {
  const server = await startServer((req, res) => (req.url.startsWith('/api/items') ? sendJson(res, 200, ITEMS) : html(res, APP_HTML)));
  try {
    const dir = tmpDir();
    const states = writeStates(dir, {
      // 1.2 s is shorter than the 1.5 s loading settle: released after its delay, the
      // data would be on screen by the time of the screenshot.
      loading: { mock: { urlPattern: '**/api/items', delayMs: 1200 } },
      Skeleton: { mock: { urlPattern: '**/api/items', status: 200, body: [{ name: 'Zed' }] } },
    });
    const res = await run(CAPTURE, ['--url', `${server.url}/`, '--width', '400', '--height', '300', '--states', states, '--out', dir], { env: captureEnv, cwd: dir });
    assert.equal(res.code, 0, res.stderr);
    const dom = json(path.join(dir, 'dom', 'loading.json'));
    assert.ok(!dom.texts.includes('Alpha'), 'captured while loading');
    assert.ok(dom.elements.some((e) => e.role === 'status'), 'the spinner is on screen');
    const manifest = json(path.join(dir, 'capture.json'));
    assert.deepEqual(manifest.states.loading.degradations, []);
    assert.match(manifest.states.Skeleton.warnings.join(' '), /answered before the screenshot/, 'an undelayed mock in a loading state is flagged');
  } finally {
    await server.close();
  }
});

browserTest('capture: --state merges into the existing manifest of the same capture', async () => {
  const server = await startServer((req, res) => (req.url.startsWith('/api/items') ? sendJson(res, 200, ITEMS) : html(res, APP_HTML)));
  try {
    const dir = tmpDir();
    const states = writeStates(dir, { 'with-data': { wait: '.row' }, empty: { mock: { urlPattern: '**/api/items', body: [] }, wait: '.empty' } });
    const base = ['--url', `${server.url}/`, '--height', '300', '--out', dir];
    const full = await run(CAPTURE, [...base, '--width', '400', '--states', states], { env: captureEnv, cwd: dir });
    assert.equal(full.code, 0, full.stderr);

    const hover = await run(CAPTURE, [...base, '--width', '400', '--state', 'hover', '--driver', '{"action":"hover","selector":".row","wait":".row"}'], { env: captureEnv, cwd: dir });
    assert.equal(hover.code, 0, hover.stderr);
    assert.match(hover.stdout, /kept 2 state\(s\) from the previous capture\.json: with-data, empty/);
    assert.match(hover.stdout, /\(3\/3 states captured\)/);
    const merged = json(path.join(dir, 'capture.json'));
    assert.deepEqual(Object.keys(merged.states), ['with-data', 'empty', 'hover']);
    assert.equal(merged.states.empty.screenshot, 'app/empty.png');

    const again = await run(CAPTURE, [...base, '--width', '400', '--states', states, '--state', 'empty'], { env: captureEnv, cwd: dir });
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(Object.keys(json(path.join(dir, 'capture.json')).states), ['with-data', 'empty', 'hover'], 're-captured in place');

    const wider = await run(CAPTURE, [...base, '--width', '500', '--states', states, '--state', 'empty'], { env: captureEnv, cwd: dir });
    assert.equal(wider.code, 0, wider.stderr);
    assert.match(wider.stderr, /warning: .*capture\.json was captured with another viewport \(400×300\); replaced by a fresh manifest/);
    assert.deepEqual(Object.keys(json(path.join(dir, 'capture.json')).states), ['empty']);
  } finally {
    await server.close();
  }
});

browserTest('capture: colliding state names exit 2 before launching a browser', async () => {
  const dir = tmpDir();
  const states = writeStates(dir, { 'with data': { query: 'a=1' }, 'with-data': {} });
  const res = await run(CAPTURE, ['--url', 'http://127.0.0.1:9/', '--width', '400', '--height', '300', '--states', states, '--out', path.join(dir, 'out')], { env: captureEnv, cwd: dir });
  assert.equal(res.code, 2, res.stderr);
  assert.match(res.stderr, /states "with data" and "with-data" would write the same evidence files/);
  assert.ok(!existsSync(path.join(dir, 'out')));
});

browserTest('capture: --header goes only to the app origin, also through a let-through mock; cookies still apply', async () => {
  const third = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/gif' });
    res.end();
  });
  const page = `<!doctype html><title>x</title><h1>Items</h1><img src="${third.url}/pixel.gif" alt="">` +
    '<script>fetch("/api/items").then((r) => r.json()).then((d) => { document.querySelector("h1").textContent = "Items " + d.length; });</script>';
  const app = await startServer((req, res) => {
    if (!(req.headers.cookie || '').includes('session=abc123')) return html(res, 'unauthorised', 401);
    return req.url.startsWith('/api/items') ? sendJson(res, 200, ITEMS) : html(res, page);
  });
  try {
    const dir = tmpDir();
    const states = writeStates(dir, { 'with-data': {}, slow: { mock: { urlPattern: '**/api/items', delayMs: 50 } } });
    const res = await run(
      CAPTURE,
      ['--url', `${app.url}/`, '--width', '400', '--height', '300', '--auth', 'cookie', '--header', 'x-bypass=${BYPASS}', '--states', states, '--out', dir],
      { env: { ...captureEnv, BYPASS: 'bypass-secret-123', DESIGN_QA_APP_COOKIE: 'session=abc123' }, cwd: dir },
    );
    assert.equal(res.code, 0, res.stderr);
    assert.ok(app.requests.length >= 4, 'page and API for both states');
    for (const r of app.requests) assert.equal(r.headers['x-bypass'], 'bypass-secret-123', `${r.url} carries the header`);
    assert.equal(app.requests.filter((r) => r.url === '/api/items').length, 2, 'the delayed mock let the request through');
    assert.ok(third.requests.length >= 1, 'the third-party image was requested');
    for (const r of third.requests) assert.equal(r.headers['x-bypass'], undefined, 'never sent to another origin');
    assert.equal(json(path.join(dir, 'dom', 'slow.json')).texts[0], 'Items 3');
  } finally {
    await app.close();
    await third.close();
  }
});

browserTest('capture: a page blocking its main thread fails the state instead of hanging; stale files are removed', async () => {
  const server = await startServer((req, res) =>
    html(res, '<!doctype html><title>x</title><h1>Busy</h1><script>addEventListener("load", () => setTimeout(() => { for (;;) {} }, 300));</script>'),
  );
  try {
    const dir = tmpDir();
    // Evidence from an earlier run that this failure must not leave behind.
    for (const rel of ['app/with-data.png', 'computed/with-data.json', 'dom/with-data.json', 'motion/with-data.json']) {
      mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), 'stale');
    }
    const started = Date.now();
    const res = await run(CAPTURE, ['--url', `${server.url}/`, '--width', '400', '--height', '300', '--timeout', '2000', '--out', dir], { env: captureEnv, cwd: dir, timeout: 60000 });
    assert.equal(res.code, 1, res.stderr);
    assert.ok(Date.now() - started < 45000, 'bounded by --timeout');
    assert.match(res.stderr, /did not finish within 2000 ms \(the page may be blocking its main thread\)/);
    const manifest = json(path.join(dir, 'capture.json'));
    assert.equal(manifest.states['with-data'].screenshot, null);
    for (const rel of ['app/with-data.png', 'computed/with-data.json', 'dom/with-data.json', 'motion/with-data.json']) {
      assert.ok(!existsSync(path.join(dir, rel)), `${rel} removed`);
    }
  } finally {
    await server.close();
  }
});

browserTest('capture: evidence is never written through a symlink planted in --out', async () => {
  const server = await startServer((req, res) => (req.url.startsWith('/api/items') ? sendJson(res, 200, ITEMS) : html(res, APP_HTML)));
  try {
    const dir = tmpDir();
    const out = path.join(dir, 'evidence');
    const outside = path.join(dir, 'outside');
    mkdirSync(path.join(out, 'app'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'victim.txt'), 'keep');
    writeFileSync(path.join(outside, 'manifest.txt'), 'keep');
    symlinkSync(path.join(outside, 'victim.txt'), path.join(out, 'app', 'with-data.png'));
    symlinkSync(path.join(outside, 'manifest.txt'), path.join(out, 'capture.json'));
    symlinkSync(outside, path.join(out, 'computed'));
    const res = await run(CAPTURE, ['--url', `${server.url}/`, '--width', '400', '--height', '300', '--wait', 'h1', '--out', out], { env: captureEnv, cwd: dir });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(readFileSync(path.join(outside, 'victim.txt'), 'utf8'), 'keep');
    assert.equal(readFileSync(path.join(outside, 'manifest.txt'), 'utf8'), 'keep');
    assert.deepEqual(readdirSync(outside).sort(), ['manifest.txt', 'victim.txt'], 'nothing written into the linked folder');
    for (const rel of ['app/with-data.png', 'capture.json', 'computed', 'computed/with-data.json']) {
      assert.equal(lstatSync(path.join(out, rel)).isSymbolicLink(), false, `${rel} is a real file or folder`);
    }
    assert.equal(json(path.join(out, 'capture.json')).states['with-data'].screenshot, 'app/with-data.png');
  } finally {
    await server.close();
  }
});

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const png = (res) => {
  res.writeHead(200, { 'content-type': 'image/png' });
  res.end(PNG_1PX);
};
const redirect = (res, location, status = 302, headers = {}) => {
  res.writeHead(status, { location, ...headers });
  res.end();
};

browserTest('capture: --header never follows a redirect off the app origin; same-origin hops keep it; Set-Cookie applies', async () => {
  const third = await startServer((req, res) => {
    if (req.url.startsWith('/lib.js')) {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end('window.thirdScript = true;');
    }
    if (req.url.startsWith('/landing')) return html(res, '<!doctype html><title>Landing</title><h1>Landing</h1>');
    return png(res);
  });
  const page =
    '<!doctype html><title>Items</title><h1>Items</h1><p id="out"></p>' +
    '<img id="cdn" src="/redir.png" alt=""><img id="local" src="/same.png" alt=""><script src="/redir.js"></script>' +
    '<script>addEventListener("load", async () => { const me = await fetch("/api/me").then((r) => r.json());' +
    ' const out = document.getElementById("out");' +
    ' out.textContent = [...document.images].map((i) => i.id + ":" + i.naturalWidth).join(" ") + " script:" + Boolean(window.thirdScript) + " cookie:" + me.cookie;' +
    ' out.dataset.done = "1"; });</script>';
  const app = await startServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'sid=fromapp; Path=/' });
      return res.end(page);
    }
    if (u.pathname === '/redir.png') return redirect(res, `${third.url}/cdn.png`);
    if (u.pathname === '/redir.js') return redirect(res, `${third.url}/lib.js`, 307);
    if (u.pathname === '/same.png') return redirect(res, '/real.png');
    if (u.pathname === '/real.png') return png(res);
    if (u.pathname === '/api/me') return sendJson(res, 200, { cookie: req.headers.cookie ?? '' });
    if (u.pathname === '/home') return redirect(res, '/en/', 302, { 'set-cookie': 'lang=en; Path=/' });
    if (u.pathname === '/en/') return html(res, '<!doctype html><title>English</title><h1>English</h1>');
    if (u.pathname === '/start') return redirect(res, `${third.url}/landing`);
    return html(res, 'not found', 404);
  });
  try {
    const dir = tmpDir();
    const states = writeStates(dir, {
      'with-data': { fixture: 'page', wait: '#out[data-done]' },
      english: { fixture: 'home', allowNavigation: true },
      offsite: { fixture: 'start' },
    });
    const res = await run(
      CAPTURE,
      ['--url', `${app.url}/{fixture}`, '--width', '400', '--height', '300', '--states', states, '--header', 'x-bypass=${BYPASS}', '--header', 'Authorization=Bearer ${TOKEN}', '--out', dir],
      { env: { ...captureEnv, BYPASS: 'bypass-secret-123', TOKEN: 'tok-secret-789' }, cwd: dir },
    );
    assert.equal(res.code, 1, `${res.stdout}\n${res.stderr}`);
    const thirdPaths = third.requests.map((r) => r.url);
    for (const p of ['/cdn.png', '/lib.js', '/landing']) assert.ok(thirdPaths.includes(p), `the redirect to ${p} was followed`);
    for (const r of third.requests) {
      assert.equal(r.headers['x-bypass'], undefined, `${r.url}: no bypass header off the app origin`);
      assert.equal(r.headers.authorization, undefined, `${r.url}: no bearer token off the app origin`);
    }
    for (const p of ['/page', '/redir.png', '/redir.js', '/same.png', '/real.png', '/api/me', '/home', '/en/', '/start']) {
      assert.ok(app.requests.some((r) => r.url === p), `${p} was requested`);
    }
    for (const r of app.requests) {
      assert.equal(r.headers['x-bypass'], 'bypass-secret-123', `${r.url} carries the header (same-origin hops included)`);
      assert.equal(r.headers.authorization, 'Bearer tok-secret-789', `${r.url} carries the token`);
    }
    assert.ok(app.requests.filter((r) => r.url === '/en/').every((r) => /lang=en/.test(r.headers.cookie ?? '')), 'a cookie set on a redirect applies to its hop');
    const texts = json(path.join(dir, 'dom', 'with-data.json')).texts.join(' ');
    assert.match(texts, /cdn:1 local:1 script:true cookie:sid=fromapp/, 'redirected assets load and the Set-Cookie from the page is sent back');
    const manifest = json(path.join(dir, 'capture.json'));
    assert.equal(manifest.states.english.screenshot, 'app/english.png');
    assert.match(manifest.states.offsite.error, /ended on .*\/landing instead of .*\/start \(the server redirected\)/);
  } finally {
    await app.close();
    await third.close();
  }
});

browserTest('capture: basic credentials answer only the app origin\'s 401 challenge', async () => {
  const challenge = (res, realm) => {
    res.writeHead(401, { 'www-authenticate': `Basic realm="${realm}"`, 'content-type': 'text/plain' });
    res.end('sign in');
  };
  const third = await startServer((req, res) => (req.headers.authorization ? png(res) : challenge(res, 'third')));
  const page = `<!doctype html><title>x</title><h1>Signed in</h1><img src="${third.url}/pixel.png" alt=""><iframe src="${third.url}/frame"></iframe>`;
  const expected = `Basic ${Buffer.from('qa-user:hunter2-secret').toString('base64')}`;
  const app = await startServer((req, res) => (req.headers.authorization === expected ? html(res, page) : challenge(res, 'app')));
  try {
    const dir = tmpDir();
    const env = { ...captureEnv, DESIGN_QA_APP_USER: 'qa-user', DESIGN_QA_APP_PASS: 'hunter2-secret', BYPASS: 'bypass-secret-123' };
    // Without headers the browser answers the challenge; with one, capture fetches app requests itself.
    for (const [name, extra] of [['plain', []], ['with-header', ['--header', 'x-bypass=${BYPASS}']]]) {
      const res = await run(CAPTURE, ['--url', `${app.url}/`, '--width', '400', '--height', '300', '--auth', 'basic', ...extra, '--out', path.join(dir, name)], { env, cwd: dir });
      assert.equal(res.code, 0, `${name}: ${res.stderr}`);
      assert.deepEqual(json(path.join(dir, name, 'dom', 'with-data.json')).texts, ['Signed in'], `${name}: the app authenticated`);
    }
    assert.ok(app.requests.some((r) => r.headers.authorization === expected), 'the app got the credentials');
    assert.ok(third.requests.length >= 4, 'the third-party image and frame were requested in both runs');
    for (const r of third.requests) assert.equal(r.headers.authorization, undefined, `${r.url}: no credentials for another origin`);
  } finally {
    await app.close();
    await third.close();
  }
});

browserTest('capture: --allow-navigation and capture.allowNavigation accept an app that always redirects; a trailing slash is no navigation', async () => {
  const server = await startServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/') return redirect(res, '/en/');
    if (u.pathname === '/items') return redirect(res, '/items/', 301);
    return html(res, `<!doctype html><title>x</title><h1>${u.pathname}</h1>`);
  });
  try {
    const dir = tmpDir();
    const capture = (name, args) => run(CAPTURE, ['--width', '400', '--height', '300', '--out', path.join(dir, name), ...args], { env: captureEnv, cwd: dir });

    const slash = await capture('slash', ['--url', `${server.url}/items`]);
    assert.equal(slash.code, 0, `a trailing-slash redirect is the same page: ${slash.stderr}`);

    const locale = await capture('locale', ['--url', `${server.url}/`]);
    assert.equal(locale.code, 5, locale.stderr);
    assert.match(locale.stderr, /every state ended on another page .*pass --allow-navigation/);

    const states = writeStates(dir, { 'with-data': {}, strict: { query: 'x=1', allowNavigation: false } });
    const lenient = await capture('lenient', ['--url', `${server.url}/`, '--allow-navigation', '--states', states]);
    assert.equal(lenient.code, 1, lenient.stderr);
    const manifest = json(path.join(dir, 'lenient', 'capture.json'));
    assert.equal(manifest.states['with-data'].screenshot, 'app/with-data.png', '--allow-navigation accepts /en/');
    assert.match(manifest.states.strict.error, /ended on .*\/en\//, 'a state\'s own "allowNavigation": false still checks');
    assert.equal(json(path.join(dir, 'lenient', 'dom', 'with-data.json')).url, `${server.url}/en/`);

    const config = path.join(dir, 'design-qa.config.json');
    writeFileSync(config, JSON.stringify({ app: { baseUrl: server.url }, surfaces: { home: { route: '/' } }, capture: { allowNavigation: true } }));
    const fromConfig = await capture('config', ['--config', config]);
    assert.equal(fromConfig.code, 0, fromConfig.stderr);
    assert.equal(json(path.join(dir, 'config', 'capture.json')).states['with-data'].screenshot, 'app/with-data.png');
  } finally {
    await server.close();
  }
});
