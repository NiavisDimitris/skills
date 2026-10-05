// The design side of a coded prototype gets element data (design-audit/<state>.json), and
// a state whose driver changed nothing (its screenshot is exactly the with-data one) is
// flagged with sameAs on both sides.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { stateFiles } from '../skills/design-qa/scripts/lib/capture-helpers.mjs';
import { fixture, run, script, startServer, tmpDir } from './_helpers.mjs';

const CAPTURE = script('capture.mjs');
const PROTO = readFileSync(fixture('proto-long.html'), 'utf8');
const captureEnv = { DESIGN_QA_COMMIT: 'test-commit', DESIGN_QA_BRANCH: 'test-branch' };
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('stateFiles: the design side\'s audit file goes with the state\'s other files', () => {
  const dirs = { shots: 'design', computed: 'design-computed', dom: 'design-dom', motion: 'design-motion', audit: 'design-audit' };
  assert.deepEqual(stateFiles(dirs, 'promo'), ['design/promo.png', 'design-computed/promo.json', 'design-dom/promo.json', 'design-motion/promo.json', 'design-audit/promo.json']);
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

const CHROMIUM = await chromiumLaunches();
const browserTest = (name, fn) =>
  test(name, { timeout: 180000 }, async (t) => {
    if (!CHROMIUM) {
      t.skip('Chromium is not installed (run `npx playwright install chromium`)');
      return;
    }
    await fn(t);
  });

const STATES = {
  'with-data': {},
  promo: { query: 'promo=1' },
  pixel: { query: 'px=1' },
  hover: { action: 'hover', selector: '#cta' },
  gone: {},
};

function protoServer() {
  return startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PROTO);
  });
}

browserTest('capture --side design: design-audit/<state>.json with elements below the fold; sameAs for a driver that changed nothing', async () => {
  const server = await protoServer();
  try {
    const dir = tmpDir();
    const out = path.join(dir, 'evidence');
    // Stale evidence of a state that is skipped this time must not survive.
    mkdirSync(path.join(out, 'design-audit'), { recursive: true });
    writeFileSync(path.join(out, 'design-audit', 'gone.json'), '{"stale":true}');
    const states = path.join(dir, 'states.json');
    writeFileSync(states, JSON.stringify(STATES));
    const res = await run(CAPTURE, ['--side', 'design', '--url', `${server.url}/proto`, '--width', '480', '--height', '360', '--states', states, '--out', out], { env: captureEnv, cwd: dir });
    assert.equal(res.code, 0, res.stderr);
    const manifest = json(path.join(out, 'design-capture.json'));

    // 1. Element data for the design side, whole page.
    const withData = manifest.states['with-data'];
    assert.equal(withData.audit, 'design-audit/with-data.json');
    const audit = json(path.join(out, withData.audit));
    assert.ok(Array.isArray(audit.elements) && audit.elements.length > 20, 'every rendered element is recorded');
    const footer = audit.elements.find((e) => e.id === 'footer');
    assert.ok(footer, 'the footer below the fold is in the audit');
    assert.ok(footer.rect.y > 360, `its box is in document coordinates below the 360 px fold: ${JSON.stringify(footer.rect)}`);
    for (const state of ['promo', 'pixel', 'hover']) assert.equal(manifest.states[state].audit, `design-audit/${state}.json`);
    assert.equal(manifest.states.gone.audit, null, 'a skipped state has no audit');
    assert.ok(!existsSync(path.join(out, 'design-audit', 'gone.json')), 'its stale audit file is deleted');

    // 2. sameAs: only the ignored query driver; one changed pixel or a hover is not the same.
    assert.equal(manifest.states.promo.sameAs, 'with-data');
    assert.ok(
      manifest.states.promo.warnings.includes(
        'promo looks exactly like with-data: the driver changed nothing (its page text and structure are identical too). Either the prototype does not implement this state, or the driver is wrong.',
      ),
      JSON.stringify(manifest.states.promo.warnings),
    );
    assert.match(res.stderr, /warning: state "promo": promo looks exactly like with-data: the driver changed nothing/);
    assert.equal(manifest.states.pixel.sameAs, null, 'a single changed pixel is a different screenshot');
    assert.equal(manifest.states.hover.sameAs, null, 'the hover state is untouched');
    assert.deepEqual(manifest.states.hover.warnings, []);
    assert.equal(manifest.states['with-data'].sameAs, null);
    assert.equal(manifest.states.gone.sameAs, null);
  } finally {
    await server.close();
  }
});

browserTest('capture (app side): sameAs on an ignored driver, also when the state is re-captured alone into the folder', async () => {
  const server = await protoServer();
  try {
    const dir = tmpDir();
    const out = path.join(dir, 'evidence');
    const states = path.join(dir, 'states.json');
    writeFileSync(states, JSON.stringify(STATES));
    const base = ['--url', `${server.url}/orders`, '--width', '480', '--height', '360', '--states', states, '--out', out];
    const res = await run(CAPTURE, base, { env: captureEnv, cwd: dir });
    assert.equal(res.code, 0, res.stderr);
    const manifest = json(path.join(out, 'capture.json'));
    assert.equal(manifest.states.promo.sameAs, 'with-data');
    assert.match(manifest.states.promo.warnings.join(' '), /Either the app does not implement this state, or the driver is wrong\./);
    assert.equal(manifest.states.promo.screenshot, 'app/promo.png', 'the capture itself is kept: nothing fails');
    assert.equal(manifest.states.promo.audit, 'audit/promo.json');

    // Re-capture only promo: compared with the with-data screenshot kept in the folder; the
    // warning is not repeated.
    const again = await run(CAPTURE, [...base, '--state', 'promo'], { env: captureEnv, cwd: dir });
    assert.equal(again.code, 0, again.stderr);
    const merged = json(path.join(out, 'capture.json'));
    assert.equal(merged.states.promo.sameAs, 'with-data');
    assert.equal(merged.states.promo.warnings.filter((w) => /looks exactly like/.test(w)).length, 1);
    assert.equal(merged.states.pixel.sameAs, null);
  } finally {
    await server.close();
  }
});
