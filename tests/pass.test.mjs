// scripts/pass.mjs end to end: start → evidence → findings.json → report → status → finish
// on a coded prototype (no Figma needed), a multi-screen Figma section with a breakpoint
// variant (spec from saved MCP metadata, design PNGs written here), and a sign-in stop.
// Real child scripts throughout. Skipped when Chromium cannot launch.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { scriptCommand } from '../skills/design-qa/scripts/lib/args.mjs';
import { createPng, writePng } from '../skills/design-qa/scripts/lib/png.mjs';
import { annotateMatrix, driverFor, fixNowLines, lockedReportDir, planEvidence, prototypeMatrix, wholePageLine } from '../skills/design-qa/scripts/lib/pass.mjs';
import { fixture, run, script, startServer, tmpDir } from './_helpers.mjs';

const PASS = script('pass.mjs');
/** The script command the children print from a temp project (outside the skill). */
const CMD = (name) => scriptCommand(name, { cwd: os.tmpdir() });
const rx = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OTHER_RUN = '20261004T000000Z-abcdef';
const ENV = { DESIGN_QA_COMMIT: 'test-commit', DESIGN_QA_BRANCH: 'test-branch', DESIGN_QA_RUN_ID: '', FIGMA_TOKEN: '', DESIGN_QA_APP_STORAGE_STATE: '', DESIGN_QA_NO_DISPLAY: '1' };

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
const SKIP = 'Chromium is not installed (run `npx playwright install chromium`)';

export const pass = (cwd, args, env = {}) => run(PASS, args, { cwd, env: { ...ENV, ...env }, timeout: 180000 });
export const nextLine = (out) => out.trim().split('\n').filter((l) => l.startsWith('Next: ')).pop() ?? '';
export const doLines = (out) => out.trim().split('\n').filter((l) => l.startsWith('Do: ')).join('\n');
export const runIdOf = (out) => /Run id: (\S+)/.exec(out)?.[1];

function repo(t, config) {
  const root = tmpDir('design-qa-pass-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'design-qa.config.json'), JSON.stringify(config, null, 2));
  return root;
}

/** Findings that file one finding and reject every audit candidate, compare FAIL row and worklist item. */
export function writeFindings(dir) {
  const ev = path.join(dir, 'evidence');
  const read = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
  const compare = read(path.join(ev, 'compare.json'));
  const rows = new Map();
  for (const [state, v] of Object.entries(compare?.states ?? {})) {
    for (const [kind, list] of Object.entries(v)) if (Array.isArray(list)) for (const r of list.filter((x) => x.result === 'FAIL')) rows.set(`${kind}|${state}|${r.elementClass ?? r._compare?.elementClass}|${r.property}|${r.role}|${r.name}`, { kind, state, ...((r.elementClass ?? r._compare?.elementClass) ? { elementClass: r.elementClass ?? r._compare.elementClass } : {}), ...(r.property ? { property: r.property } : {}), ...(r.role ? { role: r.role, name: r.name } : {}) });
  }
  const audit = read(path.join(ev, 'ds-audit.json'))?.candidates ?? [];
  const worklist = read(path.join(ev, 'worklist.json'))?.items ?? [];
  const states = read(path.join(dir, 'findings.json'))?.states;
  const findings = {
    kind: 'design-qa-findings',
    version: 1,
    ...(states ? { states } : {}),
    comparisons: Object.fromEntries(Object.entries(read(path.join(ev, 'comparison-review.json'))?.states ?? {}).filter(([,r])=>r.complete).map(([s,r])=>[s,{digest:r.digest,images:r.images.map(i=>i.path),valuesReviewed:true}])),
    findings: [
      {
        ref: 'save-colour',
        title: 'Save button background is a hardcoded colour instead of --color-primary',
        ledger: 'style',
        state: 'with-data',
        severity: 'WARNING',
        region: 'Profile form',
        property: 'background-color',
        expected: { value: 'rgb(37, 99, 235)', token: '--color-primary' },
        actual: { value: 'rgb(29, 78, 216)', token: null },
        fix: { summary: 'Use var(--color-primary) for the button background.' },
        pin: { selector: 'button' },
      },
    ],
    rejected: [
      ...(audit.length ? [{ auditKeys: audit.map((c) => c.key), reason: 'out-of-scope', detail: 'Test fixture: the audit candidates are not what this test checks.' }] : []),
      ...[...rows.values()].map((compareRow) => ({ compare: compareRow, reason: 'false-positive', detail: 'Test fixture: these rows are not what this test checks.' })),
      ...(worklist.length ? [{ worklist: worklist.map((w) => w.key), reason: 'out-of-scope', detail: 'Test fixture: these regions are not what this test checks.' }] : []),
    ],
  };
  writeFileSync(path.join(dir, 'findings.json'), JSON.stringify(findings, null, 2));
}

// ---------------------------------------------------------------------------
// Pure planning
// ---------------------------------------------------------------------------

test('driverFor: "<screen>/<state>" first, then the variant\'s screen, then a plain key; with-data defaults to the plain render', () => {
  const surface = { states: { 'cart/empty': { query: '?e=1' }, Empty: { query: '?empty=1' }, hover: { action: 'hover', selector: 'a' } } };
  assert.deepEqual(driverFor(surface, { screen: 'cart', state: 'empty' }), { key: 'cart/empty', driver: { query: '?e=1' }, from: 'config' });
  assert.deepEqual(driverFor(surface, { screen: 'cart-600', variantOf: 'cart', state: 'empty' }).key, 'cart/empty');
  assert.deepEqual(driverFor(surface, { screen: 'pay', state: 'empty' }).key, 'Empty');
  assert.deepEqual(driverFor(surface, { state: 'with-data' }), { key: null, driver: {}, from: 'default' });
  assert.equal(driverFor(surface, { state: 'loading' }), null);
});

test('planEvidence: every screen at its own frame, breakpoint variants routed through their screen, overlays not resized, undriven states named', () => {
  const matrix = [
    { state: 'orders/with-data', screen: 'orders', designed: { frame: { width: 1440, height: 1024 } } },
    { state: 'orders/empty', screen: 'orders', designed: { frame: { width: 1440, height: 1400 } } },
    { state: 'orders/row-menu', screen: 'orders', designed: { frame: { width: 240, height: 180 } } },
    { state: 'orders/loading', screen: 'orders', designed: { frame: { width: 1440, height: 1024 } } },
    { state: 'orders-600/with-data', screen: 'orders-600', designed: { frame: { width: 600, height: 1600 } } },
    { state: 'help/with-data', screen: 'help', designed: { frame: { width: 1440, height: 900 } } },
  ];
  const census = {
    screens: [
      { id: 'orders', frame: { width: 1440, height: 1024 }, states: [{ state: 'row-menu', kind: 'overlay' }] },
      { id: 'orders-600', frame: { width: 600, height: 1600 }, variantOf: 'orders', states: [{ state: 'with-data', kind: 'breakpoint' }] },
      { id: 'help', frame: { width: 1440, height: 900 }, states: [] },
    ],
  };
  const surface = { route: '/', screens: { orders: { route: '/orders' } }, states: { empty: { query: '?empty=1' }, 'row-menu': { action: 'click', selector: '.row' } } };
  const plan = planEvidence({ matrix, census, surface, surfaceName: 'shop' });
  const [orders, variant, help] = plan.screens;
  assert.equal(plan.multi, true);
  assert.deepEqual([orders.out, orders.frame, orders.configScreen], ['evidence/screens/orders', { width: 1440, height: 1024 }, 'orders']);
  assert.deepEqual([variant.frame, variant.configScreen], [{ width: 600, height: 1600 }, 'orders'], 'the variant is captured at its width on its screen\'s route');
  const by = Object.fromEntries(orders.states.map((s) => [s.local, s]));
  assert.deepEqual(by.empty.driver, { query: '?empty=1', viewport: { width: 1440, height: 1400 } }, 'a state frame of another size is captured at that size');
  assert.equal(by['row-menu'].driver.viewport, undefined, 'an overlay opens over the screen');
  assert.equal(by.loading.status, 'no-driver');
  assert.equal(by.loading.hook, 'states.json "orders/loading"');
  assert.match(by.loading.note, /surfaces\.shop\.states\.loading/, 'the config hook is named too');
  assert.equal(help.states[0].status, 'no-route');
  assert.equal(help.states[0].hook, 'states.json screens.help.route');
  const rows = annotateMatrix(matrix.map((r) => ({ ...r, result: 'MISSING_IN_CODE', note: 'x' })), plan);
  assert.equal(rows.find((r) => r.state === 'orders/loading').result, 'CANNOT_VERIFY', 'never MISSING_IN_CODE by default');
  assert.match(rows.find((r) => r.state === 'orders/loading').note, /surfaces\.shop\.states\.loading/);
  // A row the plan drives is implemented whatever discovery saw (capture and compare decide it);
  // one discovery already gave a driver is left as it wrote it.
  const empty = rows.find((r) => r.state === 'orders/empty');
  assert.deepEqual([empty.result, empty.implemented?.driver], ['CANNOT_VERIFY', 'query'], 'a driven state is never MISSING_IN_CODE');
  assert.match(empty.note, /^Pending capture/);
  const kept = annotateMatrix([{ ...matrix[1], implemented: { driver: 'query', detail: 'd' }, result: 'CANNOT_VERIFY', note: 'n' }], plan);
  assert.equal(kept[0].note, 'n', 'planned rows discovery already implemented are left as it wrote them');
  const only = planEvidence({ matrix, census, surface, surfaceName: 'shop', onlyStates: ['orders/empty'] });
  assert.equal(only.screens[0].states.find((s) => s.local === 'with-data').status, 'excluded');
  const proto = prototypeMatrix({ surface: { states: { hover: {}, 'Error state': {}, 'hover-tile': {}, 'Hover row': {}, Default: {} } }, frame: { width: 640, height: 480 } });
  assert.deepEqual(proto.map((r) => r.state), ['with-data', 'hover', 'error-state', 'hover-tile', 'hover-row'], 'a key names the state it spells; a with-data synonym is with-data');
  assert.throws(
    () => prototypeMatrix({ surface: { states: { 'hover-tile': {}, 'Hover tile': {} } }, passStates: { 'with-data': {}, default: {} }, frame: { width: 640, height: 480 } }),
    (err) => err.exitCode === 3 && /"hover-tile" and "Hover tile" are both state "hover-tile"/.test(err.message) && /"with-data" and "default" are both state "with-data"/.test(err.message),
  );
});

test('report summary: whole-page line says which captured state is not verified and why; the fix-now list, one line each', () => {
  const report = JSON.parse(readFileSync(fixture('report-valid.json'), 'utf8'));
  const page = { width: 1440, height: 900, fullPage: true, clipped: 0, image: { width: 1440, height: 900 } };
  for (const row of report.stateMatrix) if (row.captured?.page) row.captured.page = { ...page };
  // A designed state the app does not implement: captured (same as the default), not verified.
  const loading = report.stateMatrix.find((r) => r.state === 'loading');
  loading.captured = { ...(loading.captured ?? {}), page: { ...page } };
  assert.equal(wholePageLine(report), 'Whole page: 4 of 4 states captured over their full height and width · captured, not verified: loading: not implemented in the app');
  const { count, lines } = fixNowLines(report, { max: 3, fixplan: 'qa-reports/abc/report-fixplan.md' });
  assert.ok(count > 3, `fix-now ${count}`);
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^ {2}fix now DQ-001 BLOCKER: Empty state message is missing$/);
  for (const l of lines.slice(0, 3)) assert.match(l, /^ {2}fix now DQ-\d{3} (BLOCKER|WARNING|DS_CANDIDATE): \S.{0,89}$/);
  assert.equal(lines[3], `  … ${count - 3} more fix-now finding(s) in qa-reports/abc/report-fixplan.md`);
  const long = structuredClone(report);
  long.findings.find((f) => f.id === 'DQ-001').title = 'A'.repeat(200);
  assert.equal(fixNowLines(long).lines[0], `  fix now DQ-001 BLOCKER: ${'A'.repeat(89)}…`, 'titles are cut to 90 characters');
});

test('lockedReportDir: the nearest locked ancestor of an output', () => {
  const root = tmpDir();
  const dir = path.join(root, 'qa-reports', 'abc-123');
  mkdirSync(path.join(dir, 'evidence', 'screens', 'cart'), { recursive: true });
  assert.equal(lockedReportDir(path.join(dir, 'evidence', 'screens', 'cart', 'diff.json')), null);
  writeFileSync(path.join(dir, '.design-qa-run.json'), '{}');
  assert.equal(lockedReportDir(path.join(dir, 'evidence', 'screens', 'cart', 'diff.json')), dir);
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A coded prototype, end to end
// ---------------------------------------------------------------------------

export function prototypeConfig(serverUrl) {
  return {
    app: { baseUrl: serverUrl },
    surfaces: {
      profile: {
        route: '/profile',
        prototype: pathToFileURL(fixture('prototype.html')).href,
        states: { hover: { action: 'hover', selector: 'button', wait: 'h1' }, disabled: {} },
      },
    },
    designSystem: { name: 'Acme UI' },
    report: { commit: false },
  };
}

export const appDriftServer = () => {
  const html = readFileSync(fixture('app-drift.html'));
  return startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
};

test('pass.mjs on a coded prototype: start → evidence → report → status → finish, resumable, run-id checked', { timeout: 300000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP);
  const server = await appDriftServer();
  t.after(() => server.close());
  const root = repo(t, prototypeConfig(server.url));
  const dir = path.join(root, 'qa-reports', 'abc-123');
  const rel = 'qa-reports/abc-123';

  // start
  const s = await pass(root, ['start', '--feature', 'ABC-123', '--label', 'test agent', '--agent', 'figma-mcp=no', '--agent', 'ticket-mcp=no', '--quick']);
  assert.equal(s.code, 0, s.stdout + s.stderr);
  const id = runIdOf(s.stdout);
  assert.ok(id);
  assert.match(s.stdout, /^Report folder: qa-reports\/abc-123 \(new\)$/m);
  assert.match(s.stdout, /^Setup: ready/m);
  assert.equal(nextLine(s.stdout), `Next: ${CMD('pass.mjs')} evidence --dir ${rel} --run ${id}`);
  assert.ok(existsSync(path.join(dir, '.design-qa-run.json')));
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'pass.json'), 'utf8')).runId, id);

  // evidence: refused without the run id or with another
  const noId = await pass(root, ['evidence', '--dir', rel]);
  assert.equal(noId.code, 2);
  assert.match(noId.stdout, /^Next: /m);
  const foreign = await pass(root, ['evidence', '--dir', rel, '--run', OTHER_RUN]);
  assert.equal(foreign.code, 5);
  assert.match(foreign.stderr, /belongs to run/);
  assert.equal(existsSync(path.join(dir, 'state-matrix.json')), false, 'nothing written');

  // A designed state nothing drives stops the stage until a driver or a reason is recorded.
  const undriven = await pass(root, ['evidence', '--dir', rel, '--run', id]);
  assert.equal(undriven.code, 3, undriven.stdout + undriven.stderr);
  assert.match(doLines(undriven.stdout), new RegExp(`^Do: For each of disabled: write its driver to ${rel}/states\\.json under that id .*${rel}/findings\\.json "states"`, 'm'));
  assert.equal(nextLine(undriven.stdout), `Next: ${CMD('pass.mjs')} evidence --dir ${rel} --run ${id}`);
  const decided = { kind: 'design-qa-findings', version: 1, findings: [], states: { disabled: { result: 'CANNOT_VERIFY', note: 'No disabled save button in this build: it needs a read-only account.' } } };
  writeFileSync(path.join(dir, 'findings.json'), JSON.stringify(decided));
  const e = await pass(root, ['evidence', '--dir', rel, '--run', id]);
  assert.equal(e.code, 0, e.stdout + e.stderr);
  for (const f of ['state-matrix.json', 'evidence/capture.json', 'evidence/design-capture.json', 'evidence/diff.json', 'evidence/compare.json', 'evidence/audit/with-data.json', 'evidence/audit/hover.json', 'evidence/design/hover.png', 'evidence/app/hover.png', 'worklist.md', 'evidence/worklist.json', 'logs/capture-main.log']) {
    assert.ok(existsSync(path.join(dir, f)), f);
  }
  const diff = JSON.parse(readFileSync(path.join(dir, 'evidence', 'diff.json'), 'utf8'));
  assert.equal(diff.results['with-data'].out, 'evidence/diff/with-data.png', 'paths relative to the report folder');
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'evidence', 'pairs.json'), 'utf8'))['with-data'].frameWidth, 1440, 'the frame width is the scale reference');
  const matrix = JSON.parse(readFileSync(path.join(dir, 'state-matrix.json'), 'utf8'));
  const disabled = matrix.find((r) => r.state === 'disabled');
  assert.equal(disabled.result, 'CANNOT_VERIFY');
  assert.match(disabled.note, /surfaces\.profile\.states\.disabled/);
  assert.match(e.stdout, /^Whole page: 2 of 2 captured states cover their full page height and width/m);
  assert.match(e.stdout, /disabled: no driver → states\.json "disabled"/);
  assert.match(e.stdout, /^PARTIAL: 1 of 3 designed states not captured/m);
  assert.equal(nextLine(e.stdout), `Next: ${CMD('pass.mjs')} report --dir ${rel} --run ${id} --check`);
  assert.match(doLines(e.stdout), new RegExp(`^Do: Work through ${rel}/worklist\\.md and write ${rel}/findings\\.json`));
  assert.doesNotMatch(e.stdout, /ds-audit\.json/, 'no raw evidence file is named');
  const passJson = JSON.parse(readFileSync(path.join(dir, 'pass.json'), 'utf8'));
  assert.equal(passJson.states['with-data'].status, 'captured');
  assert.equal(passJson.states['with-data'].wholePage.covered, true);
  assert.equal(passJson.states.disabled.status, 'no-driver');
  assert.equal(passJson.steps.discover.status, 'ok');

  // Resumable: a second run does nothing; deleting one capture redoes only that state.
  const shot = (s1) => statSync(path.join(dir, 'evidence', 'app', `${s1}.png`)).mtimeMs;
  const before = shot('with-data');
  const again = await pass(root, ['evidence', '--dir', rel, '--run', id]);
  assert.equal(again.code, 0, again.stdout);
  assert.match(again.stdout, /^0 steps run, \d+ up to date$/m);
  rmSync(path.join(dir, 'evidence', 'app', 'hover.png'));
  const redo = await pass(root, ['evidence', '--dir', rel, '--run', id]);
  assert.equal(redo.code, 0, redo.stdout);
  assert.match(readFileSync(path.join(dir, 'logs', 'capture-main.log'), 'utf8'), /--state hover/, 'only hover was captured again');
  assert.equal(shot('with-data'), before, 'with-data was not captured again');
  assert.ok(existsSync(path.join(dir, 'evidence', 'app', 'hover.png')));
  assert.match(redo.stdout, /design\s+main 2\/2 captured \(up to date\)/);

  // report
  rmSync(path.join(dir, 'findings.json'));
  const missing = await pass(root, ['report', '--dir', rel, '--run', id]);
  assert.equal(missing.code, 3, 'no findings file yet');
  assert.match(missing.stdout, /^No qa-reports\/abc-123\/findings\.json yet\. Still to decide \(each filed as a finding or rejected with a reason\):$/m);
  assert.match(missing.stdout, /audit candidate\(s\) are neither filed nor rejected/, 'the to-decide list, without a findings file');
  assert.match(missing.stdout, /compare\.json with-data: FAIL row covered by no finding/);
  assert.match(doLines(missing.stdout), /^Do: Create qa-reports\/abc-123\/findings\.json from references\/templates\/findings\.template\.json, deciding every line above/);
  assert.equal(nextLine(missing.stdout), `Next: ${CMD('pass.mjs')} report --dir ${rel} --run ${id} --check`);
  writeFileSync(path.join(dir, 'findings.json'), JSON.stringify({ ...decided, findings: [{ ref: 'x', title: 'Broken' }] }));
  const bad = await pass(root, ['report', '--dir', rel, '--run', id, '--check']);
  assert.equal(bad.code, 3);
  assert.match(bad.stdout, /^build-report\.mjs found problems \(full text: qa-reports\/abc-123\/logs\/report-check\.log\):/m);
  assert.match(doLines(bad.stdout), /^Do: Fix these in qa-reports\/abc-123\/findings\.json\.$/);
  assert.equal(nextLine(bad.stdout), `Next: ${CMD('pass.mjs')} report --dir ${rel} --run ${id} --check`);
  writeFindings(dir);
  const check = await pass(root, ['report', '--dir', rel, '--run', id, '--check']);
  assert.equal(check.code, 0, check.stdout);
  assert.equal(existsSync(path.join(dir, 'report.json')), false, '--check writes nothing');
  const foreignReport = await pass(root, ['report', '--dir', rel, '--run', OTHER_RUN]);
  assert.equal(foreignReport.code, 5);
  const r = await pass(root, ['report', '--dir', rel, '--run', id]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  for (const f of ['report.json', 'report.html', 'report-fixplan.md', 'logs/report-build.log', 'logs/report-validate.log']) assert.ok(existsSync(path.join(dir, f)), f);
  assert.match(r.stdout.split('\n')[0], /^(PASS|REVIEW|FAIL) · match (\d+%|not measured)( \(\d+ without a pin\))? · \d+ of \d+ findings? settled · 2 of 3 states verified$/);
  assert.match(r.stdout, /^Whole page: 2 of 2 states captured over their full height and width$/m);
  assert.match(r.stdout, /^Findings: 1 · .* · fix now 1 · /m);
  assert.match(r.stdout, /^ {2}fix now DQ-\d+ WARNING: Save button background is a hardcoded colour instead of --color-primary$/m);
  assert.equal(nextLine(r.stdout), `Next: ${CMD('pass.mjs')} review --dir ${rel} --run ${id}`);
  assert.match(r.stdout, /The review is long-running: start the next command in the background/);
  const report = JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8'));
  assert.equal(report.stateMatrix.find((row) => row.state === 'disabled').result, 'CANNOT_VERIFY');

  // status, finish
  const st = await pass(root, ['status', '--dir', rel, '--run', id]);
  assert.equal(st.code, 0);
  assert.match(st.stdout, /evidence\s+up to date/);
  assert.match(st.stdout, /report\s+valid/);
  assert.match(nextLine(st.stdout), /pass\.mjs review --dir/);
  const finForeign = await pass(root, ['finish', '--dir', rel, '--run', OTHER_RUN]);
  assert.equal(finForeign.code, 5);
  const fin = await pass(root, ['finish', '--dir', rel, '--run', id]);
  assert.equal(fin.code, 0, fin.stdout + fin.stderr);
  assert.equal(nextLine(fin.stdout), 'Next: nothing: the pass is finished');
  assert.equal(JSON.parse(readFileSync(path.join(dir, '.design-qa-run.json'), 'utf8')).status, 'finished');
});

// ---------------------------------------------------------------------------
// Multi-screen Figma section with a breakpoint variant
// ---------------------------------------------------------------------------

const ORDERS_HTML = (empty) => `<!doctype html><html><head><meta charset="utf-8"><title>Orders</title>
<style>body{margin:0;font:16px/1.5 Arial,sans-serif}header{padding:16px 24px;border-bottom:1px solid #ddd}.row{padding:12px 24px;border-bottom:1px solid #eee}.row:hover{background:#f0f4ff}.empty{padding:24px}</style></head>
<body><header><h1>Orders</h1></header><main>${empty ? '<p class="empty">No orders yet</p>' : Array.from({ length: 30 }, (_, i) => `<div class="row">Order ${i + 1}</div>`).join('')}</main></body></html>`;

test('pass.mjs evidence on a Figma section: frame-map stop, every screen at its own size (a 600px breakpoint variant), missing design PNGs, then only the diff is redone', { timeout: 300000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP);
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(ORDERS_HTML(req.url.includes('empty=1')));
  });
  t.after(() => server.close());
  const root = repo(t, {
    app: { baseUrl: server.url },
    surfaces: { orders: { route: '/orders', screens: { orders: { route: '/orders' } }, states: { empty: { query: '?empty=1', wait: '.empty' }, 'row-menu': { action: 'hover', selector: '.row' } } } },
    designSystem: { name: 'Acme UI' },
    report: { commit: false },
  });
  const rel = 'qa-reports/abc-200';
  const dir = path.join(root, rel);
  const figmaUrl = 'https://www.figma.com/design/AbCdEf123/Acme?node-id=12-300';
  const s = await pass(root, ['start', '--feature', 'abc-200', '--design', figmaUrl, '--agent', 'figma-mcp=yes', '--agent', 'ticket-mcp=no', '--quick']);
  assert.equal(s.code, 0, s.stdout + s.stderr);
  const id = runIdOf(s.stdout);
  assert.equal(nextLine(s.stdout), `Next: ${CMD('figma-mcp-spec.mjs')} --metadata ${rel}/evidence/metadata.xml --url '${figmaUrl}' --out ${rel}/evidence && ${CMD('pass.mjs')} evidence --dir ${rel} --run ${id}`);
  assert.match(doLines(s.stdout), new RegExp(`Do: Call get_metadata on the linked node with your Figma tools and save the result as ${rel}/evidence/metadata\\.xml\\.`));

  // The agent's part: the spec from saved MCP metadata, and the design PNGs.
  mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  writeFileSync(path.join(dir, 'evidence', 'metadata.xml'), readFileSync(fixture('mcp-metadata-section.xml')));
  const spec = await run(script('figma-mcp-spec.mjs'), ['--metadata', path.join(dir, 'evidence', 'metadata.xml'), '--url', figmaUrl, '--out', path.join(dir, 'evidence')], { cwd: root });
  assert.equal(spec.code, 0, spec.stderr);
  const png = (screen, state, w, h) => {
    const f = path.join(dir, 'evidence', 'screens', screen, 'figma', `${state}.png`);
    mkdirSync(path.dirname(f), { recursive: true });
    writePng(f, createPng(w, h, [255, 255, 255, 255]));
  };
  png('orders', 'with-data', 1440, 1024);
  png('orders', 'row-menu', 240, 180);
  png('orders-600', 'with-data', 600, 1600);

  // An unmapped frame stops discovery with the exact fix.
  const e1 = await pass(root, ['evidence', '--dir', rel, '--run', id]);
  assert.equal(e1.code, 3, e1.stdout + e1.stderr);
  assert.match(e1.stdout, /STOPPED at discover: 1 unmapped frame/);
  assert.match(e1.stdout, /frame 12:450 "Bulk edit" .*"12:450": \{ "screen": "orders", "state": "bulk-edit" \}/);
  assert.equal(nextLine(e1.stdout), `Next: ${CMD('pass.mjs')} evidence --dir ${rel} --run ${id}`);
  assert.match(doLines(e1.stdout), new RegExp(`write them to ${rel}/frame-map\\.json`));
  writeFileSync(path.join(dir, 'frame-map.json'), JSON.stringify({ '12:450': { screen: 'orders', state: 'bulk-edit' } }));

  // Every screen and state captured at its own frame; one design PNG still missing.
  const e2 = await pass(root, ['evidence', '--dir', rel, '--run', id]);
  assert.equal(e2.code, 3, e2.stdout + e2.stderr);
  assert.match(e2.stdout, /Design PNGs missing \(1; no pixel diff for them\):/);
  assert.match(e2.stdout, new RegExp(`orders/empty → ${rx(CMD('figma-mcp-spec.mjs'))} --spec ${rel}/evidence/screens/orders/figma-spec\\.json --state empty`));
  const capOrders = JSON.parse(readFileSync(path.join(dir, 'evidence', 'screens', 'orders', 'capture.json'), 'utf8'));
  const cap600 = JSON.parse(readFileSync(path.join(dir, 'evidence', 'screens', 'orders-600', 'capture.json'), 'utf8'));
  assert.deepEqual(capOrders.frame, { width: 1440, height: 1024 });
  assert.deepEqual(Object.keys(capOrders.states).sort(), ['empty', 'row-menu', 'with-data']);
  assert.deepEqual(cap600.frame, { width: 600, height: 1600 }, 'the breakpoint variant at its own width');
  assert.equal(cap600.states['with-data'].size.width, 600);
  assert.ok(capOrders.states['with-data'].size.height > 1024, 'the whole page, not the first screen');
  const matrix = JSON.parse(readFileSync(path.join(dir, 'state-matrix.json'), 'utf8'));
  for (const local of ['loading', 'side-panel', 'bulk-edit']) {
    const row = matrix.find((r) => r.state === `orders/${local}`);
    assert.equal(row.result, 'CANNOT_VERIFY', local);
    assert.match(row.note, new RegExp(`surfaces\\.orders\\.states\\.${local}`));
  }
  const diffOrders = JSON.parse(readFileSync(path.join(dir, 'evidence', 'screens', 'orders', 'diff.json'), 'utf8'));
  assert.deepEqual(Object.keys(diffOrders.results), ['with-data'], 'the overlay is compared by styles, not pixels');
  assert.ok(existsSync(path.join(dir, 'evidence', 'screens', 'orders-600', 'diff.json')));

  // The missing PNG arrives: captures are up to date, the diff runs again.
  png('orders', 'empty', 1440, 1024);
  const e3 = await pass(root, ['evidence', '--dir', rel, '--run', id]);
  assert.equal(e3.code, 3, 'three designed states have no driver and no recorded reason');
  assert.match(doLines(e3.stdout), /For each of orders\/loading, orders\/bulk-edit, orders\/side-panel: write its driver/);
  assert.match(e3.stdout, /capture\s+orders \d\/\d captured \(up to date\) · orders-600 1\/1 captured \(up to date\)/);
  assert.match(e3.stdout, /diff\s+orders 2 pairs · orders-600 1 pair \(up to date\)/);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(dir, 'evidence', 'screens', 'orders', 'diff.json'), 'utf8')).results).sort(), ['empty', 'with-data']);
  assert.match(e3.stdout, /^Whole page: 4 of 4 captured states/m);
  const why = { result: 'CANNOT_VERIFY', note: 'Not reachable in this test app: no such state is built.' };
  writeFileSync(path.join(dir, 'findings.json'), JSON.stringify({ kind: 'design-qa-findings', version: 1, findings: [], states: { 'orders/loading': why, 'orders/side-panel': why, 'orders/bulk-edit': why } }));
  const e4 = await pass(root, ['evidence', '--dir', rel, '--run', id]);
  assert.equal(e4.code, 0, e4.stdout + e4.stderr);
  assert.equal(nextLine(e4.stdout), `Next: ${CMD('pass.mjs')} report --dir ${rel} --run ${id} --check`);
});

// ---------------------------------------------------------------------------
// A sign-in page
// ---------------------------------------------------------------------------

test('pass.mjs evidence: a sign-in page stops the stage as "needs a signed-in session" with save-session, never "unreachable"', { timeout: 180000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP);
  const server = await startServer((req, res) => {
    if (!req.url.startsWith('/login')) {
      res.writeHead(302, { location: '/login?next=/profile' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Sign in</title><form><input name="email"><input type="password" name="password"><button>Sign in</button></form>');
  });
  t.after(() => server.close());
  const root = repo(t, prototypeConfig(server.url));
  const s = await pass(root, ['start', '--feature', 'abc-300', '--agent', 'figma-mcp=no', '--agent', 'ticket-mcp=no', '--quick']);
  assert.equal(s.code, 0, s.stdout + s.stderr);
  const id = runIdOf(s.stdout);
  const e = await pass(root, ['evidence', '--dir', 'qa-reports/abc-300', '--run', id]);
  assert.equal(e.code, 3, e.stdout + e.stderr);
  assert.match(e.stdout, /STOPPED at capture:main: sign-in page/);
  assert.doesNotMatch(e.stdout, /unreachable/i);
  assert.match(nextLine(e.stdout), /^Next: node \S*scripts\/setup\.mjs save-session --config design-qa\.config\.json && node \S*scripts\/pass\.mjs evidence --dir qa-reports\/abc-300 --run \S+$/);
  assert.match(doLines(e.stdout), /signed-in session: the next command opens a browser window where they sign in themselves/);
  const passJson = JSON.parse(readFileSync(path.join(root, 'qa-reports', 'abc-300', 'pass.json'), 'utf8'));
  assert.equal(passJson.states['with-data'].status, 'sign-in');
});
