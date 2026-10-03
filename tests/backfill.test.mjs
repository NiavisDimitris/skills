import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  BackfillGateError,
  attachCaptures,
  decideItems,
  formatBackfillMessage,
  frameName,
  gateStatus,
  isBackfillReady,
  mergeCandidates,
  normalizeCandidate,
  parseBackfillFile,
  parseBackfillMessage,
  parseCandidatesFile,
  recordBuilt,
  setOverride,
} from '../skills/design-qa/scripts/lib/backfill.mjs';
import { backfillPointer, designAgentIntro, designAgentPrompt, renderBackfillPlan } from '../skills/design-qa/scripts/lib/backfill-plan.mjs';
import { renderFixplan } from '../skills/design-qa/scripts/lib/fixplan.mjs';
import { backfillSummary, computeScorecard } from '../skills/design-qa/scripts/lib/ranking.mjs';
import { validateReport } from '../skills/design-qa/scripts/lib/schema-check.mjs';
import { collectImagePaths } from '../skills/design-qa/scripts/render-report.mjs';
import { createPng, writePng } from '../skills/design-qa/scripts/lib/png.mjs';
import { fixture, loadFixture, run, script, tmpDir } from './_helpers.mjs';

const BACKFILL = script('backfill.mjs');
const RENDER = script('render-report.mjs');
const VALIDATE = script('validate.mjs');
const TEMPLATE = fixture('template.html');
const FIGMA = 'https://www.figma.com/design/AbCdEf123456/Items?node-id=1-90';

/** report-valid.json (step 1 still open: loopClosed false) without a backfill block. */
const openReport = () => loadFixture('report-valid.json');

/** The same report with step 1 closed: every open finding explained as DATA, no open decisions. */
function closedReport() {
  const r = openReport();
  for (const f of r.findings) if (['FIX_CODE', 'UNCLASSIFIED'].includes(f.resolution)) f.resolution = 'DATA';
  for (const f of r.findings) f.rank = null;
  r.openDecisions = [];
  r.triage = null;
  r.scorecard = computeScorecard(r);
  return r;
}

const candidates = [
  { state: 'bulk-selected', label: 'Bulk selected', discoveredBy: 'source', detail: 'ItemsTable.tsx:88 renders BulkBar', driver: { action: 'click', selector: '.row input' } },
  { state: 'disabled', discoveredBy: 'config', detail: 'config surfaces.items.states.disabled: query ?readonly=1', driver: { query: 'readonly=1' } },
  { state: 'empty', discoveredBy: 'config', detail: 'designed already' },
];

/** Write a report to <root>/qa-reports/<slug>/report.json like the skill does. */
function place(root, report, slug = 'ABC-12') {
  const dir = path.join(root, 'qa-reports', slug);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'report.json');
  writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const item = (report, id) => report.backfill.items.find((i) => i.id === id);

test('normalizeCandidate: defaults, screen prefixes, validation', () => {
  assert.deepEqual(normalizeCandidate({ state: 'bulk-selected', detail: ' x ' }), {
    state: 'bulk-selected',
    screen: null,
    label: 'Bulk selected',
    discoveredBy: 'source',
    detail: 'x',
    driver: null,
  });
  assert.equal(normalizeCandidate({ state: 'bulk-selected', screen: 'cart' }).state, 'cart/bulk-selected');
  assert.equal(normalizeCandidate({ state: 'cart/bulk-selected' }).screen, 'cart');
  assert.throws(() => normalizeCandidate({ label: 'x' }), /"state" is required/);
  assert.throws(() => normalizeCandidate({ state: 'x', discoveredBy: 'figma' }), /discoveredBy must be one of config, source, ticket, capture/);
  assert.equal(parseCandidatesFile({ generatedAt: 'x', surface: 'items', candidates }).length, 3);
  assert.throws(() => parseCandidatesFile({ nope: [] }), /expected backfill-candidates\.json/);
});

test('mergeCandidates: BF ids, upsert by screen + state keeps decisions, designed states skipped, input untouched', () => {
  const report = openReport();
  const first = mergeCandidates(report, candidates);
  assert.equal(report.backfill, undefined, 'the input is not modified');
  assert.deepEqual(first.added, ['BF-001', 'BF-002']);
  assert.deepEqual(first.skipped, [{ state: 'empty', why: 'the design defines it (a stateMatrix row)' }]);
  assert.deepEqual(first.report.backfill.gate, { override: null });
  const bf1 = item(first.report, 'BF-001');
  assert.deepEqual(Object.keys(bf1), [
    'id', 'state', 'screen', 'label', 'discoveredBy', 'detail', 'driver', 'captured', 'anchor', 'components', 'tokens',
    'decision', 'decidedBy', 'decidedAt', 'reason', 'figma', 'dsGaps',
  ]);
  assert.equal(bf1.decision, 'pending');
  assert.equal(item(first.report, 'BF-002').label, 'Disabled');

  const decided = decideItems(first.report, [{ id: 'BF-001', decision: 'build', by: 'Dana', date: '2026-10-01T10:00:00Z' }]).report;
  const again = mergeCandidates(decided, [
    { state: 'bulk-selected', discoveredBy: 'source', detail: 'ItemsTable.tsx:91 renders BulkBar' },
    { state: 'saved-toast', discoveredBy: 'ticket', detail: 'ticket AC-5' },
  ]);
  assert.deepEqual(again.added, ['BF-003']);
  assert.deepEqual(again.updated, ['BF-001']);
  const kept = item(again.report, 'BF-001');
  assert.equal(kept.decision, 'build', 'decisions are kept');
  assert.equal(kept.detail, 'ItemsTable.tsx:91 renders BulkBar', 'detail is refreshed');
  assert.deepEqual(kept.driver, { action: 'click', selector: '.row input' }, 'a null driver never overwrites a known one');
  assert.deepEqual(again.report.stateMatrix, report.stateMatrix, 'the matrix stays designed-only');
  assert.deepEqual(again.report.findings, report.findings);
});

test('attachCaptures: paths relative to report.json, failed and unmatched states, screen filter', () => {
  const { report } = mergeCandidates(openReport(), candidates);
  const capture = {
    states: {
      'bulk-selected': { driver: {}, screenshot: 'app/bulk-selected.png', computed: 'computed/bulk-selected.json', dom: 'dom/bulk-selected.json', motion: 'motion/bulk-selected.json' },
      disabled: { driver: { query: 'readonly=1' }, screenshot: null, degradations: [{ step: 'capture:disabled', reason: 'timeout', impact: 'x' }] },
      hover: { screenshot: 'app/hover.png' },
    },
  };
  const res = attachCaptures(report, capture, { prefix: 'evidence/backfill' });
  assert.deepEqual(res.attached, [{ id: 'BF-001', state: 'bulk-selected' }]);
  assert.deepEqual(res.failed, [{ id: 'BF-002', state: 'disabled', reason: 'timeout' }]);
  assert.deepEqual(res.unmatched, ['hover']);
  assert.deepEqual(item(res.report, 'BF-001').captured, {
    app: 'evidence/backfill/app/bulk-selected.png',
    computed: 'evidence/backfill/computed/bulk-selected.json',
    dom: 'evidence/backfill/dom/bulk-selected.json',
    motion: 'evidence/backfill/motion/bulk-selected.json',
  });
  assert.equal(item(res.report, 'BF-002').captured, null);

  const multi = mergeCandidates(openReport(), [{ state: 'bulk-selected', screen: 'cart' }, { state: 'bulk-selected', screen: 'orders' }]).report;
  const one = attachCaptures(multi, { states: { 'bulk-selected': { screenshot: 'app/bulk-selected.png' } } }, { prefix: 'evidence/screens/orders/backfill', screen: 'orders' });
  assert.deepEqual(one.attached, [{ id: 'BF-002', state: 'orders/bulk-selected' }]);
  assert.throws(() => attachCaptures(multi, { nope: 1 }), /not a capture\.json/);
});

test('decideItems: build / not-needed with a reason; unknown ids; built frames stay built', () => {
  const { report } = mergeCandidates(openReport(), candidates);
  assert.throws(() => decideItems(report, [{ id: 'BF-002', decision: 'not-needed', reason: '  ' }]), /a reason is required for not-needed/);
  assert.throws(() => decideItems(report, [{ id: 'BF-009', decision: 'build' }]), /unknown backfill id: BF-009 \(have: BF-001, BF-002\)/);
  assert.throws(() => decideItems(report, [{ id: 'BF-001', decision: 'ship' }]), /decision must be one of pending, build, not-needed/);
  assert.throws(() => decideItems(openReport(), [{ id: 'BF-001', decision: 'build' }]), /no backfill block yet/);
  const { report: next, changes } = decideItems(report, [
    { id: 'BF-001', decision: 'build', by: 'Dana', date: '2026-10-01T10:00:00Z' },
    { id: 'BF-002', decision: 'not needed', reason: 'Read-only mode is an admin tool, out of scope', by: null },
  ]);
  assert.deepEqual(changes.map((c) => [c.id, c.decision, c.previous]), [['BF-001', 'build', 'pending'], ['BF-002', 'not-needed', 'pending']]);
  assert.equal(item(next, 'BF-001').decidedBy, 'Dana');
  assert.equal(item(next, 'BF-001').decidedAt, '2026-10-01T10:00:00Z');
  assert.equal(item(next, 'BF-002').reason, 'Read-only mode is an admin tool, out of scope');
  assert.match(item(next, 'BF-002').decidedAt, /^\d{4}-\d{2}-\d{2}T/);
  const built = loadFixture('report-backfill.json');
  assert.throws(() => decideItems(built, [{ id: 'BF-002', decision: 'not-needed', reason: 'x' }]), /BF-002 is already built in Figma/);
});

test('gate: recordBuilt is refused until step 1 is closed, allowed after an override or when loopClosed', () => {
  const base = decideItems(mergeCandidates(openReport(), candidates).report, [{ id: 'BF-001', decision: 'build' }]).report;
  assert.equal(isBackfillReady(base), false);
  assert.deepEqual(gateStatus(base), { ready: false, loopClosed: false, open: 6, override: null });
  assert.throws(() => recordBuilt(base, 'BF-001', { figmaUrl: FIGMA }), (err) => err instanceof BackfillGateError && /production does not match the design yet \(6 open in step 1/.test(err.message));

  assert.throws(() => setOverride(base, { reason: ' ' }), /an override needs a reason/);
  const overridden = setOverride(base, { reason: 'Design review on Friday', by: 'Dana', date: '2026-10-01T09:00:00Z' }).report;
  assert.deepEqual(overridden.backfill.gate.override, { by: 'Dana', date: '2026-10-01T09:00:00Z', reason: 'Design review on Friday' });
  assert.equal(isBackfillReady(overridden), true);
  const { report: built } = recordBuilt(overridden, 'BF-001', { figmaUrl: FIGMA, roundTrip: 0.4, builtAt: '2026-10-02T09:00:00Z' });
  assert.deepEqual(item(built, 'BF-001').figma, {
    nodeId: '1:90',
    url: FIGMA,
    name: 'Items list – Bulk selected',
    builtAt: '2026-10-02T09:00:00Z',
    roundTrip: { percent: 0.4, band: 'pass' },
  });

  const closed = decideItems(mergeCandidates(closedReport(), candidates).report, [{ id: 'BF-002', decision: 'not-needed', reason: 'x' }]).report;
  assert.equal(isBackfillReady(closed), true);
  const viaClosed = recordBuilt(closed, 'BF-001', { figmaUrl: FIGMA, nodeId: '2-5', name: 'Items – Selection bar', roundTrip: 7, tolerances: { pass: 1, review: 5 } }).report;
  const f = item(viaClosed, 'BF-001');
  assert.equal(f.decision, 'build', 'a pending item becomes build when its frame is recorded');
  assert.deepEqual([f.figma.nodeId, f.figma.name, f.figma.roundTrip.band], ['2:5', 'Items – Selection bar', 'fail']);
  assert.throws(() => recordBuilt(closed, 'BF-002', { figmaUrl: FIGMA }), /BF-002 is decided not-needed/);
  assert.throws(() => recordBuilt(closed, 'BF-001', { figmaUrl: 'https://example.com/x' }), /must be a Figma link/);
  assert.throws(() => recordBuilt(closed, 'BF-001', { figmaUrl: 'https://www.figma.com/design/AbCdEf123456/Items' }), /has no node-id; pass --node-id/);
  assert.throws(() => recordBuilt(closed, 'BF-001', { figmaUrl: FIGMA, roundTrip: 120 }), /between 0 and 100/);
});

test('frameName: "<Screen> – <State>" from the screen, the anchor family or the feature', () => {
  const report = openReport();
  assert.equal(frameName({ label: 'Bulk selected', anchor: { nodeId: '1:2', name: 'Orders – With data' } }, report), 'Orders – Bulk selected');
  assert.equal(frameName({ label: 'Bulk selected', anchor: { nodeId: '1:2', name: 'Orders / With data' } }, report), 'Orders – Bulk selected');
  assert.equal(frameName({ label: 'Bulk selected' }, report), 'Items list – Bulk selected');
  const multi = loadFixture('report-multiscreen.json');
  const screen = multi.meta.screens[0];
  assert.equal(frameName({ label: 'Bulk selected', screen: screen.id }, multi), `${screen.name} – Bulk selected`);
});

test('chat message: parse (dash variants, notes, continuation lines, fences) and format round-trip', () => {
  const message = [
    '```',
    '/design-qa backfill ABC-12',
    'BF-001 build',
    'BF-002 build — use the new Banner',
    'BF-003 not-needed — transient toast,',
    'covered by the Toast spec',
    'BF-004 not needed: admin only',
    'by: Dana',
    '```',
  ].join('\n');
  const parsed = parseBackfillMessage(message);
  assert.equal(parsed.slug, 'ABC-12');
  assert.equal(parsed.decidedBy, 'Dana');
  assert.deepEqual(
    parsed.items.map((i) => [i.id, i.decision, i.reason]),
    [
      ['BF-001', 'build', ''],
      ['BF-002', 'build', 'use the new Banner'],
      ['BF-003', 'not-needed', 'transient toast, covered by the Toast spec'],
      ['BF-004', 'not-needed', 'admin only'],
    ],
  );
  const formatted = formatBackfillMessage({ slug: 'ABC-12', items: parsed.items, decidedBy: 'Dana' });
  assert.equal(
    formatted,
    '/design-qa backfill ABC-12\nBF-001 build\nBF-002 build — use the new Banner\nBF-003 not-needed — transient toast, covered by the Toast spec\nBF-004 not-needed — admin only\nby: Dana',
  );
  assert.deepEqual(parseBackfillMessage(formatted).items, parsed.items);
  assert.throws(() => parseBackfillMessage('/design-qa backfill x\nBF-001 maybe'), /expected "BF-001 build" or "BF-003 not-needed — <reason>"/);
  assert.throws(() => parseBackfillMessage('hello'), /starts with "\/design-qa backfill <slug>"/);
  assert.throws(() => parseBackfillMessage('/design-qa backfill x'), /no backfill decisions found/);
});

test('parseBackfillFile: the report.html export and the chat message', () => {
  const json = parseBackfillFile(
    JSON.stringify({
      feature: 'Items list',
      slug: 'ABC-12',
      reportGeneratedAt: '2026-09-23T10:00:00Z',
      decidedBy: 'Dana',
      items: [
        { id: 'bf-001', decision: 'build', reason: '', by: null, date: '2026-10-01T10:00:00Z' },
        { itemId: 'BF-003', decision: 'Not needed', reason: ' toast ', by: 'Lee', date: 'yesterday' },
      ],
    }),
  );
  assert.equal(json.format, 'json');
  assert.deepEqual(json.items, [
    { id: 'BF-001', decision: 'build', reason: '', by: null, date: '2026-10-01T10:00:00Z' },
    { id: 'BF-003', decision: 'not-needed', reason: 'toast', by: 'Lee', date: null },
  ]);
  assert.equal(parseBackfillFile('/design-qa backfill ABC-12\nBF-001 build').format, 'chat');
  assert.throws(() => parseBackfillFile('{"items":[]}'), /has no items/);
  assert.throws(() => parseBackfillFile('{"items":[{"id":"DQ-001","decision":"build"}]}'), /is not a backfill id/);
  assert.throws(() => parseBackfillFile('{"items":[{"id":"BF-001","decision":"pending"}]}'), /decision must be one of build, not-needed/);
});

test('backfill plan: status line, build list with the design-agent block, built, not needed, pending', () => {
  const report = loadFixture('report-backfill.json');
  const plan = renderBackfillPlan(report);
  const lines = plan.split('\n');
  assert.equal(lines[0], '# Design backfill — Items list');
  assert.equal(lines[2], 'Step 2 of 2 · Production matches the design: no (6 open) · Candidates 3 · build 1 · built 1 · not needed 1');
  assert.match(plan, /^Override: building before step 1 is closed — "Design review on Friday/m);
  assert.ok(!plan.includes('Blocked until step 1 is closed'), 'an override unblocks');
  const headings = lines.filter((l) => l.startsWith('#'));
  assert.deepEqual(headings, ['# Design backfill — Items list', '## Build in Figma (1)', '### Paste to your design agent', '## Built (1)', '## Not needed (1)', '## Pending decision (0)']);
  assert.match(plan, /^- BF-001 — Bulk selected — found by source: ItemsTable\.tsx:88 renders BulkBar when selection\.length > 0 — app capture evidence\/backfill\/app\/bulk-selected\.png — DS gaps: BulkBar component$/m);
  assert.ok(plan.includes(`\`\`\`text\n${designAgentIntro}\n\n[BF-001] Bulk selected\n`));
  assert.match(plan, /^- BF-002 — No search results — \[Items – No search results\]\(https:\/\/www\.figma\.com\/design\/AbCdEf123456\/Items\?node-id=1-77\) \(node 1:77\) — round trip 0\.6% \(pass\) — built 2026-09-23$/m);
  assert.match(plan, /^- BF-003 — Saved toast — "Transient toast; the Toast component spec in the library covers it\." — by Dana, 2026-09-23$/m);
  assert.match(plan, /## Pending decision \(0\)\n- None\n$/);

  const blocked = structuredClone(report);
  blocked.backfill.gate.override = null;
  blocked.backfill.items = blocked.backfill.items.filter((i) => !i.figma);
  const b = renderBackfillPlan(blocked);
  assert.match(b, /^Blocked until step 1 is closed \(parity pass\): fix or dismiss the open findings first, or record an override\.$/m);
  assert.ok(!b.includes('### Paste') || b.includes('## Build in Figma (1)'));

  const closed = closedReport();
  closed.backfill = { gate: { override: null }, items: [{ ...report.backfill.items[0], decision: 'pending', figma: null }] };
  const c = renderBackfillPlan(closed);
  assert.match(c, /Production matches the design: yes · Candidates 1 · build 0 · built 0 · not needed 0/);
  assert.ok(!c.includes('Blocked') && !c.includes('### Paste to your design agent'));
  assert.match(c, /## Pending decision \(1\)\n- BF-001 — Bulk selected — found by source: ItemsTable\.tsx:88/);

  assert.equal(renderBackfillPlan(openReport()), null);
  assert.equal(renderBackfillPlan({ ...openReport(), backfill: { gate: { override: null }, items: [] } }), null);
});

test('designAgentPrompt format (snapshot)', () => {
  const report = loadFixture('report-backfill.json');
  assert.equal(
    designAgentPrompt(report.backfill.items[0], report),
    [
      '[BF-001] Bulk selected',
      'Exists in: the app, not the design · found by: source — ItemsTable.tsx:88 renders BulkBar when selection.length > 0',
      'App capture: evidence/backfill/app/bulk-selected.png',
      'Place: next to "Items – With data" (1:2), named "Items – Bulk selected"',
      'Build with: Button (Secondary), Checkbox (Checked), BulkBar [not in library] · tokens color/surface/raised, space/4',
      'DS gaps: BulkBar component',
    ].join('\n'),
  );
  const bare = { id: 'BF-009', state: 'cart/x', screen: 'cart', label: 'X', discoveredBy: 'ticket', detail: null, captured: null, anchor: null, components: [], tokens: [], dsGaps: [] };
  const multi = loadFixture('report-multiscreen.json');
  const name = multi.meta.screens.find((s) => s.id === 'cart')?.name ?? 'cart';
  assert.equal(
    designAgentPrompt(bare, { ...multi, meta: { ...multi.meta, figma: { nodeId: '9:9' } } }),
    [
      `[BF-009] X (screen ${name})`,
      'Exists in: the app, not the design · found by: ticket — –',
      'App capture: –',
      `Place: next to the main design frame (9:9), named "${name} – X"`,
      'Build with: – · tokens –',
      'DS gaps: –',
    ].join('\n'),
  );
});

test('fix plan: one pointer line at the very end, only when there are backfill items', () => {
  const plain = renderFixplan(openReport());
  const withBackfill = renderFixplan(loadFixture('report-backfill.json'));
  assert.equal(withBackfill, `${plain}\nNext step — design backfill: 3 undesigned state(s) found; see report-backfill.md.\n`);
  assert.ok(!plain.includes('design backfill'));
  assert.equal(backfillPointer(openReport()), null);
});

test('render-report: --backfill-plan writes report-backfill.md; --embed-images inlines backfill captures', async () => {
  const dir = tmpDir();
  const report = loadFixture('report-backfill.json');
  assert.ok(collectImagePaths(report).includes('evidence/backfill/app/bulk-selected.png'));
  const file = path.join(dir, 'report.json');
  writeFileSync(file, JSON.stringify(report));
  writePng(path.join(dir, 'evidence/backfill/app/bulk-selected.png'), createPng(4, 4, [10, 20, 30, 255]));
  const plan = path.join(dir, 'report-backfill.md');
  const res = await run(RENDER, ['--in', file, '--template', TEMPLATE, '--out', path.join(dir, 'r.html'), '--backfill-plan', plan, '--embed-images']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Wrote design-backfill plan/);
  assert.equal(readFileSync(plan, 'utf8'), renderBackfillPlan(report));
  const html = readFileSync(path.join(dir, 'r.html'), 'utf8');
  assert.ok(html.includes('"evidence/backfill/app/bulk-selected.png":"data:image/png;base64,'), 'the backfill capture is embedded');

  const none = path.join(dir, 'none.md');
  const res2 = await run(RENDER, ['--in', fixture('report-valid.json'), '--template', TEMPLATE, '--out', path.join(dir, 'v.html'), '--backfill-plan', none]);
  assert.equal(res2.code, 0, res2.stderr);
  assert.match(res2.stdout, /No design-backfill items; .* not written/);
  assert.equal(existsSync(none), false);
});

test('CLI: --candidates, --add, --captured, --build, --not-needed; Next hint; the report re-renders and validates', async () => {
  const root = tmpDir();
  const file = place(root, openReport());
  const dir = path.dirname(file);
  const candFile = path.join(dir, 'backfill-candidates.json');
  writeFileSync(candFile, JSON.stringify({ generatedAt: '2026-10-01T00:00:00Z', surface: 'items', candidates }));

  const merged = await run(BACKFILL, ['--report', file, '--candidates', candFile]);
  assert.equal(merged.code, 0, merged.stderr);
  assert.match(merged.stdout, /^Added BF-001 bulk-selected \(source\) — ItemsTable\.tsx:88 renders BulkBar$/m);
  assert.match(merged.stderr, /warning: skipped empty: the design defines it/);
  assert.match(merged.stdout, /Backfill candidates: 2 added, 0 updated, 1 skipped/);
  assert.match(merged.stdout, /Capture them app-only: node scripts\/capture\.mjs .*bulk-selected, disabled.*--out .*evidence\/backfill/);
  assert.match(merged.stdout, /Next: node scripts\/render-report\.mjs --in .*report\.json --recompute --write-back --backfill-plan .*report-backfill\.md/);

  const added = await run(BACKFILL, ['--report', file, '--add', 'saved-toast', '--label', 'Saved toast', '--detail', 'useSave.ts:40 shows a toast', '--driver', '{"action":"click","selector":"button.save"}']);
  assert.equal(added.code, 0, added.stderr);
  assert.deepEqual(item(read(file), 'BF-003').driver, { action: 'click', selector: 'button.save' });

  const capDir = path.join(dir, 'evidence', 'backfill');
  mkdirSync(capDir, { recursive: true });
  writeFileSync(path.join(capDir, 'capture.json'), JSON.stringify({ states: { 'bulk-selected': { screenshot: 'app/bulk-selected.png', computed: 'computed/bulk-selected.json', dom: 'dom/bulk-selected.json', motion: 'motion/bulk-selected.json' } } }));
  const cap = await run(BACKFILL, ['--report', file, '--captured', path.join(capDir, 'capture.json')]);
  assert.equal(cap.code, 0, cap.stderr);
  assert.equal(item(read(file), 'BF-001').captured.app, 'evidence/backfill/app/bulk-selected.png');

  const build = await run(BACKFILL, ['--report', file, '--build', 'bf-001', '--by', 'Dana']);
  assert.equal(build.code, 0, build.stderr);
  const nn = await run(BACKFILL, ['--report', file, '--not-needed', 'BF-002,BF-003', '--reason', 'Admin-only and transient states', '--by', 'Dana']);
  assert.equal(nn.code, 0, nn.stderr);
  assert.match(nn.stdout, /Backfill: 3 candidate\(s\) · build 1 · built 0 · not needed 2 · pending 0 · ready no/);
  const after = read(file);
  assert.deepEqual(after.backfill.items.map((i) => [i.id, i.decision, i.decidedBy]), [['BF-001', 'build', 'Dana'], ['BF-002', 'not-needed', 'Dana'], ['BF-003', 'not-needed', 'Dana']]);
  assert.deepEqual(after.findings, openReport().findings, 'step 1 is untouched');
  assert.deepEqual(after.stateMatrix, openReport().stateMatrix);

  const plan = path.join(dir, 'report-backfill.md');
  const render = await run(RENDER, ['--in', file, '--template', TEMPLATE, '--out', path.join(dir, 'report.html'), '--recompute', '--write-back', '--backfill-plan', plan]);
  assert.equal(render.code, 0, render.stderr);
  const rendered = read(file);
  assert.deepEqual(rendered.scorecard.backfill, { candidates: 3, toBuild: 1, built: 0, notNeeded: 2, pending: 0, ready: false });
  assert.equal(rendered.scorecard.parity, openReport().scorecard.parity);
  assert.equal(rendered.scorecard.verdict, openReport().scorecard.verdict);
  assert.match(readFileSync(plan, 'utf8'), /Blocked until step 1 is closed/);
  const v = await run(VALIDATE, [file]);
  assert.equal(v.code, 0, v.stderr);
});

test('CLI gate: --record refused (exit 1) until ready; allowed after --override or when loopClosed', async () => {
  const root = tmpDir();
  const start = decideItems(mergeCandidates(openReport(), candidates).report, [{ id: 'BF-001', decision: 'build' }]).report;
  const file = place(root, start);

  const refused = await run(BACKFILL, ['--report', file, '--record', 'BF-001', '--figma-url', FIGMA]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /backfill\.mjs: error: cannot record BF-001: production does not match the design yet \(6 open in step 1/);
  assert.match(refused.stderr, /record an override: --override --reason "<why>"/);
  assert.equal(item(read(file), 'BF-001').figma, null, 'nothing written');

  assert.equal((await run(BACKFILL, ['--report', file, '--override'])).code, 2, 'an override needs a reason');
  const ov = await run(BACKFILL, ['--report', file, '--override', '--reason', 'Design review on Friday', '--by', 'Dana']);
  assert.equal(ov.code, 0, ov.stderr);
  assert.match(ov.stdout, /Override recorded — "Design review on Friday" — by Dana \(step 1 open: 6\)/);
  assert.match(ov.stdout, /ready yes/);

  const dry = await run(BACKFILL, ['--report', file, '--record', 'BF-001', '--figma-url', FIGMA, '--dry-run']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /\[dry run\] report\.json not written/);
  assert.equal(item(read(file), 'BF-001').figma, null);

  const rec = await run(BACKFILL, ['--report', file, '--record', 'BF-001', '--figma-url', FIGMA, '--round-trip', '2.5', '--config', fixture('config.json')]);
  assert.equal(rec.code, 0, rec.stderr);
  assert.match(rec.stdout, /Recorded BF-001 built in Figma: "Items list – Bulk selected" \(1:90\) .* round trip 2\.5% \(review\)/);
  const plan = path.join(path.dirname(file), 'report-backfill.md');
  const render = await run(RENDER, ['--in', file, '--template', TEMPLATE, '--out', path.join(path.dirname(file), 'r.html'), '--recompute', '--write-back', '--backfill-plan', plan, '--config', fixture('config.json')]);
  assert.equal(render.code, 0, render.stderr);
  assert.deepEqual(read(file).scorecard.backfill, { candidates: 2, toBuild: 0, built: 1, notNeeded: 0, pending: 1, ready: true });

  // Step 1 closed: no override needed.
  const closedFile = place(root, mergeCandidates(closedReport(), candidates).report, 'closed');
  const ok = await run(BACKFILL, ['--report', closedFile, '--record', 'BF-002', '--figma-url', FIGMA, '--node-id', '1:91', '--name', 'Items – Read only']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(item(read(closedFile), 'BF-002').figma.nodeId, '1:91');
  assert.equal(item(read(closedFile), 'BF-002').decision, 'build');
  const r2 = await run(RENDER, ['--in', closedFile, '--template', TEMPLATE, '--out', path.join(root, 'c.html'), '--recompute', '--write-back']);
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(read(closedFile).scorecard.backfill.ready, true);
  assert.equal(read(closedFile).scorecard.loopClosed, true);
});

test('CLI --from: backfill.json from report.html (with mismatch warnings) and the chat message', async () => {
  const root = tmpDir();
  const file = place(root, mergeCandidates(openReport(), candidates).report);
  const json = path.join(root, 'backfill.json');
  writeFileSync(
    json,
    JSON.stringify({
      feature: 'Items list',
      slug: 'OTHER-1',
      reportGeneratedAt: '2026-01-01T00:00:00Z',
      decidedBy: 'Dana',
      items: [{ id: 'BF-001', decision: 'build', reason: '', by: null, date: null }],
    }),
  );
  const fromJson = await run(BACKFILL, ['--report', file, '--from', json]);
  assert.equal(fromJson.code, 0, fromJson.stderr);
  assert.match(fromJson.stderr, /warning: backfill decisions are for "OTHER-1" but this report is "ABC-12"/);
  assert.match(fromJson.stderr, /warning: backfill decisions were made on the report generated 2026-01-01T00:00:00Z/);
  assert.equal(item(read(file), 'BF-001').decidedBy, 'Dana');

  const msg = path.join(root, 'message.txt');
  writeFileSync(msg, formatBackfillMessage({ slug: 'ABC-12', items: [{ id: 'BF-002', decision: 'not-needed', reason: 'Admin only' }], decidedBy: 'Lee' }));
  const fromChat = await run(BACKFILL, ['--report', file, '--from', msg]);
  assert.equal(fromChat.code, 0, fromChat.stderr);
  assert.equal(fromChat.stderr, '');
  assert.deepEqual([item(read(file), 'BF-002').decision, item(read(file), 'BF-002').reason, item(read(file), 'BF-002').decidedBy], ['not-needed', 'Admin only', 'Lee']);

  writeFileSync(msg, '/design-qa backfill ABC-12\nBF-001 not-needed\nby: Lee');
  const blank = await run(BACKFILL, ['--report', file, '--from', msg]);
  assert.equal(blank.code, 2);
  assert.match(blank.stderr, /a reason is required for every not-needed decision; missing for BF-001/);
});

test('CLI: bad arguments exit 2; unreadable or 1.x reports exit 1', async () => {
  const root = tmpDir();
  const file = place(root, mergeCandidates(openReport(), candidates).report);
  const cases = [
    [[], /--report <report\.json> is required/],
    [['--report', file], /choose exactly one of --candidates, --add, --captured, --build, --not-needed, --record, --override or --from/],
    [['--report', file, '--build', 'BF-001', '--not-needed', 'BF-002'], /choose exactly one/],
    [['--report', file, '--not-needed', 'BF-001'], /--reason is required with --not-needed/],
    [['--report', file, '--build', 'DQ-001'], /--build: not backfill ids: DQ-001/],
    [['--report', file, '--build', 'BF-042'], /unknown backfill id: BF-042/],
    [['--report', file, '--add', 'Bulk Selected', '--detail', 'x'], /--add must be a kebab-case state id/],
    [['--report', file, '--add', 'bulk-bar'], /--detail is required with --add/],
    [['--report', file, '--add', 'bulk-bar', '--detail', 'x', '--screen', 'cart'], /--screen "cart" is not in meta\.screens \(have: none/],
    [['--report', file, '--add', 'bulk-bar', '--detail', 'x', '--discovered-by', 'figma'], /--discovered-by must be one of config, source, ticket, capture/],
    [['--report', file, '--add', 'bulk-bar', '--detail', 'x', '--driver', '{nope'], /--driver: not valid JSON/],
    [['--report', file, '--build', 'BF-001', '--label', 'x'], /--label goes with --add/],
    [['--report', file, '--record', 'BF-001'], /--figma-url <url> is required with --record/],
    [['--report', file, '--candidates', path.join(root, 'missing.json')], /cannot read candidates file/],
    [['--report', file, '--build', 'BF-001', '--figma-url', FIGMA], /--figma-url goes with --record/],
  ];
  for (const [args, pattern] of cases) {
    const res = await run(BACKFILL, args);
    assert.equal(res.code, 2, `${args.join(' ')} → ${res.code}\n${res.stderr}`);
    assert.match(res.stderr, pattern);
  }
  const old = place(root, { ...openReport(), schemaVersion: '1.1' }, 'old');
  const res = await run(BACKFILL, ['--report', old, '--build', 'BF-001']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /schemaVersion 2\.0 required/);
  assert.equal((await run(BACKFILL, ['--report', path.join(root, 'nope.json'), '--build', 'BF-001'])).code, 1);
  const help = await run(BACKFILL, ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Design backfill \(step 2\)/);
});

test('backfillSummary and validation of the fixture: the backfill stays beside step 1', () => {
  const report = loadFixture('report-backfill.json');
  assert.deepEqual(validateReport(report).errors, []);
  assert.deepEqual(backfillSummary(report), { candidates: 3, toBuild: 1, built: 1, notNeeded: 1, pending: 0, ready: true });
  const plain = loadFixture('report-valid.json');
  const { backfill, ...sc } = report.scorecard;
  assert.ok(backfill);
  assert.deepEqual(sc, plain.scorecard, 'every step-1 value is the same with and without the backfill');
});
