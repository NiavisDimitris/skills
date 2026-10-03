// Browser tests for templates/report.html with report 2.0 data: no Figma sync, Dismiss (panel,
// pending bar, copy/download, Undo), the Design system tab, multi-screen state picking and the
// Design backfill tab (step 2: decisions, pending bar, design-agent prompts).
// Skipped when Chromium cannot launch.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { ROOT, SKILL, loadFixture, tmpDir } from './_helpers.mjs';

const TEMPLATE = path.join(SKILL, 'templates', 'report.html');
const SAMPLE_EVIDENCE = path.join(ROOT, 'examples', 'sample', 'evidence');

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

// Same injection as fillTemplate() in scripts/render-report.mjs (kept local so this test
// does not depend on the renderer's validation of the report).
function serializeForScript(value) {
  return JSON.stringify(value).replace(/<\//g, '<\\/').replace(/<!--/g, '\\u003c!--').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
function fill(template, report, assets) {
  return template
    .replace('/*__DESIGN_QA_DATA__*/', () => serializeForScript(report))
    .replace('/*__DESIGN_QA_ASSETS__*/', () => serializeForScript(assets))
    .split('__DESIGN_QA_TITLE__')
    .join(`Design QA — ${report.meta.feature}`);
}
// The fixtures point at evidence/{design,app,diff}/<state>.png; embed the sample images.
function assetsFor(report) {
  const out = {};
  const json = JSON.stringify(report);
  for (const m of json.matchAll(/"evidence\/(design|app|diff)\/([a-z-]+)\.png"/g)) {
    const file = path.join(SAMPLE_EVIDENCE, m[1] === 'design' ? 'figma' : m[1], `${m[2]}.png`);
    if (existsSync(file)) out[`evidence/${m[1]}/${m[2]}.png`] = `data:image/png;base64,${readFileSync(file).toString('base64')}`;
  }
  // Backfill items carry app-only captures (evidence/backfill/app/<state>.png): any sample app image will do.
  for (const m of json.matchAll(/"evidence\/backfill\/app\/([a-z-]+)\.png"/g)) {
    const own = path.join(SAMPLE_EVIDENCE, 'app', `${m[1]}.png`);
    const file = existsSync(own) ? own : path.join(SAMPLE_EVIDENCE, 'app', 'with-data.png');
    out[`evidence/backfill/app/${m[1]}.png`] = `data:image/png;base64,${readFileSync(file).toString('base64')}`;
  }
  return out;
}
function renderFixture(name, dir = tmpDir('design-qa-ui-'), mutate = null) {
  const report = loadFixture(name);
  if (mutate) mutate(report);
  const file = path.join(dir, name.replace(/\.json$/, '.html'));
  writeFileSync(file, fill(readFileSync(TEMPLATE, 'utf8'), report, assetsFor(report)));
  return { file, url: pathToFileURL(file).href, report };
}

const STUB = () => {
  window.__copied = null;
  const grab = (t) => { window.__copied = t; return Promise.resolve(); };
  Object.defineProperty(Navigator.prototype, 'clipboard', { configurable: true, get: () => ({ writeText: grab }) });
  const exec = Document.prototype.execCommand;
  Document.prototype.execCommand = function (cmd, ...rest) {
    if (cmd === 'copy') { const a = document.activeElement; window.__copied = a && 'value' in a ? a.value : null; return true; }
    return exec.call(this, cmd, ...rest);
  };
};

let browser;
async function open(t, name, { hash = '', width = 1440, height = 1000, mutate = null } = {}) {
  if (!browser) {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
  }
  const { url, report } = renderFixture(name, undefined, mutate);
  const context = await browser.newContext({ viewport: { width, height }, acceptDownloads: true });
  await context.addInitScript(STUB);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url + hash);
  await page.waitForSelector('#page-title');
  t.after(() => context.close());
  return { page, errors, report, url, context };
}
test.after(async () => { if (browser) await browser.close(); });

const ids = (page, sel) => page.$$eval(sel, (els) => els.map((e) => e.getAttribute('data-fid')));

test('template carries no Figma-sync remnants', () => {
  const src = readFileSync(TEMPLATE, 'utf8');
  for (const s of ['SYNC_FIGMA', 'Sync to Figma', 'sync-figma', 'Copy Figma prompt', 'design agent', 'MISSING_IN_DESIGN', 'figmaPromptText']) {
    assert.equal(src.includes(s), false, `template still contains ${s}`);
  }
});

test('report 2.0 renders: source label, no sync UI, pre-dismissed findings, no pins for them', { timeout: 60000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP_REASON);
  const { page, errors } = await open(t, 'ui-report.json', { hash: '#state=with-data' });
  const text = await page.evaluate(() => document.body.innerText);
  for (const s of ['Sync to Figma', 'SYNC_FIGMA', 'Copy Figma prompt', 'design agent']) assert.equal(text.includes(s), false, s);

  // Design pane label from meta.source.kind
  await page.click('[aria-label="View"] [data-v="side"]');
  const labels = await page.$$eval('.pane-label', (els) => els.map((e) => e.textContent));
  assert.deepEqual(labels, ['Design (Figma)', 'Implementation (app)']);

  // Dismissed findings: listed with kind, reason, by, date; never pinned
  assert.equal(await page.locator('.pin[data-fid="DQ-008"], .pin[data-fid="DQ-015"]').count(), 0);
  assert.ok(await page.locator('.pin[data-fid="DQ-002"]').count() > 0, 'open findings keep their pins');
  assert.equal(await page.textContent('#count-dismissed'), '3');
  await page.click('#h-dismissed');
  const d8 = await page.textContent('#dismissed-list li[data-fid="DQ-008"]');
  assert.match(d8, /Not an issue/);
  assert.match(d8, /Rendering noise: anti-aliasing on the 1px divider/);
  assert.match(d8, /by A\. Lee · 2026-09-30/);
  assert.match(await page.textContent('#dismissed-list li[data-fid="DQ-015"]'), /Removed from QA.*by J\. Park/s);
  assert.match(await page.textContent('#dismissed-list li[data-fid="DQ-009"]'), /Accepted as intentional.*M\. Ortiz/s);
  assert.equal(await page.locator('#dismissed-list [data-undo]').count(), 0, 'recorded dismissals have no local Undo');
  assert.equal(await page.isHidden('#dismiss-bar'), true);

  // Summary: dismissed findings leave the denominator; design-system counts from the scorecard
  const summary = await page.textContent('#summary');
  assert.match(summary, /9 of 13 findings open/);
  assert.match(summary, /2 dismissed/);
  assert.match(summary, /Design system: 3 token · 1 component · 2 motion/);

  // Board holds FIX_CODE findings only, each with a Dismiss button
  assert.deepEqual((await ids(page, '#lane-fix .tri-card')).sort(), ['DQ-001', 'DQ-002', 'DQ-003', 'DQ-004', 'DQ-006']);
  assert.deepEqual((await ids(page, '#lane-debt .tri-card')).sort(), ['DQ-007', 'DQ-013', 'DQ-014']);
  assert.equal(await page.locator('.tri-card [data-dismiss]').count(), 8);
  assert.equal(await page.locator('#copy-figma-prompt').count(), 0);
  assert.deepEqual(errors, []);
});

test('Dismiss: panel, required reason, save, pending bar, copy for Claude Code, download, Undo', { timeout: 90000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP_REASON);
  const { page, errors, url } = await open(t, 'ui-report.json');

  // 1. Board card → inline panel, focus inside, Save disabled until a reason is typed, Esc closes
  const trigger = page.locator('.tri-card[data-fid="DQ-004"] [data-dismiss]');
  await trigger.click();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
  const panel = page.locator('.dismiss-panel[data-panel-for="DQ-004"]');
  assert.equal(await panel.isVisible(), true);
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('.dismiss-panel')), true, 'focus moves into the panel');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Not an issue');
  await page.keyboard.press('Escape');
  assert.equal(await panel.count(), 0, 'Esc closes the panel');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-dismiss')), 'DQ-004', 'focus returns to the trigger');

  await trigger.click();
  const save = panel.locator('.dp-save');
  assert.equal(await save.isDisabled(), true);
  await panel.getByLabel('Reason (required)').fill('   ');
  assert.equal(await save.isDisabled(), true, 'blank reason keeps Save disabled');
  await panel.getByLabel('Reason (required)').fill('Matches the design within tolerance after zoom.');
  await panel.getByLabel('Your name').fill('Dana');
  assert.equal(await save.isDisabled(), false);
  await save.click();

  assert.equal(await page.locator('.tri-card[data-fid="DQ-004"]').count(), 0, 'leaves the board');
  assert.equal(await page.textContent('#dismiss-bar-msg'), '1 dismissal not recorded yet');
  assert.equal(await page.isVisible('#dismiss-bar'), true);
  assert.equal(await page.textContent('#count-dismissed'), '4');
  assert.match(await page.textContent('#summary'), /8 of 12 findings open.*3 dismissed.*2 token/s);
  assert.match(await page.textContent('#dismissed-list li[data-fid="DQ-004"]'), /Not an issue.*by Dana.*Not recorded yet.*Matches the design within tolerance/s);

  // 2. Findings table row → Remove from QA (multi-line reason is folded into one line in the message)
  await page.click('#tab-findings');
  await page.click('#findings-table [data-dismiss="DQ-007"]');
  const p7 = page.locator('.dismiss-panel[data-panel-for="DQ-007"]');
  assert.equal(await page.locator('tr.dismiss-tr').count(), 1, 'opens inline under the row');
  await p7.locator('[role="radio"][data-v="remove"]').click();
  assert.equal(await p7.getByLabel('Your name').inputValue(), 'Dana', 'name remembered');
  await p7.getByLabel('Reason (required)').fill('Duplicate of DQ-006:\n  same skeleton');
  await p7.getByRole('button', { name: 'Save' }).click();
  assert.equal(await page.textContent('#f-DQ-007 td:nth-child(7)'), 'DISMISSEDnot recorded');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-undo')), 'DQ-007', 'focus lands on the row Undo');

  // 3. Finding detail → Accept as intentional (the old sign-off), keyboard only
  await page.click('#f-DQ-012');
  await page.click('#finding-sheet [data-dismiss="DQ-012"]');
  await page.keyboard.press('ArrowRight'); // Not an issue → Remove from QA
  await page.keyboard.press('ArrowRight'); // → Accept as intentional
  const p12 = page.locator('#finding-sheet .dismiss-panel');
  assert.equal(await p12.locator('[aria-checked="true"]').textContent(), 'Accept as intentional');
  await p12.getByLabel('Reason (required)').fill('Copy approved by content design.');
  await p12.getByLabel('Reason (required)').press('Control+Enter');
  assert.match(await page.textContent('#sheet-dismissal'), /Accepted as intentional · by Dana.*not recorded yet.*Copy approved by content design/s);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'sheet-undo');
  await page.keyboard.press('Escape');
  assert.equal(await page.isHidden('#sheet-root'), true);

  assert.equal(await page.textContent('#dismiss-bar-msg'), '3 dismissals not recorded yet');
  await page.click('#copy-dismiss');
  await page.waitForFunction(() => window.__copied);
  assert.equal(await page.evaluate(() => window.__copied), [
    '/design-qa dismiss ACME-482',
    'DQ-004 not-an-issue — Matches the design within tolerance after zoom.',
    'DQ-007 remove — Duplicate of DQ-006: same skeleton',
    'DQ-012 intentional — Copy approved by content design.',
    'by: Dana',
  ].join('\n'));

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download-dismissals')]);
  assert.equal(dl.suggestedFilename(), 'dismissals.json');
  const json = JSON.parse(readFileSync(await dl.path(), 'utf8'));
  for (const it of json.items) {
    assert.match(it.date, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
    delete it.date;
  }
  assert.deepEqual(json, {
    feature: 'Orders list', slug: 'ACME-482', reportGeneratedAt: '2026-10-01T12:00:00Z', decidedBy: 'Dana',
    items: [
      { findingId: 'DQ-004', kind: 'not-an-issue', reason: 'Matches the design within tolerance after zoom.', by: 'Dana' },
      { findingId: 'DQ-007', kind: 'remove', reason: 'Duplicate of DQ-006:\n  same skeleton', by: 'Dana' },
      { findingId: 'DQ-012', kind: 'intentional', reason: 'Copy approved by content design.', by: 'Dana' },
    ],
  });

  // 4. Undo from the Dismissed list: back on the board, bar count drops
  await page.click('#tab-overview');
  if ((await page.getAttribute('#h-dismissed', 'aria-expanded')) !== 'true') await page.click('#h-dismissed');
  await page.click('#dismissed-list li[data-fid="DQ-007"] [data-undo]');
  assert.deepEqual(await ids(page, '#lane-debt .tri-card[data-fid="DQ-007"]'), ['DQ-007']);
  assert.equal(await page.textContent('#dismiss-bar-msg'), '2 dismissals not recorded yet');

  // 5. Dismissals survive a reload (localStorage keyed by feature + generatedAt)
  await page.goto(url);
  await page.waitForSelector('#page-title');
  assert.equal(await page.textContent('#dismiss-bar-msg'), '2 dismissals not recorded yet');
  assert.equal(await page.locator('.tri-card[data-fid="DQ-004"]').count(), 0);
  assert.deepEqual(errors, []);
});

test('Design system tab: token, component and motion mismatches; Missing motion; dismiss from a row', { timeout: 60000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP_REASON);
  const { page, errors } = await open(t, 'ui-report.json', { hash: '#tab=design-system' });
  assert.equal(await page.getAttribute('#tab-design-system', 'aria-selected'), 'true');
  assert.deepEqual(await ids(page, '#ds-tokens tbody tr[data-fid]'), ['DQ-003', 'DQ-004', 'DQ-013']);
  const t3 = await page.textContent('#ds-tokens tr[data-fid="DQ-003"]');
  assert.match(t3, /--ads-color-surface-hover/);
  assert.match(t3, /hardcoded/);
  assert.match(await page.textContent('#ds-tokens tr[data-fid="DQ-004"]'), /--ads-space-6.*24px.*--ads-space-5.*20px/s);
  assert.deepEqual(await ids(page, '#ds-components tbody tr[data-fid]'), ['DQ-002']);
  assert.match(await page.textContent('#ds-components tr[data-fid="DQ-002"]'), /Table\.Header.*compact.*thead \(custom CSS\)/s);
  assert.deepEqual(await ids(page, '#ds-motion tbody tr[data-fid]'), ['DQ-006', 'DQ-007'], 'the passing motion check is left out');
  const m6 = await page.textContent('#ds-motion tr[data-fid="DQ-006"]');
  assert.match(m6, /hover.*background-color.*transition · 150ms · ease-out.*Missing/s);
  assert.equal(await page.locator('#ds-motion tr[data-fid="DQ-006"] .motion-missing').count(), 1);
  assert.match(await page.textContent('#ds-motion tr[data-fid="DQ-007"]'), /transition · 400ms · linear/);
  assert.equal(await page.locator('#ds-motion tr[data-fid="DQ-007"] .motion-missing').count(), 0);
  assert.equal(await page.textContent('#ds-stats'), '3 tokens1 component2 motion');
  assert.equal(await page.textContent('#tab-design-system .tabular'), '6');

  // Each row links to its finding
  await page.click('#ds-components tr[data-fid="DQ-002"] .fid');
  assert.equal(await page.getAttribute('#finding-sheet', 'data-id'), 'DQ-002');
  await page.keyboard.press('Escape');

  // Dismiss from a motion row: the row leaves, the counts follow
  await page.click('#ds-motion [data-dismiss="DQ-006"]');
  await page.getByLabel('Reason (required)').fill('The hover tint is instant in the design system spec.');
  await page.locator('.dismiss-panel').getByRole('button', { name: 'Save' }).click();
  assert.deepEqual(await ids(page, '#ds-motion tbody tr[data-fid]'), ['DQ-007']);
  assert.equal(await page.textContent('#ds-stats'), '3 tokens1 component1 motion');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'dismiss-bar-msg');

  // Findings: the ledger filter offers Motion
  await page.click('#tab-findings');
  await page.click('[data-facet="ledger"]');
  const items = await page.$$eval('.menu .menu-item', (els) => els.map((e) => e.textContent));
  assert.ok(items.some((s) => s.startsWith('Motion')), items.join(' | '));
  await page.click('.menu [data-v="motion"]');
  await page.keyboard.press('Escape');
  assert.deepEqual((await page.$$eval('#findings-table tbody tr[data-id]', (els) => els.map((e) => e.getAttribute('data-id')))).sort(), ['DQ-006', 'DQ-007']);
  assert.deepEqual(errors, []);
});

test('multi-screen: screen select filters the state tabs; badges name the screen; prototype source', { timeout: 60000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP_REASON);
  const { page, errors } = await open(t, 'ui-report-multiscreen.json');
  const opts = await page.$$eval('#screen-select option', (els) => els.map((e) => [e.value, e.textContent]));
  assert.deepEqual(opts, [['cart', 'Cart'], ['checkout', 'Checkout']]);
  assert.equal(await page.inputValue('#screen-select'), 'cart');
  const tabs = () => page.$$eval('.state-tabs [role="tab"]', (els) => els.map((e) => e.getAttribute('data-state')));
  assert.deepEqual(await tabs(), ['cart/with-items', 'cart/empty']);
  await page.selectOption('#screen-select', 'checkout');
  assert.deepEqual(await tabs(), ['checkout/form', 'checkout/error']);
  assert.match(await page.evaluate(() => location.hash), /state=checkout%2F(form|error)/);
  assert.equal(await page.textContent('.state-tabs [aria-selected="true"]').then((s) => /Form|Error/.test(s)), true);

  await page.click('[aria-label="View"] [data-v="side"]');
  assert.equal(await page.textContent('.pane-label'), 'Design (prototype)');
  assert.match(await page.textContent('.page-head .meta'), /Prototype.*Checkout prototype.*framer/s);

  // Fallback ranking (ranks missing) puts the open FIX_CODE findings on the board
  assert.deepEqual((await ids(page, '.tri-card')).sort(), ['DQ-001', 'DQ-002', 'DQ-003']);
  await page.click('.tri-card[data-fid="DQ-003"] .tri-open');
  assert.equal(await page.textContent('#finding-sheet [data-screen]'), 'Checkout');
  assert.match(await page.textContent('#finding-sheet .sheet-header'), /Motion · Form/);
  await page.keyboard.press('Escape');

  // A state deep link picks its screen
  await page.evaluate(() => { location.hash = '#state=cart%2Fempty'; });
  await page.waitForFunction(() => document.querySelector('#screen-select').value === 'cart');
  assert.deepEqual(await tabs(), ['cart/with-items', 'cart/empty']);
  assert.deepEqual(errors, []);
});

test('narrow viewport and dark theme render without errors', { timeout: 60000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP_REASON);
  const { page, errors } = await open(t, 'ui-report.json', { width: 390, height: 844 });
  await page.click('[data-theme-btn="dark"]');
  await page.click('.tri-card[data-fid="DQ-003"] [data-dismiss]');
  const box = await page.locator('.dismiss-panel').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, `panel fits the viewport (${box.x}, ${box.width})`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 390), true, 'no horizontal page scroll');
  assert.deepEqual(errors, []);
});

/* ===== Design backfill (step 2) ===== */
const BF_INTRO = 'Build these states as new frames in the Figma file, next to their anchor frames. Use the design-system library only: library component instances in the right variant, variables for colour, spacing, radius and type, text styles; never raw hex, never detached or local components. If the library lacks a piece, stop and list it as a DS gap. Re-export each frame at 1x and compare it with the app capture.';
const BF_001 = [
  '[BF-001] Bulk selected',
  'Exists in: the app, not the design · found by: source — OrdersTable.tsx:88 renders BulkBar when selection.length > 0',
  'App capture: evidence/backfill/app/bulk-selected.png',
  'Place: next to "Orders – With data" (12:345), named "Orders – Bulk selected"',
  'Build with: Button (Secondary), Checkbox (Checked) · tokens color/surface/raised, space/4',
  'DS gaps: –',
].join('\n');
const BF_002 = [
  '[BF-002] Saved toast',
  'Exists in: the app, not the design · found by: ticket — AC-4: a toast confirms the save',
  'App capture: evidence/backfill/app/saved-toast.png',
  'Place: next to "Orders – With data" (12:345), named "Orders – Saved toast"',
  'Build with: Toast (Success) [not in library] · tokens color/feedback/success',
  'DS gaps: Toast (Success)',
].join('\n');
const BF_004 = [
  '[BF-004] Refreshing',
  'Exists in: the app, not the design · found by: source — useOrders.ts:41 shows a spinner while isFetching',
  'App capture: –',
  'Place: next to "Orders – Loading" (12:350), named "Orders – Refreshing"',
  'Build with: – · tokens –',
  'DS gaps: –',
].join('\n');
const block = (...items) => [BF_INTRO, ...items].join('\n\n');
async function copied(page, sel) {
  await page.evaluate(() => { window.__copied = null; });
  await page.click(sel);
  await page.waitForFunction(() => window.__copied !== null);
  return page.evaluate(() => window.__copied);
}
// Everything step 1 shows: the backfill tab must never change any of it.
async function step1Snapshot(page) {
  return page.evaluate(() => {
    const txt = (s) => { const el = document.querySelector(s); return el ? el.textContent : null; };
    const fids = (s) => Array.from(document.querySelectorAll(s)).map((e) => e.getAttribute('data-fid') || e.getAttribute('data-id'));
    return {
      summary: txt('#summary'), verdict: txt('#verdict'), dismissed: txt('#count-dismissed'), dsStats: txt('#ds-stats'),
      tabFindings: txt('#tab-findings'), tabDs: txt('#tab-design-system'), pins: fids('.pin'), board: fids('.tri-card'),
      table: fids('#findings-table tbody tr[data-id]'), dsRows: fids('#panel-design-system tr[data-fid]'), dismissBar: document.querySelector('#dismiss-bar').hidden,
    };
  });
}

test('Design backfill tab is hidden when report.backfill has no items', { timeout: 60000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP_REASON);
  const { page, errors } = await open(t, 'ui-report.json', { hash: '#tab=backfill' });
  assert.equal(await page.locator('#tab-backfill, #panel-backfill').count(), 0);
  assert.equal(await page.getAttribute('#tab-overview', 'aria-selected'), 'true', 'an unknown tab falls back to Overview');
  assert.equal(await page.isHidden('#backfill-bar'), true);
  const empty = await open(t, 'ui-report.json', { mutate: (r) => { r.backfill = { gate: { override: null }, items: [] }; } });
  assert.equal(await empty.page.locator('#tab-backfill').count(), 0);
  assert.deepEqual([...errors, ...empty.errors], []);
});

test('Design backfill tab: last tab, not-ready notice, cards, thumbnail, design-agent prompts', { timeout: 60000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP_REASON);
  const { page, errors, report } = await open(t, 'ui-report-backfill.json', { hash: '#tab=backfill' });
  const tabs = await page.$$eval('[aria-label="Report sections"] [role="tab"]', (els) => els.map((e) => e.id));
  assert.equal(tabs[tabs.length - 1], 'tab-backfill', 'last tab, after Evidence');
  assert.equal(tabs[tabs.length - 2], 'tab-evidence');
  assert.equal(await page.textContent('#tab-backfill'), 'Design backfill4');
  assert.equal(await page.getAttribute('#tab-backfill', 'aria-selected'), 'true');
  assert.equal(await page.textContent('#h-backfill'), 'Step 2 · Build undesigned states in Figma');
  assert.equal(await page.getAttribute('#bf-ready', 'data-ready'), 'false');
  assert.equal(await page.textContent('#bf-ready'), 'Production does not match the design yet (9 open).Finish step 1 first; the list below is for planning.');

  const cards = await page.$$eval('.bf-card', (els) => els.map((e) => [e.getAttribute('data-bf'), e.getAttribute('data-decision')]));
  assert.deepEqual(cards, [['BF-001', 'pending'], ['BF-002', 'build'], ['BF-003', 'pending'], ['BF-004', 'not-needed']]);
  assert.equal(await page.textContent('#bf-stats'), '4 candidates1 to build0 built1 not needed2 pending');
  const c1 = await page.textContent('#bf-BF-001');
  assert.match(c1, /bulk-selected.*source.*OrdersTable\.tsx:88 renders BulkBar.*next to “Orders – With data” 12:345.*as “Orders – Bulk selected”.*Button· Secondary.*Checkbox· Checked.*color\/surface\/raised.*space\/4/s);
  assert.equal(await page.locator('#bf-BF-001 .bf-gap').count(), 0);
  assert.equal(await page.locator('#bf-BF-002 .bf-gap').count(), 1, 'a component the library lacks is flagged');
  assert.match(await page.textContent('#bf-BF-002'), /Toast· Success.*not in library.*DS gaps.*Toast \(Success\).*To build · by A\. Lee, 2026-10-01/s);
  assert.equal(await page.locator('#bf-BF-002 [data-bf-build]').count(), 0, 'already decided build');
  assert.equal(await page.locator('#bf-BF-002 [data-bf-skip]').count(), 1);
  assert.equal(await page.locator('#bf-BF-003 .bf-nocap').count(), 1, 'no capture → placeholder');
  assert.match(await page.textContent('#bf-BF-004 .bf-reason'), /^Same as Loading; the loading frame covers it\.$/);
  assert.equal(await page.locator('#bf-BF-004 [data-bf-copy]').count(), 0, 'no prompt for a state that is not needed');
  assert.equal(await page.locator('#bf-BF-004 [data-bf-build]').count(), 1, 'can still be switched to build');

  // The app capture opens larger in the lightbox
  await page.click('#bf-BF-001 .thumb');
  assert.equal(await page.isVisible('#lightbox .dialog'), true);
  assert.equal(await page.textContent('#lb-title'), 'BF-001 · Bulk selected');
  await page.keyboard.press('Escape');
  assert.equal(await page.isHidden('#lightbox'), true);

  // Prompts: one item (intro + block) and Copy all (every item to build, report or browser decision)
  assert.equal(await copied(page, '#bf-BF-001 [data-bf-copy]'), block(BF_001));
  assert.equal(await copied(page, '#copy-backfill-all'), block(BF_002));
  // No anchor: placed next to the main design frame, named after the feature
  assert.match(await copied(page, '#bf-BF-003 [data-bf-copy]'), /\nPlace: next to the main design frame \(1:2\), named "Orders list – Filter – no results"\nBuild with: EmptyState \(Search\) · tokens –\nDS gaps: –$/);
  // Same text as report-backfill.md (scripts/lib/backfill-plan.mjs), item by item
  const plan = path.join(SKILL, 'scripts', 'lib', 'backfill-plan.mjs');
  if (existsSync(plan)) {
    const { designAgentBlock } = await import(pathToFileURL(plan).href);
    for (const it of report.backfill.items.filter((i) => i.decision !== 'not-needed')) {
      assert.equal(await copied(page, `#bf-${it.id} [data-bf-copy]`), designAgentBlock([it], report), `${it.id} matches the plan`);
    }
    assert.equal(await copied(page, '#copy-backfill-all'), designAgentBlock(report.backfill.items.filter((i) => i.decision === 'build'), report));
  }
  assert.deepEqual(errors, []);
});

test('Design backfill decisions: Not needed needs a reason, Build in Figma, pending bar, copy, download, Undo, reload', { timeout: 90000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP_REASON);
  const { page, errors, url } = await open(t, 'ui-report-backfill.json', { hash: '#tab=backfill' });
  const before = await step1Snapshot(page);

  // 1. Not needed → inline panel (dismiss style), focus in the reason, Save disabled until a reason, Esc closes
  const skip = page.locator('[data-bf-skip="BF-003"]');
  await skip.click();
  const panel = page.locator('.dismiss-panel[data-panel-for="BF-003"]');
  assert.equal(await panel.isVisible(), true);
  assert.equal(await skip.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'bfp-BF-003-reason');
  const save = panel.locator('.dp-save');
  assert.equal(await save.isDisabled(), true);
  await panel.getByLabel('Reason (required)').fill('  ');
  assert.equal(await save.isDisabled(), true, 'blank reason keeps Save disabled');
  await page.keyboard.press('Escape');
  assert.equal(await panel.count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-bf-skip')), 'BF-003', 'focus returns to the trigger');

  await skip.click();
  await panel.getByLabel('Reason (required)').fill('Covered by the Empty frame: same layout.\n  Search copy only.');
  await panel.getByLabel('Your name').fill('Dana');
  await panel.getByLabel('Reason (required)').press('Control+Enter');
  assert.equal(await page.getAttribute('#bf-BF-003', 'data-decision'), 'not-needed');
  assert.match(await page.textContent('#bf-BF-003'), /Not needed.*Not recorded yet.*by Dana.*\(this browser\)/s);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-bf-undo')), 'BF-003', 'focus lands on Undo');
  assert.equal(await page.isVisible('#backfill-bar'), true);
  assert.equal(await page.isHidden('#dismiss-bar'), true, 'the dismiss bar is separate');
  assert.equal(await page.textContent('#backfill-bar-msg'), '1 backfill decision not recorded yet');

  // 2. Build in Figma: one click (the remembered name signs it); a recorded not-needed can be switched to build
  await page.click('[data-bf-build="BF-001"]');
  await page.click('[data-bf-build="BF-004"]');
  assert.equal(await page.getAttribute('#bf-BF-001', 'data-decision'), 'build');
  assert.equal(await page.getAttribute('#bf-BF-004', 'data-decision'), 'build');
  assert.equal(await page.textContent('#backfill-bar-msg'), '3 backfill decisions not recorded yet');
  assert.equal(await page.textContent('#bf-stats'), '4 candidates3 to build0 built1 not needed0 pending');
  assert.equal(await copied(page, '#copy-backfill-all'), block(BF_001, BF_002, BF_004));

  const message = await copied(page, '#copy-backfill');
  assert.equal(message, [
    '/design-qa backfill ACME-482',
    'BF-001 build',
    'BF-003 not-needed — Covered by the Empty frame: same layout. Search copy only.',
    'BF-004 build',
    'by: Dana',
  ].join('\n'));

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download-backfill')]);
  assert.equal(dl.suggestedFilename(), 'backfill.json');
  const json = JSON.parse(readFileSync(await dl.path(), 'utf8'));
  for (const it of json.items) {
    assert.match(it.date, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
    delete it.date;
  }
  assert.deepEqual(json, {
    feature: 'Orders list', slug: 'ACME-482', reportGeneratedAt: '2026-10-01T12:00:00Z', decidedBy: 'Dana',
    items: [
      { id: 'BF-001', decision: 'build', reason: null, by: 'Dana' },
      { id: 'BF-003', decision: 'not-needed', reason: 'Covered by the Empty frame: same layout.\n  Search copy only.', by: 'Dana' },
      { id: 'BF-004', decision: 'build', reason: null, by: 'Dana' },
    ],
  });
  // scripts/lib/backfill.mjs reads both and formats the same message
  const lib = path.join(SKILL, 'scripts', 'lib', 'backfill.mjs');
  if (existsSync(lib)) {
    const { formatBackfillMessage, parseBackfillFile } = await import(pathToFileURL(lib).href);
    const fromJson = parseBackfillFile(readFileSync(await dl.path(), 'utf8'));
    assert.equal(formatBackfillMessage({ slug: fromJson.slug, items: fromJson.items, decidedBy: fromJson.decidedBy }), message);
    const fromChat = parseBackfillFile(message);
    assert.deepEqual(fromChat.items.map((i) => [i.id, i.decision, i.reason || null]), fromJson.items.map((i) => [i.id, i.decision, i.reason ? i.reason.replace(/\s*\n\s*/g, ' ') : null]));
  }

  // 3. Undo puts the recorded decision back
  await page.click('[data-bf-undo="BF-004"]');
  assert.equal(await page.getAttribute('#bf-BF-004', 'data-decision'), 'not-needed');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-bf-build')), 'BF-004');
  assert.equal(await page.textContent('#backfill-bar-msg'), '2 backfill decisions not recorded yet');

  // 4. Step 1 is untouched: summary, verdict, pins, board, findings table, Design system
  assert.deepEqual(await step1Snapshot(page), before);

  // 5. Decisions survive a reload (own localStorage key); dismissals and backfill bars stay apart
  await page.goto(url + '#tab=backfill');
  await page.waitForSelector('#page-title');
  assert.equal(await page.textContent('#backfill-bar-msg'), '2 backfill decisions not recorded yet');
  assert.equal(await page.getAttribute('#bf-BF-003', 'data-decision'), 'not-needed');
  assert.equal(await page.isHidden('#dismiss-bar'), true);
  await page.click('#review-backfill');
  assert.equal(await page.getAttribute('#tab-backfill', 'aria-selected'), 'true');
  assert.deepEqual(errors, []);
});

test('Design backfill readiness: loopClosed, override, local fallback; built items link to Figma', { timeout: 60000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP_REASON);
  const ready = await open(t, 'ui-report-backfill.json', { hash: '#tab=backfill', mutate: (r) => {
    r.scorecard.loopClosed = true;
    Object.assign(r.backfill.items[1], { figma: { nodeId: '45:6', url: 'https://www.figma.com/design/AbC123/Orders?node-id=45-6', name: 'Orders – Saved toast', builtAt: '2026-10-02T10:00:00Z', roundTrip: { percent: 1.8, band: 'pass' } } });
  } });
  assert.equal(await ready.page.getAttribute('#bf-ready', 'data-ready'), 'true');
  assert.equal(await ready.page.textContent('#bf-ready'), 'Production matches the design.Build these frames with the design-system library.');
  assert.equal(await ready.page.getAttribute('#bf-BF-002', 'data-decision'), 'built');
  assert.equal(await ready.page.getAttribute('#bf-BF-002 .bf-figma a', 'href'), 'https://www.figma.com/design/AbC123/Orders?node-id=45-6');
  assert.match(await ready.page.textContent('#bf-BF-002 .bf-figma'), /Orders – Saved toast.*Round trip 1\.80% · pass/s);
  assert.equal(await ready.page.locator('#bf-BF-002 .bf-actions').count(), 0, 'a built frame has no decision buttons');
  assert.equal(await ready.page.isDisabled('#copy-backfill-all'), true, 'nothing left to build');
  assert.equal(await ready.page.textContent('#bf-stats'), '4 candidates0 to build1 built1 not needed2 pending');

  const override = await open(t, 'ui-report-backfill.json', { hash: '#tab=backfill', mutate: (r) => {
    r.backfill.gate.override = { by: 'M. Ortiz', date: '2026-10-02T09:00:00Z', reason: 'The design review on Friday needs the frames.' };
  } });
  assert.equal(await override.page.getAttribute('#bf-ready', 'data-ready'), 'true');
  assert.match(await override.page.textContent('#bf-ready'),
    /^Production does not match the design yet \(9 open\)\.Building is allowed by an override \(by M\. Ortiz, 2026-10-02\): “The design review on Friday needs the frames\.”/);

  // No loopClosed/unexplained in the scorecard: computed from the open findings and decisions
  const local = await open(t, 'ui-report-backfill.json', { hash: '#tab=backfill', mutate: (r) => {
    delete r.scorecard.loopClosed; delete r.scorecard.unexplained; r.openDecisions = [];
  } });
  assert.equal(await local.page.getAttribute('#bf-ready', 'data-ready'), 'false');
  assert.match(await local.page.textContent('#bf-ready'), /yet \(9 open\)/);
  const closed = await open(t, 'ui-report-backfill.json', { hash: '#tab=backfill', mutate: (r) => {
    delete r.scorecard.loopClosed; delete r.scorecard.unexplained; r.openDecisions = [];
    for (const f of r.findings) if (f.resolution === 'FIX_CODE' || f.resolution === 'UNCLASSIFIED') f.resolution = 'INTENTIONAL';
  } });
  assert.equal(await closed.page.getAttribute('#bf-ready', 'data-ready'), 'true');

  // Multi-screen: the prompt names the screen and the frame after it
  const multi = await open(t, 'ui-report-multiscreen.json', { hash: '#tab=backfill', mutate: (r) => {
    r.backfill = { gate: { override: null }, items: [{ id: 'BF-001', state: 'promo-applied', screen: 'cart', label: 'Promo applied', discoveredBy: 'capture', detail: null, driver: null,
      captured: null, anchor: { nodeId: '3:4', name: 'Cart – With items' }, components: [], tokens: ['space/2'], decision: 'pending', decidedBy: null, decidedAt: null, reason: null, figma: null, dsGaps: [] }] };
  } });
  assert.equal(await multi.page.textContent('#bf-BF-001 [data-screen]'), 'Cart');
  assert.equal(await copied(multi.page, '#bf-BF-001 [data-bf-copy]'), block([
    '[BF-001] Promo applied (screen Cart)',
    'Exists in: the app, not the design · found by: capture — –',
    'App capture: –',
    'Place: next to "Cart – With items" (3:4), named "Cart – Promo applied"',
    'Build with: – · tokens space/2',
    'DS gaps: –',
  ].join('\n')));
  assert.deepEqual([...ready.errors, ...override.errors, ...local.errors, ...closed.errors, ...multi.errors], []);
});

test('backfill leaves step 1 alone: same Overview, pins, parity, findings and Design system as without it', { timeout: 60000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP_REASON);
  const plain = await open(t, 'ui-report.json');
  const withBf = await open(t, 'ui-report-backfill.json');
  assert.deepEqual(await step1Snapshot(withBf.page), await step1Snapshot(plain.page));
  assert.equal(await withBf.page.textContent('#tab-findings'), await plain.page.textContent('#tab-findings'));
  const text = await withBf.page.evaluate(() => document.querySelector('#panel-overview').innerText);
  assert.equal(/backfill|BF-00/i.test(text), false, 'nothing about step 2 on the Overview');
  assert.deepEqual([...plain.errors, ...withBf.errors], []);
});

test('390px dark: both pending bars stack without overlap; the Not needed panel fits', { timeout: 60000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP_REASON);
  const { page, errors } = await open(t, 'ui-report-backfill.json', { width: 390, height: 844 });
  await page.click('[data-theme-btn="dark"]');
  await page.click('.tri-card[data-fid="DQ-003"] [data-dismiss]');
  await page.getByLabel('Reason (required)').fill('Hover tint is within the design-system tolerance.');
  await page.locator('.dismiss-panel').getByRole('button', { name: 'Save' }).click();
  await page.click('#tab-backfill');
  await page.click('[data-bf-build="BF-001"]');
  await page.click('[data-bf-skip="BF-003"]');
  const pbox = await page.locator('.dismiss-panel[data-panel-for="BF-003"]').boundingBox();
  assert.ok(pbox.x >= 0 && pbox.x + pbox.width <= 390, `panel fits the viewport (${pbox.x}, ${pbox.width})`);
  await page.keyboard.press('Escape');
  const a = await page.locator('#dismiss-bar').boundingBox();
  const b = await page.locator('#backfill-bar').boundingBox();
  assert.ok(a && b, 'both bars are visible');
  assert.ok(a.y + a.height <= b.y || b.y + b.height <= a.y, `bars do not overlap (${a.y}+${a.height} / ${b.y}+${b.height})`);
  for (const r of [a, b]) assert.ok(r.x >= 0 && r.x + r.width <= 390 && r.y + r.height <= 844, `bar fits the viewport ${JSON.stringify(r)}`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 390), true, 'no horizontal page scroll');
  const pad = await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('main')).paddingBottom));
  assert.ok(pad >= a.height + b.height, `the page keeps room for both bars (${pad})`);
  assert.deepEqual(errors, []);
});

/* ===== Overview picker vs Findings filters, pin collisions, Design system counts ===== */
const findingRows = (page) => page.$$eval('#findings-table tbody tr[data-id]', (els) => els.map((e) => e.getAttribute('data-id')).sort());

test('Overview screen/state picker never filters Findings; "Findings for this state" does, visibly', { timeout: 60000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP_REASON);
  const { page, errors, report } = await open(t, 'ui-report-multiscreen.json', { hash: '#state=cart%2Fwith-items' });
  const all = report.findings.map((f) => f.id).sort();
  // Browse captures: screen select, state tabs, the #state deep link
  await page.selectOption('#screen-select', 'checkout');
  await page.click('.state-tabs [data-state="checkout/error"]');
  await page.selectOption('#screen-select', 'cart');
  await page.evaluate(() => { location.hash = '#state=cart%2Fwith-items'; });
  await page.waitForFunction(() => document.querySelector('.state-tabs [aria-selected="true"]').getAttribute('data-state') === 'cart/with-items');
  await page.click('#tab-findings');
  assert.deepEqual(await findingRows(page), all, 'Findings shows every finding after browsing the Overview');
  assert.equal(await page.locator('#filter-status').isHidden(), true);
  assert.equal(await page.locator('#filters-reset').count(), 0);
  assert.equal(await page.textContent('.table-footer'), `${all.length} of ${all.length} row(s)`);

  // The deliberate link filters, and says so: chip + "Showing n of N · Clear"
  await page.click('#tab-overview');
  await page.click('#rail-findings button');
  assert.equal(await page.getAttribute('#tab-findings', 'aria-selected'), 'true');
  const mine = report.findings.filter((f) => f.state === 'cart/with-items').map((f) => f.id).sort();
  assert.deepEqual(await findingRows(page), mine);
  assert.equal(await page.locator('#filter-status').isVisible(), true);
  assert.match(await page.textContent('#filter-status .fchip[data-filter="state"]'), /State.*Cart \/ With items/);
  assert.equal(await page.textContent('#filter-count'), `Showing ${mine.length} of ${all.length}`);
  // Browsing the Overview again leaves that filter alone
  await page.click('#tab-overview');
  await page.selectOption('#screen-select', 'checkout');
  await page.click('#tab-findings');
  assert.deepEqual(await findingRows(page), mine);
  await page.click('#filters-clear');
  assert.deepEqual(await findingRows(page), all);
  assert.equal(await page.locator('#filter-status').isHidden(), true);

  // States tab: the findings count is the same deliberate filter; removing its chip clears it
  await page.click('#tab-states');
  await page.click('#state-table [data-state-findings="cart/with-items"]');
  assert.deepEqual(await findingRows(page), mine);
  await page.click('#filter-status .fchip[data-filter="state"]');
  assert.deepEqual(await findingRows(page), all);
  assert.deepEqual(errors, []);
});

// Three PASS findings stacked on DQ-005's badge (crops 1–3px apart): their pins all want the same spot.
function closePins(report) {
  const base = report.findings.find((f) => f.id === 'DQ-005');
  [[1, 0], [2, 3], [0, 2]].forEach(([dx, dy], i) => {
    const f = structuredClone(base);
    f.id = `DQ-0${16 + i}`;
    f.title = `Close pin ${i + 1}`;
    f.evidence[0].crop = { x: 750 + dx, y: 277 + dy, w: 66, h: 22 };
    report.findings.push(f);
  });
}
const nextFrames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
async function pinLayout(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('#hero-stage .pins')).map((layer) => {
    const lb = layer.getBoundingClientRect();
    const pins = Array.from(layer.querySelectorAll('.pin:not([hidden])')).map((p) => {
      const r = p.getBoundingClientRect();
      const lead = layer.querySelector(`.pin-leader[data-fid="${p.dataset.fid}"]`);
      return { fid: p.dataset.fid, x: r.left, y: r.top, w: r.width, h: r.height, moved: p.hasAttribute('data-moved'),
        leader: lead && lead.classList.contains('on') ? { left: parseFloat(lead.style.left), top: parseFloat(lead.style.top) } : null };
    });
    const hits = [];
    for (let i = 0; i < pins.length; i++) for (let j = i + 1; j < pins.length; j++) {
      const a = pins[i], b = pins[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) hits.push(`${a.fid}/${b.fid}`);
    }
    return { width: lb.width, pins, hits };
  }));
}

for (const width of [390, 1440]) {
  test(`pins never overlap in rendered pixels: ${width}px at Fit, 100%, 200% and side by side`, { timeout: 60000 }, async (t) => {
    if (!CHROMIUM) return t.skip(SKIP_REASON);
    const { page, errors } = await open(t, 'ui-report.json', { hash: '#state=with-data', width, height: 900, mutate: closePins });
    for (const [mode, zoom] of [['app', 'fit'], ['side', 'fit'], ['app', '100'], ['app', '200']]) {
      await page.click(`[aria-label="View"] [data-v="${mode}"]`);
      await page.click(`[aria-label="Zoom"] [data-v="${zoom}"]`);
      await page.waitForFunction(() => Array.from(document.querySelectorAll('#hero-stage .pins')).every((l) => l.clientWidth > 0));
      await nextFrames(page); // the ResizeObserver spreads the pins before the next paint
      const layers = await pinLayout(page);
      // The app capture carries the close pins (the design pane only has the design crops)
      assert.equal(layers.filter((l) => l.pins.some((p) => p.fid === 'DQ-016')).length, 1, `${mode}/${zoom}: one app layer`);
      for (const l of layers) {
        assert.deepEqual(l.hits, [], `${mode}/${zoom} at ${l.width}px: no pin overlaps another`);
        if (!l.pins.some((p) => p.fid === 'DQ-016')) continue;
        assert.ok(l.pins.length >= 6, `${mode}/${zoom}: the close pins are drawn (${l.pins.length})`);
        const moved = l.pins.filter((p) => p.moved);
        assert.ok(moved.length >= 3, `${mode}/${zoom}: the stacked pins were pushed apart`);
        // A displaced pin keeps a leader to its true centre (the crop centre, in % of the image)
        for (const p of moved) {
          assert.ok(p.leader, `${p.fid} has a leader`);
          if (/^DQ-01[678]$/.test(p.fid)) {
            assert.ok(Math.abs(p.leader.left - (783 / 1440) * 100) < 0.3, `${p.fid} leader starts at its element (${p.leader.left})`);
          }
        }
      }
    }
    // A resize re-spreads (Fit at the new width)
    await page.click('[aria-label="View"] [data-v="app"]');
    await page.click('[aria-label="Zoom"] [data-v="fit"]');
    await page.setViewportSize({ width: width === 390 ? 1440 : 390, height: 900 });
    await nextFrames(page);
    for (const l of await pinLayout(page)) assert.deepEqual(l.hits, [], `after resize to ${l.width}px`);
    assert.deepEqual(errors, []);
  });
}

test('Design system: one Motion row per open motion finding, so rows equal the badge count', { timeout: 60000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP_REASON);
  const mutate = (r) => {
    // DQ-007 owns two failing motion checks; one failing check names no finding
    r.ledgers.motion.push({ state: 'loading', selector: '.skeleton-row', figmaNodeId: null, trigger: 'load', property: 'transform',
      expected: { type: 'transition', durationMs: 200, easing: 'ease-out', delayMs: null, detail: null }, observed: null, result: 'FAIL', findingIds: ['DQ-007'] });
    r.ledgers.motion.push({ state: 'with-data', selector: '.toast', figmaNodeId: null, trigger: 'load', property: 'opacity',
      expected: { type: 'transition', durationMs: 150, easing: 'ease-out', delayMs: null, detail: null }, observed: null, result: 'FAIL', findingIds: [] });
  };
  const { page, errors, report } = await open(t, 'ui-report.json', { hash: '#tab=design-system', mutate });
  const badge = Number(await page.textContent('#ds-stats [data-ds="motion"] b'));
  assert.equal(badge, report.scorecard.designSystem.motion);
  assert.deepEqual(await ids(page, '#ds-motion tbody tr[data-fid]'), ['DQ-006', 'DQ-007']);
  assert.equal(await page.locator('#ds-motion tbody tr').count(), badge, 'table rows = badge count');
  assert.match(await page.textContent('#h-ds-motion'), new RegExp(`Motion \\(${badge}\\)`));
  const row7 = page.locator('#ds-motion tr[data-fid="DQ-007"]');
  assert.equal(await row7.locator('.motion-check').count(), 2, 'both of DQ-007 ledger checks sit inside its row');
  assert.match(await row7.textContent(), /opacity.*transition · 200ms · ease-out.*transition · 400ms · linear.*transform.*Missing/s);
  assert.match(await page.textContent('#ds-motion-unlinked'), /1 failing motion check without a finding.*opacity/);
  // Tokens and components: rows = open findings in the group = badge
  for (const [key, label] of [['tokens', 'tokens'], ['components', 'components']]) {
    assert.equal(await page.locator(`#ds-${key} tbody tr[data-fid]`).count(), Number(await page.textContent(`#ds-stats [data-ds="${label}"] b`)), key);
  }
  // Dismissing the finding removes its whole row and the count follows
  await page.click('#ds-motion [data-dismiss="DQ-007"]');
  await page.getByLabel('Reason (required)').fill('Loading motion is out of scope for this pass.');
  await page.locator('.dismiss-panel').getByRole('button', { name: 'Save' }).click();
  assert.deepEqual(await ids(page, '#ds-motion tbody tr[data-fid]'), ['DQ-006']);
  assert.equal(await page.textContent('#ds-stats [data-ds="motion"] b'), '1');
  assert.deepEqual(errors, []);
});
