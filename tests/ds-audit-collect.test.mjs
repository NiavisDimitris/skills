// Design-system audit, in-page half: the collector on fixture pages in Chromium, and the
// whole chain fixture page → collector → ds-audit.mjs → candidates. Skipped when
// Chromium cannot launch.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { auditSelectors, collectAuditElements } from '../skills/design-qa/scripts/lib/audit-collect.mjs';
import { fixture, run, script, tmpDir } from './_helpers.mjs';

async function chromium() {
  try {
    const { chromium: c } = await import('playwright');
    const browser = await c.launch({ headless: true });
    return browser;
  } catch {
    return null;
  }
}
const BROWSER = await chromium();
const SKIP = 'Chromium is not installed (run `npx playwright install chromium`)';
test.after(async () => {
  await BROWSER?.close();
});

async function openFixture(name, { width = 800, height = 600 } = {}) {
  const context = await BROWSER.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(pathToFileURL(fixture(name)).href);
  return { page, context };
}
const byText = (r, text) => r.elements.find((e) => e.text === text);

test('collector: every rendered element of the whole page, in document coordinates', async (t) => {
  if (!BROWSER) return t.skip(SKIP);
  const { page, context } = await openFixture('ds-audit-page.html');
  try {
    const r = await page.evaluate(collectAuditElements, { fullPage: true, selectors: ['[data-ds-component]', 'button:not([data-ds-component])', 'main >>> bad'] });
    assert.equal(r.fullPage, true);
    assert.ok(r.page.h > 1800, 'the page is taller than the 600px viewport');
    // Far below the fold: recorded, with its document position.
    const card = byText(r, 'Card three');
    assert.ok(card, 'an element 1000px below the fold is recorded');
    assert.ok(card.rect.y > 1500, `document y, not viewport y (${card.rect.y})`);
    assert.deepEqual(card.vis, card.rect, 'fully visible in a full-page screenshot');
    // Inside a scroll container: recorded; clipped ones say so and name their container.
    const scroller = r.elements.find((e) => e.cls.includes('scroller'));
    const deep = byText(r, 'Row 4 deep');
    assert.ok(deep, 'scrolled-out rows of an inner container are recorded');
    assert.equal(deep.vis, null, 'not visible in the screenshot');
    assert.equal(deep.clip, scroller.i);
    assert.equal(byText(r, 'Row 2').partial, true);
    assert.equal(deep.s.color, 'rgb(180, 35, 24)');
    // Not rendered: display none, opacity 0, screen-reader only.
    for (const text of ['Not rendered', 'Invisible', 'Screen reader only']) assert.equal(byText(r, text), undefined, text);
    // Properties only where they apply.
    const section = r.elements.find((e) => e.attrs['aria-label'] === 'Below the fold');
    assert.deepEqual(section.s, {}, 'a plain section: no transparent background, no zero padding, no text styles');
    assert.equal(card.s['padding-top'], '13px');
    assert.equal(card.s['border-top-color'], 'rgb(208, 212, 218)');
    assert.equal(card.s['border-top-left-radius'], '6px');
    assert.ok(!('background-color' in card.s));
    assert.equal(scroller.s.color, undefined, 'no own text: no typography');
    // Authored var() references, proven by the resolved value.
    const save = byText(r, 'Save');
    assert.equal(save.v['background-color'], '--ds-color-brand');
    assert.equal(save.v['border-top-left-radius'], '--ds-radius-control');
    const header = r.elements.find((e) => e.tag === 'header');
    assert.equal(header.v['padding-top'], '--ds-space-4', 'a shorthand padding: var() is traced to its longhands');
    // Identity, never form values or secret-looking attributes.
    assert.equal(save.attrs['data-ds-component'], 'Button');
    assert.equal(save.attrs['data-secret-token'], undefined);
    const input = r.elements.find((e) => e.tag === 'input');
    assert.equal(input.control, 'textbox');
    assert.doesNotMatch(JSON.stringify(r), /never-recorded/);
    // In-page selectors; a bad one is reported, not thrown.
    assert.deepEqual(r.selectors.map((s) => [s.count, Boolean(s.error)]), [[1, false], [2, false], [0, true]]);
    assert.deepEqual(save.sel, [0]);
    assert.ok(r.regions.includes('section "Below the fold"'));
    assert.equal(r.regions[card.r], 'section "Below the fold"');
    assert.equal(r.rootTokens['--ds-color-brand'], 'rgb(37, 99, 235)');
    assert.equal(r.truncated, null);
  } finally {
    await context.close();
  }
});

test('collector: viewport coordinates without full page; the cap keeps the whole page and says so', async (t) => {
  if (!BROWSER) return t.skip(SKIP);
  const { page, context } = await openFixture('ds-audit-page.html');
  try {
    await page.evaluate(() => window.scrollTo(0, 1000));
    const vp = await page.evaluate(collectAuditElements, { fullPage: false });
    const card = byText(vp, 'Card one');
    assert.ok(card.rect.y < 600, 'viewport coordinates');
    assert.equal(byText(vp, 'Orders').vis, null, 'above the viewport: not in a viewport screenshot');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.setContent(`<body style="margin:0">${Array.from({ length: 600 }, (_, k) => `<div style="padding:4px">Row ${k}</div>`).join('')}</body>`);
    const r = await page.evaluate(collectAuditElements, { fullPage: true, maxElements: 100 });
    assert.equal(r.elements.length, 100);
    assert.equal(r.truncated.limit, 100);
    assert.ok(r.truncated.rendered > 600);
    assert.match(r.truncated.strategy, /evenly across the whole page/);
    const ys = r.elements.map((e) => e.rect.y);
    assert.ok(Math.max(...ys) > r.page.h * 0.9, 'kept elements reach the bottom of the page, not just the top');
    const walk = await page.evaluate(collectAuditElements, { fullPage: true, maxWalk: 50 });
    assert.match(walk.truncated.walk.note, /stopped after 50 DOM nodes/);
  } finally {
    await context.close();
  }
});

test('auditSelectors: library selectors and the catalog selectors, the catalog read from inside the config folder', () => {
  const dir = tmpDir();
  copyFileSync(fixture('ds-audit-catalog.json'), path.join(dir, 'catalog.json'));
  const config = { designSystem: { componentCatalog: 'catalog.json', libraries: [{ name: 'Mui', kind: 'third-party', classPrefix: 'Mui' }, { name: 'DS', kind: 'design-system', selector: '[data-ds-component]' }] } };
  const sels = auditSelectors(config, dir);
  assert.ok(sels.includes('[data-ds-component]'));
  assert.ok(sels.includes("[data-ds-component='Button']"));
  assert.ok(sels.includes('button:not([data-ds-component])'));
  assert.deepEqual(auditSelectors({ designSystem: { componentCatalog: '../elsewhere.json' } }, dir), [], 'outside the config folder: ignored');
});

test('end to end: fixture page → collector → ds-audit.mjs → the expected candidates', { timeout: 120000 }, async (t) => {
  if (!BROWSER) return t.skip(SKIP);
  const dir = tmpDir();
  const evidence = path.join(dir, 'evidence');
  mkdirSync(path.join(evidence, 'app'), { recursive: true });
  mkdirSync(path.join(evidence, 'audit'), { recursive: true });
  copyFileSync(fixture('ds-audit-tokens.json'), path.join(dir, 'tokens.json'));
  copyFileSync(fixture('ds-audit-catalog.json'), path.join(dir, 'catalog.json'));
  const config = {
    app: { baseUrl: 'http://localhost:3000' },
    surfaces: { orders: { route: '/' } },
    designSystem: {
      name: 'Acme DS',
      tokens: ['tokens.json'],
      componentCatalog: 'catalog.json',
      libraries: [{ name: 'Mui', kind: 'third-party', classPrefix: 'Mui' }, { name: 'Old UI', kind: 'legacy', classPrefix: 'legacy-' }],
    },
  };
  writeFileSync(path.join(dir, 'design-qa.config.json'), JSON.stringify(config));
  const { page, context } = await openFixture('ds-audit-page.html');
  try {
    writeFileSync(path.join(evidence, 'app', 'with-data.png'), await page.screenshot({ fullPage: true }));
    const r = await page.evaluate(collectAuditElements, { fullPage: true, selectors: auditSelectors(config, dir) });
    writeFileSync(path.join(evidence, 'audit', 'with-data.json'), JSON.stringify(r));
  } finally {
    await context.close();
  }
  writeFileSync(path.join(evidence, 'capture.json'), JSON.stringify({ states: { 'with-data': { screenshot: 'app/with-data.png', audit: 'audit/with-data.json' } } }));
  const args = ['--evidence', evidence, '--config', path.join(dir, 'design-qa.config.json'), '--verbose'];
  const res = await run(script('ds-audit.mjs'), args);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(readFileSync(path.join(evidence, 'ds-audit.json'), 'utf8'));
  const keys = out.candidates.map((c) => c.key).sort();
  assert.deepEqual(keys, [
    'component:mui:mui-button>acme-button',
    'component:native:input-text>acme-text-field',
    'component:old-ui:legacy-tag>acme-tag',
    'component:raw:button>acme-button',
    'style:color:#2563eb',
    'style:color:#2664eb',
    'style:color:#3a3f47',
    'style:color:#b42318',
    'style:space:13px',
    'style:border-width:1px', 'style:color:#1a1d23', 'style:color:#d0d4da', 'style:color:#ffffff', 'style:radius:6px', 'style:space:12px', 'style:space:16px', 'style:space:8px', 'style:text:14px/20px-600-arial', 'style:text:16px/24px-400-arial', 'style:text:24px/32px-700-arial',
  ].sort());
  const by = Object.fromEntries(out.candidates.map((c) => [c.key, c]));
  assert.equal(by['component:mui:mui-button>acme-button'].severity, 'BLOCKER');
  assert.equal(by['component:mui:mui-button>acme-button'].expected.value, 'AcmeButton (design system)');
  assert.equal(by['style:space:13px']._audit.count, 3, 'the three cards, below the fold');
  assert.equal(by['style:color:#3a3f47'].severity, 'WARNING', 'recurring drift remains an implementation fix');
  assert.equal(by['style:color:#2664eb']._audit.kind, 'near-miss');
  assert.equal(by['style:color:#b42318']._audit.samples[0].pinnedTo, 'scroll-container');
  for (const c of out.candidates) assert.ok(c.evidence.some((e) => e.state === 'with-data' && e.crop), `${c.key} is pinned`);
  assert.equal(out.summary.nonSystemComponents, 4);
  assert.equal(out.summary.offTokenValues, 4);
  assert.ok(out.summary.elementsChecked >= 20);
  assert.equal(out.summary.tokenMatches.verified, 0, 'page-local variable names require source verification against the authoritative token names');
  assert.ok(out.summary.tokenUsageUnverified > 0);
  for (const key of keys) assert.ok(res.stdout.includes(key), `stdout names ${key}`);
  // Same page, second run: the same keys.
  const again = await run(script('ds-audit.mjs'), [...args, '--out', path.join(dir, 'again.json')]);
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'again.json'), 'utf8')).candidates.map((c) => c.key).sort(), keys);
});


test('collector: an equal literal overriding var() never proves token usage', async (t) => {
  if (!BROWSER) return t.skip(SKIP);
  const context = await BROWSER.newContext();
  const page = await context.newPage();
  try {
    await page.setContent(`<style>:root { --space-small: 8px; } .card { padding: var(--space-small); } .override { padding: 8px; }</style><main><div class="card">Token</div><div class="card override">Stylesheet literal</div><div class="card" style="padding:8px">Inline literal</div></main>`);
    const r = await page.evaluate(collectAuditElements, { fullPage: true });
    assert.equal(byText(r, 'Token').v?.['padding-top'], '--space-small');
    assert.equal(byText(r, 'Stylesheet literal').s['padding-top'], '8px');
    assert.equal(byText(r, 'Stylesheet literal').v?.['padding-top'], undefined);
    assert.equal(byText(r, 'Inline literal').v?.['padding-top'], undefined);
  } finally { await context.close(); }
});
