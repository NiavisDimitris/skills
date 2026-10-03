// Browser tests for templates/report.html with report 2.0 data: no Figma sync, Dismiss (panel,
// Undo), the Design system tab, multi-screen state picking, the Design backfill tab (step 2:
// decisions, design-agent prompts) and Review and send (one review bar, one Send panel, one
// decisions document: copied for any agent, downloaded, or sent to scripts/review.mjs).
// Skipped when Chromium cannot launch.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { decisionsMessage, normalizeDecisions, parseDecisions } from '../skills/design-qa/scripts/lib/decisions.mjs';
import { applyTriage, buildTriage } from '../skills/design-qa/scripts/lib/triage.mjs';
import { ROOT, SKILL, loadFixture, run, script, tmpDir } from './_helpers.mjs';

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
function fill(template, report, assets, context = {}) {
  return template
    .replace('/*__DESIGN_QA_CONTEXT__*/', () => serializeForScript(context))
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
function renderFixture(name, dir = tmpDir('design-qa-ui-'), mutate = null, context = {}) {
  const report = loadFixture(name);
  if (mutate) mutate(report);
  const file = path.join(dir, name.replace(/\.json$/, '.html'));
  writeFileSync(file, fill(readFileSync(TEMPLATE, 'utf8'), report, assetsFor(report), context));
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
async function launch() {
  if (!browser) {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}
// A page on `url` with the clipboard stub; `requests` records every http(s) request the page makes.
async function openUrl(t, url, { width = 1440, height = 1000, stub = STUB, colorScheme = 'light' } = {}) {
  const context = await (await launch()).newContext({ viewport: { width, height }, acceptDownloads: true, colorScheme });
  await context.addInitScript(stub);
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => { if (/^https?:/.test(r.url())) requests.push(r); });
  t.after(() => context.close());
  await page.goto(url);
  await page.waitForSelector('#page-title');
  return { page, errors, requests, context };
}
async function open(t, name, { hash = '', width = 1440, height = 1000, mutate = null, context: ctx = {}, stub = STUB } = {}) {
  const dir = tmpDir('design-qa-ui-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { url, report } = renderFixture(name, dir, mutate, ctx);
  const opened = await openUrl(t, url + hash, { width, height, stub });
  return { ...opened, report, url };
}
test.after(async () => { if (browser) await browser.close(); });

const ids = (page, sel) => page.$$eval(sel, (els) => els.map((e) => e.getAttribute('data-fid')));
async function copied(page, sel) {
  await page.evaluate(() => { window.__copied = null; });
  await page.click(sel);
  await page.waitForFunction(() => window.__copied !== null);
  return page.evaluate(() => window.__copied);
}

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
  // One review bar: nothing recorded yet (no triage block), nothing pending
  assert.equal(await page.isVisible('#review-bar'), true);
  assert.equal(await page.textContent('#review-bar-msg'), 'Fix now 5 · Later 3');
  assert.equal(await page.textContent('#review-bar-status'), 'Not sent yet');
  assert.equal(await page.isEnabled('#review-send'), true);
  for (const id of ['#copy-triage', '#export-selection', '#copy-dismiss', '#download-dismissals', '#copy-backfill', '#download-backfill', '#dismiss-bar', '#backfill-bar']) {
    assert.equal(await page.locator(id).count(), 0, `${id} is gone`);
  }

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

test('Dismiss: panel, required reason, save, review bar, sent with the decisions (copy, download), Undo', { timeout: 90000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP_REASON);
  const { page, errors, url, report } = await open(t, 'ui-report.json');

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
  assert.equal(await page.textContent('#review-bar-msg'), 'Fix now 4 · Later 3 · Dismissed 1');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'review-bar-msg', 'focus lands on the review bar when the card leaves');
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

  assert.equal(await page.textContent('#review-bar-msg'), 'Fix now 4 · Later 2 · Dismissed 3');
  await page.click('#review-send');
  assert.match(await page.textContent('#send-summary'), /Dismissed \(3\).*DQ-004Not an issue.*DQ-007Removed from QA.*DQ-012Accepted as intentional/s);
  const message = await copied(page, '#copy-for-agent');
  const doc = parseDecisions(message);
  for (const it of doc.dismissals) {
    assert.match(it.date, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
  }
  assert.deepEqual(doc.dismissals.map(({ date, ...rest }) => rest), [
    { findingId: 'DQ-004', kind: 'not-an-issue', reason: 'Matches the design within tolerance after zoom.', by: 'Dana' },
    { findingId: 'DQ-007', kind: 'remove', reason: 'Duplicate of DQ-006:\n  same skeleton', by: 'Dana' },
    { findingId: 'DQ-012', kind: 'intentional', reason: 'Copy approved by content design.', by: 'Dana' },
  ]);
  assert.deepEqual(doc.triage, { fixNow: ['DQ-001', 'DQ-002', 'DQ-003', 'DQ-006'], debt: ['DQ-014', 'DQ-013'] }, 'dismissed findings leave the triage');
  assert.equal(doc.decidedBy, 'Dana');
  assert.equal(message, decisionsMessage(report, doc), 'the message the library writes, with the default report path');
  assert.match(message, /\nDismissed \(3\)\n- DQ-004 not-an-issue — Matches the design within tolerance after zoom\.\n- DQ-007 remove — Duplicate of DQ-006: same skeleton\n- DQ-012 intentional — Copy approved by content design\.$/);

  await page.click('#review-send');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download-decisions')]);
  assert.equal(dl.suggestedFilename(), 'decisions.json');
  const fromFile = parseDecisions(readFileSync(await dl.path(), 'utf8'));
  assert.deepEqual(fromFile.dismissals, doc.dismissals);
  await page.keyboard.press('Escape');

  // 4. Undo from the Dismissed list: back on the board, bar count drops
  await page.click('#tab-overview');
  if ((await page.getAttribute('#h-dismissed', 'aria-expanded')) !== 'true') await page.click('#h-dismissed');
  await page.click('#dismissed-list li[data-fid="DQ-007"] [data-undo]');
  assert.deepEqual(await ids(page, '#lane-debt .tri-card[data-fid="DQ-007"]'), ['DQ-007']);
  assert.equal(await page.textContent('#review-bar-msg'), 'Fix now 4 · Later 3 · Dismissed 2');
  assert.equal(await page.textContent('#review-bar-status'), 'Changed since you sent');

  // 5. Dismissals survive a reload (localStorage keyed by feature + generatedAt)
  await page.goto(url);
  await page.waitForSelector('#page-title');
  assert.equal(await page.textContent('#review-bar-msg'), 'Fix now 4 · Later 3 · Dismissed 2');
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
  assert.equal(await page.evaluate(() => document.activeElement.id), 'review-bar-msg');

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
// Everything step 1 shows: the backfill tab must never change any of it.
async function step1Snapshot(page) {
  return page.evaluate(() => {
    const txt = (s) => { const el = document.querySelector(s); return el ? el.textContent : null; };
    const fids = (s) => Array.from(document.querySelectorAll(s)).map((e) => e.getAttribute('data-fid') || e.getAttribute('data-id'));
    return {
      summary: txt('#summary'), verdict: txt('#verdict'), dismissed: txt('#count-dismissed'), dsStats: txt('#ds-stats'),
      tabFindings: txt('#tab-findings'), tabDs: txt('#tab-design-system'), pins: fids('.pin'), board: fids('.tri-card'),
      table: fids('#findings-table tbody tr[data-id]'), dsRows: fids('#panel-design-system tr[data-fid]'), triageBar: (txt('#review-bar-msg') || '').replace(/ · Backfill \d+$/, ''),
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

test('Design backfill decisions: Not needed needs a reason, Build in Figma, review bar, sent with the decisions, Undo, reload', { timeout: 90000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP_REASON);
  const { page, errors, url, report } = await open(t, 'ui-report-backfill.json', { hash: '#tab=backfill' });
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
  assert.equal(await page.textContent('#review-bar-msg'), 'Fix now 5 · Later 3 · Backfill 1', 'one bar: the backfill decision joins the triage');

  // 2. Build in Figma: one click (the remembered name signs it); a recorded not-needed can be switched to build
  await page.click('[data-bf-build="BF-001"]');
  await page.click('[data-bf-build="BF-004"]');
  assert.equal(await page.getAttribute('#bf-BF-001', 'data-decision'), 'build');
  assert.equal(await page.getAttribute('#bf-BF-004', 'data-decision'), 'build');
  assert.equal(await page.textContent('#review-bar-msg'), 'Fix now 5 · Later 3 · Backfill 3');
  assert.equal(await page.textContent('#bf-stats'), '4 candidates3 to build0 built1 not needed0 pending');
  assert.equal(await copied(page, '#copy-backfill-all'), block(BF_001, BF_002, BF_004));

  await page.click('#review-send');
  assert.match(await page.textContent('#send-summary'), /Backfill \(3\).*BF-001Build in Figma · Bulk selected.*BF-003Not needed · Filter – no results.*BF-004Build in Figma · Refreshing/s);
  const message = await copied(page, '#copy-for-agent');
  const doc = parseDecisions(message);
  for (const it of doc.backfill) assert.match(it.date, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
  assert.deepEqual(doc.backfill.map(({ date, ...rest }) => rest), [
    { id: 'BF-001', decision: 'build', reason: null, by: 'Dana' },
    { id: 'BF-003', decision: 'not-needed', reason: 'Covered by the Empty frame: same layout.\n  Search copy only.', by: 'Dana' },
    { id: 'BF-004', decision: 'build', reason: null, by: 'Dana' },
  ]);
  assert.deepEqual(doc.dismissals, []);
  assert.equal(message, decisionsMessage(report, doc));
  assert.match(message, /\nDesign backfill \(3\)\n- BF-001 build\n- BF-003 not-needed — Covered by the Empty frame: same layout\. Search copy only\.\n- BF-004 build$/);

  // 3. Undo puts the recorded decision back
  await page.click('[data-bf-undo="BF-004"]');
  assert.equal(await page.getAttribute('#bf-BF-004', 'data-decision'), 'not-needed');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-bf-build')), 'BF-004');
  assert.equal(await page.textContent('#review-bar-msg'), 'Fix now 5 · Later 3 · Backfill 2');
  assert.equal(await page.textContent('#review-bar-status'), 'Changed since you sent');

  // 4. Step 1 is untouched: summary, verdict, pins, board, findings table, Design system
  assert.deepEqual(await step1Snapshot(page), before);

  // 5. Decisions survive a reload (own localStorage key); the Send panel's Review link goes back to the tab
  await page.goto(url + '#tab=overview');
  await page.waitForSelector('#page-title');
  assert.equal(await page.textContent('#review-bar-msg'), 'Fix now 5 · Later 3 · Backfill 2');
  assert.equal(await page.getAttribute('#bf-BF-003', 'data-decision'), 'not-needed');
  await page.click('#review-send');
  await page.click('#send-summary .sp-review');
  assert.equal(await page.isHidden('#send-panel'), true, 'Review closes the panel');
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

test('390px dark: one review bar above the annotation sheet; the Not needed and Send panels fit', { timeout: 60000 }, async (t) => {
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
  assert.equal(await page.locator('.dismiss-bar').count(), 1, 'one bar');
  assert.equal(await page.textContent('#review-bar-msg'), 'Fix now 4 · Later 3 · Dismissed 1 · Backfill 1');
  const bar = await page.locator('#review-bar').boundingBox();
  assert.ok(bar.x >= 0 && bar.x + bar.width <= 390 && bar.y + bar.height <= 844, `bar fits the viewport ${JSON.stringify(bar)}`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 390), true, 'no horizontal page scroll');
  const pad = await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('main')).paddingBottom));
  assert.ok(pad >= bar.height, `the page keeps room for the bar (${pad})`);

  // The annotation bottom sheet: the bar sits above it, clear of its controls
  await page.click('#tab-overview');
  await page.locator('.pin-row[data-fid]').first().click();
  await page.waitForSelector('#ann-panel');
  const ann = await page.locator('#ann-panel').boundingBox();
  const bar2 = await page.locator('#review-bar').boundingBox();
  assert.ok(bar2.y + bar2.height <= ann.y + 1, `the bar is above the sheet (${bar2.y}+${bar2.height} / ${ann.y})`);
  for (const sel of ['#ann-panel .ann-foot .btn', '#ann-panel .tseg-btn']) {
    const c = await page.locator(sel).first().boundingBox();
    const hit = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('#review-bar'), [c.x + c.width / 2, c.y + c.height / 2]);
    assert.equal(hit, false, `${sel} is not covered by the bar`);
  }
  // Opening the Send panel closes the sheet (one bottom sheet at a time); the panel fits above the bar
  await page.click('#review-send');
  assert.equal(await page.locator('#ann-panel').count(), 0);
  const sp = await page.locator('#send-panel').boundingBox();
  const bar3 = await page.locator('#review-bar').boundingBox();
  assert.ok(sp.x >= 0 && sp.x + sp.width <= 390 && sp.y >= 0, `Send panel fits ${JSON.stringify(sp)}`);
  assert.ok(sp.y + sp.height <= bar3.y, 'the panel sits above the bar');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 390), true, 'no horizontal page scroll with the panel open');
  const primary = await page.locator('#copy-for-agent').boundingBox();
  assert.ok(primary.y + primary.height <= bar3.y, 'the primary action is in view');
  // The finding detail sheet covers the bar, never the other way round
  await page.keyboard.press('Escape');
  await page.click('#tab-findings');
  await page.click('#f-DQ-001');
  const sheetBtn = await page.locator('#finding-sheet button').last().boundingBox();
  const hit = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('#review-bar'), [sheetBtn.x + sheetBtn.width / 2, sheetBtn.y + sheetBtn.height / 2]);
  assert.equal(hit, false, 'sheet controls are on top of the bar');
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

/* ===== Review and send: one bar, one Send panel, one decisions document ===== */
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const fenceJson = (message) => /```design-qa-decisions\n([\s\S]*?)\n```/.exec(message)[1];
async function move(page, id, decision) {
  await page.click(`.tri-card[data-fid="${id}"] [data-decision="${decision}"]`);
}
async function dismiss(page, id, reason, name) {
  await page.click(`.tri-card[data-fid="${id}"] [data-dismiss]`);
  const panel = page.locator(`.dismiss-panel[data-panel-for="${id}"]`);
  await panel.getByLabel('Reason (required)').fill(reason);
  if (name !== undefined) await panel.getByLabel('Your name').fill(name);
  await panel.locator('.dp-save').click();
}

test('Review and send (file mode): one document for triage, dismissals and backfill; the message equals decisionsMessage()', { timeout: 90000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP_REASON);
  const reportPath = 'qa-reports/ACME-482/report.json';
  const configPath = 'config/review settings.json';
  const { page, errors, report, url, requests } = await open(t, 'ui-report-backfill.json', { context: { reportPath, configPath } });
  await move(page, 'DQ-003', 'debt');
  await move(page, 'DQ-007', 'fix-now');
  await dismiss(page, 'DQ-004', 'Matches the design within tolerance after zoom.', 'Dana');
  await page.click('#tab-backfill');
  await page.click('[data-bf-build="BF-001"]');
  assert.equal(await page.textContent('#review-bar-msg'), 'Fix now 4 · Later 3 · Dismissed 1 · Backfill 1');
  assert.equal(await page.textContent('#review-bar-status'), 'Not sent yet');

  // The panel: heading, focus inside, summary in rank order, name prefilled, tickets checkbox
  await page.click('#review-send');
  assert.equal(await page.getAttribute('#review-send', 'aria-expanded'), 'true');
  assert.equal(await page.textContent('#send-title'), 'Send your decisions');
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('#send-panel')), true, 'focus moves into the panel');
  const groups = await page.$$eval('#send-summary .sp-group', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  assert.equal(groups.length, 4);
  assert.match(groups[0], /^Fix now \(4\) DQ-001 .* DQ-002 .* DQ-006 .* DQ-007 /);
  assert.equal(groups[1], 'Later (3) DQ-003, DQ-014, DQ-013');
  assert.match(groups[2], /^Dismissed \(1\) Review DQ-004 Not an issue$/);
  assert.match(groups[3], /^Backfill \(1\) Review BF-001 Build in Figma · Bulk selected$/);
  assert.equal(await page.inputValue('#send-name'), 'Dana');
  assert.equal(await page.textContent('#send-tickets'), 'Create tickets for the 3 later items');
  assert.equal(await page.getAttribute('#send-tickets-box', 'aria-checked'), 'true', 'checked by default: the report has a ticket');
  assert.match(await page.textContent('#send-panel'), /Sending approves this: your agent records the decisions, creates the tickets if ticked, and starts on the Fix now items\./);
  assert.equal(await page.locator('#send-to-agent, #copy-instead').count(), 0, 'no Send to agent in file mode');
  assert.equal(await page.textContent('#copy-for-agent'), 'Copy for your agent');
  await page.click('#send-tickets-box');
  assert.equal(await page.getAttribute('#send-tickets-box', 'aria-checked'), 'false');
  await page.fill('#send-name', '  Dana Reviewer ');
  // Esc closes and returns focus to the bar button; the choices are kept
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#send-panel').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'review-send');
  await page.click('#review-send');
  assert.equal(await page.inputValue('#send-name'), 'Dana Reviewer', 'the name is kept, trimmed');
  assert.equal(await page.getAttribute('#send-tickets-box', 'aria-checked'), 'false');

  const message = await copied(page, '#copy-for-agent');
  const doc = parseDecisions(message);
  assert.equal(message, decisionsMessage(report, doc, { reportPath, configPath }), 'character for character');
  assert.match(message, /--config 'config\/review settings.json'/);
  assert.match(message, /^Apply my design QA review for Orders list \(ACME-482\)\.\n\nReport: qa-reports\/ACME-482\/report\.json\nDecided by Dana Reviewer: fix now 4 · later 3 · dismissed 1 · backfill 1 · tickets: no\n/);
  assert.equal(doc.decidedBy, 'Dana Reviewer');
  assert.equal(doc.tickets, false);
  assert.match(doc.decidedAt, ISO);
  assert.deepEqual(doc.triage, { fixNow: ['DQ-001', 'DQ-002', 'DQ-006', 'DQ-007'], debt: ['DQ-003', 'DQ-014', 'DQ-013'] });
  assert.deepEqual(doc.dismissals.map(({ date, ...rest }) => rest), [{ findingId: 'DQ-004', kind: 'not-an-issue', reason: 'Matches the design within tolerance after zoom.', by: 'Dana' }]);
  assert.deepEqual(doc.backfill.map(({ date, ...rest }) => rest), [{ id: 'BF-001', decision: 'build', reason: null, by: 'Dana' }]);
  assert.equal(JSON.stringify(JSON.parse(fenceJson(message))), JSON.stringify(normalizeDecisions(JSON.parse(fenceJson(message)))), 'canonical key order');

  // Copied: the bar says so; the panel closed
  assert.equal(await page.locator('#send-panel').count(), 0);
  assert.match(await page.textContent('#review-bar-status'), /^Copied at \d\d:\d\d: paste it into your agent's chat$/);
  const copiedStatus = await page.textContent('#review-bar-status');

  // Download: the same document, pretty-printed, trailing newline
  await page.click('#review-send');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download-decisions')]);
  assert.equal(dl.suggestedFilename(), 'decisions.json');
  const body = readFileSync(await dl.path(), 'utf8');
  const fileDoc = parseDecisions(body);
  assert.equal(body, `${JSON.stringify(JSON.parse(body), null, 2)}\n`);
  assert.equal(JSON.stringify(JSON.parse(body)), JSON.stringify(normalizeDecisions(JSON.parse(body))), 'canonical key order');
  assert.deepEqual({ ...fileDoc, decidedAt: null }, { ...doc, decidedAt: null });
  await page.keyboard.press('Escape');

  // Any change returns the bar to unsent; undoing it matches the copied document again
  await page.click('#tab-overview');
  await move(page, 'DQ-003', 'fix-now');
  assert.equal(await page.textContent('#review-bar-status'), 'Changed since you sent');
  await move(page, 'DQ-003', 'debt');
  assert.equal(await page.textContent('#review-bar-status'), copiedStatus);

  // The state survives a reload
  await page.goto(url);
  await page.waitForSelector('#page-title');
  assert.equal(await page.textContent('#review-bar-status'), copiedStatus);
  assert.equal(await page.textContent('#review-bar-msg'), 'Fix now 4 · Later 3 · Dismissed 1 · Backfill 1');

  assert.deepEqual(requests.map((r) => r.url()), [], 'no network request in file mode');
  assert.deepEqual(errors, []);
});

test('Review and send: a recorded triage can be sent unchanged and ticket approval can change independently', { timeout: 60000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP_REASON);
  const recorded = (r) => {
    const split = { 'DQ-001': 'fix-now', 'DQ-002': 'fix-now', 'DQ-003': 'fix-now', 'DQ-004': 'fix-now', 'DQ-006': 'fix-now', 'DQ-007': 'debt', 'DQ-013': 'debt', 'DQ-014': 'debt' };
    r.triage = { decidedBy: 'M. Ortiz', decidedAt: '2026-10-02T09:30:00Z', source: 'report-ui', ticketsAuthorized: false,
      items: Object.entries(split).map(([findingId, decision]) => ({ findingId, decision, reason: null, ticket: null })) };
  };
  const { page, errors } = await open(t, 'ui-report.json', { mutate: recorded });
  assert.equal(await page.textContent('#review-bar-msg'), 'Fix now 5 · Later 3');
  assert.equal(await page.textContent('#review-bar-status'), 'All decisions are recorded · by M. Ortiz, 2026-10-02');
  assert.equal(await page.getAttribute('#review-bar', 'data-state'), 'recorded');
  assert.equal(await page.isEnabled('#review-send'), true);
  await page.click('#review-send');
  assert.equal(await page.getAttribute('#send-tickets-box', 'aria-checked'), 'false', 'preserve the recorded refusal');
  await page.click('#send-tickets-box');
  assert.equal(await page.getAttribute('#send-tickets-box', 'aria-checked'), 'true');
  assert.equal(await page.textContent('#review-bar-status'), 'Not sent yet', 'ticket approval is a pending decision');
  await page.keyboard.press('Escape');

  await move(page, 'DQ-006', 'debt');
  assert.equal(await page.textContent('#review-bar-status'), 'Not sent yet');
  assert.equal(await page.isEnabled('#review-send'), true);
  await page.reload();
  await page.waitForSelector('#page-title');
  assert.equal(await page.textContent('#review-bar-status'), 'Not sent yet', 'the change survives a reload');
  await move(page, 'DQ-006', 'fix-now');
  assert.equal(await page.textContent('#review-bar-status'), 'Not sent yet', 'the split matches but ticket approval changed');
  assert.equal(await page.isEnabled('#review-send'), true);
  await page.click('#review-send');
  assert.equal(parseDecisions(await copied(page, '#copy-for-agent')).tickets, true);

  // No report ticket: the tickets box starts unchecked; no later items: no tickets box at all
  const plain = await open(t, 'ui-report-multiscreen.json');
  await plain.page.click('#review-send');
  assert.equal(await plain.page.locator('#send-tickets-box').count(), 0, 'nothing is later');
  await plain.page.keyboard.press('Escape');
  await move(plain.page, 'DQ-001', 'debt');
  await plain.page.click('#review-send');
  assert.equal(await plain.page.textContent('#send-tickets'), 'Create tickets for the 1 later item');
  assert.equal(await plain.page.getAttribute('#send-tickets-box', 'aria-checked'), 'false');
  assert.equal(parseDecisions(await copied(plain.page, '#copy-for-agent')).tickets, false);
  assert.deepEqual([...errors, ...plain.errors], []);
});

test('Review and send: when the clipboard is blocked the message is shown selected, with Select all and copy', { timeout: 60000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP_REASON);
  const BLOCKED = () => {
    window.__copied = null;
    window.__allowExec = false;
    Object.defineProperty(Navigator.prototype, 'clipboard', { configurable: true, get: () => ({ writeText: () => Promise.reject(new Error('denied')) }) });
    Document.prototype.execCommand = function (cmd) {
      if (cmd !== 'copy' || !window.__allowExec) return false;
      const a = document.activeElement; window.__copied = a && 'value' in a ? a.value : null; return true;
    };
  };
  const { page, errors, report } = await open(t, 'ui-report.json', { stub: BLOCKED });
  await page.click('#review-send');
  await page.click('#copy-for-agent');
  await page.waitForSelector('#send-message');
  const shown = await page.inputValue('#send-message');
  assert.equal(shown, decisionsMessage(report, parseDecisions(shown)));
  assert.equal(await page.evaluate(() => { const ta = document.getElementById('send-message'); return document.activeElement === ta && ta.selectionStart === 0 && ta.selectionEnd === ta.value.length && ta.readOnly; }), true, 'read-only, focused and selected');
  assert.equal(await page.textContent('#review-bar-status'), 'Not sent yet');
  await page.evaluate(() => { window.__allowExec = true; });
  await page.click('#send-select-all');
  assert.equal(await page.evaluate(() => window.__copied), shown);
  assert.match(await page.textContent('#review-bar-status'), /^Copied at \d\d:\d\d/);
  assert.deepEqual(errors, []);
});

test('no element in the rendered UI names a specific agent product', { timeout: 60000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP_REASON);
  const { page, errors } = await open(t, 'ui-report-backfill.json');
  await dismiss(page, 'DQ-004', 'Not real.', 'Dana');
  await page.click('#tab-backfill');
  await page.click('[data-bf-build="BF-001"]');
  await page.click('#review-send');
  const leaks = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
      for (const a of el.getAttributeNames()) if (/claude code/i.test(el.getAttribute(a))) out.push(`${el.tagName}[${a}]`);
    }
    if (/claude code/i.test(document.body.innerText)) out.push('text');
    return out;
  });
  assert.deepEqual(leaks, []);
  for (const tab of ['findings', 'design-system', 'states', 'decisions', 'evidence', 'backfill']) {
    await page.click(`#tab-${tab}`);
    assert.equal(/claude code/i.test(await page.evaluate(() => document.body.innerText)), false, tab);
  }
  assert.deepEqual(errors, []);
});

/* ===== Live mode: the page served by scripts/review.mjs ===== */
// <tmp>/qa-reports/ACME-482/report.json rendered with render-report.mjs, then review.mjs started from <tmp>.
async function liveReview(t, name = 'ui-report.json', mutate = null) {
  const root = tmpDir('design-qa-live-');
  const dir = path.join(root, 'qa-reports', 'ACME-482');
  mkdirSync(dir, { recursive: true });
  const reportFile = path.join(dir, 'report.json');
  const input = loadFixture(name);
  if (mutate) mutate(input);
  writeFileSync(reportFile, `${JSON.stringify(input, null, 2)}\n`);
  const children = [];
  t.after(() => {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  });
  const rendered = await run(script('render-report.mjs'), ['--in', path.join('qa-reports', 'ACME-482', 'report.json'), '--recompute', '--write-back'], { cwd: root });
  assert.equal(rendered.code, 0, rendered.stderr);
  assert.match(readFileSync(path.join(dir, 'report.html'), 'utf8'), /<script id="design-qa-context" type="application\/json">\{"reportPath":"qa-reports\/ACME-482\/report\.json"\}<\/script>/);
  const child = spawn(process.execPath, [script('review.mjs'), '--report', path.join('qa-reports', 'ACME-482', 'report.json'), '--no-open'], {
    cwd: root, env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((done) => child.on('close', (code) => done({ code, stdout, stderr })));
  const url = await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => {
      stdout += d;
      const m = /Review open: (http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+)/.exec(stdout);
      if (m) resolve(m[1]);
    });
    exited.then((r) => reject(new Error(`review.mjs exited ${r.code} before starting:\n${r.stdout}\n${r.stderr}`)));
  });
  return { root, dir, reportFile, child, url, exited, output: () => stdout };
}
// Requests after the page loaded, minus images (the unembedded evidence paths).
const afterLoad = (requests, from) => requests.slice(from).filter((r) => r.resourceType() !== 'image');
const liveErrors = (errors) => errors.filter((e) => !/Failed to load resource/.test(e));

test('live mode: accept unchanged CI triage and complete a review with no findings', { timeout: 120000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP_REASON);
  for (const empty of [false, true]) {
    const live = await liveReview(t, 'ui-report.json', (r) => {
      if (empty) {
        r.findings = [];
        for (const ledger of Object.values(r.ledgers)) for (const row of ledger) row.findingIds = [];
        for (const row of r.stateMatrix) row.findings = [];
      } else {
        Object.assign(r, applyTriage(r, buildTriage(r, { fixIds: ['DQ-001', 'DQ-002'], source: 'ci-default' }).triage));
      }
    });
    const { page } = await openUrl(t, live.url);
    assert.equal(await page.locator('#review-send').isVisible(), true);
    assert.equal(await page.locator('#review-send').isEnabled(), true);
    if (!empty) assert.equal(await page.textContent('#review-bar-status'), 'Not sent yet');
    await page.click('#review-send');
    await page.click('#send-to-agent');
    const received = await live.exited;
    assert.equal(received.code, 0, received.stderr);
    const applied = await run(script('apply-decisions.mjs'), ['--report', live.reportFile], { cwd: live.root });
    assert.equal(applied.code, 0, applied.stderr);
    const result = JSON.parse(readFileSync(live.reportFile, 'utf8'));
    if (!empty) assert.equal(result.triage.source, 'report-ui');
    else assert.deepEqual(result.findings, []);
  }
});

test('live mode: Send to agent posts the one document; review.mjs saves it and exits 0; apply-decisions records it', { timeout: 120000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP_REASON);
  const live = await liveReview(t);
  const { page, errors, requests } = await openUrl(t, live.url);
  await page.waitForLoadState('networkidle');
  const from = requests.length;
  await move(page, 'DQ-003', 'debt');
  await dismiss(page, 'DQ-007', 'The 400ms fade is the Acme platform default.', 'Dana');
  await page.click('#review-send');
  assert.equal(await page.textContent('#send-to-agent'), 'Send to agent');
  assert.equal(await page.textContent('#copy-instead'), 'Copy instead');
  assert.equal(await page.locator('#copy-for-agent').count(), 0);
  await page.click('#send-to-agent');
  await page.waitForFunction(() => /^Sent to your agent at \d\d:\d\d$/.test(document.getElementById('review-bar-status').textContent));
  assert.equal(await page.locator('#send-panel').count(), 0, 'the panel closes');
  assert.match(await page.textContent('.toaster'), /Sent to your agent/);

  const sent = afterLoad(requests, from);
  assert.deepEqual(sent.map((r) => `${r.method()} ${new URL(r.url()).pathname}`), ['POST /decisions'], 'exactly one request');
  const posted = JSON.parse(sent[0].postData());
  assert.equal(sent[0].headers()['content-type'], 'application/json');
  assert.match(sent[0].headers()['x-design-qa-token'], /^[0-9a-f]{32}$/);
  assert.equal(JSON.stringify(posted), JSON.stringify(normalizeDecisions(posted)), 'canonical document');
  assert.deepEqual(posted.triage, { fixNow: ['DQ-001', 'DQ-002', 'DQ-004', 'DQ-006'], debt: ['DQ-003', 'DQ-014', 'DQ-013'] });
  assert.deepEqual(posted.dismissals.map((d) => [d.findingId, d.kind, d.by]), [['DQ-007', 'not-an-issue', 'Dana']]);

  const result = await live.exited;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Decisions received from Dana: fix now 4 · later 3 · dismissed 1 · tickets: yes/);
  assert.match(result.stdout, /\nNext: node \S*apply-decisions\.mjs --report qa-reports\/ACME-482\/report\.json/);
  const saved = readFileSync(path.join(live.dir, 'decisions.json'), 'utf8');
  assert.equal(saved, `${JSON.stringify(posted, null, 2)}\n`, 'decisions.json is the page document');

  const apply = await run(script('apply-decisions.mjs'), ['--report', live.reportFile], { cwd: live.root });
  assert.equal(apply.code, 0, apply.stderr);
  const after = JSON.parse(readFileSync(live.reportFile, 'utf8'));
  const decision = Object.fromEntries(after.triage.items.map((i) => [i.findingId, i.decision]));
  assert.deepEqual(decision, { 'DQ-001': 'fix-now', 'DQ-002': 'fix-now', 'DQ-004': 'fix-now', 'DQ-006': 'fix-now', 'DQ-003': 'debt', 'DQ-013': 'debt', 'DQ-014': 'debt' });
  assert.equal(after.triage.decidedBy, 'Dana');
  const d7 = after.findings.find((f) => f.id === 'DQ-007');
  assert.equal(d7.resolution, 'DISMISSED');
  assert.equal(d7.dismissal.reason, 'The 400ms fade is the Acme platform default.');

  // After a send the panel offers Copy (the agent stopped waiting)
  await page.click('#review-send');
  assert.equal(await page.locator('#send-to-agent').count(), 0);
  assert.equal(await page.locator('#copy-for-agent').count(), 1);
  assert.equal(afterLoad(requests, from).length, 1, 'never a second request');
  assert.deepEqual(liveErrors(errors), []);
});

test('live mode: the server is gone → the panel says so and Copy for your agent becomes the primary action', { timeout: 120000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP_REASON);
  const live = await liveReview(t);
  const { page, errors } = await openUrl(t, live.url);
  await move(page, 'DQ-003', 'debt');
  live.child.kill('SIGTERM');
  assert.equal((await live.exited).code, 3);
  await page.click('#review-send');
  await page.click('#send-to-agent');
  await page.waitForSelector('#send-error');
  assert.match(await page.textContent('#send-error'), /Your agent is no longer waiting\. Copy the decisions and paste them into its chat\./);
  assert.equal(await page.locator('#send-to-agent').count(), 0);
  assert.equal(await page.getAttribute('#copy-for-agent', 'class'), 'btn btn-default btn-sm', 'Copy is the primary action');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'copy-for-agent');
  const message = await copied(page, '#copy-for-agent');
  const doc = parseDecisions(message);
  assert.deepEqual(doc.triage.debt, ['DQ-003', 'DQ-007', 'DQ-014', 'DQ-013']);
  assert.match(message, /\nReport: qa-reports\/ACME-482\/report\.json\n/);
  assert.match(await page.textContent('#review-bar-status'), /^Copied at \d\d:\d\d: paste it into your agent's chat$/);
  assert.deepEqual(liveErrors(errors).filter((e) => !/ERR_CONNECTION_REFUSED|Failed to fetch/.test(e)), []);
});

test('live mode: a stale report is rejected with the server\'s reason; the server keeps waiting', { timeout: 120000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP_REASON);
  const live = await liveReview(t);
  const { page, errors, requests } = await openUrl(t, live.url);
  await page.waitForLoadState('networkidle');
  const from = requests.length;
  const onDisk = JSON.parse(readFileSync(live.reportFile, 'utf8'));
  onDisk.meta.generatedAt = '2026-10-04T08:00:00Z';
  writeFileSync(live.reportFile, JSON.stringify(onDisk, null, 2));
  await page.click('#review-send');
  await page.click('#send-to-agent');
  await page.waitForSelector('#send-error');
  const error = await page.textContent('#send-error .alert-description');
  assert.match(error, /^these decisions were made on the report generated 2026-10-01T12:00:00Z, but report\.json was generated 2026-10-04T08:00:00Z\..*Reopen the current report\.html, review again and send the new decisions\.$/s);
  assert.equal(await page.isVisible('#send-panel'), true, 'the panel stays open');
  assert.equal(await page.isEnabled('#send-to-agent'), true, 'Send is available again');
  assert.equal(await page.textContent('#review-bar-status'), 'Not sent yet');
  assert.equal(live.child.exitCode, null, 'the server keeps running');
  assert.match(live.output(), /Waiting for the reviewer/);
  assert.deepEqual(afterLoad(requests, from).map((r) => r.method()), ['POST']);
  assert.deepEqual(liveErrors(errors).filter((e) => !/409/.test(e)), []);
});
