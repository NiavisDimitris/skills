// Every capture covers the whole page: below the fold, inside an app shell's scroll
// panel (unrolled), and sideways; what still cannot be shown is listed as clipped.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { clippedMessage, scaleFactor } from '../skills/design-qa/scripts/lib/capture-helpers.mjs';
import { readPng } from '../skills/design-qa/scripts/lib/png.mjs';
import { fixture, run, script, startServer, tmpDir } from './_helpers.mjs';

const CAPTURE = script('capture.mjs');
const TALL_HTML = readFileSync(fixture('tall-page.html'), 'utf8');
const SHELL_HTML = readFileSync(fixture('tall-shell.html'), 'utf8');
const captureEnv = { DESIGN_QA_COMMIT: 'test-commit', DESIGN_QA_BRANCH: 'test-branch' };
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('scaleFactor: only an integer multiple in both dimensions is the device-scale error', () => {
  assert.equal(scaleFactor({ width: 1600, height: 1200 }, { width: 800, height: 600 }), 2);
  assert.equal(scaleFactor({ width: 2400, height: 1801 }, { width: 800, height: 600 }), 3, 'a pixel of page drift is tolerated');
  assert.equal(scaleFactor({ width: 1600, height: 600 }, { width: 800, height: 600 }), null, 'twice as wide only: a wide page, not DPR 2');
  assert.equal(scaleFactor({ width: 800, height: 600 }, { width: 800, height: 600 }), null);
  assert.equal(scaleFactor({ width: 1200, height: 900 }, { width: 800, height: 600 }), null, '1.5× is not an integer factor');
  assert.match(clippedMessage({ selector: 'div#log', axis: 'y', hiddenPx: 1850 }), /^the div#log panel still hides 1,850 px of content/);
  assert.match(clippedMessage({ selector: 'div.wide', axis: 'x', hiddenPx: 600 }), /scrolls sideways and hides 600 px .*not unrolled/);
});

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
const pixel = (png, x, y) => Array.from(png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3));

browserTest('capture: a short frame on a long page captures the whole page; --viewport-only and a state\'s viewportOnly opt out', async () => {
  const server = await startServer((req, res) => html(res, TALL_HTML));
  try {
    const dir = tmpDir();
    const grab = path.join(dir, 'grab.json');
    writeFileSync(grab, JSON.stringify({ section: { selector: 'section', props: ['height'], limit: 10 } }));
    const states = path.join(dir, 'states.json');
    writeFileSync(states, JSON.stringify({ 'with-data': {}, fold: { query: 'fold=1', viewportOnly: true } }));
    const out = path.join(dir, 'whole');
    const res = await run(CAPTURE, ['--url', `${server.url}/`, '--width', '800', '--height', '600', '--grab', grab, '--states', states, '--out', out], { env: captureEnv, cwd: dir });
    assert.equal(res.code, 0, res.stderr);
    const manifest = json(path.join(out, 'capture.json'));
    const whole = manifest.states['with-data'];
    assert.deepEqual([manifest.viewport, manifest.fullPage, whole.viewport, whole.fullPage], [{ width: 800, height: 600 }, true, { width: 800, height: 600 }, true]);
    const png = readPng(path.join(out, whole.screenshot));
    // hero (100vh = 600) + three 600 px sections + the lazy 600 px section, against an 800×600 frame.
    assert.ok(png.height >= 600 * 5, `the whole page, not one screen (height ${png.height})`);
    assert.deepEqual(whole.page, { width: 800, height: png.height });
    // Element boxes are document coordinates: the lazy section sits below the fold, inside the PNG.
    const rects = json(path.join(out, 'computed', 'with-data.json')).section.samples.map((s) => s.__rect);
    const lazy = rects.at(-1);
    assert.ok(lazy.y >= 2400 && lazy.y + lazy.h <= png.height, `lazy section box ${JSON.stringify(lazy)} is in the PNG`);
    assert.deepEqual(pixel(png, 400, lazy.y + 300), [255, 247, 230], 'the PNG shows the lazy section where its box says');

    // A state's own viewportOnly: one screen, the page size still recorded.
    const fold = manifest.states.fold;
    assert.deepEqual([fold.fullPage, fold.size, fold.page.height > 600], [false, { width: 800, height: 600 }, true]);

    // --viewport-only for the run.
    const only = await run(CAPTURE, ['--url', `${server.url}/`, '--width', '800', '--height', '600', '--viewport-only', '--out', path.join(dir, 'only')], { env: captureEnv, cwd: dir });
    assert.equal(only.code, 0, only.stderr);
    const om = json(path.join(dir, 'only', 'capture.json'));
    assert.deepEqual([om.fullPage, om.viewportOnly, om.states['with-data'].size], [false, true, { width: 800, height: 600 }]);
    assert.equal((await run(CAPTURE, ['--url', `${server.url}/`, '--width', '800', '--height', '600', '--viewport-only', '--full-page', '--out', path.join(dir, 'x')], { cwd: dir })).code, 2);
  } finally {
    await server.close();
  }
});

browserTest('capture: an app shell\'s scroll panel is unrolled, its lazy rows included; a sideways scroller is listed as clipped', async () => {
  const server = await startServer((req, res) => html(res, SHELL_HTML));
  try {
    const dir = tmpDir();
    const grab = path.join(dir, 'grab.json');
    writeFileSync(grab, JSON.stringify({ row: { selector: '.row', props: ['background-color'], limit: 100 } }));
    const out = path.join(dir, 'shell');
    const res = await run(CAPTURE, ['--url', `${server.url}/`, '--width', '600', '--height', '400', '--grab', grab, '--out', out], { env: captureEnv, cwd: dir });
    assert.equal(res.code, 0, res.stderr);
    const state = json(path.join(out, 'capture.json')).states['with-data'];
    const png = readPng(path.join(out, state.screenshot));
    // 40 px heading + 60 px scroller + 61 rows of 40 px (50, 10 lazy, the end row).
    assert.ok(png.height >= 40 + 60 + 61 * 40, `the panel's whole content is in the PNG (height ${png.height})`);
    assert.deepEqual(state.page, { width: 600, height: png.height });
    assert.equal(state.unrolled.length, 1);
    assert.equal(state.unrolled[0].selector, 'main#panel');
    assert.equal(state.unrolled[0].axis, 'y');
    assert.ok(state.unrolled[0].addedPx >= 61 * 40 + 100 - 400 - 1, `addedPx ${state.unrolled[0].addedPx}`);
    assert.ok(json(path.join(out, 'dom', 'with-data.json')).texts.includes('End of list'), 'lazy rows inside the panel rendered');
    // The last row's box, in document coordinates, is where the PNG shows it.
    const last = json(path.join(out, 'computed', 'with-data.json')).row.samples.at(-1);
    assert.equal(last['background-color'], 'rgb(255, 0, 0)');
    assert.ok(last.__rect.y > 400 && last.__rect.y + last.__rect.h <= png.height, JSON.stringify(last.__rect));
    assert.deepEqual(pixel(png, last.__rect.x + 20, last.__rect.y + 20), [255, 0, 0], 'the end row is in the screenshot');
    // The sideways scroller stays as the app shows it, and is listed.
    assert.equal(state.clipped.length, 1);
    const [wide] = state.clipped;
    assert.deepEqual([wide.selector, wide.axis], ['div.wide', 'x']);
    assert.ok(wide.hiddenPx >= 590, `hiddenPx ${wide.hiddenPx}`);
    assert.deepEqual([wide.rect.x, wide.rect.y, wide.rect.w, wide.rect.h], [120, 40, 200, 60], 'rect in screenshot pixels');
    assert.match(res.stderr, /warning: state "with-data": the div\.wide panel scrolls sideways and hides \d[\d,]* px/);
  } finally {
    await server.close();
  }
});

browserTest('capture: a fixed-height panel is unrolled by its styles; a small one that cannot be is clipped, with a warning', async () => {
  const rows = (n, label) => Array.from({ length: n }, (_, i) => `<div style="height:40px;border-bottom:1px solid #ddd;box-sizing:border-box">${label} ${i + 1}</div>`).join('');
  const page = '<!doctype html><title>Panels</title><body style="margin:0;font:14px Arial">' +
    `<div id="log" style="width:400px;height:300px;overflow:auto">${rows(30, 'Entry')}<div id="tail" style="height:40px;background:rgb(0,0,255)">Last entry</div></div>` +
    `<div id="picker" style="width:120px;height:80px;overflow:auto">${rows(10, 'Option')}</div></body>`;
  const server = await startServer((req, res) => html(res, page));
  try {
    const dir = tmpDir();
    const grab = path.join(dir, 'grab.json');
    writeFileSync(grab, JSON.stringify({ tail: { selector: '#tail', props: ['height'], limit: 1 } }));
    const out = path.join(dir, 'panels');
    const res = await run(CAPTURE, ['--url', `${server.url}/`, '--width', '480', '--height', '360', '--grab', grab, '--out', out], { env: captureEnv, cwd: dir });
    assert.equal(res.code, 0, res.stderr);
    const manifest = json(path.join(out, 'capture.json'));
    const state = manifest.states['with-data'];
    const png = readPng(path.join(out, state.screenshot));
    assert.deepEqual(state.unrolled.map((u) => u.selector), ['div#log']);
    assert.ok(state.warnings.some((w) => /the div#log panel has a fixed height; it was unrolled by overriding its height/.test(w)));
    const tail = json(path.join(out, 'computed', 'with-data.json')).tail.samples[0].__rect;
    assert.ok(tail.y + tail.h <= png.height, `the last entry is in the PNG: ${JSON.stringify(tail)}, height ${png.height}`);
    assert.deepEqual(pixel(png, 50, tail.y + 20), [0, 0, 255]);
    // The small picker is not a main panel: left as the app shows it, listed and warned about.
    assert.deepEqual(state.clipped.map((c) => [c.selector, c.axis]), [['div#picker', 'y']]);
    assert.ok(state.clipped[0].hiddenPx >= 300);
    assert.match(res.stderr, /warning: state "with-data": the div#picker panel still hides \d+ px of content/);
    assert.ok(manifest.degradations.some((d) => d.step === 'capture:with-data' && /div#picker/.test(d.reason)));
  } finally {
    await server.close();
  }
});

browserTest('capture: a page wider than the viewport is captured at its full width', async () => {
  const page = '<!doctype html><title>Wide</title><body style="margin:0"><div style="width:1600px;height:200px;background:linear-gradient(to right, rgb(0,128,0), rgb(0,128,0) 1500px, rgb(255,0,255) 1500px)">Wide</div></body>';
  const server = await startServer((req, res) => html(res, page));
  try {
    const dir = tmpDir();
    const res = await run(CAPTURE, ['--url', `${server.url}/`, '--width', '480', '--height', '360', '--out', dir], { env: captureEnv, cwd: dir });
    assert.equal(res.code, 0, res.stderr);
    const state = json(path.join(dir, 'capture.json')).states['with-data'];
    const png = readPng(path.join(dir, state.screenshot));
    assert.deepEqual([png.width, state.size.width, state.page.width, state.viewport.width], [1600, 1600, 1600, 480]);
    assert.deepEqual(pixel(png, 1550, 100), [255, 0, 255], 'the part beyond the viewport is in the PNG');
    assert.deepEqual(state.clipped, [], 'the document\'s own overflow is captured, not clipped');
  } finally {
    await server.close();
  }
});
