// Default-output budgets: what an agent reads after each command it runs costs tokens on
// every pass, so the default stdout + stderr of pass.mjs and of the scripts an agent runs
// directly must stay short. These budgets fail the build when output creeps back up.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createPng, writePng } from '../skills/design-qa/scripts/lib/png.mjs';
import { fixture, run, script, startServer, tmpDir } from './_helpers.mjs';

const ENV = { DESIGN_QA_COMMIT: 'c', DESIGN_QA_BRANCH: 'b', DESIGN_QA_RUN_ID: '', FIGMA_TOKEN: '', DESIGN_QA_APP_STORAGE_STATE: '', DESIGN_QA_NO_DISPLAY: '1' };

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

/** Assert the default output (stdout + stderr) of one command stays within its budget. */
function within(name, res, { lines, bytes }) {
  const text = `${res.stdout}${res.stderr}`;
  const n = text.split('\n').filter((l) => l.trim()).length;
  const b = Buffer.byteLength(text);
  assert.ok(n <= lines && b <= bytes, `${name}: ${n} lines / ${b} bytes (budget ${lines} lines / ${bytes} bytes)\n${text}`);
  return text;
}

const exec = (name, args, opts = {}) => run(script(name), args, { timeout: 180000, ...opts, env: { ...ENV, ...(opts.env ?? {}) } });

test('budget: pass.mjs stages on a coded prototype (start ≤ 16 lines, evidence ≤ 40, report ≤ 30, status ≤ 25, finish ≤ 10)', { timeout: 300000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP);
  const html = readFileSync(fixture('app-drift.html'));
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  const root = tmpDir('design-qa-budget-');
  t.after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(
    path.join(root, 'design-qa.config.json'),
    JSON.stringify({
      app: { baseUrl: server.url },
      surfaces: { profile: { route: '/profile', prototype: pathToFileURL(fixture('prototype.html')).href, states: { hover: { action: 'hover', selector: 'button', wait: 'h1' }, disabled: {} } } },
      designSystem: { name: 'Acme UI' },
      report: { commit: false },
    }),
  );
  const pass = (args) => exec('pass.mjs', args, { cwd: root });
  const s = await pass(['start', '--feature', 'abc-123', '--agent', 'figma-mcp=no', '--agent', 'ticket-mcp=no', '--quick']);
  assert.equal(s.code, 0, s.stdout + s.stderr);
  within('pass start', s, { lines: 16, bytes: 2000 });
  const id = /Run id: (\S+)/.exec(s.stdout)[1];
  const rel = 'qa-reports/abc-123';
  // `disabled` has no driver: record why, as an agent would, so evidence goes on.
  const states = { disabled: { result: 'CANNOT_VERIFY', note: 'The prototype has no disabled control.' } };
  writeFileSync(path.join(root, rel, 'findings.json'), JSON.stringify({ kind: 'design-qa-findings', version: 1, findings: [], states }));
  const e = await pass(['evidence', '--dir', rel, '--run', id]);
  assert.equal(e.code, 0, e.stdout + e.stderr);
  within('pass evidence', e, { lines: 40, bytes: 3500 });
  within('pass evidence (nothing to redo)', await pass(['evidence', '--dir', rel, '--run', id]), { lines: 40, bytes: 3500 });
  writeFileSync(path.join(root, rel, 'findings.json'), JSON.stringify({ kind: 'design-qa-findings', version: 1, findings: [{ ref: 'x', title: 'Broken' }], states }));
  const bad = await pass(['report', '--dir', rel, '--run', id]);
  assert.equal(bad.code, 3);
  within('pass report (findings problems)', bad, { lines: 30, bytes: 4500 });
  within('pass status', await pass(['status', '--dir', rel]), { lines: 25, bytes: 1500 });
  within('pass finish', await pass(['finish', '--dir', rel, '--run', id]), { lines: 10, bytes: 600 });
});

test('budget: setup.mjs check, run.mjs start / status', { timeout: 120000 }, async () => {
  within('setup check --quick', await exec('setup.mjs', ['check', '--quick'], { cwd: fixture('setup-repo') }), { lines: 40, bytes: 4000 });
  within('setup check --quick --json', await exec('setup.mjs', ['check', '--quick', '--json'], { cwd: fixture('setup-repo') }), { lines: 220, bytes: 6500 });
  const root = tmpDir();
  const dir = path.join('qa-reports', 'abc-123');
  within('run start', await exec('run.mjs', ['start', '--dir', dir, '--label', 'agent'], { cwd: root }), { lines: 4, bytes: 400 });
  within('run status', await exec('run.mjs', ['status', '--dir', dir], { cwd: root }), { lines: 4, bytes: 500 });
  rmSync(root, { recursive: true, force: true });
});

test('budget: figma-mcp-spec.mjs and state-discovery.mjs on a section with two screens', { timeout: 60000 }, async () => {
  const root = tmpDir();
  const ev = path.join(root, 'evidence');
  const spec = await exec('figma-mcp-spec.mjs', ['--metadata', fixture('mcp-metadata-section.xml'), '--url', 'https://www.figma.com/design/AbCdEf123/Acme?node-id=12-300', '--out', ev], { cwd: root });
  assert.equal(spec.code, 0, spec.stderr);
  const text = within('figma-mcp-spec', spec, { lines: 22, bytes: 2000 });
  assert.equal(text.split('--spec ').length - 1 <= 3, true, 'the --spec path is not repeated per state');
  const sd = await exec('lib/state-discovery.mjs', ['--figma-spec', path.join(ev, 'figma-spec.json'), '--out', path.join(root, 'state-matrix.json')], { cwd: root });
  assert.equal(sd.code, 0, sd.stderr);
  within('state-discovery', sd, { lines: 26, bytes: 2600 });
  rmSync(root, { recursive: true, force: true });
});

test('budget: diff.mjs, render-report.mjs and validate.mjs', { timeout: 60000 }, async () => {
  const root = tmpDir();
  for (const [name, w, h, c] of [['figma/a.png', 64, 64, 255], ['app/a.png', 64, 64, 250], ['figma/b.png', 64, 64, 255], ['app/b.png', 64, 80, 255]]) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writePng(path.join(root, name), createPng(w, h, [c, c, c, 255]));
  }
  writeFileSync(path.join(root, 'pairs.json'), JSON.stringify({ a: { a: 'figma/a.png', b: 'app/a.png' }, b: { a: 'figma/b.png', b: 'app/b.png' } }));
  within('diff --pairs (2 states)', await exec('diff.mjs', ['--pairs', path.join(root, 'pairs.json'), '--out-dir', path.join(root, 'diff')], { cwd: root }), { lines: 6, bytes: 2500 });
  const report = path.join(root, 'report.json');
  copyFileSync(fixture('report-valid.json'), report);
  within('render-report', await exec('render-report.mjs', ['--in', report, '--out', path.join(root, 'report.html'), '--fixplan', path.join(root, 'report-fixplan.md')], { cwd: root }), { lines: 8, bytes: 1500 });
  within('validate', await exec('validate.mjs', [report], { cwd: root }), { lines: 12, bytes: 2000 });
  rmSync(root, { recursive: true, force: true });
});

test('budget: capture.mjs (3 states) and ds-audit.mjs on a whole page', { timeout: 180000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP);
  const page = readFileSync(fixture('ds-audit-page.html'));
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  });
  const root = tmpDir();
  t.after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  copyFileSync(fixture('ds-audit-tokens.json'), path.join(root, 'tokens.json'));
  copyFileSync(fixture('ds-audit-catalog.json'), path.join(root, 'catalog.json'));
  const config = path.join(root, 'design-qa.config.json');
  writeFileSync(
    config,
    JSON.stringify({
      app: { baseUrl: server.url },
      surfaces: { orders: { route: '/', states: { 'with-data': {}, hover: { action: 'hover', selector: 'button' }, focus: { action: 'focus', selector: 'input' } } } },
      designSystem: { name: 'Acme DS', tokens: ['tokens.json'], componentCatalog: 'catalog.json', libraries: [{ name: 'Mui', kind: 'third-party', classPrefix: 'Mui' }] },
    }),
  );
  const ev = path.join(root, 'evidence');
  const cap = await exec('capture.mjs', ['--config', config, '--width', '800', '--height', '600', '--out', ev], { cwd: root });
  assert.equal(cap.code, 0, cap.stderr);
  within('capture (3 states)', cap, { lines: 8, bytes: 1500 });
  const ds = await exec('ds-audit.mjs', ['--evidence', ev, '--config', config], { cwd: root });
  assert.equal(ds.code, 0, ds.stderr);
  within('ds-audit', ds, { lines: 20, bytes: 3000 });
});
