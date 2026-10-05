import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildStateUrl,
  checkDriver,
  checkGrab,
  configDefaults,
  expandEnv,
  isDrivable,
  isLoadingState,
  loadStates,
  normalizeAuthType,
  parseCookieString,
  parseHeaders,
  parseKeys,
  redact,
  resolveAuth,
} from '../skills/design-qa/scripts/lib/capture-helpers.mjs';
import { readPng } from '../skills/design-qa/scripts/lib/png.mjs';
import { fixture, loadFixture, run, script, sendJson, startServer, tmpDir } from './_helpers.mjs';

const CAPTURE = script('capture.mjs');

// ---------------------------------------------------------------------------
// Pure helpers (no browser needed)
// ---------------------------------------------------------------------------

test('expandEnv expands ${VAR} recursively and rejects missing variables', () => {
  const env = { HOST: 'example.com', TOKEN: 't0k' };
  assert.equal(expandEnv('https://${HOST}/x', env), 'https://example.com/x');
  assert.deepEqual(expandEnv({ a: ['${TOKEN}', 1, null], b: { c: '${HOST}' } }, env), { a: ['t0k', 1, null], b: { c: 'example.com' } });
  assert.throws(() => expandEnv('${NOPE}', env, 'states.json'), (err) => err.exitCode === 2 && /NOPE is not set .*states\.json/.test(err.message));
  assert.equal(expandEnv('$HOST and ${ not a var', env), '$HOST and ${ not a var', 'only ${NAME} is a placeholder');
});

test('headers, cookies, auth types, keys and redaction', () => {
  assert.deepEqual(parseHeaders(['x-bypass=${T}', 'Accept-Language: en'], { T: 'secret' }), { 'x-bypass': 'secret', 'Accept-Language': 'en' });
  assert.throws(() => parseHeaders(['novalue']), /expected name=value/);
  assert.deepEqual(parseCookieString('session=abc; theme=dark=1', 'https://app.example.com:8443/items'), [
    { name: 'session', value: 'abc', url: 'https://app.example.com:8443/' },
    { name: 'theme', value: 'dark=1', url: 'https://app.example.com:8443/' },
  ]);
  assert.equal(normalizeAuthType(undefined), 'none');
  assert.equal(normalizeAuthType('storageState'), 'storage-state');
  assert.throws(() => normalizeAuthType('oauth'), /--auth must be one of/);
  assert.deepEqual(parseKeys('Tab Tab,Shift+Tab'), ['Tab', 'Tab', 'Shift+Tab']);
  assert.equal(redact('login failed for bob with hunter2', ['hunter2', 'bob']), 'login failed for *** with ***');
});

test('resolveAuth reads <PREFIX>_* variables', () => {
  const env = { APP_USER: 'u', APP_PASS: 'p4ss', APP_COOKIE: 'sid=1', APP_STORAGE_STATE: '/tmp/state.json' };
  assert.deepEqual(resolveAuth('basic', 'APP', env, 'http://x.test/items?a=1').httpCredentials, { username: 'u', password: 'p4ss', origin: 'http://x.test' }, 'bound to the URL origin');
  assert.equal(resolveAuth('basic', 'APP', env, 'https://proto.framer.app:8443/p').httpCredentials.origin, 'https://proto.framer.app:8443', '--side design: the prototype origin');
  assert.equal(resolveAuth('cookie', 'APP', env, 'http://x.test').cookies[0].name, 'sid');
  assert.equal(resolveAuth('storage-state', 'APP', env, 'http://x.test').storageStatePath, '/tmp/state.json');
  assert.deepEqual(resolveAuth('none', 'APP', {}, 'http://x.test').cookies, []);
  assert.throws(() => resolveAuth('basic', 'OTHER', env, 'http://x.test'), /needs the OTHER_USER environment variable/);
});

test('buildStateUrl: fixture placeholders, ?fixture= fallback and query merging', () => {
  assert.equal(buildStateUrl('http://localhost:3000/items/{fixture}', { fixture: 'empty list' }), 'http://localhost:3000/items/empty%20list');
  assert.equal(buildStateUrl('http://localhost:3000/orders/{id}', { fixture: '42' }), 'http://localhost:3000/orders/42');
  assert.equal(buildStateUrl('http://localhost:3000/items', { fixture: 'three' }), 'http://localhost:3000/items?fixture=three');
  assert.equal(buildStateUrl('http://localhost:3000/items?a=1', { query: '?state=empty' }), 'http://localhost:3000/items?a=1&state=empty');
  assert.equal(buildStateUrl('http://localhost:3000/items?state=x', { query: 'state=empty' }), 'http://localhost:3000/items?state=empty');
  assert.equal(buildStateUrl('http://localhost:3000/items', {}), 'http://localhost:3000/items');
  assert.throws(() => buildStateUrl('http://localhost:3000/items/{id}', {}, 'hover'), /state "hover": the URL contains \{fixture\}\/\{id\}/);
});

test('loading detection, state lists, driver and grab validation', () => {
  assert.equal(isLoadingState('loading', {}), true);
  assert.equal(isLoadingState('Skeleton', {}), true);
  assert.equal(isLoadingState('empty', { mock: { urlPattern: '**', delayMs: 5000 } }), true);
  assert.equal(isLoadingState('empty', { mock: { urlPattern: '**', delayMs: 200 } }), false);
  assert.deepEqual(loadStates(), [['with-data', {}]]);
  const file = { empty: { query: 'e=1' }, hover: { action: 'hover', selector: '.row' } };
  assert.deepEqual(loadStates({ statesFile: file }), [['empty', { query: 'e=1' }], ['hover', { action: 'hover', selector: '.row' }]]);
  assert.deepEqual(loadStates({ statesFile: file, stateName: 'hover' }), [['hover', { action: 'hover', selector: '.row' }]], '--state picks one state');
  assert.deepEqual(loadStates({ statesFile: file, stateName: 'focus', driver: { action: 'focus', selector: 'a' } }), [['focus', { action: 'focus', selector: 'a' }]]);
  assert.throws(() => loadStates({ statesFile: file, stateName: 'focus' }), /state "focus" has no driver/);
  assert.deepEqual(loadStates({ stateName: 'hover' }), [['hover', {}]]);
  assert.throws(() => loadStates({ statesFile: [] }), /expected an object/);
  assert.throws(() => loadStates({ stateName: '../evil' }), /may only contain/);
  assert.deepEqual(checkDriver('hover', { action: 'hover', selector: '.row', settleMs: 100 }), []);
  assert.throws(() => checkDriver('hover', { action: 'hover' }), /needs a "selector"/);
  assert.throws(() => checkDriver('x', { action: 'wiggle', selector: 'a' }), /action: expected one of hover, focus, active, click, keyboard/);
  assert.throws(() => checkDriver('x', { mock: { status: 500 } }), /mock\.urlPattern: required key is missing/);
  assert.throws(() => checkDriver('x', 'nope'), /must be a JSON object/);
  assert.deepEqual(checkDriver('x', { selector: '.a', colour: 1 }), ['colour: unknown key (ignored)', '"selector" has no effect without an "action"']);
  assert.throws(() => checkGrab({ row: { selector: '.row' } }), /expected \{ "selector": string, "props"/);
  assert.throws(() => checkGrab({ row: { selector: '.row', props: [], limit: 0 } }), /limit must be an integer/);
  assert.throws(() => checkGrab({ rootTokens: { selector: ':root', props: [] } }), /"rootTokens" is reserved/);
});

test('configDefaults: URL, states, auth, headers and flags from design-qa.config.json', () => {
  const d = configDefaults(loadFixture('config.json'), 'items');
  assert.equal(d.surface, 'items');
  assert.equal(d.url, '${APP_URL}/items/{fixture}');
  assert.equal(d.auth, 'cookie');
  assert.equal(d.envPrefix, 'ITEMS_APP');
  assert.equal(d.loginConfig, null);
  assert.deepEqual(d.headers, { 'x-preview-bypass': '${PREVIEW_BYPASS}' });
  assert.deepEqual(Object.keys(d.states), ['with-data', 'empty', 'loading', 'hover', 'disabled', 'error']);
  assert.equal(d.fullPage, false);
  assert.equal(d.reducedMotion, true);
  assert.equal(d.allowNavigation, false);
  const lenient = loadFixture('config.json');
  lenient.capture.allowNavigation = true;
  assert.equal(configDefaults(lenient, 'items').allowNavigation, true, 'capture.allowNavigation');
  assert.equal(configDefaults(loadFixture('config.json')).surface, 'items', 'a single surface needs no --surface');
  assert.throws(() => configDefaults(loadFixture('config.json'), 'nope'), /surface "nope" is not in the config/);
  const bad = loadFixture('config.json');
  bad.app.baseUrl = 'nope';
  assert.throws(() => configDefaults(bad, 'items'), /--config is invalid/);
  const two = loadFixture('config.json');
  two.surfaces.other = { route: '/other' };
  assert.throws(() => configDefaults(two), /pass --surface/);
});

test('configDefaults: prototype URL for --side design, per-screen routes and prototypes', () => {
  const config = loadFixture('config.json');
  assert.equal(configDefaults(config, 'items').prototype, null);
  assert.equal(configDefaults(config, 'items', { side: 'design' }).url, null, 'no prototype configured: --url is needed');
  config.surfaces.items.prototype = 'https://items-proto.framer.app/items';
  config.surfaces.items.screens = {
    cart: { figma: 'https://www.figma.com/design/KEY/Shop?node-id=1-1', prototype: 'https://items-proto.framer.app/cart', route: '/cart' },
    profile: { figma: null, prototype: null, route: 'https://other.example.com/me' },
  };
  const design = configDefaults(config, 'items', { side: 'design' });
  assert.equal(design.url, 'https://items-proto.framer.app/items');
  assert.equal(design.auth, 'none', 'app credentials are never sent to the prototype');
  assert.deepEqual(design.headers, {});
  assert.equal(configDefaults(config, 'items', { screen: 'cart' }).url, '${APP_URL}/cart');
  assert.equal(configDefaults(config, 'items', { screen: 'cart', side: 'design' }).url, 'https://items-proto.framer.app/cart');
  assert.equal(configDefaults(config, 'items', { screen: 'profile' }).url, 'https://other.example.com/me');
  assert.deepEqual(Object.keys(configDefaults(config, 'items').screens), ['cart', 'profile']);
  assert.throws(() => configDefaults(config, 'items', { screen: 'nope' }), /has no screen "nope" \(have: cart, profile\)/);
  const bad = loadFixture('config.json');
  bad.surfaces.items.prototype = 'ftp://x';
  assert.throws(() => configDefaults(bad, 'items'), /prototype: must be an http\(s\) or file: URL/);
});

test('isDrivable: only with-data may be captured without a driver', () => {
  assert.equal(isDrivable('with-data', {}), true);
  assert.equal(isDrivable('Default', {}), true);
  assert.equal(isDrivable('error', {}), false);
  assert.equal(isDrivable('error', { source: 'src/Items.tsx:88', wait: '.x' }), false);
  assert.equal(isDrivable('error', { mock: { urlPattern: '**' } }), true);
  assert.equal(isDrivable('mobile', { viewport: { width: 375, height: 812 } }), true);
});

test('capture CLI rejects bad arguments before launching a browser (exit 2)', async () => {
  const out = tmpDir();
  const base = ['--width', '800', '--height', '600', '--out', out];
  const cases = [
    [],
    ['--url', 'ftp://x.test', ...base],
    ['--url', 'http://127.0.0.1:9/', '--width', '0', '--height', '600', '--out', out],
    ['--url', 'http://127.0.0.1:9/', ...base, '--state', 'hover', '--driver', '{"action":"hover"}'],
    ['--url', 'http://127.0.0.1:9/', ...base, '--driver', '{}'],
    ['--url', 'http://127.0.0.1:9/', ...base, '--auth', 'basic'],
    ['--url', 'http://127.0.0.1:9/', ...base, '--auth', 'login'],
    ['--url', 'http://${MISSING_TEST_VAR}/', ...base],
    ['--url', 'http://127.0.0.1:9/{id}', ...base],
    ['--url', 'http://127.0.0.1:9/', ...base, '--side', 'figma'],
    ['--side', 'design', ...base],
    ['--url', 'file:///tmp/app.html', ...base],
    ['--url', 'http://127.0.0.1:9/', ...base, '--screen', 'cart'],
  ];
  for (const args of cases) {
    const res = await run(CAPTURE, args, { env: { DESIGN_QA_APP_USER: '', DESIGN_QA_APP_PASS: '' } });
    assert.equal(res.code, 2, `${args.join(' ')}\n${res.stderr}`);
  }
  assert.ok(!existsSync(path.join(out, 'capture.json')), 'nothing written for usage errors');
});

// ---------------------------------------------------------------------------
// Browser smoke test (skipped when Chromium cannot launch)
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
const APP_HTML = readFileSync(fixture('app.html'));
const ITEMS = [{ name: 'Alpha' }, { name: 'Beta' }, { name: 'Gamma' }];

function appServer({ requireCookie = null } = {}) {
  return startServer((req, res) => {
    if (requireCookie && !(req.headers.cookie || '').includes(requireCookie)) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('unauthorised');
      return;
    }
    if (req.url.startsWith('/api/items')) return sendJson(res, 200, ITEMS);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(APP_HTML);
  });
}

const captureEnv = { DESIGN_QA_COMMIT: 'test-commit', DESIGN_QA_BRANCH: 'test-branch' };

test('capture: one screenshot, computed styles and DOM per state at the exact viewport', { timeout: 120000 }, async (t) => {
  if (!CHROMIUM) {
    t.skip(SKIP_REASON);
    return;
  }
  const server = await appServer();
  try {
    const dir = tmpDir();
    const states = path.join(dir, 'states.json');
    writeFileSync(
      states,
      JSON.stringify({
        'with-data': { fixture: 'three', wait: '.row' },
        empty: { fixture: 'three', mock: { urlPattern: '**/api/items', status: 200, body: [] }, wait: '.empty' },
        loading: { fixture: 'three', mock: { urlPattern: '**/api/items', delayMs: 60000 } },
        error: { fixture: 'three', mock: { urlPattern: '**/api/items', status: 500, body: { error: 'boom' } }, wait: '.error' },
        hover: { fixture: 'three', action: 'hover', selector: '.row', wait: '.row' },
      }),
    );
    const grab = path.join(dir, 'grab.json');
    writeFileSync(
      grab,
      JSON.stringify({
        row: { selector: '.row', props: ['background-color', 'padding-top'], limit: 3 },
        heading: { selector: 'h1', props: ['font-size', 'fontWeight'] },
        hint: { selector: '.hint', props: ['color'] },
      }),
    );
    const out = path.join(dir, 'capture');
    const started = Date.now();
    const res = await run(
      CAPTURE,
      ['--url', `${server.url}/items/{fixture}`, '--width', '800', '--height', '600', '--wait', 'h1', '--states', states, '--grab', grab, '--out', out],
      { env: captureEnv, cwd: dir },
    );
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    assert.ok(Date.now() - started < 40000, 'a delayed (loading) mock must not hold the capture open');

    const manifest = JSON.parse(readFileSync(path.join(out, 'capture.json'), 'utf8'));
    assert.equal(manifest.kind, 'local');
    assert.deepEqual(manifest.viewport, { width: 800, height: 600 });
    assert.equal(manifest.dpr, 1);
    assert.equal(manifest.commit, 'test-commit');
    assert.equal(manifest.branch, 'test-branch');
    assert.deepEqual(Object.keys(manifest.states), ['with-data', 'empty', 'loading', 'error', 'hover']);
    assert.equal(manifest.states['with-data'].url, `${server.url}/items/three`);

    const computed = {};
    const dom = {};
    const motion = {};
    assert.equal(manifest.side, 'app');
    for (const state of Object.keys(manifest.states)) {
      const entry = manifest.states[state];
      assert.equal(entry.screenshot, `app/${state}.png`);
      const png = readPng(path.join(out, entry.screenshot));
      assert.equal(png.width, 800, `${state} width`);
      assert.equal(png.height, 600, `${state} height`);
      computed[state] = JSON.parse(readFileSync(path.join(out, entry.computed), 'utf8'));
      dom[state] = JSON.parse(readFileSync(path.join(out, entry.dom), 'utf8'));
      assert.ok(dom[state].texts.length > 0, `${state} dom texts`);
      assert.ok(dom[state].elements.length > 0, `${state} dom elements`);
      assert.deepEqual(Object.keys(computed[state].heading.samples[0]), ['font-size', 'fontWeight', '__rect', '__visible', '__el', '__vars']);
      assert.equal(entry.motion, `motion/${state}.json`);
      motion[state] = JSON.parse(readFileSync(path.join(out, entry.motion), 'utf8'));
      assert.deepEqual(entry.degradations, [], `${state}: motion captured without problems`);
      assert.equal(computed[state].heading.samples[0]['font-size'], '24px');
      assert.deepEqual(entry.scroll, { x: 0, y: 0 });
    }
    assert.equal(computed['with-data'].row.count, 3);
    assert.deepEqual(Object.keys(computed['with-data'].row.samples[0]), ['background-color', 'padding-top', '__rect', '__visible', '__el', '__vars']);
    assert.deepEqual(computed['with-data'].rootTokens, {}, 'app.html defines no custom properties');
    assert.deepEqual(computed['with-data'].row.samples[1].__el, {
      tag: 'div', id: null, classes: ['row'], component: null, variant: null, testid: null, role: null, text: 'Beta', selector: 'div.row',
    });

    // Motion: longhands per grabbed element, running animations, keyframes, the action target.
    assert.equal(motion.hover.trigger, 'hover');
    assert.equal(motion.hover.actionTarget.selector, '.row');
    assert.equal(motion.hover.actionTarget['transition-duration'], '0s');
    assert.deepEqual(Object.keys(motion['with-data'].elements.row.samples[0]), [
      'transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay', 'animation-name',
      'animation-duration', 'animation-timing-function', 'animation-delay', 'animation-iteration-count', '__selector',
    ]);
    const spin = motion.loading.animations.find((a) => a.animationName === 'spin');
    assert.deepEqual(
      { type: spin.type, target: spin.target, element: spin.element, durationMs: spin.durationMs, easing: spin.easing, iterations: spin.iterations },
      { type: 'CSSAnimation', target: 'div.spinner', element: null, durationMs: 1000, easing: 'linear', iterations: 'infinite' },
      'the loading spinner is running (not grabbed, so element is null)',
    );
    // Its path (the audit's form) and untransformed box, so a finding about it can be pinned.
    assert.equal(spin.selector, 'main#app > div.spinner');
    assert.deepEqual([spin.rect.w, spin.rect.h], [30, 30], 'the layout box, not the rotated bounding box');
    assert.ok(spin.rect.x >= 24 && spin.rect.y >= 24, JSON.stringify(spin.rect));
    assert.match(motion.loading.keyframes.spin, /@keyframes spin/);
    assert.equal(motion['with-data'].animations.length, 0, 'nothing animates once the rows are shown');

    // Element boxes for evidence crops: integers, inside the 800×600 capture, rows stacked.
    const rows = computed['with-data'].row.samples.map((sample) => sample.__rect);
    assert.equal(rows.length, 3);
    for (const [i, rect] of rows.entries()) {
      assert.deepEqual(Object.keys(rect), ['x', 'y', 'w', 'h']);
      for (const v of Object.values(rect)) assert.ok(Number.isInteger(v), `row ${i}: ${JSON.stringify(rect)} has integer values`);
      assert.equal(rect.x, 0);
      assert.equal(rect.w, 800);
      assert.ok(rect.h > 0 && rect.y >= 0 && rect.y + rect.h <= 600, `row ${i} inside the viewport: ${JSON.stringify(rect)}`);
      assert.equal(computed['with-data'].row.samples[i].__visible, true);
      if (i > 0) assert.ok(rect.y >= rows[i - 1].y + rows[i - 1].h - 1, 'rows are stacked top to bottom');
    }
    const heading = computed['with-data'].heading.samples[0].__rect;
    assert.ok(heading.y + heading.h <= rows[0].y, 'the heading sits above the first row');
    assert.equal(computed['with-data'].hint.count, 1);
    assert.equal(computed['with-data'].hint.samples[0].__visible, false, 'hidden elements are flagged');
    assert.deepEqual(computed['with-data'].hint.samples[0].__rect, { x: 0, y: 0, w: 0, h: 0 });
    assert.equal(computed['with-data'].row.samples[0]['background-color'], 'rgb(255, 255, 255)');
    assert.equal(computed.hover.row.samples[0]['background-color'], 'rgb(240, 244, 255)', 'hover applied');
    assert.equal(computed.empty.row.count, 0);
    assert.ok(dom.empty.texts.includes('No items yet'));
    assert.ok(dom.error.texts.includes('Something went wrong'));
    assert.ok(dom.loading.elements.some((e) => e.role === 'status'), 'loading spinner captured');
    assert.ok(!dom.loading.texts.includes('Alpha'), 'loading state captured before data arrived');
    if (dom['with-data'].ariaSnapshot !== null) assert.match(dom['with-data'].ariaSnapshot, /heading "Items"/);
  } finally {
    await server.close();
  }
});

test('capture: __rect is in screenshot pixels for --viewport-only and whole-page captures, even after scrolling', { timeout: 120000 }, async (t) => {
  if (!CHROMIUM) {
    t.skip(SKIP_REASON);
    return;
  }
  const server = await appServer();
  try {
    const dir = tmpDir();
    const states = path.join(dir, 'states.json');
    // Hovering the last row scrolls it into the 150 px tall viewport.
    writeFileSync(states, JSON.stringify({ 'with-data': { wait: '.row' }, hover: { action: 'hover', selector: '.row:last-child', wait: '.row' } }));
    const grab = path.join(dir, 'grab.json');
    writeFileSync(grab, JSON.stringify({ row: { selector: '.row', props: ['background-color'], limit: 3 } }));
    const capture = async (name, extra = []) => {
      const out = path.join(dir, name);
      const res = await run(CAPTURE, ['--url', `${server.url}/`, '--width', '800', '--height', '150', '--states', states, '--grab', grab, '--out', out, ...extra], { env: captureEnv, cwd: dir });
      assert.equal(res.code, 0, res.stderr);
      const manifest = JSON.parse(readFileSync(path.join(out, 'capture.json'), 'utf8'));
      const rects = (state) => JSON.parse(readFileSync(path.join(out, manifest.states[state].computed), 'utf8')).row.samples.map((x) => x.__rect);
      return { manifest, rects, image: (state) => readPng(path.join(out, manifest.states[state].screenshot)) };
    };

    // Viewport-only capture: the hover scrolled the page, so boxes are viewport coordinates.
    const viewport = await capture('viewport', ['--viewport-only']);
    const scrolled = viewport.manifest.states.hover.scroll;
    assert.equal(viewport.manifest.states['with-data'].scroll.y, 0);
    assert.ok(scrolled.y > 0, 'hovering the last row scrolled the page');
    const last = viewport.rects('hover')[2];
    assert.equal(last.y, viewport.rects('with-data')[2].y - scrolled.y, 'shifted by the scroll offset');
    assert.ok(last.y >= 0 && last.y + last.h <= 150, `hovered row is inside the 150 px image: ${JSON.stringify(last)}`);

    // Whole-page capture (the default; --full-page is accepted): boxes are document
    // coordinates, the same with or without scrolling.
    const full = await capture('full');
    assert.equal((await capture('compat', ['--full-page'])).manifest.fullPage, true, '--full-page is still accepted');
    assert.deepEqual(full.rects('hover'), full.rects('with-data'));
    const image = full.image('with-data');
    assert.ok(image.height > 150, 'the full page is taller than the viewport');
    for (const rect of full.rects('with-data')) assert.ok(rect.y + rect.h <= image.height, `${JSON.stringify(rect)} inside the full-page image`);
  } finally {
    await server.close();
  }
});

test('capture: cookie auth; HTTP 401 is a sign-in failure (exit 6); an unreachable app exits 5', { timeout: 120000 }, async (t) => {
  if (!CHROMIUM) {
    t.skip(SKIP_REASON);
    return;
  }
  const server = await appServer({ requireCookie: 'session=abc123' });
  try {
    const dir = tmpDir();
    const args = ['--url', `${server.url}/`, '--width', '640', '--height', '480', '--wait', 'h1', '--out', path.join(dir, 'ok')];
    const ok = await run(CAPTURE, [...args, '--auth', 'cookie'], { env: { ...captureEnv, DESIGN_QA_APP_COOKIE: 'session=abc123' }, cwd: dir });
    assert.equal(ok.code, 0, ok.stderr);
    assert.ok(!ok.stdout.includes('abc123') && !ok.stderr.includes('abc123'), 'cookie never printed');
    assert.equal(readPng(path.join(dir, 'ok', 'app', 'with-data.png')).width, 640);

    const denied = await run(CAPTURE, ['--url', `${server.url}/`, '--width', '640', '--height', '480', '--out', path.join(dir, 'denied')], { env: captureEnv, cwd: dir });
    assert.equal(denied.code, 6, denied.stderr);
    assert.match(denied.stderr, /answered HTTP 401: the page needs a signed-in session/);
    assert.match(denied.stderr, /DESIGN_QA_APP_STORAGE_STATE/, 'says how to supply a session');
    const manifest = JSON.parse(readFileSync(path.join(dir, 'denied', 'capture.json'), 'utf8'));
    assert.equal(manifest.degradations[0].step, 'capture:with-data');
    assert.deepEqual(manifest.states['with-data'].failure, { kind: 'sign-in', finalUrl: `${server.url}/`, detail: 'HTTP 401' });
  } finally {
    await server.close();
  }
  const dir = tmpDir();
  const gone = await run(CAPTURE, ['--url', 'http://127.0.0.1:9/', '--width', '320', '--height', '240', '--timeout', '5000', '--out', dir], { env: captureEnv, cwd: dir });
  assert.equal(gone.code, 5, gone.stderr);
  assert.match(gone.stderr, /could not load http:\/\/127\.0\.0\.1:9\//);
  const goneManifest = JSON.parse(readFileSync(path.join(dir, 'capture.json'), 'utf8'));
  assert.equal(goneManifest.failure.kind, 'unreachable');
});

test('capture: --config/--surface supply the URL and states; undrivable states are skipped', { timeout: 120000 }, async (t) => {
  if (!CHROMIUM) {
    t.skip(SKIP_REASON);
    return;
  }
  const server = await appServer();
  try {
    const dir = tmpDir();
    const config = path.join(dir, 'design-qa.config.json');
    writeFileSync(
      config,
      JSON.stringify({
        app: { baseUrl: '${TEST_APP_URL}', auth: { type: 'none' }, headers: { 'x-test': '${TEST_HEADER}' } },
        surfaces: {
          items: {
            route: '/items',
            fullPage: false,
            states: { 'with-data': { wait: '.row' }, empty: { mock: { urlPattern: '**/api/items', body: [] }, wait: '.empty' }, error: {} },
          },
        },
      }),
    );
    const out = path.join(dir, 'capture');
    const env = { ...captureEnv, TEST_APP_URL: server.url, TEST_HEADER: 'on' };
    const res = await run(CAPTURE, ['--config', config, '--width', '480', '--height', '360', '--out', out], { env, cwd: dir });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /skipped error: no runtime driver/);
    const manifest = JSON.parse(readFileSync(path.join(out, 'capture.json'), 'utf8'));
    assert.equal(manifest.url, `${server.url}/items`);
    assert.deepEqual(Object.keys(manifest.states), ['with-data', 'empty', 'error']);
    assert.equal(manifest.states.error.screenshot, null);
    assert.equal(manifest.states.error.skipped, true);
    assert.ok(manifest.degradations.some((d) => d.step === 'capture:error'));
    assert.equal(readPng(path.join(out, 'app', 'empty.png')).width, 480);
    const page = server.requests.find((r) => r.url === '/items');
    assert.equal(page.headers['x-test'], 'on', 'config headers are sent');

    const single = await run(CAPTURE, ['--config', config, '--surface', 'items', '--state', 'empty', '--width', '480', '--height', '360', '--out', path.join(dir, 'single')], { env, cwd: dir });
    assert.equal(single.code, 0, single.stderr);
    const one = JSON.parse(readFileSync(path.join(dir, 'single', 'capture.json'), 'utf8'));
    assert.deepEqual(Object.keys(one.states), ['empty']);
    assert.equal(one.states.empty.driver.mock.urlPattern, '**/api/items');
  } finally {
    await server.close();
  }
});

test('capture: a failing action marks that state failed and exits 1', { timeout: 120000 }, async (t) => {
  if (!CHROMIUM) {
    t.skip(SKIP_REASON);
    return;
  }
  const server = await appServer();
  try {
    const dir = tmpDir();
    const states = path.join(dir, 'states.json');
    writeFileSync(states, JSON.stringify({ 'with-data': { wait: '.row' }, hover: { action: 'hover', selector: '.does-not-exist' } }));
    const res = await run(
      CAPTURE,
      ['--url', `${server.url}/`, '--width', '400', '--height', '300', '--states', states, '--timeout', '1500', '--out', dir],
      { env: captureEnv, cwd: dir },
    );
    assert.equal(res.code, 1, res.stderr);
    const manifest = JSON.parse(readFileSync(path.join(dir, 'capture.json'), 'utf8'));
    assert.equal(manifest.states['with-data'].screenshot, 'app/with-data.png');
    assert.equal(manifest.states.hover.screenshot, null);
    assert.match(manifest.states.hover.error, /action "hover" on "\.does-not-exist" failed/);
  } finally {
    await server.close();
  }
});

test('capture: a motion-trace failure never fails the state; it is recorded as a degradation', { timeout: 120000 }, async (t) => {
  if (!CHROMIUM) {
    t.skip(SKIP_REASON);
    return;
  }
  const page = '<!doctype html><title>x</title><h1>Hi</h1><script>document.getAnimations = () => { throw new Error("boom"); };</script>';
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  });
  try {
    const dir = tmpDir();
    const res = await run(CAPTURE, ['--url', `${server.url}/`, '--width', '320', '--height', '240', '--out', dir], { env: captureEnv, cwd: dir });
    assert.equal(res.code, 0, res.stderr);
    const manifest = JSON.parse(readFileSync(path.join(dir, 'capture.json'), 'utf8'));
    const state = manifest.states['with-data'];
    assert.equal(state.screenshot, 'app/with-data.png');
    assert.equal(state.motion, 'motion/with-data.json');
    assert.equal(state.degradations.length, 1);
    assert.equal(state.degradations[0].step, 'motion:with-data');
    assert.match(state.degradations[0].reason, /document\.getAnimations\(\) failed: .*boom/);
    assert.ok(manifest.degradations.some((d) => d.step === 'motion:with-data'));
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, state.motion), 'utf8')).animations, []);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Design-system audit collector, saved sessions (app.auth.storageState) and run ownership
// ---------------------------------------------------------------------------

const DS_PAGE = readFileSync(fixture('ds-audit-page.html'));
const htmlServer = (html) =>
  startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });

test('capture: audit/<state>.json for every captured state (hover included), consumed by ds-audit.mjs end to end', { timeout: 180000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP_REASON);
  const server = await htmlServer(DS_PAGE);
  try {
    const dir = tmpDir();
    const evidence = path.join(dir, 'evidence');
    copyFileSync(fixture('ds-audit-tokens.json'), path.join(dir, 'tokens.json'));
    copyFileSync(fixture('ds-audit-catalog.json'), path.join(dir, 'catalog.json'));
    const config = path.join(dir, 'design-qa.config.json');
    writeFileSync(
      config,
      JSON.stringify({
        app: { baseUrl: server.url },
        surfaces: { orders: { route: '/', states: { 'with-data': {}, hover: { action: 'hover', selector: 'button' }, ghost: { wait: '.nothing' } } } },
        designSystem: {
          name: 'Acme DS',
          tokens: ['tokens.json'],
          componentCatalog: 'catalog.json',
          libraries: [{ name: 'Mui', kind: 'third-party', classPrefix: 'Mui' }, { name: 'Old UI', kind: 'legacy', classPrefix: 'legacy-' }],
        },
      }),
    );
    // A stale audit file of a state that is skipped this time is deleted with its other files.
    mkdirSync(path.join(evidence, 'audit'), { recursive: true });
    writeFileSync(path.join(evidence, 'audit', 'ghost.json'), '{"stale":true}');
    const res = await run(CAPTURE, ['--config', config, '--width', '800', '--height', '600', '--out', evidence], { env: captureEnv, cwd: dir });
    assert.equal(res.code, 0, res.stderr);
    const manifest = JSON.parse(readFileSync(path.join(evidence, 'capture.json'), 'utf8'));
    assert.equal(manifest.states['with-data'].audit, 'audit/with-data.json');
    assert.equal(manifest.states.hover.audit, 'audit/hover.json');
    assert.equal(manifest.states.ghost.audit, null, 'skipped (no runtime driver): no audit');
    assert.equal(existsSync(path.join(evidence, 'audit', 'ghost.json')), false, 'the stale audit file is gone');
    const text = readFileSync(path.join(evidence, 'audit', 'with-data.json'), 'utf8');
    assert.equal(text.trim().split('\n').length, 1, 'compact JSON');
    const audit = JSON.parse(text);
    assert.equal(audit.fullPage, true);
    assert.ok(audit.page.h > 1800, 'the whole page');
    const card = audit.elements.find((e) => e.text === 'Card three');
    assert.ok(card.rect.y > 1500, 'below the fold, in screenshot (document) pixels');
    assert.ok(audit.selectors.some((x) => x.selector === "[data-ds-component='Button']"), 'the catalog selectors are evaluated in the page');
    const hover = JSON.parse(readFileSync(path.join(evidence, 'audit', 'hover.json'), 'utf8'));
    assert.ok(hover.elements.length > 20, 'hover state audited too');
    assert.ok(!manifest.degradations.some((d) => /^audit:/.test(d.step)), 'no collector degradation');

    const ds = await run(script('ds-audit.mjs'), ['--evidence', evidence, '--config', config], { cwd: dir });
    assert.equal(ds.code, 0, ds.stderr);
    const out = JSON.parse(readFileSync(path.join(evidence, 'ds-audit.json'), 'utf8'));
    assert.deepEqual(Object.keys(out.states).sort(), ['hover', 'with-data']);
    const keys = out.candidates.map((c) => c.key);
    for (const key of ['component:mui:mui-button>acme-button', 'style:space:13px', 'style:color:#3a3f47']) assert.ok(keys.includes(key), key);
    for (const c of out.candidates) assert.ok(c.evidence.some((e) => e.crop), `${c.key} is pinned`);
  } finally {
    await server.close();
  }
});

test('resolveAuth storage-state: the variable wins, else app.auth.storageState expanded (~, ${ENV}, relative to the config folder)', () => {
  const base = '/work/repo';
  const fromEnv = resolveAuth('storage-state', 'APP', { APP_STORAGE_STATE: '/tmp/env-state.json' }, 'http://x.test', { storageState: '~/s.json', configDir: base });
  assert.equal(fromEnv.storageStatePath, '/tmp/env-state.json');
  assert.equal(fromEnv.storageStateSource, 'env');
  const home = resolveAuth('storage-state', 'APP', {}, 'http://x.test', { storageState: '~/.design-qa/sessions/acme.json', configDir: base });
  assert.equal(home.storageStatePath, path.join(os.homedir(), '.design-qa', 'sessions', 'acme.json'));
  assert.equal(home.storageStateSource, 'config');
  assert.equal(resolveAuth('storage-state', 'APP', { SESSIONS: '/srv/s' }, 'http://x.test', { storageState: '${SESSIONS}/a.json', configDir: base }).storageStatePath, '/srv/s/a.json');
  assert.equal(resolveAuth('storage-state', 'APP', {}, 'http://x.test', { storageState: '.auth/a.json', configDir: base }).storageStatePath, path.join(base, '.auth', 'a.json'));
  assert.throws(() => resolveAuth('storage-state', 'APP', {}, 'http://x.test'), /APP_STORAGE_STATE.*app\.auth\.storageState.*setup\.mjs save-session/s);
  assert.throws(() => resolveAuth('storage-state', 'APP', {}, 'http://x.test', { storageState: '${NOPE}/a.json' }), /NOPE is not set/);
  assert.equal(configDefaults({ app: { baseUrl: 'http://x.test', auth: { type: 'storageState', storageState: '~/a.json' } }, surfaces: { s: { route: '/' } } }).storageState, '~/a.json');
  assert.equal(configDefaults({ app: { baseUrl: 'http://x.test', auth: { type: 'storageState', storageState: '~/a.json' } }, surfaces: { s: { route: '/', prototype: 'http://p.test/' } } }, 's', { side: 'design' }).storageState, null, 'app side only');
});

test('capture: the saved session from app.auth.storageState signs in; the env var wins; a missing file names the path and save-session; the content never shows', { timeout: 120000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP_REASON);
  const SECRET = 'sess-0f9e8d7c6b5a4321-never-print';
  const server = await startServer((req, res) => {
    if (!(req.headers.cookie || '').includes(`sid=${SECRET}`)) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      return res.end('unauthorised');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>App</title><nav data-testid="app-nav">Acme</nav><h1>Orders</h1>');
  });
  try {
    const dir = tmpDir();
    const host = new URL(server.url).hostname;
    const session = { cookies: [{ name: 'sid', value: SECRET, domain: host, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] };
    mkdirSync(path.join(dir, '.auth'), { recursive: true });
    writeFileSync(path.join(dir, '.auth', 'good.json'), JSON.stringify(session));
    writeFileSync(path.join(dir, '.auth', 'bad.json'), JSON.stringify({ cookies: [], origins: [] }));
    const config = (pointer) => {
      const file = path.join(dir, 'design-qa.config.json');
      writeFileSync(file, JSON.stringify({ app: { baseUrl: server.url, auth: { type: 'storageState', ...(pointer ? { storageState: pointer } : {}), signedInSelector: '[data-testid=app-nav]' } }, surfaces: { orders: { route: '/' } } }));
      return file;
    };
    const env = { ...captureEnv, DESIGN_QA_APP_STORAGE_STATE: '' };
    const all = [];
    const cap = async (args, extra = {}) => {
      const r = await run(CAPTURE, args, { env: { ...env, ...extra }, cwd: dir });
      all.push(r.stdout, r.stderr);
      return r;
    };
    // The config pointer, relative to the config's folder.
    const ok = await cap(['--config', config('.auth/good.json'), '--width', '320', '--height', '240', '--out', path.join(dir, 'ev1')]);
    assert.equal(ok.code, 0, ok.stderr);
    // --probe uses the same resolution.
    const probe = await cap(['--probe', '--config', config('.auth/good.json')]);
    assert.equal(probe.code, 0, probe.stderr);
    assert.equal(JSON.parse(probe.stdout).signIn, false);
    // The variable wins over the config pointer.
    const envWins = await cap(['--probe', '--config', config('.auth/good.json')], { DESIGN_QA_APP_STORAGE_STATE: path.join(dir, '.auth', 'bad.json') });
    assert.equal(envWins.code, 6, 'the (signed-out) session from the variable is used');
    assert.match(envWins.stderr, /setup\.mjs save-session/);
    // A missing file: the path and save-session.
    const missing = await cap(['--config', config('.auth/gone.json'), '--width', '320', '--height', '240', '--out', path.join(dir, 'ev2')]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /saved session .*\.auth\/gone\.json \(from app\.auth\.storageState\) does not exist\. Sign in again: node \S*scripts\/setup\.mjs save-session/);
    // Neither: both sources named.
    const neither = await cap(['--config', config(null), '--width', '320', '--height', '240', '--out', path.join(dir, 'ev3')]);
    assert.equal(neither.code, 2);
    assert.match(neither.stderr, /DESIGN_QA_APP_STORAGE_STATE.*app\.auth\.storageState.*setup\.mjs save-session/);
    for (const text of all) assert.doesNotMatch(text, new RegExp(SECRET), 'the session content never appears');
    for (const f of ['capture.json', 'dom/with-data.json']) assert.doesNotMatch(readFileSync(path.join(dir, 'ev1', f), 'utf8'), new RegExp(SECRET));
  } finally {
    await server.close();
  }
});

test('capture --run: another run\'s report folder is refused before anything is written; no id, or an --out outside a locked folder, works', { timeout: 120000 }, async (t) => {
  const dir = tmpDir();
  const report = path.join(dir, 'qa-reports', 'abc-123');
  mkdirSync(path.join(report, 'evidence', 'screens', 'cart'), { recursive: true });
  writeFileSync(path.join(report, '.design-qa-run.json'), JSON.stringify({ kind: 'design-qa-run', version: 1, runId: '20261004T113201Z-a1b2c3', label: null, status: 'active', startedAt: '2026-10-04T11:32:01Z', finishedAt: null }));
  const args = (out) => ['--url', 'http://127.0.0.1:9/', '--width', '320', '--height', '240', '--out', out];
  for (const out of [path.join(report, 'evidence'), path.join(report, 'evidence', 'screens', 'cart')]) {
    const refused = await run(CAPTURE, [...args(out), '--run', '20261004T113202Z-bbbbbb'], { cwd: dir });
    assert.equal(refused.code, 5, refused.stderr);
    assert.match(refused.stderr, /belongs to run 20261004T113201Z-a1b2c3/);
    assert.equal(existsSync(path.join(out, 'capture.json')), false);
    const env = await run(CAPTURE, args(out), { cwd: dir, env: { DESIGN_QA_RUN_ID: '20261004T113202Z-bbbbbb' } });
    assert.equal(env.code, 5, 'DESIGN_QA_RUN_ID is the fallback');
  }
  if (!CHROMIUM) return;
  // No run id: not refused (the unreachable app is what fails, exit 5 with a load error).
  const noId = await run(CAPTURE, args(path.join(report, 'evidence')), { cwd: dir, env: { DESIGN_QA_RUN_ID: '' } });
  assert.doesNotMatch(noId.stderr, /belongs to run/);
  const own = await run(CAPTURE, [...args(path.join(dir, 'elsewhere')), '--run', '20261004T113202Z-bbbbbb'], { cwd: dir });
  assert.doesNotMatch(own.stderr, /belongs to run/, 'an --out under no locked folder is not checked');
});
