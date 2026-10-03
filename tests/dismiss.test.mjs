import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  applyDismissal,
  applyPriorDismissals,
  fingerprint,
  formatChatDismissMessage,
  parseChatDismissMessage,
  parseDismissalsFile,
  renderDismissedMarkdown,
  undoDismissal,
  upsertLogEntries,
} from '../skills/design-qa/scripts/lib/dismissals.mjs';
import { fixture, run, script, tmpDir } from './_helpers.mjs';

const DISMISS = script('dismiss.mjs');
const VALIDATE = script('validate.mjs');
const GENERATED_AT = '2026-10-01T09:00:00Z';

function finding(id, severity, resolution, extra = {}) {
  return {
    id,
    title: `Finding ${id}`,
    ledger: 'style',
    state: 'with-data',
    severity,
    resolution,
    region: 'List',
    element: { selector: null, figmaLayerPath: null, figmaNodeId: null },
    property: null,
    expected: { value: null, token: null, source: 'figma' },
    actual: { value: null, token: null, source: { file: null, line: null, snippet: null } },
    delta: null,
    tolerance: null,
    fix: null,
    evidence: [],
    rank: null,
    signoff: null,
    knownDrift: null,
    acRef: null,
    ...extra,
  };
}

/** A minimal schemaVersion 2.0 report (built inline: the shared fixture is mid-migration). */
function makeReport({ feature = 'Items list', key = 'ABC-12', generatedAt = GENERATED_AT } = {}) {
  const findings = [
    finding('DQ-001', 'BLOCKER', 'FIX_CODE', {
      title: 'Empty state message is missing',
      ledger: 'structure',
      state: 'empty',
      element: { selector: 'main .empty', figmaLayerPath: 'Items / Empty/Message', figmaNodeId: '1:41' },
      expected: { value: '"No items yet" message', token: null, source: 'figma' },
      actual: { value: 'blank area', token: null, source: { file: 'src/Items.tsx', line: 42, snippet: null } },
    }),
    finding('DQ-002', 'WARNING', 'FIX_CODE', {
      title: 'Row title is 14px instead of 16px',
      element: { selector: '.row  .Title', figmaLayerPath: 'Row/Title', figmaNodeId: '1:7' },
      property: 'font-size',
      expected: { value: '16px', token: 'font.size.md', source: 'figma' },
      actual: { value: '14px', token: null, source: { file: 'src/Row.css', line: 4, snippet: null } },
    }),
    finding('DQ-003', 'WARNING', 'UNCLASSIFIED', {
      title: 'Hover fade is missing',
      ledger: 'motion',
      state: 'hover',
      element: { selector: '.row', figmaLayerPath: 'Row', figmaNodeId: '1:5' },
      property: 'transition-duration',
      expected: { value: '200ms ease-out on opacity', token: null, source: 'figma' },
      actual: { value: 'none', token: null, source: { file: null, line: null, snippet: null } },
    }),
    finding('DQ-004', 'DS_CANDIDATE', 'FIX_CODE', {
      title: 'Hard-coded grey could be a token',
      element: { selector: '.row .meta', figmaLayerPath: 'Row/Meta', figmaNodeId: '1:9' },
      property: 'color',
      expected: { value: '#6B7280', token: 'color.text.muted', source: 'figma' },
      actual: { value: '#6B7280', token: null, source: { file: 'src/Row.css', line: 12, snippet: null } },
    }),
    finding('DQ-005', 'PASS', 'NONE', { title: 'Row height matches' }),
    finding('DQ-006', 'WARNING', 'INTENTIONAL', {
      title: 'Sticky header',
      element: { selector: 'header', figmaLayerPath: null, figmaNodeId: null },
      signoff: { by: 'design lead', date: '2026-09-20T00:00:00Z', reason: 'Sticky header approved' },
    }),
  ];
  return {
    schemaVersion: '2.0',
    meta: {
      feature,
      generatedAt,
      skillVersion: '0.2.0',
      mode: 'audit',
      ticket: key ? { provider: 'jira', key, url: `https://example.atlassian.net/browse/${key}`, title: feature } : null,
      source: { kind: 'figma', url: 'https://www.figma.com/design/AbC/Items?node-id=1-2', label: null, tool: null, frame: { width: 1440, height: 900 } },
    },
    scorecard: {},
    triage: {
      decidedBy: 'Dana',
      decidedAt: '2026-10-01T08:00:00Z',
      source: 'cli',
      items: [
        { findingId: 'DQ-001', decision: 'fix-now', reason: null, ticket: null },
        { findingId: 'DQ-002', decision: 'fix-now', reason: null, ticket: null },
        { findingId: 'DQ-004', decision: 'debt', reason: null, ticket: null },
      ],
    },
    stateMatrix: [],
    findings,
    ledgers: { structure: [], component: [], style: [], state: [], behavior: [], motion: [] },
    openDecisions: [],
    fixLoop: null,
    evidence: {},
  };
}

/** Write a report to <root>/qa-reports/<slug>/report.json like the skill does. */
function place(root, report, slug = 'ABC-12') {
  const dir = path.join(root, 'qa-reports', slug);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'report.json');
  writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const byId = (report, id) => report.findings.find((f) => f.id === id);
const triageIds = (report) => report.triage.items.map((i) => i.findingId);

test('fingerprint: ledger|state|selector|property, lower-cased and whitespace-collapsed, with fallbacks', () => {
  const r = makeReport();
  assert.equal(fingerprint(byId(r, 'DQ-002')), 'style|with-data|.row .title|font-size');
  assert.equal(fingerprint(byId(r, 'DQ-001')), 'structure|empty|main .empty|');
  assert.equal(fingerprint({ ledger: 'style', state: 's', element: { selector: null, figmaLayerPath: 'Row / Meta' }, property: 'Color' }), 'style|s|row / meta|color');
  assert.equal(fingerprint({ ledger: 'style', state: 's', element: {}, region: 'Main   Content', property: null }), 'style|s|main content|');
});

test('applyDismissal: DISMISSED with dismissal, rank none, out of triage; the input is untouched', () => {
  const r = makeReport();
  const { report: next, finding: f } = applyDismissal(r, 'DQ-002', {
    kind: 'Not an issue',
    reason: '  1px anti-aliasing  ',
    by: 'Maya',
    date: '2026-10-01T10:00:00Z',
    source: 'report-ui',
  });
  assert.equal(f.resolution, 'DISMISSED');
  assert.deepEqual(f.dismissal, { kind: 'not-an-issue', reason: '1px anti-aliasing', by: 'Maya', date: '2026-10-01T10:00:00Z', source: 'report-ui', priorRef: null });
  assert.equal(f.severity, 'WARNING', 'severity stays');
  assert.equal(f.signoff, null);
  assert.deepEqual(f.rank, { score: 0, bucket: 'none' });
  assert.deepEqual(triageIds(next), ['DQ-001', 'DQ-004']);
  assert.equal(byId(r, 'DQ-002').resolution, 'FIX_CODE', 'pure: the input report is not mutated');
  assert.equal(r.triage.items.length, 3);

  const { finding: ok } = applyDismissal(r, 'DQ-004', { kind: 'intentional', reason: 'Approved grey', by: 'Lee', date: '2026-10-01T10:00:00Z' });
  assert.equal(ok.resolution, 'INTENTIONAL');
  assert.deepEqual(ok.signoff, { by: 'Lee', date: '2026-10-01T10:00:00Z', reason: 'Approved grey' });
  assert.equal('dismissal' in ok, false);

  const { finding: removed } = applyDismissal(r, 'DQ-003', { kind: 'remove', reason: 'Duplicate of DQ-002' });
  assert.equal(removed.dismissal.kind, 'remove');
  assert.equal(removed.dismissal.source, 'cli');
  assert.ok(!Number.isNaN(Date.parse(removed.dismissal.date)));

  assert.throws(() => applyDismissal(r, 'DQ-002', { kind: 'remove', reason: '   ' }), /a reason is required/);
  assert.throws(() => applyDismissal(r, 'DQ-002', { kind: 'ignore', reason: 'x' }), /kind must be one of/);
  assert.throws(() => applyDismissal(r, 'DQ-005', { kind: 'remove', reason: 'x' }), /DQ-005 is PASS: only BLOCKER, WARNING and DS_CANDIDATE/);
  assert.throws(() => applyDismissal(r, 'DQ-099', { kind: 'remove', reason: 'x' }), /unknown finding id: DQ-099/);
});

test('undoDismissal: back to FIX_CODE, dismissal and signoff removed, rank cleared, back in triage', () => {
  const { report: dismissed } = applyDismissal(makeReport(), 'DQ-002', { kind: 'remove', reason: 'Out of scope' });
  const { report: next, finding: f } = undoDismissal(dismissed, 'DQ-002');
  assert.equal(f.resolution, 'FIX_CODE');
  assert.equal('dismissal' in f, false);
  assert.equal(f.signoff, null);
  assert.equal(f.rank, null);
  assert.deepEqual(triageIds(next), ['DQ-001', 'DQ-002', 'DQ-004']);
  assert.equal(next.triage.items[1].decision, 'fix-now');

  const { finding: intentional } = undoDismissal(makeReport(), 'DQ-006');
  assert.equal(intentional.resolution, 'FIX_CODE');
  assert.equal(intentional.signoff, null);
  assert.throws(() => undoDismissal(makeReport(), 'DQ-001'), /DQ-001 is FIX_CODE, not dismissed/);
});

test('chat message: parse (dash variants, continuation lines, fences) and format round-trip', () => {
  const message = [
    '```',
    '/design-qa dismiss ABC-12',
    'DQ-004 not-an-issue — 1px anti-aliasing,',
    'not visible at 100%',
    'DQ-007 remove – duplicate of DQ-004',
    'dq-009 Intentional - approved by Lee',
    'DQ-010 not an issue: rendering noise',
    'by: Maya',
    '```',
  ].join('\n');
  const parsed = parseChatDismissMessage(message);
  assert.equal(parsed.slug, 'ABC-12');
  assert.equal(parsed.decidedBy, 'Maya');
  assert.deepEqual(
    parsed.items.map((i) => [i.findingId, i.kind, i.reason]),
    [
      ['DQ-004', 'not-an-issue', '1px anti-aliasing, not visible at 100%'],
      ['DQ-007', 'remove', 'duplicate of DQ-004'],
      ['DQ-009', 'intentional', 'approved by Lee'],
      ['DQ-010', 'not-an-issue', 'rendering noise'],
    ],
  );
  const text = formatChatDismissMessage({ slug: 'ABC-12', decidedBy: 'Maya', items: parsed.items });
  assert.equal(
    text,
    [
      '/design-qa dismiss ABC-12',
      'DQ-004 not-an-issue — 1px anti-aliasing, not visible at 100%',
      'DQ-007 remove — duplicate of DQ-004',
      'DQ-009 intentional — approved by Lee',
      'DQ-010 not-an-issue — rendering noise',
      'by: Maya',
    ].join('\n'),
  );
  assert.deepEqual(parseChatDismissMessage(text).items, parsed.items);
  assert.equal(parseChatDismissMessage('/design-qa dismiss X\nDQ-001 remove —').items[0].reason, '', 'a blank reason parses; the CLI rejects it');
  assert.throws(() => parseChatDismissMessage('/design-qa dismiss X\nDQ-001 ignore — meh'), /cannot read "DQ-001 ignore — meh"/);
  assert.throws(() => parseChatDismissMessage('/design-qa dismiss X\nby: me'), /no dismissals found/);
  assert.throws(() => parseChatDismissMessage('hello\nDQ-001 remove — x'), /starts with "\/design-qa dismiss <slug>"/);
});

test('parseDismissalsFile: the report.html export and the chat message', () => {
  const json = parseDismissalsFile(readFileSync(fixture('dismissals.json'), 'utf8'));
  assert.equal(json.format, 'json');
  assert.deepEqual([json.feature, json.slug, json.reportGeneratedAt, json.decidedBy], ['Items list', 'ABC-12', GENERATED_AT, 'Maya']);
  assert.deepEqual(json.items[1], {
    findingId: 'DQ-003',
    kind: 'remove',
    reason: 'Hover motion belongs to the shared Row component, audited separately',
    by: 'Dana',
    date: '2026-10-01T10:16:00Z',
  });
  const chat = parseDismissalsFile('/design-qa dismiss ABC-12\nDQ-002 remove — dup');
  assert.equal(chat.format, 'chat');
  assert.throws(() => parseDismissalsFile('{"items": []}'), /has no items/);
  assert.throws(() => parseDismissalsFile('{"items": [{"findingId": "row-1", "kind": "remove"}]}'), /not a finding id/);
  assert.throws(() => parseDismissalsFile('{"items": [{"findingId": "DQ-001", "kind": "maybe"}]}'), /kind must be one of/);
  assert.throws(() => parseDismissalsFile('{ nope'), /not valid JSON/);
});

test('upsertLogEntries: stable DS ids keyed by feature + fingerprint, undo, re-dismiss reactivates', () => {
  let r = makeReport();
  ({ report: r } = applyDismissal(r, 'DQ-002', { kind: 'not-an-issue', reason: 'noise', by: 'Maya', date: '2026-10-01T10:00:00Z', source: 'chat' }));
  ({ report: r } = applyDismissal(r, 'DQ-004', { kind: 'intentional', reason: 'approved', by: 'Lee', date: '2026-10-01T10:00:00Z' }));
  const first = upsertLogEntries(null, r, [
    { findingId: 'DQ-002', action: 'dismiss', source: 'chat' },
    { findingId: 'DQ-004', action: 'dismiss', source: 'cli' },
  ], { now: '2026-10-01T10:00:00Z' });
  assert.deepEqual(first.stats, { added: 2, updated: 0, undone: 0 });
  assert.deepEqual(first.log.entries[0], {
    id: 'DS-0001',
    feature: 'Items list',
    slug: 'ABC-12',
    findingId: 'DQ-002',
    title: 'Row title is 14px instead of 16px',
    fingerprint: 'style|with-data|.row .title|font-size',
    ledger: 'style',
    state: 'with-data',
    selector: '.row  .Title',
    figmaLayerPath: 'Row/Title',
    property: 'font-size',
    expectedValue: '16px',
    actualValue: '14px',
    kind: 'not-an-issue',
    reason: 'noise',
    by: 'Maya',
    date: '2026-10-01T10:00:00Z',
    source: 'chat',
    status: 'active',
  });
  assert.deepEqual([first.log.entries[1].id, first.log.entries[1].kind, first.log.entries[1].source], ['DS-0002', 'intentional', 'cli']);

  const { report: undone } = undoDismissal(r, 'DQ-002');
  const second = upsertLogEntries(first.log, undone, [{ findingId: 'DQ-002', action: 'undo' }], { now: '2026-10-02T00:00:00Z' });
  assert.deepEqual(second.stats, { added: 0, updated: 0, undone: 1 });
  assert.equal(second.log.entries[0].status, 'undone');
  assert.equal(second.log.entries[0].undoneAt, '2026-10-02T00:00:00Z');

  const { report: again } = applyDismissal(undone, 'DQ-002', { kind: 'remove', reason: 'out of scope', by: 'Maya' });
  const third = upsertLogEntries(second.log, again, [{ findingId: 'DQ-002', action: 'dismiss', source: 'cli' }]);
  assert.deepEqual(third.stats, { added: 0, updated: 1, undone: 0 });
  assert.equal(third.log.entries.length, 2);
  assert.deepEqual([third.log.entries[0].id, third.log.entries[0].status, third.log.entries[0].kind], ['DS-0001', 'active', 'remove']);
  assert.equal('undoneAt' in third.log.entries[0], false);

  const other = makeReport({ feature: 'Checkout', key: 'ABC-30' });
  const { report: o } = applyDismissal(other, 'DQ-002', { kind: 'remove', reason: 'x' });
  const fourth = upsertLogEntries(third.log, o, [{ findingId: 'DQ-002', action: 'dismiss' }]);
  assert.equal(fourth.log.entries[2].id, 'DS-0003', 'same fingerprint, other feature: a new entry');

  const md = renderDismissedMarkdown(fourth.log);
  assert.match(md, /^# Dismissed findings\n/);
  assert.match(md, /active 3 · undone 0/);
  assert.match(md, /## Checkout \(ABC-30\)\n\n\| ID \| Finding \| Kind \| Reason \| By \| Date \| Status \|/);
  assert.match(md, /## Items list \(ABC-12\)/);
  assert.ok(md.indexOf('## Checkout') < md.indexOf('## Items list'), 'features sorted by name');
  assert.match(md, /\| DS-0002 \| DQ-004 — Hard-coded grey could be a token \| intentional \| approved \| Lee \| 2026-10-01 \| active \|/);
  assert.match(renderDismissedMarkdown(second.log), /\| DS-0001 \| .* \| undone 2026-10-02 \|/);
});

test('applyPriorDismissals: unchanged matches are re-dismissed (prior-pass), changed values stay open', () => {
  let prev = makeReport();
  ({ report: prev } = applyDismissal(prev, 'DQ-002', { kind: 'not-an-issue', reason: 'noise', by: 'Maya', date: '2026-10-01T10:00:00Z' }));
  ({ report: prev } = applyDismissal(prev, 'DQ-003', { kind: 'remove', reason: 'shared component', by: 'Dana', date: '2026-10-01T10:00:00Z' }));
  ({ report: prev } = applyDismissal(prev, 'DQ-004', { kind: 'intentional', reason: 'approved', by: 'Lee', date: '2026-10-01T10:00:00Z' }));
  ({ report: prev } = applyDismissal(prev, 'DQ-001', { kind: 'remove', reason: 'later undone' }));
  let { log } = upsertLogEntries(null, prev, ['DQ-002', 'DQ-003', 'DQ-004', 'DQ-001'].map((findingId) => ({ findingId, action: 'dismiss' })));
  ({ log } = upsertLogEntries(log, undoDismissal(prev, 'DQ-001').report, [{ findingId: 'DQ-001', action: 'undo' }]));

  // The next pass renumbers the findings; DQ-003's motion values changed.
  const pass2 = makeReport({ generatedAt: '2026-10-05T09:00:00Z' });
  const renumber = { 'DQ-002': 'DQ-012', 'DQ-003': 'DQ-013', 'DQ-004': 'DQ-014' };
  for (const f of pass2.findings) f.id = renumber[f.id] ?? f.id;
  pass2.triage.items = pass2.triage.items.map((i) => ({ ...i, findingId: renumber[i.findingId] ?? i.findingId }));
  byId(pass2, 'DQ-013').actual.value = '400ms linear on opacity';

  const { report: next, applied, changed } = applyPriorDismissals(pass2, log);
  assert.deepEqual(applied, [
    { findingId: 'DQ-012', entryId: 'DS-0001', kind: 'not-an-issue' },
    { findingId: 'DQ-014', entryId: 'DS-0003', kind: 'intentional' },
  ]);
  assert.deepEqual(changed, [
    {
      findingId: 'DQ-013',
      entryId: 'DS-0002',
      kind: 'remove',
      was: { expectedValue: '200ms ease-out on opacity', actualValue: 'none' },
      now: { expectedValue: '200ms ease-out on opacity', actualValue: '400ms linear on opacity' },
    },
  ]);
  assert.deepEqual(byId(next, 'DQ-012').dismissal, {
    kind: 'not-an-issue',
    reason: 'noise',
    by: 'Maya',
    date: '2026-10-01T10:00:00Z',
    source: 'prior-pass',
    priorRef: 'DS-0001',
  });
  assert.deepEqual(byId(next, 'DQ-014').signoff, { by: 'Lee', date: '2026-10-01T10:00:00Z', reason: 'approved' });
  assert.equal(byId(next, 'DQ-013').resolution, 'UNCLASSIFIED');
  assert.equal(byId(next, 'DQ-001').resolution, 'FIX_CODE', 'undone entries are not re-applied');
  assert.deepEqual(triageIds(next), ['DQ-001']);

  const elsewhere = applyPriorDismissals(makeReport({ feature: 'Checkout' }), log);
  assert.equal(elsewhere.applied.length + elsewhere.changed.length, 0, 'only entries of the same feature apply');
  assert.deepEqual(applyPriorDismissals(pass2, null).applied, []);
});

test('CLI --id: dismisses, writes the report and qa-reports/dismissed.{json,md}, hints the re-render', async () => {
  const root = tmpDir();
  const file = place(root, makeReport());
  const res = await run(DISMISS, ['--report', file, '--id', 'dq-002', '--kind', 'not-an-issue', '--reason', '1px anti-aliasing', '--by', 'Maya']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Dismissed DQ-002 not-an-issue — "1px anti-aliasing"/);
  assert.match(res.stdout, /Dismissed log: 1 added, 0 updated, 0 undone/);
  assert.match(res.stdout, /Next: node scripts\/render-report\.mjs --in .*report\.json --recompute --write-back/);
  const r = read(file);
  const f = byId(r, 'DQ-002');
  assert.equal(f.resolution, 'DISMISSED');
  assert.deepEqual({ ...f.dismissal, date: null }, { kind: 'not-an-issue', reason: '1px anti-aliasing', by: 'Maya', date: null, source: 'cli', priorRef: null });
  assert.deepEqual(f.rank, { score: 0, bucket: 'none' });
  assert.deepEqual(triageIds(r), ['DQ-001', 'DQ-004']);
  assert.deepEqual(r.scorecard, {}, 'the scorecard is left for render-report --recompute');
  const log = read(path.join(root, 'qa-reports', 'dismissed.json'));
  assert.deepEqual(log.entries.map((e) => [e.id, e.findingId, e.status]), [['DS-0001', 'DQ-002', 'active']]);
  assert.match(readFileSync(path.join(root, 'qa-reports', 'dismissed.md'), 'utf8'), /\| DS-0001 \| DQ-002 — Row title is 14px instead of 16px \| not-an-issue \| 1px anti-aliasing \| Maya \|/);

  const intentional = await run(DISMISS, ['--report', file, '--id', 'DQ-004', '--kind', 'intentional', '--reason', 'Approved', '--by', 'Lee', '--quiet']);
  assert.equal(intentional.code, 0, intentional.stderr);
  assert.equal(intentional.stdout, '');
  const r2 = read(file);
  assert.equal(byId(r2, 'DQ-004').resolution, 'INTENTIONAL');
  assert.equal(byId(r2, 'DQ-004').signoff.by, 'Lee');
  assert.deepEqual(read(path.join(root, 'qa-reports', 'dismissed.json')).entries.map((e) => e.id), ['DS-0001', 'DS-0002']);
});

test('CLI: a reason is mandatory; bad ids, kinds, severities and modes exit 2; a 1.x report exits 1', async () => {
  const root = tmpDir();
  const file = place(root, makeReport());
  const before = readFileSync(file, 'utf8');
  const missing = await run(DISMISS, ['--report', file, '--id', 'DQ-002', '--kind', 'remove']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /--reason is required: say why DQ-002 should be removed from this QA/);
  const blank = await run(DISMISS, ['--report', file, '--id', 'DQ-002', '--kind', 'not-an-issue', '--reason', '   ']);
  assert.equal(blank.code, 2);
  assert.match(blank.stderr, /--reason is required: say why DQ-002 is not an issue/);
  assert.equal((await run(DISMISS, ['--report', file, '--id', 'DQ-002', '--reason', 'x'])).code, 2, '--kind is required');
  assert.equal((await run(DISMISS, ['--report', file, '--id', 'DQ-002', '--kind', 'ignore', '--reason', 'x'])).code, 2);
  const pass = await run(DISMISS, ['--report', file, '--id', 'DQ-005', '--kind', 'remove', '--reason', 'x']);
  assert.equal(pass.code, 2);
  assert.match(pass.stderr, /DQ-005 is PASS: only BLOCKER, WARNING and DS_CANDIDATE/);
  const unknown = await run(DISMISS, ['--report', file, '--id', 'DQ-002,DQ-777', '--kind', 'remove', '--reason', 'x']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown finding id\(s\): DQ-777/);
  assert.equal((await run(DISMISS, ['--report', file, '--id', 'row-2', '--kind', 'remove', '--reason', 'x'])).code, 2);
  assert.equal((await run(DISMISS, ['--report', file])).code, 2, 'a mode is required');
  assert.equal((await run(DISMISS, ['--report', file, '--undo', 'DQ-002', '--apply-log'])).code, 2, 'only one mode');
  assert.equal((await run(DISMISS, ['--report', file, '--apply-log', '--reason', 'x'])).code, 2, '--reason only with --id');
  assert.equal((await run(DISMISS, ['--report', file, '--id', 'DQ-002', '--kind', 'remove', '--reason', 'x', '--source', 'prior-pass'])).code, 2);
  assert.equal((await run(DISMISS, ['--id', 'DQ-002', '--kind', 'remove', '--reason', 'x'])).code, 2, '--report is required');
  const notDismissed = await run(DISMISS, ['--report', file, '--undo', 'DQ-001']);
  assert.equal(notDismissed.code, 2);
  assert.match(notDismissed.stderr, /DQ-001 is FIX_CODE, not dismissed/);
  assert.equal(readFileSync(file, 'utf8'), before, 'nothing written on errors');
  assert.equal(existsSync(path.join(root, 'qa-reports', 'dismissed.json')), false);

  const old = makeReport();
  old.schemaVersion = '1.1';
  const v1 = await run(DISMISS, ['--report', place(tmpDir(), old), '--id', 'DQ-002', '--kind', 'remove', '--reason', 'x']);
  assert.equal(v1.code, 1);
  assert.match(v1.stderr, /schemaVersion 2\.0 required \(got "1\.1"\); 1\.x reports: re-run the pass/);
});

test('CLI --from: dismissals.json from report.html (with mismatch warnings) and the chat message', async () => {
  const root = tmpDir();
  const file = place(root, makeReport({ generatedAt: '2026-10-02T09:00:00Z' }));
  const res = await run(DISMISS, ['--report', file, '--from', fixture('dismissals.json')]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /warning: dismissals were made on the report generated 2026-10-01T09:00:00Z; this report was generated 2026-10-02T09:00:00Z/);
  assert.doesNotMatch(res.stderr, /dismissals are for/);
  assert.match(res.stdout, /Dismissed log: 3 added/);
  const r = read(file);
  assert.deepEqual(byId(r, 'DQ-002').dismissal, {
    kind: 'not-an-issue',
    reason: '1px anti-aliasing difference, not visible at 100%',
    by: 'Maya',
    date: '2026-10-01T10:15:00Z',
    source: 'report-ui',
    priorRef: null,
  });
  assert.equal(byId(r, 'DQ-003').dismissal.by, 'Dana', "an item's own by wins over decidedBy");
  assert.deepEqual(byId(r, 'DQ-004').signoff, { by: 'Maya', date: '2026-10-01T10:17:00Z', reason: 'Muted grey approved for the meta line until the token sweep' });
  assert.deepEqual(triageIds(r), ['DQ-001']);

  const chatRoot = tmpDir();
  const chatFile = place(chatRoot, makeReport());
  const message = path.join(chatRoot, 'message.txt');
  writeFileSync(message, '/design-qa dismiss OTHER-9\nDQ-001 remove — tracked in ABC-40 instead\nby: Sam\n');
  const chat = await run(DISMISS, ['--report', chatFile, '--from', message]);
  assert.equal(chat.code, 0, chat.stderr);
  assert.match(chat.stderr, /dismissals are for "OTHER-9" but this report is "ABC-12"/);
  assert.deepEqual(
    (({ kind, by, source }) => ({ kind, by, source }))(byId(read(chatFile), 'DQ-001').dismissal),
    { kind: 'remove', by: 'Sam', source: 'chat' },
  );

  writeFileSync(message, '/design-qa dismiss ABC-12\nDQ-002 remove —\nDQ-004 not-an-issue — fine\n');
  const noReason = await run(DISMISS, ['--report', chatFile, '--from', message]);
  assert.equal(noReason.code, 2);
  assert.match(noReason.stderr, /a reason is required for every dismissal; missing for DQ-002/);
  assert.equal(byId(read(chatFile), 'DQ-004').resolution, 'FIX_CODE', 'all or nothing');
  assert.equal((await run(DISMISS, ['--report', chatFile, '--from', path.join(chatRoot, 'nope.json')])).code, 2);
});

test('CLI --undo, --apply-log on the next pass, --dry-run and custom log paths', async () => {
  const root = tmpDir();
  const file = place(root, makeReport());
  assert.equal((await run(DISMISS, ['--report', file, '--from', fixture('dismissals.json'), '--quiet'])).code, 0);
  const undo = await run(DISMISS, ['--report', file, '--undo', 'DQ-003']);
  assert.equal(undo.code, 0, undo.stderr);
  assert.match(undo.stdout, /Undone DQ-003: back to FIX_CODE/);
  assert.match(undo.stdout, /0 added, 0 updated, 1 undone/);
  assert.equal(byId(read(file), 'DQ-003').resolution, 'FIX_CODE');
  const logFile = path.join(root, 'qa-reports', 'dismissed.json');
  assert.deepEqual(read(logFile).entries.map((e) => [e.id, e.status]), [['DS-0001', 'active'], ['DS-0002', 'undone'], ['DS-0003', 'active']]);

  // Next pass: fresh report, same findings; DQ-004's actual value changed.
  const pass2 = makeReport({ generatedAt: '2026-10-05T09:00:00Z' });
  byId(pass2, 'DQ-004').actual.value = '#6B7281';
  place(root, pass2);
  const dry = await run(DISMISS, ['--report', file, '--apply-log', '--dry-run']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /\[dry run\]/);
  assert.equal(byId(read(file), 'DQ-002').resolution, 'FIX_CODE', 'dry run writes nothing');
  const logBefore = readFileSync(logFile, 'utf8');
  const applied = await run(DISMISS, ['--report', file, '--apply-log']);
  assert.equal(applied.code, 0, applied.stderr);
  assert.match(applied.stdout, /DQ-002 not-an-issue \(DS-0001\) — "1px anti-aliasing difference, not visible at 100%"/);
  assert.match(applied.stdout, /notice: DQ-004 matches DS-0003 \(intentional\) but its values changed — expected "#6B7280" → "#6B7280", actual "#6B7280" → "#6B7281"; left open/);
  assert.match(applied.stdout, /re-applied 1, changed 1 \(left open\)/);
  const r = read(file);
  assert.equal(byId(r, 'DQ-002').dismissal.source, 'prior-pass');
  assert.equal(byId(r, 'DQ-002').dismissal.priorRef, 'DS-0001');
  assert.equal(byId(r, 'DQ-003').resolution, 'UNCLASSIFIED', 'an undone entry is not re-applied');
  assert.equal(byId(r, 'DQ-004').resolution, 'FIX_CODE');
  assert.equal(readFileSync(logFile, 'utf8'), logBefore, '--apply-log leaves the log alone');

  const custom = path.join(root, 'docs', 'qa-dismissed.json');
  const res = await run(DISMISS, ['--report', file, '--id', 'DQ-001', '--kind', 'remove', '--reason', 'Covered by ABC-40', '--log', custom, '--quiet']);
  assert.equal(res.code, 0, res.stderr);
  assert.ok(existsSync(path.join(root, 'docs', 'qa-dismissed.md')), '--log alone puts the Markdown next to it');
  const mdOnly = path.join(root, 'notes', 'dismissed-log.md');
  assert.equal((await run(DISMISS, ['--report', file, '--undo', 'DQ-001', '--md', mdOnly, '--quiet'])).code, 0);
  assert.ok(existsSync(path.join(root, 'notes', 'dismissed-log.json')), '--md alone puts the JSON next to it');
});

test('a dismissed report re-renders and validates', async () => {
  const root = tmpDir();
  const report = JSON.parse(readFileSync(fixture('report-valid.json'), 'utf8'));
  const target = report.findings.find((f) => ['BLOCKER', 'WARNING', 'DS_CANDIDATE'].includes(f.severity) && ['FIX_CODE', 'UNCLASSIFIED'].includes(f.resolution));
  const before = report.findings.filter((f) => f.resolution === 'DISMISSED').length;
  const file = place(root, report);
  const res = await run(DISMISS, ['--report', file, '--id', target.id, '--kind', 'not-an-issue', '--reason', 'Rendering noise', '--by', 'Maya', '--quiet']);
  assert.equal(res.code, 0, res.stderr);
  const render = await run(script('render-report.mjs'), ['--in', file, '--recompute', '--write-back']);
  assert.equal(render.code, 0, render.stderr);
  const check = await run(VALIDATE, [file]);
  assert.equal(check.code, 0, `${check.stdout}\n${check.stderr}`);
  const r = read(file);
  assert.equal(r.scorecard.dismissed, before + 1);
  assert.equal(r.findings.find((f) => f.id === target.id).dismissal.reason, 'Rendering noise');
});
