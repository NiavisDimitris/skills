import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { agentPrompt, codingAgentIntro, parseDebtItems, renderFixplan, stateLabel, triageCommand } from '../skills/design-qa/scripts/lib/fixplan.mjs';
import { collectImagePaths } from '../skills/design-qa/scripts/render-report.mjs';
import { validateReport } from '../skills/design-qa/scripts/lib/schema-check.mjs';
import { applyTriage, buildTriage } from '../skills/design-qa/scripts/lib/triage.mjs';
import { createPng, writePng } from '../skills/design-qa/scripts/lib/png.mjs';
import { rankFindings } from '../skills/design-qa/scripts/lib/ranking.mjs';
import { SKILL, fixture, loadFixture, run, script, tmpDir } from './_helpers.mjs';

const RENDER = script('render-report.mjs');
const TEMPLATE = fixture('template.html');

function scriptContent(html, id) {
  const m = new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)</script>`).exec(html);
  assert.ok(m, `script #${id} not found`);
  return m[1];
}

function writeReport(dir, report) {
  const file = path.join(dir, 'report.json');
  writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

test('renders the template: placeholders replaced, ranks filled, title escaped', async () => {
  const dir = tmpDir();
  const report = loadFixture('report-valid.json');
  report.meta.feature = 'Items <list> & "more"';
  const inFile = writeReport(dir, report);
  const out = path.join(dir, 'out', 'report.html');
  const res = await run(RENDER, ['--in', inFile, '--out', out, '--template', TEMPLATE]);
  assert.equal(res.code, 0, res.stderr);
  const html = readFileSync(out, 'utf8');
  assert.ok(!html.includes('/*__DESIGN_QA_DATA__*/'));
  assert.ok(!html.includes('/*__DESIGN_QA_ASSETS__*/'));
  assert.ok(!html.includes('__DESIGN_QA_TITLE__'));
  assert.match(html, /<title>Design QA — Items &lt;list&gt; &amp; &quot;more&quot;<\/title>/);
  const data = JSON.parse(scriptContent(html, 'design-qa-data'));
  assert.equal(data.meta.feature, 'Items <list> & "more"');
  assert.deepEqual(
    data.findings.map((f) => f.rank.bucket),
    ['fix-now', 'fix-now', 'fix-now', 'fix-now', 'none', 'none', 'none', 'fix-now', 'none'],
  );
  assert.deepEqual(JSON.parse(scriptContent(html, 'design-qa-assets')), {}, 'no assets without --embed-images');
});

test('script-breaking text in the data is escaped and round-trips', async () => {
  const dir = tmpDir();
  const report = loadFixture('report-valid.json');
  const nasty = `</script><script>alert(1)</script> <!--<script> $& $' ${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}`;
  report.findings[0].title = nasty;
  const inFile = writeReport(dir, report);
  const out = path.join(dir, 'report.html');
  const res = await run(RENDER, ['--in', inFile, '--out', out, '--template', TEMPLATE]);
  assert.equal(res.code, 0, res.stderr);
  const html = readFileSync(out, 'utf8');
  const raw = scriptContent(html, 'design-qa-data');
  assert.ok(!raw.includes('</script'), 'no closing script tag inside the data');
  assert.ok(!raw.includes('<!--'), 'no comment opener inside the data');
  assert.ok(raw.includes('\\u003c/script\\u003e'), 'every < and > is a \\u escape');
  assert.ok(!/[<>&]/.test(raw), 'no raw <, > or & in the data');
  assert.ok(!raw.includes(String.fromCharCode(0x2028)) && !raw.includes(String.fromCharCode(0x2029)));
  assert.equal(JSON.parse(raw).findings[0].title, nasty);
  assert.equal((html.match(/<\/script>/g) || []).length, 3, 'only the template’s own closing tags remain');
});

test('--embed-images inlines every referenced image that exists', async () => {
  const dir = tmpDir();
  const report = loadFixture('report-valid.json');
  const inFile = writeReport(dir, report);
  for (const rel of ['app/empty.png', 'figma/empty.png', 'diff/with-data.png', 'app/with-data.png', 'figma/hover.png']) {
    mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    writePng(path.join(dir, rel), createPng(2, 2, [255, 0, 0, 255]));
  }
  const out = path.join(dir, 'report.html');
  const res = await run(RENDER, ['--in', inFile, '--out', out, '--template', TEMPLATE, '--embed-images']);
  assert.equal(res.code, 0, res.stderr);
  const assets = JSON.parse(scriptContent(readFileSync(out, 'utf8'), 'design-qa-assets'));
  assert.deepEqual(Object.keys(assets).sort(), ['app/empty.png', 'app/with-data.png', 'diff/with-data.png', 'figma/empty.png', 'figma/hover.png']);
  for (const value of Object.values(assets)) assert.match(value, /^data:image\/png;base64,iVBORw0KGgo/);
  assert.match(res.stderr, /image not found, not embedded: diff\/empty\.png/);
  assert.ok(!('computed/with-data.json' in assets), 'JSON evidence is not an image');
  assert.ok(!('motion/hover.json' in assets), 'motion JSON is not an image');
});

test('collectImagePaths: captured.design, evidence.states.*.design and design/motion evidence images', () => {
  assert.deepEqual(collectImagePaths(loadFixture('report-multiscreen.json')), [
    'screens/cart/diff/with-data.png',
    'screens/checkout/diff/with-data.png',
    'screens/cart/design/with-data.png',
    'screens/cart/app/with-data.png',
    'screens/cart/design/empty.png',
    'screens/cart/app/empty.png',
    'screens/checkout/design/with-data.png',
    'screens/checkout/app/with-data.png',
  ]);
  const report = {
    findings: [{ evidence: [{ type: 'motion', path: 'motion/hover.gif' }, { type: 'design', path: 'design/only-here.png' }, { type: 'computed', path: 'x.png' }] }],
    evidence: { states: { hover: { design: 'design/hover.webp', designComputed: 'design-computed/hover.json' } } },
  };
  assert.deepEqual(collectImagePaths(report), ['motion/hover.gif', 'design/only-here.png', 'design/hover.webp']);
  const withBackfill = {
    ...report,
    backfill: { gate: { override: null }, items: [{ captured: { app: 'evidence/backfill/app/bulk.png', computed: 'evidence/backfill/computed/bulk.json' } }, { captured: null }, { captured: { app: 'design/hover.webp' } }] },
  };
  assert.deepEqual(collectImagePaths(withBackfill), ['motion/hover.gif', 'design/only-here.png', 'design/hover.webp', 'evidence/backfill/app/bulk.png'], 'backfill captures (app side) last, deduplicated');
});

test('invalid reports fail; scorecard drift needs --recompute; --write-back saves', async () => {
  const dir = tmpDir();
  const bad = loadFixture('report-valid.json');
  bad.findings[0].severity = 'CRITICAL';
  const res = await run(RENDER, ['--in', writeReport(dir, bad), '--template', TEMPLATE, '--out', path.join(dir, 'r.html')]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /findings\[0\]\.severity: expected one of/);

  const drift = loadFixture('report-valid.json');
  drift.scorecard.parity = 99;
  drift.scorecard.verdict = 'PASS';
  const driftFile = writeReport(dir, drift);
  const refused = await run(RENDER, ['--in', driftFile, '--template', TEMPLATE, '--out', path.join(dir, 'r.html')]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /scorecard\.parity: expected 38/);
  assert.match(refused.stderr, /--recompute/);

  const fixed = await run(RENDER, ['--in', driftFile, '--template', TEMPLATE, '--out', path.join(dir, 'r.html'), '--recompute', '--write-back']);
  assert.equal(fixed.code, 0, fixed.stderr);
  const html = readFileSync(path.join(dir, 'r.html'), 'utf8');
  const data = JSON.parse(scriptContent(html, 'design-qa-data'));
  assert.equal(data.scorecard.parity, 38);
  assert.equal(data.scorecard.verdict, 'FAIL');
  const saved = JSON.parse(readFileSync(driftFile, 'utf8'));
  assert.equal(saved.scorecard.verdict, 'FAIL');
  assert.equal(saved.findings[0].rank.bucket, 'fix-now');
  const again = await run(script('validate.mjs'), [driftFile]);
  assert.equal(again.code, 0, again.stderr);
});

test('stale ranks: rejected without --recompute, re-ranked with it', async () => {
  const dir = tmpDir();
  const stale = loadFixture('report-valid.json');
  stale.findings = rankFindings(stale.findings);
  stale.findings[8].rank = { score: 225, bucket: 'fix-now' }; // DQ-009 is DISMISSED
  const file = writeReport(dir, stale);
  const refused = await run(RENDER, ['--in', file, '--template', TEMPLATE, '--out', path.join(dir, 'r.html')]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /findings\[8\]\.rank\.bucket: must be "none"/);
  assert.match(refused.stderr, /scorecard or ranks disagree with the derived rules; fix the report or pass --recompute/);
  const fixed = await run(RENDER, ['--in', file, '--template', TEMPLATE, '--out', path.join(dir, 'r.html'), '--recompute']);
  assert.equal(fixed.code, 0, fixed.stderr);
  const data = JSON.parse(scriptContent(readFileSync(path.join(dir, 'r.html'), 'utf8'), 'design-qa-data'));
  assert.deepEqual(data.findings[8].rank, { score: 0, bucket: 'none' });
});

test('a template without the data placeholder is rejected', async () => {
  const dir = tmpDir();
  const tpl = path.join(dir, 'bad.html');
  writeFileSync(tpl, '<html><title>__DESIGN_QA_TITLE__</title></html>');
  const res = await run(RENDER, ['--in', fixture('report-valid.json'), '--template', tpl, '--out', path.join(dir, 'x.html')]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /missing the \/\*__DESIGN_QA_DATA__\*\/ placeholder/);
  assert.equal((await run(RENDER, ['--out', 'x.html'])).code, 2, '--in is required');
});

test('fix plan: section order, fix-now ordering, paste block, design-system mismatches, debt and dismissed', async () => {
  const dir = tmpDir();
  const plan = path.join(dir, 'fixplan.md');
  const res = await run(RENDER, [
    '--in', fixture('report-valid.json'), '--template', TEMPLATE, '--out', path.join(dir, 'r.html'), '--fixplan', plan, '--top-n', '2',
  ]);
  assert.equal(res.code, 0, res.stderr);
  const md = readFileSync(plan, 'utf8');
  const headings = md.split('\n').filter((l) => l.startsWith('#'));
  assert.deepEqual(headings, [
    '# Design QA fix plan — Items list',
    '## Fix now (2)',
    '### Paste to your coding agent',
    '## Design-system mismatches',
    '### Tokens (2)',
    '### Components (1)',
    '### Motion (1)',
    '## Debt (3) — tickets',
    '## Missing states / needs decision',
    '## Dismissed (2)',
    '## Cannot verify',
  ]);
  assert.ok(!/sync|Paste to your design agent/i.test(md), 'nothing points back at the design');
  const lines = md.split('\n');
  assert.equal(lines[1], 'Verdict: FAIL · Parity 38% · States: 3/5 verified (5 designed, 3 specified, 4 implemented)');
  assert.equal(
    lines[2],
    'Source: figma https://www.figma.com/design/AbCdEf123456/Items?node-id=1-2 · App: http://localhost:3000/items (local) · Ticket: ABC-12 · Generated: 2026-09-23T10:00:00Z',
  );
  assert.equal(
    lines[3],
    'Triage: recommended (top 2 by rank). Choose in report.html and click "Review and send", or type /design-qa triage ABC-12 --fix DQ-001,DQ-003',
  );
  assert.equal(lines[4], 'Dismissed: 1 · accepted as intentional: 1');
  assert.equal(lines[5], '');
  const section = (from, to) => md.slice(md.indexOf(from), md.indexOf(to));

  const fixNow = section('## Fix now', '## Design-system mismatches');
  assert.ok(fixNow.includes('1. **DQ-001 — Empty state message is missing** (BLOCKER, structure, state empty)\n   - Where: src/Items.tsx:42 · selector `main .empty`'));
  assert.ok(fixNow.includes('2. **DQ-003 — Hover row renders ListItem instead of TableRow** (WARNING, component, state hover)'));
  assert.ok(fixNow.includes(`\`\`\`text\n${codingAgentIntro}\n\n[DQ-001]`));
  assert.ok(fixNow.indexOf('[DQ-001]') < fixNow.indexOf('[DQ-003]'));
  assert.ok(!fixNow.includes('DQ-009'), 'dismissed findings never go to the coding agent');

  assert.equal(
    section('## Design-system mismatches', '## Debt').trim(),
    [
      '## Design-system mismatches',
      '### Tokens (2)',
      '- DQ-002 — Row padding is 12px instead of 16px — expected space.4 (16px) · actual 12px',
      '- DQ-004 — Hard-coded grey could be a design-system token — expected color.text.muted (#6B7280) · actual #6B7280',
      '### Components (1)',
      '- DQ-003 — Hover row renders ListItem instead of TableRow — expected TableRow (State=Hover) · actual ListItem',
      '### Motion (1)',
      '- DQ-008 — Row hover has no background transition — expected motion.duration.fast (150ms ease-out on background-color) · actual none',
    ].join('\n'),
  );

  assert.equal(
    section('## Debt', '## Missing states').trim(),
    [
      '## Debt (3) — tickets',
      "- DQ-002 — Row padding is 12px instead of 16px (WARNING, owner engineering) — no ticket yet — Use the space.4 token for the row's vertical padding",
      '- DQ-008 — Row hover has no background transition (WARNING, owner engineering) — no ticket yet — Add the fast background-color transition to .row',
      '- DQ-004 — Hard-coded grey could be a design-system token (DS_CANDIDATE, owner engineering) — no ticket yet — Replace the literal with var(--color-text-muted)',
    ].join('\n'),
  );

  assert.equal(
    section('## Missing states', '## Dismissed').trim(),
    [
      '## Missing states / needs decision',
      '- Loading: MISSING_IN_CODE — Designed (Loading skeleton) but not implemented: if the code has it, add a driver at surfaces.items.states.loading; otherwise build it.',
      '- OD-1: Ship the empty state before the illustration asset is final? — options: Ship with the placeholder illustration: Empty state matches the layout now; the asset is swapped later; Wait for the final asset: DQ-001 stays open until the asset lands — recommendation: Ship with the placeholder illustration',
    ].join('\n'),
  );
  assert.equal(
    section('## Dismissed', '## Cannot verify').trim(),
    [
      '## Dismissed (2)',
      '- DQ-007 — Table header is sticky in the app, static in the design — intentional — "Sticky header approved for long lists" — by design lead, 2026-09-20',
      '- DQ-009 — Table header text renders 1px lower — not-an-issue — "Font rasterisation difference between the Figma export and Chrome; the line boxes are identical." — by Dana, 2026-09-23',
    ].join('\n'),
  );
  assert.ok(md.includes('## Cannot verify\n- DQ-006 — Retry button behaviour could not be exercised — no driver for the error state\n- Error: No runtime driver for the error state'));

  const debt = parseDebtItems(md);
  assert.deepEqual(debt.map((d) => d.id), ['DQ-002', 'DQ-008', 'DQ-004']);
  assert.equal(debt[2].title, 'Hard-coded grey could be a design-system token');
  assert.equal(debt[2].meta, 'DS_CANDIDATE, owner engineering');
  assert.equal(debt[2].owner, 'engineering');
  assert.equal(debt[2].ticket, null);
  assert.equal(debt[2].summary, 'Replace the literal with var(--color-text-muted)');
});

test('fix plan: the recommendation keeps every blocker in fix now; prototype sources and screens', () => {
  const report = loadFixture('report-valid.json');
  const md = renderFixplan({ ...report, findings: rankFindings(report.findings, { topN: 0 }) }, { topN: 0 });
  assert.ok(md.includes('## Fix now (1)\n1. **DQ-001'), 'a blocker in the debt bucket is still fixed now');
  assert.ok(md.includes('## Debt (4) — tickets\n- DQ-003'));
  assert.ok(md.split('\n')[3].endsWith('--fix DQ-001'));

  const multi = loadFixture('report-multiscreen.json');
  const plan = renderFixplan(multi);
  const lines = plan.split('\n');
  assert.equal(lines[2], 'Source: prototype https://acme-checkout.framer.website/cart · App: http://localhost:5173/cart (local) · Ticket: – · Generated: 2026-10-01T09:30:00Z');
  assert.ok(!plan.includes('Dismissed: '), 'no Dismissed line when nothing is dismissed');
  assert.ok(plan.includes('### Tokens (1)\n- DQ-001 — Cart total uses a hard-coded colour instead of the brand token — expected --color-text-strong (rgb(17, 24, 39)) · actual rgb(31, 41, 55)'));
  assert.ok(plan.includes('### Components (0)\n- None'));
  assert.ok(plan.includes('### Motion (1)\n- DQ-002 — Pay button has no press animation — expected 120ms ease-out on transform · actual none'));
  assert.ok(plan.includes('(WARNING, style, state cart/with-data)'));
  assert.ok(plan.includes('## Dismissed (0)\n- None'));
});

test('fix plan: multi-screen state lines name the screen (Missing states, Cannot verify)', () => {
  const multi = loadFixture('report-multiscreen.json');
  const base = multi.stateMatrix[0];
  const report = {
    ...multi,
    stateMatrix: [
      ...multi.stateMatrix,
      { ...base, screen: 'checkout', state: 'checkout/promo-applied', label: 'Promo applied', result: 'MISSING_IN_CODE', note: 'Apply has no handler' },
      { ...base, screen: 'cart', state: 'cart/promo-applied', label: 'Promo applied', result: 'NOT_SPECIFIED', note: 'no AC' },
      { ...base, screen: 'checkout', state: 'checkout/error', label: null, result: 'CANNOT_VERIFY', note: 'No runtime driver for the error state' },
    ],
    findings: [
      ...multi.findings,
      { ...multi.findings[1], id: 'DQ-004', severity: 'CANNOT_VERIFY', resolution: 'UNCLASSIFIED', title: 'Pay button focus ring cannot be verified', delta: 'no focus driver', rank: undefined },
    ],
  };
  const plan = renderFixplan(report);
  const section = (from, to) => plan.slice(plan.indexOf(from), plan.indexOf(to));
  assert.equal(
    section('## Missing states', '## Dismissed').trim(),
    [
      '## Missing states / needs decision',
      '- Checkout / Promo applied: MISSING_IN_CODE — Apply has no handler',
      '- Cart / Promo applied: NOT_SPECIFIED — no AC',
    ].join('\n'),
    'the same label on two screens stays unambiguous',
  );
  assert.ok(
    plan.includes(
      [
        '## Cannot verify',
        '- DQ-004 — Checkout / With data: Pay button focus ring cannot be verified — no focus driver',
        '- Checkout / error: No runtime driver for the error state',
      ].join('\n'),
    ),
    plan,
  );
  assert.equal(stateLabel(report, { state: 'with-data', label: 'With data' }), 'With data', 'single-screen rows keep their label');
  assert.equal(stateLabel(report, { screen: 'ghost', state: 'ghost/empty' }), 'ghost / empty', 'an unknown screen id shows the id');
  assert.equal(stateLabel(report, null), '–');
});

test('parseDebtItems reads the current and the older debt bullet formats', () => {
  const md = [
    '## Debt (3) — tickets',
    '- DQ-004 — Card padding is 20px (24px) (WARNING, owner engineering) — ACME-511 — Use the spacing token.',
    '- DQ-009 — Bulk bar has no design (Acme DS) (DS_CANDIDATE, owner design) — no ticket yet — –',
    '- DQ-010 — Old format (WARNING, style, state with-data) — Fix it — evidence: app/x.png',
    '',
    '## Missing states / needs decision',
    '- DQ-011 — not debt (WARNING, owner engineering) — – — –',
  ].join('\n');
  const items = parseDebtItems(md);
  assert.deepEqual(items.map((i) => [i.id, i.title, i.owner, i.ticket, i.summary, i.evidence]), [
    ['DQ-004', 'Card padding is 20px (24px)', 'engineering', 'ACME-511', 'Use the spacing token.', null],
    ['DQ-009', 'Bulk bar has no design (Acme DS)', 'design', null, null, null],
    ['DQ-010', 'Old format', null, null, 'Fix it', 'app/x.png'],
  ]);
});

test('fix plan with triage: the decisions fill Fix now and Debt', () => {
  const report = loadFixture('report-valid.json');
  const { triage } = buildTriage(report, { fixIds: ['DQ-002'], decidedBy: 'Dana', decidedAt: '2026-09-24T09:00:00Z', source: 'cli' });
  triage.items.find((i) => i.findingId === 'DQ-004').ticket = {
    provider: 'jira', key: 'ABC-99', url: 'https://example.atlassian.net/browse/ABC-99', createdAt: '2026-09-24T09:05:00Z',
  };
  const triaged = applyTriage(report, triage);
  assert.deepEqual(validateReport(triaged).errors, []);
  const md = renderFixplan(triaged);
  const lines = md.split('\n');
  assert.equal(lines[3], 'Triage: 2 fix now · 3 debt (1 ticketed) · Dana, 2026-09-24');
  assert.equal(lines[4], 'Dismissed: 1 · accepted as intentional: 1');
  const section = (from, to) => md.slice(md.indexOf(from), md.indexOf(to));
  const fixNow = section('## Fix now', '## Design-system mismatches');
  assert.ok(fixNow.startsWith('## Fix now (2)\n1. **DQ-001'), 'the BLOCKER stays in fix now');
  assert.ok(fixNow.includes('2. **DQ-002'));
  assert.equal(
    section('## Debt', '## Missing states').trim(),
    [
      '## Debt (3) — tickets',
      '- DQ-003 — Hover row renders ListItem instead of TableRow (WARNING, owner engineering) — no ticket yet — Render the design-system TableRow for each item',
      '- DQ-008 — Row hover has no background transition (WARNING, owner engineering) — no ticket yet — Add the fast background-color transition to .row',
      '- DQ-004 — Hard-coded grey could be a design-system token (DS_CANDIDATE, owner engineering) — ABC-99 — Replace the literal with var(--color-text-muted)',
    ].join('\n'),
  );
  assert.ok(section('## Design-system mismatches', '## Debt').includes('### Tokens (2)\n- DQ-002'), 'design-system lists every open mismatch, fix now or debt');
});

test('triageCommand: slug from the ticket key, else the kebab-cased feature', () => {
  const report = loadFixture('report-valid.json');
  assert.equal(triageCommand(report, ['DQ-001', 'DQ-002']), '/design-qa triage ABC-12 --fix DQ-001,DQ-002');
  report.meta.ticket = null;
  report.meta.feature = 'Orders list: bulk actions';
  assert.equal(triageCommand(report, []), '/design-qa triage orders-list-bulk-actions --fix none');
});

test('agentPrompt format (snapshot)', () => {
  const report = loadFixture('report-valid.json');
  const byId = Object.fromEntries(report.findings.map((f) => [f.id, f]));
  assert.equal(
    agentPrompt(byId['DQ-002']),
    [
      '[DQ-002] Row padding is 12px instead of 16px',
      'Ledger: style · State: with-data · Severity: WARNING · Resolution: FIX_CODE',
      'Element: .row (Figma: Items/Table/Row)',
      'Property: padding-top',
      'Expected: 16px (token: space.4; source: figma)',
      'Actual: 12px (token: none) at src/Row.css:7',
      '  .row {',
      '    padding: 12px 24px;',
      '  }',
      "Fix: Use the space.4 token for the row's vertical padding",
      'Patch hint: padding: var(--space-4) var(--space-6);',
      'Files: src/Row.css',
      'Evidence: computed/with-data.json',
    ].join('\n'),
  );
  assert.equal(
    agentPrompt(byId['DQ-006']),
    [
      '[DQ-006] Retry button behaviour could not be exercised',
      'Ledger: behavior · State: error · Severity: CANNOT_VERIFY · Resolution: NONE',
      'Element: – (Figma: Items / Error/Retry)',
      'Property: –',
      'Expected: Retry refetches the list (token: none; source: ticket)',
      'Actual: – (token: none) at –',
      'Fix: –',
      'Patch hint: –',
      'Files: –',
      'Evidence: –',
    ].join('\n'),
  );
});

test('renderFixplan handles empty sections', () => {
  const report = loadFixture('report-valid.json');
  report.findings = report.findings.filter((f) => f.severity === 'PASS');
  report.stateMatrix = [];
  report.openDecisions = [];
  const md = renderFixplan({ ...report, findings: rankFindings(report.findings) });
  assert.ok(md.includes('## Fix now (0)\n- None'));
  assert.ok(!md.includes('Paste to your coding agent'));
  assert.equal(md.split('\n')[3], 'Triage: nothing to triage');
  assert.equal(md.split('\n')[4], '', 'no Dismissed line');
  assert.ok(md.includes('## Design-system mismatches\n### Tokens (0)\n- None\n### Components (0)\n- None\n### Motion (0)\n- None'));
  assert.ok(md.includes('## Debt (0) — tickets\n- None'));
  assert.ok(md.includes('## Missing states / needs decision\n- None'));
  assert.ok(md.includes('## Dismissed (0)\n- None'));
  assert.ok(md.includes('## Cannot verify\n- None'));
});

test('renders with the shipped template when it exists', async (t) => {
  const shipped = path.join(SKILL, 'templates', 'report.html');
  if (!existsSync(shipped)) {
    t.skip('templates/report.html not written yet');
    return;
  }
  const dir = tmpDir();
  const out = path.join(dir, 'report.html');
  const res = await run(RENDER, ['--in', fixture('report-valid.json'), '--out', out]);
  assert.equal(res.code, 0, res.stderr);
  const html = readFileSync(out, 'utf8');
  assert.equal(JSON.parse(scriptContent(html, 'design-qa-data')).meta.feature, 'Items list');
});

test('shipped template: pins, the Annotations rail and the triage board share one triage store', (t) => {
  const shipped = path.join(SKILL, 'templates', 'report.html');
  if (!existsSync(shipped)) {
    t.skip('templates/report.html not written yet');
    return;
  }
  const src = readFileSync(shipped, 'utf8');
  // One write path; every surface uses the same triageSeg() control (rail, board, Findings table and sheet, panel).
  assert.equal((src.match(/function setTriage\(/g) || []).length, 1);
  assert.equal((src.match(/function triageSeg\(/g) || []).length, 1, 'one reusable Fix now / Debt control');
  assert.match(src, /setTriage\(f\.id, dec, \{ announce: true \}\)/, 'the control moves through the shared store');
  for (const surface of ["triageSeg(f, 'rail')", "triageSeg(f, 'board')", "triageSeg(f, 'table')", "triageSeg(f, 'sheet')", "triageSeg(f, 'panel', { large: true })"]) {
    assert.ok(src.includes(surface), `missing ${surface}`);
  }
  assert.ok(!src.includes("role: 'checkbox', class: 'checkbox tri-check'"), 'the board checkbox is replaced by the control');
  assert.ok(!src.includes("'data-bucket-ctl'"), 'the rail bucket button is replaced by the control');
  assert.ok(!src.includes('function toggleTriage('), 'no toggle path outside setTriage');
  // Radiogroup semantics, a locked Debt segment for blockers, and clicks that never reach the row or card.
  for (const hook of ["role: 'radiogroup'", "role: 'radio'", "b.setAttribute('aria-checked', String(on))", "if (off) b.setAttribute('aria-disabled', 'true')", "e.stopPropagation(); var b = e.target.closest('.tseg-btn')", "'ArrowLeft', 'ArrowRight'"]) {
    assert.ok(src.includes(hook), `missing ${hook}`);
  }
  // Live review summary in the rail head and the board header.
  for (const id of ["id: 'rail-tri-summary'", "id: 'board-tri-summary'", 'function triSummary(']) assert.ok(src.includes(id), `missing ${id}`);
  // Pins and rail rows open one side panel (no anchored popover).
  assert.ok(!src.includes("id: 'pin-pop'"), 'the pin popover is gone');
  assert.match(src, /openPanel\(p\.f\.id, \{ kind: 'pin'/);
  assert.match(src, /openPanel\(f\.id, \{ kind: 'row'/);
  // Every surface repaints from the store after a move or a reset.
  assert.ok((src.match(/paintTriageViews\(\);/g) || []).length >= 2);
  for (const hook of ["id: 'ann-panel'", "role: 'dialog'", "'data-open-fid'", "'aria-haspopup': 'dialog'", "'data-show-fid'", 'function showOnCapture(', 'function lockReason(']) {
    assert.ok(src.includes(hook), `missing ${hook}`);
  }
});
