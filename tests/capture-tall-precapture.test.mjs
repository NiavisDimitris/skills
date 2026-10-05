// Long design frames are captured in full without an extra flag (auto full page, lazy
// content scrolled into view), and the preCapture hook (storage, hide, remove, click)
// from config, merged surface over app, with storage values kept out of the evidence.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  configDefaults,
  defaultMaxViewportHeight,
  describePreCapture,
  fitViewport,
  mergeManifest,
  mergePreCapture,
  normalizePreCapture,
} from '../skills/design-qa/scripts/lib/capture-helpers.mjs';
import { validateConfig } from '../skills/design-qa/scripts/lib/schema-check.mjs';
import { readPng } from '../skills/design-qa/scripts/lib/png.mjs';
import { fixture, loadFixture, run, script, startServer, tmpDir } from './_helpers.mjs';

const CAPTURE = script('capture.mjs');
const TALL_HTML = readFileSync(fixture('tall-page.html'), 'utf8');
const captureEnv = { DESIGN_QA_COMMIT: 'test-commit', DESIGN_QA_BRANCH: 'test-branch' };
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('fitViewport: the layout viewport is W×H for a screen, W × maxViewportHeight for a long frame', () => {
  assert.equal(defaultMaxViewportHeight(1440), 1440);
  assert.equal(defaultMaxViewportHeight(390), 1000, 'phones');
  assert.deepEqual(fitViewport({ width: 1440, height: 1024 }), { viewport: { width: 1440, height: 1024 }, capped: false });
  assert.deepEqual(fitViewport({ width: 1024, height: 1366 }), { viewport: { width: 1024, height: 1366 }, capped: false }, 'a tablet portrait frame is a screen');
  assert.deepEqual(fitViewport({ width: 1440, height: 4292 }), { viewport: { width: 1440, height: 1440 }, capped: true });
  assert.deepEqual(fitViewport({ width: 390, height: 2400 }), { viewport: { width: 390, height: 1000 }, capped: true });
  assert.deepEqual(fitViewport({ width: 1440, height: 1024 }, 900), { viewport: { width: 1440, height: 900 }, capped: true }, 'the knob');
  assert.deepEqual(fitViewport({ width: 1440, height: 4292 }, 20000), { viewport: { width: 1440, height: 4292 }, capped: false }, 'a huge knob restores exact W×H');
});

test('preCapture: validation, surface-over-app merge, and a description without storage values', () => {
  assert.equal(normalizePreCapture(undefined), null);
  const app = normalizePreCapture({ localStorage: { promo: '0', theme: 'light' }, hide: ['.chat'], click: ['#dismiss'] });
  assert.deepEqual(app, { localStorage: { promo: '0', theme: 'light' }, sessionStorage: {}, hide: ['.chat'], remove: [], click: ['#dismiss'] });
  const surface = normalizePreCapture({ localStorage: { promo: 'S3cret-value' }, sessionStorage: { tour: 'done' }, remove: ['.cookie-bar'], click: ['#dismiss', '#later'] });
  const merged = mergePreCapture(app, surface);
  assert.deepEqual(merged.localStorage, { promo: 'S3cret-value', theme: 'light' }, 'the surface wins on the same key');
  assert.deepEqual(merged.click, ['#dismiss', '#later'], 'selectors joined without repeats');
  assert.deepEqual(describePreCapture(merged), { localStorage: ['promo', 'theme'], sessionStorage: ['tour'], hide: ['.chat'], remove: ['.cookie-bar'], click: ['#dismiss', '#later'] });
  assert.ok(!JSON.stringify(describePreCapture(merged)).includes('S3cret'), 'no storage value in the description');
  assert.equal(mergePreCapture(null, app), app);
  assert.equal(mergePreCapture(app, null), app);
  assert.throws(() => normalizePreCapture({ hide: '.chat' }), (err) => err.exitCode === 2 && /hide: expected an array of CSS selectors/.test(err.message));
  assert.throws(() => normalizePreCapture({ remove: ['.a } body { display: none'] }), /not a selector \(no \{ or \}\)/);
  assert.throws(() => normalizePreCapture({ hidden: [] }), /unknown key\(s\) hidden/);
  assert.throws(() => normalizePreCapture({ localStorage: ['a'] }), /localStorage: expected an object/);
});

test('config: preCapture, app.auth sign-in knobs and capture.maxViewportHeight are validated and read', () => {
  const config = loadFixture('config.json');
  config.app.auth.signedInSelector = '[data-testid=app-nav]';
  config.app.auth.signInUrlPattern = '/u/continue';
  config.app.preCapture = { localStorage: { promo: '1' }, hide: ['.chat'] };
  config.surfaces.items.preCapture = { remove: ['.cookie-bar'], localStorage: { promo: '2' } };
  config.capture.maxViewportHeight = 1200;
  assert.deepEqual(validateConfig(config).errors, []);
  const d = configDefaults(config, 'items');
  assert.equal(d.signedInSelector, '[data-testid=app-nav]');
  assert.equal(d.signInUrlPattern, '/u/continue');
  assert.equal(d.maxViewportHeight, 1200);
  assert.deepEqual(d.preCapture, { localStorage: { promo: '2' }, sessionStorage: {}, hide: ['.chat'], remove: ['.cookie-bar'], click: [] });
  config.surfaces.items.prototype = 'https://items-proto.framer.app/items';
  const design = configDefaults(config, 'items', { side: 'design' });
  assert.deepEqual([design.preCapture, design.signedInSelector, design.signInUrlPattern], [null, null, null], 'the app\'s hook and checks never apply to the prototype');

  const bad = loadFixture('config.json');
  bad.app.preCapture = { hide: ['.a { color: red }'] };
  bad.capture.maxViewportHeight = 10;
  bad.surfaces.items.states['with-data'].allowSignIn = 'yes';
  const errors = validateConfig(bad).errors.map((e) => `${e.path}: ${e.message}`).join('\n');
  assert.match(errors, /app\.preCapture\.hide\[0\]: must be a CSS selector without \{ or \}/);
  assert.match(errors, /capture\.maxViewportHeight: must be >= 100/);
  assert.match(errors, /allowSignIn: expected boolean/);
});

test('mergeManifest: two long frames sharing the capped viewport are different captures', () => {
  const base = { side: 'app', url: 'http://h/x', viewport: { width: 1440, height: 1440 }, fullPage: true, states: { a: {} } };
  const merged = mergeManifest({ ...base, frame: { width: 1440, height: 4292 } }, { ...base, frame: { width: 1440, height: 3000 }, states: { b: {} } }, ['b']);
  assert.match(merged.mismatch, /frame \(1440×4292\)/);
  assert.equal(mergeManifest({ ...base, frame: { width: 1440, height: 4292 } }, { ...base, frame: { width: 1440, height: 4292 }, states: { b: {} } }, ['b']).mismatch, null);
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

const html = (res, body) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
};
const listFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));

browserTest('capture: a tall frame is laid out on a screen-high viewport and captured whole, lazy content included', async () => {
  const server = await startServer((req, res) => html(res, TALL_HTML));
  try {
    const dir = tmpDir();
    const grab = path.join(dir, 'grab.json');
    writeFileSync(grab, JSON.stringify({ hero: { selector: '.hero', props: ['height'], limit: 1 } }));
    const out = path.join(dir, 'tall');
    // The agent passes the frame W×H only: 800×3000 is a long page.
    const res = await run(CAPTURE, ['--url', `${server.url}/`, '--width', '800', '--height', '3000', '--max-viewport-height', '700', '--grab', grab, '--out', out], { env: captureEnv, cwd: dir });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /whole page, layout viewport 800×700/);
    const manifest = json(path.join(out, 'capture.json'));
    assert.deepEqual([manifest.frame, manifest.viewport, manifest.fullPage, manifest.viewportOnly, manifest.maxViewportHeight], [{ width: 800, height: 3000 }, { width: 800, height: 700 }, true, false, 700]);
    const state = manifest.states['with-data'];
    assert.deepEqual([state.frame, state.viewport, state.fullPage, state.unrolled, state.clipped], [{ width: 800, height: 3000 }, { width: 800, height: 700 }, true, [], []]);
    const png = readPng(path.join(out, state.screenshot));
    assert.deepEqual(state.size, { width: png.width, height: png.height }, 'size is the PNG written');
    assert.deepEqual(state.page, state.size, 'the PNG is the whole page');
    // hero (100vh = 700) + three 600 px sections + the lazy 600 px section.
    assert.ok(png.height >= 700 + 3 * 600 + 600, `the lazy section is in the screenshot (height ${png.height})`);
    assert.ok(json(path.join(out, 'dom', 'with-data.json')).texts.includes('Lazy section loaded'), 'lazy content rendered');
    assert.equal(json(path.join(out, 'computed', 'with-data.json')).hero.samples[0].height, '700px', '100vh is a real screen, not the 3000 px frame');
    assert.deepEqual(state.scroll, { x: 0, y: 0 }, 'back at the top after scrolling through');
  } finally {
    await server.close();
  }
});

const PROMO_PAGE = `<!doctype html><title>Shop</title>
<style>body{margin:0;font:16px Arial}.promo,.cookie-bar,.chat,.modal{padding:8px}</style>
<div class="promo" id="promo">Try the new plan</div>
<div class="cookie-bar">We use cookies</div>
<div class="chat">Chat with us</div>
<div class="modal" id="modal">Welcome tour <button id="dismiss" type="button">Dismiss</button></div>
<h1>Orders</h1><p id="theme"></p><p id="tour"></p>
<script>
  if (localStorage.getItem('promo-dismissed')) document.getElementById('promo').remove();
  document.getElementById('theme').textContent = 'theme ' + (localStorage.getItem('theme') || 'none');
  document.getElementById('tour').textContent = 'tour ' + (sessionStorage.getItem('tour') || 'none');
  document.getElementById('dismiss').addEventListener('click', () => document.getElementById('modal').remove());
</script>`;

browserTest('capture: preCapture from config (surface merged over app) sets storage, hides, removes and clicks; values never reach the evidence', async () => {
  const SECRET = 'S3cret-dismiss-token-42';
  const server = await startServer((req, res) => html(res, PROMO_PAGE));
  try {
    const dir = tmpDir();
    const config = path.join(dir, 'design-qa.config.json');
    writeFileSync(config, JSON.stringify({
      app: { baseUrl: server.url, preCapture: { localStorage: { 'promo-dismissed': '0', theme: 'light-theme-value' }, hide: ['.chat'], click: ['#dismiss'] } },
      surfaces: {
        shop: {
          route: '/shop',
          prototype: `${server.url}/proto`,
          preCapture: { localStorage: { 'promo-dismissed': SECRET }, sessionStorage: { tour: 'done-tour-value' }, remove: ['.cookie-bar'], click: ['#absent'] },
          states: { 'with-data': {}, dark: { storage: { local: { theme: 'dark' } } } },
        },
      },
    }));
    const grab = path.join(dir, 'grab.json');
    writeFileSync(grab, JSON.stringify({ chat: { selector: '.chat', props: ['visibility'], limit: 1 }, cookie: { selector: '.cookie-bar', props: ['display'], limit: 1 } }));
    const out = path.join(dir, 'evidence');
    const res = await run(CAPTURE, ['--config', config, '--width', '480', '--height', '360', '--grab', grab, '--out', out], { env: captureEnv, cwd: dir });
    assert.equal(res.code, 0, res.stderr);

    const manifest = json(path.join(out, 'capture.json'));
    assert.deepEqual(manifest.preCapture, {
      localStorage: ['promo-dismissed', 'theme'],
      sessionStorage: ['tour'],
      hide: ['.chat'],
      remove: ['.cookie-bar'],
      click: ['#dismiss', '#absent'],
    });
    const record = manifest.states['with-data'].preCapture;
    assert.deepEqual([record.clicked, record.removed], [['#dismiss'], 1], 'an absent click target is skipped quietly');
    assert.deepEqual(record.matched.map((m) => [m.selector, m.kind, m.count, m.rects[0].w]), [['.chat', 'hide', 1, 480], ['.cookie-bar', 'remove', 1, 480]], 'what was hidden, and its box');
    assert.ok(record.matched.every((m) => m.areaPx > 480 * 16), JSON.stringify(record.matched));
    assert.deepEqual(manifest.states['with-data'].warnings, []);
    const texts = json(path.join(out, 'dom', 'with-data.json')).texts;
    assert.ok(!texts.includes('Try the new plan'), 'localStorage set before the app ran: the promo is gone');
    assert.ok(!texts.includes('Welcome tour'), 'the dismiss button was clicked');
    assert.ok(!texts.includes('We use cookies'), 'removed');
    assert.ok(!texts.includes('Chat with us'), 'hidden (invisible text is not listed)');
    assert.ok(texts.includes('tour done-tour-value'), 'sessionStorage set');
    assert.ok(texts.includes('theme light-theme-value'), 'app-level keys the surface does not override are kept');
    assert.ok(json(path.join(out, 'dom', 'dark.json')).texts.includes('theme dark'), 'a state\'s own storage wins over preCapture');
    const computed = json(path.join(out, 'computed', 'with-data.json'));
    assert.equal(computed.chat.samples[0].visibility, 'hidden');
    assert.equal(computed.chat.samples[0].__visible, false);
    assert.equal(computed.cookie.count, 0, 'removed from the DOM before the page was read');

    // Storage values never reach capture.json, any evidence file, stdout or stderr. (The
    // page itself printing a value is page content: the fixture prints only the theme and tour.)
    for (const file of listFiles(out)) assert.ok(!readFileSync(file).includes(SECRET), `${path.relative(out, file)} leaks a storage value`);
    assert.ok(!res.stdout.includes(SECRET) && !res.stderr.includes(SECRET));
    for (const value of ['light-theme-value', 'done-tour-value', SECRET]) assert.ok(!readFileSync(path.join(out, 'capture.json'), 'utf8').includes(value), `capture.json holds ${value}`);

    // The design side never gets the app's hook from config; --pre-capture applies to either side.
    const design = await run(CAPTURE, ['--config', config, '--side', 'design', '--width', '480', '--height', '360', '--out', out], { env: captureEnv, cwd: dir });
    assert.equal(design.code, 0, design.stderr);
    assert.equal(json(path.join(out, 'design-capture.json')).preCapture, null);
    assert.ok(json(path.join(out, 'design-dom', 'with-data.json')).texts.includes('Try the new plan'));
    const flagged = await run(
      CAPTURE,
      ['--config', config, '--side', 'design', '--width', '480', '--height', '360', '--pre-capture', '{"remove":["#promo"]}', '--out', path.join(dir, 'flag')],
      { env: captureEnv, cwd: dir },
    );
    assert.equal(flagged.code, 0, flagged.stderr);
    assert.deepEqual(json(path.join(dir, 'flag', 'design-capture.json')).preCapture.remove, ['#promo']);
    assert.ok(!json(path.join(dir, 'flag', 'design-dom', 'with-data.json')).texts.includes('Try the new plan'));
    assert.equal((await run(CAPTURE, ['--url', `${server.url}/`, '--width', '480', '--height', '360', '--pre-capture', '{"hide":".chat"}', '--out', path.join(dir, 'bad')], { cwd: dir })).code, 2);
  } finally {
    await server.close();
  }
});
