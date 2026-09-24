import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { agentPrompt, codingAgentIntro, designAgentIntro, parseDebtItems, renderFixplan } from '../skills/design-qa/scripts/lib/fixplan.mjs';
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
    ['fix-now', 'fix-now', 'sync-figma', 'fix-now', 'none', 'none', 'none'],
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
  assert.ok(raw.includes('<\\/script>'), '</ is escaped as <\\/');
  assert.ok(!raw.includes(String.fromCharCode(0x2028)) && !raw.includes(String.fromCharCode(0x2029)));
  assert.equal(JSON.parse(raw).findings[0].title, nasty);
  assert.equal((html.match(/<\/script>/g) || []).length, 3, 'only the template’s own closing tags remain');
});

test('--embed-images inlines every referenced image that exists', async () => {
  const dir = tmpDir();
  const report = loadFixture('report-valid.json');
  const inFile = writeReport(dir, report);
  for (const rel of ['app/empty.png', 'figma/empty.png', 'diff/with-data.png', 'app/with-data.png']) {
    mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    writePng(path.join(dir, rel), createPng(2, 2, [255, 0, 0, 255]));
  }
  const out = path.join(dir, 'report.html');
  const res = await run(RENDER, ['--in', inFile, '--out', out, '--template', TEMPLATE, '--embed-images']);
  assert.equal(res.code, 0, res.stderr);
  const assets = JSON.parse(scriptContent(readFileSync(out, 'utf8'), 'design-qa-assets'));
  assert.deepEqual(Object.keys(assets).sort(), ['app/empty.png', 'app/with-data.png', 'diff/with-data.png', 'figma/empty.png']);
  for (const value of Object.values(assets)) assert.match(value, /^data:image\/png;base64,iVBORw0KGgo/);
  assert.match(res.stderr, /image not found, not embedded: diff\/empty\.png/);
  assert.ok(!('computed/with-data.json' in assets), 'JSON evidence is not an image');
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
  assert.match(refused.stderr, /scorecard\.parity: expected 43/);
  assert.match(refused.stderr, /--recompute/);

  const fixed = await run(RENDER, ['--in', driftFile, '--template', TEMPLATE, '--out', path.join(dir, 'r.html'), '--recompute', '--write-back']);
  assert.equal(fixed.code, 0, fixed.stderr);
  const html = readFileSync(path.join(dir, 'r.html'), 'utf8');
  const data = JSON.parse(scriptContent(html, 'design-qa-data'));
  assert.equal(data.scorecard.parity, 43);
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
  stale.findings[2].rank = { score: 233, bucket: 'fix-now' }; // DQ-003 is SYNC_FIGMA
  const file = writeReport(dir, stale);
  const refused = await run(RENDER, ['--in', file, '--template', TEMPLATE, '--out', path.join(dir, 'r.html')]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /findings\[2\]\.rank\.bucket: must be "sync-figma"/);
  assert.match(refused.stderr, /scorecard or ranks disagree with the derived rules; fix the report or pass --recompute/);
  const fixed = await run(RENDER, ['--in', file, '--template', TEMPLATE, '--out', path.join(dir, 'r.html'), '--recompute']);
  assert.equal(fixed.code, 0, fixed.stderr);
  const data = JSON.parse(scriptContent(readFileSync(path.join(dir, 'r.html'), 'utf8'), 'design-qa-data'));
  assert.deepEqual(data.findings[2].rank, { score: 233, bucket: 'sync-figma' });
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

test('fix plan: section order, fix-now ordering, paste blocks, debt and sync to Figma', async () => {
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
    '## Debt (1) — log as tickets',
    '## Sync to Figma (1)',
    '### Paste to your design agent',
    '## Missing states / needs decision',
    '## Cannot verify',
  ]);
  const lines = md.split('\n');
  assert.equal(lines[1], 'Verdict: FAIL · Parity 43% · States: 3/5 verified (4 designed, 3 specified, 5 implemented)');
  assert.equal(
    lines[2],
    'Figma: https://www.figma.com/design/AbCdEf123456/Items?node-id=1-2 · App: http://localhost:3000/items (local) · Ticket: ABC-12 · Generated: 2026-09-23T10:00:00Z',
  );
  const section = (from, to) => md.slice(md.indexOf(from), md.indexOf(to));

  const fixNow = section('## Fix now', '## Debt');
  assert.ok(fixNow.includes('1. **DQ-001 — Empty state message is missing** (BLOCKER, structure, state empty)\n   - Where: src/Items.tsx:42 · selector `main .empty`'));
  assert.ok(fixNow.includes('2. **DQ-002 — Row padding is 12px instead of 16px** (WARNING, style, state with-data)'));
  assert.ok(fixNow.includes(`\`\`\`text\n${codingAgentIntro}\n\n[DQ-001]`));
  assert.ok(fixNow.indexOf('[DQ-001]') < fixNow.indexOf('[DQ-002]'));
  assert.ok(!fixNow.includes('DQ-003'), 'SYNC_FIGMA findings never go to the coding agent');

  const debtSection = section('## Debt', '## Sync to Figma');
  assert.equal(
    debtSection.trim(),
    '## Debt (1) — log as tickets\n- DQ-004 — Hard-coded grey could be a design-system token (DS_CANDIDATE, style, state with-data) — Replace the literal with var(--color-text-muted) — evidence: app/with-data.png',
  );

  const sync = section('## Sync to Figma', '## Missing states');
  assert.equal(
    sync.trim(),
    [
      '## Sync to Figma (1)',
      '- DQ-003 — Hover row uses the old highlight colour in Figma (WARNING, component, state hover) — Update the Row/Hover variant to color.surface.hover — Figma: Row / Hover',
      '',
      '### Paste to your design agent',
      '```text',
      designAgentIntro,
      '',
      agentPrompt(loadFixture('report-valid.json').findings[2]),
      '```',
    ].join('\n'),
  );
  assert.equal(
    designAgentIntro,
    'Update the Figma file so these match the shipped code. Use library components and bound variables, never arbitrary hex. Re-export the node and diff it against the app after each item.',
  );

  assert.ok(md.includes('- Disabled: MISSING_IN_DESIGN — Read-only mode exists in code but has no design'));
  assert.ok(md.includes('- OD-1: Should read-only mode get its own design? — options: Design it: One more frame to maintain; Reuse the disabled style: No design work; slightly less clear — recommendation: Reuse the disabled style'));
  assert.ok(md.includes('## Cannot verify\n- DQ-006 — Retry button behaviour could not be exercised — no driver for the error state\n- Error: No runtime driver for the error state'));

  const debt = parseDebtItems(md);
  assert.deepEqual(debt.map((d) => d.id), ['DQ-004']);
  assert.equal(debt[0].title, 'Hard-coded grey could be a design-system token');
  assert.equal(debt[0].meta, 'DS_CANDIDATE, style, state with-data');
  assert.equal(debt[0].summary, 'Replace the literal with var(--color-text-muted)');
  assert.equal(debt[0].evidence, 'app/with-data.png');
});

test('sync to Figma: several items in score order, Figma node id when there is no layer path', () => {
  const report = loadFixture('report-valid.json');
  const extra = structuredClone(report.findings[2]);
  extra.id = 'DQ-008';
  extra.title = 'Empty illustration differs from the shipped one';
  extra.severity = 'BLOCKER';
  extra.ledger = 'structure';
  extra.element = { selector: null, figmaLayerPath: null, figmaNodeId: '1:41' };
  extra.fix = null;
  report.findings.push(extra);
  const md = renderFixplan({ ...report, findings: rankFindings(report.findings) });
  const sync = md.slice(md.indexOf('## Sync to Figma'), md.indexOf('## Missing states'));
  assert.ok(sync.startsWith('## Sync to Figma (2)\n- DQ-008 — Empty illustration differs from the shipped one (BLOCKER, structure, state hover) — – — Figma: 1:41\n- DQ-003'));
  assert.ok(sync.indexOf('[DQ-008]') < sync.indexOf('[DQ-003]'), 'design prompts follow score order');
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
  assert.ok(md.includes('## Debt (0) — log as tickets\n- None'));
  assert.ok(md.includes('## Sync to Figma (0)\n- None'));
  assert.ok(!md.includes('Paste to your design agent'));
  assert.ok(md.includes('## Missing states / needs decision\n- None'));
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
