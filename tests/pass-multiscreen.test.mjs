import { comparisonFixtureRecords } from './_helpers.mjs';
// pass.mjs on a multi-screen coded prototype (three screens of the bundled checkout mock):
// start on a project with no config (it leaves one), screens and "<screen>/<state>" drivers in
// the pass's states.json, --url with a path, the state count and coverage, the URLs captured,
// no phantom suggestions; an unreachable app; start --ci and report in ci mode (default
// triage, gate); a code change making captures stale, and --recapture; and the Do/Next
// contract on every line the passes print.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ROOT, run, script, startServer, tmpDir } from './_helpers.mjs';

const PASS = script('pass.mjs');
const MOCK = path.join(ROOT, 'examples', 'mock-five-frames', 'src');
const ENV = { DESIGN_QA_COMMIT: '', DESIGN_QA_BRANCH: '', DESIGN_QA_RUN_ID: '', FIGMA_TOKEN: '', DESIGN_QA_APP_STORAGE_STATE: '', DESIGN_QA_NO_DISPLAY: '1', CI: '' };
const ALL_NEXT = [];
const pass = async (cwd, args, env = {}) => {
  const r = await run(PASS, args, { cwd, env: { ...ENV, ...env }, timeout: 240000 });
  ALL_NEXT.push(...r.stdout.split('\n').filter((l) => l.startsWith('Next: ')));
  return r;
};
const nextLine = (out) => out.trim().split('\n').filter((l) => l.startsWith('Next: ')).pop() ?? '';
/** A first start shows what it assumed and stops; the person agrees: its Next (apply, then start) runs as printed. */
const agreeAndStart = (cwd, first) =>
  new Promise((resolve) => {
    writeFileSync(path.join(cwd, /^Report folder: (\S+)/m.exec(first.stdout)[1], 'answers.json'), '{}');
    execFile('sh', ['-c', nextLine(first.stdout).replace(/^Next: /, '')], { cwd, env: { ...process.env, NO_COLOR: '1', ...ENV } }, (err, stdout, stderr) => {
      ALL_NEXT.push(...stdout.split('\n').filter((l) => l.startsWith('Next: ')));
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
const doLines = (out) => out.trim().split('\n').filter((l) => l.startsWith('Do: ')).join('\n');
const runIdOf = (out) => /Run id: (\S+)/.exec(out)?.[1];
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));

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

/** The mock: /checkout/<id> is the app, /figma/<id> the coded prototype. appStatus: answer app pages with this status. */
function mockServer({ appStatus = 200 } = {}) {
  return startServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const m = /^\/(checkout|figma)\/([a-z-]+)$/.exec(url.pathname);
    let file = null;
    if (m) file = path.join(MOCK, m[1] === 'checkout' ? 'app' : 'design', `${m[2]}.html`);
    else if (/^\/[a-z-]+\.(css|js)$/.test(url.pathname)) file = path.join(MOCK, url.pathname.slice(1));
    if (!file || !existsSync(file) || (m?.[1] === 'checkout' && appStatus !== 200)) {
      res.writeHead(m?.[1] === 'checkout' ? appStatus : 404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
    res.end(readFileSync(file));
  });
}

function project(t, { packageJson = true } = {}) {
  const root = tmpDir('design-qa-multi-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (packageJson) writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'acme-shop', private: true }));
  return root;
}

const SCREENS = (base) => ({
  screens: {
    cart: { prototype: `${base}/figma/cart`, route: '/checkout/cart' },
    shipping: { prototype: `${base}/figma/shipping`, route: '/checkout/shipping' },
    payment: { prototype: `${base}/figma/payment`, route: '/checkout/payment' },
  },
  'cart/empty': { query: '?empty=1' },
  'shipping/hover': { action: 'hover', selector: '[data-testid=primary-cta]' },
  'payment/error': { query: '?error=1' },
});

/** Findings that reject everything the evidence asks about (a fixture pass, not a review). */
function writeFindings(dir) {
  const ev = path.join(dir, 'evidence');
  const rows = [];
  const items = [];
  const audit = [];
  for (const screen of ['cart', 'shipping', 'payment']) {
    const base = path.join(ev, 'screens', screen);
    const c = existsSync(path.join(base, 'compare.json')) ? read(path.join(base, 'compare.json')) : null;
    for (const [state, v] of Object.entries(c?.states ?? {})) {
      for (const [kind, list] of Object.entries(v)) if (Array.isArray(list)) for (const r of list.filter((x) => x.result === 'FAIL')) rows.push({ kind, state: `${screen}/${state}`, ...((r.elementClass ?? r._compare?.elementClass) ? { elementClass: r.elementClass ?? r._compare.elementClass } : {}), ...(r.property ? { property: r.property } : {}), ...(r.role ? { role: r.role, name: r.name } : {}) });
    }
    if (existsSync(path.join(base, 'worklist.json'))) items.push(...read(path.join(base, 'worklist.json')).items.map((i) => i.key));
  }
  if (existsSync(path.join(ev, 'worklist.json'))) items.push(...read(path.join(ev, 'worklist.json')).items.map((i) => i.key));
  if (existsSync(path.join(ev, 'ds-audit.json'))) audit.push(...read(path.join(ev, 'ds-audit.json')).candidates.map((c) => c.key));
  writeFileSync(
    path.join(dir, 'findings.json'),
    JSON.stringify({
      kind: 'design-qa-findings',
      version: 1,
      comparisons: comparisonFixtureRecords(dir),
      findings: [],
      rejected: [
        ...(audit.length ? [{ auditKeys: audit, reason: 'out-of-scope', detail: 'Test fixture: the audit candidates are not what this test checks.' }] : []),
        ...rows.map((compare) => ({ compare, reason: 'false-positive', detail: 'Test fixture: these rows are not what this test checks.' })),
        // One reason per region: one stock sentence for many unsupported regions is refused (a blanket rejection).
        ...items.map((key) => ({ worklist: key, reason: 'out-of-scope', detail: `Test fixture: region ${key} is not what this test checks.` })),
      ],
    }),
  );
}

test('multi-screen coded prototype: start saves a config once the person agrees; screens and drivers in states.json; --url with a path; 6 states, every URL right, no phantoms; ci report and gate', { timeout: 600000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP);
  const server = await mockServer();
  t.after(() => server.close());
  const root = project(t);
  const page = `${server.url}/checkout/cart`;

  // start: no config yet, --url a page of one screen, a prototype URL. What it assumed is shown, not written.
  const first = await pass(root, ['start', '--feature', 'abc-500', '--url', page, '--prototype', `${server.url}/figma/cart`, '--agent', 'figma-mcp=no', '--agent', 'ticket-mcp=no', '--quick']);
  assert.equal(first.code, 3, first.stdout + first.stderr);
  assert.match(first.stdout, /^Assumed \(not saved yet/m);
  assert.ok(!existsSync(path.join(root, 'design-qa.config.json')));
  const s = await agreeAndStart(root, first);
  assert.equal(s.code, 0, s.stdout + s.stderr);
  const config = read(path.join(root, 'design-qa.config.json'));
  assert.equal(config.app.baseUrl, server.url, 'the printed apply left a valid config with the app address');
  assert.match(s.stdout, /^qa-reports\/abc-500\/states\.json skeleton \(one screen; add one entry per screen and one key per extra state\):$/m);
  assert.match(s.stdout, new RegExp(`^  \\{ "screens": \\{ "cart": \\{ "prototype": "${server.url.replace(/[.]/g, '\\.')}/figma/cart", "route": "/checkout/cart" \\} \\},$`, 'm'));
  assert.match(s.stdout, /^Do: If the design has more screens or states than this one page, write them to qa-reports\/abc-500\/states\.json before the next command/m);
  assert.match(nextLine(s.stdout), /pass\.mjs evidence --dir qa-reports\/abc-500 --run \S+$/);
  const id = runIdOf(s.stdout);
  const rel = 'qa-reports/abc-500';
  const dir = path.join(root, rel);

  // A plain key in a multi-screen pass is refused: it does not say which screen.
  writeFileSync(path.join(dir, 'states.json'), JSON.stringify({ ...SCREENS(server.url), empty: { query: '?empty=1' } }));
  const bad = await pass(root, ['evidence', '--dir', rel, '--run', id]);
  assert.equal(bad.code, 3, bad.stdout);
  assert.match(bad.stdout, /states\.json "empty": this pass has several screens \(cart, shipping, payment\); key the state by its screen, e\.g\. "cart\/empty"/);

  writeFileSync(path.join(dir, 'states.json'), JSON.stringify(SCREENS(server.url)));
  const e = await pass(root, ['evidence', '--dir', rel, '--run', id]);
  assert.equal(e.code, 0, e.stdout + e.stderr);
  assert.match(e.stdout, /^Evidence: qa-reports\/abc-500 · prototype source · 3 screens · 6 designed states$/m);
  assert.doesNotMatch(e.stdout, /PARTIAL|Driver suggestions|not a designed state/);
  assert.match(e.stdout, /^Component check is off: no component library is configured/m, 'the gap is said, not read as Components: 0');
  const matrix = read(path.join(dir, 'state-matrix.json'));
  assert.deepEqual(matrix.map((r) => r.state).sort(), ['cart/empty', 'cart/with-data', 'payment/error', 'payment/with-data', 'shipping/hover', 'shipping/with-data']);
  for (const screen of ['cart', 'shipping', 'payment']) {
    const app = read(path.join(dir, 'evidence', 'screens', screen, 'capture.json'));
    const design = read(path.join(dir, 'evidence', 'screens', screen, 'design-capture.json'));
    assert.equal(app.url, `${server.url}/checkout/${screen}`, 'the origin of --url plus the screen route, never doubled');
    assert.equal(design.url, `${server.url}/figma/${screen}`);
  }
  assert.equal(read(path.join(dir, 'pass.json')).url, page, '--url is kept for the pass');

  // ci: report records the default triage, renders again and ends with finish; gate maps the verdict.
  writeFindings(dir);
  const r = await pass(root, ['report', '--dir', rel, '--run', id, '--mode', 'ci']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout.split('\n')[0], /^(PASS|REVIEW|FAIL|INCOMPLETE) · match (\d+%|not measured)( \(\d+ without a pin\))? · \d+ of \d+ findings? settled · 6 of 6 states verified$/);
  const rep = read(path.join(dir, 'report.json'));
  assert.equal(rep.triage?.source, 'ci-default', 'the default triage is recorded');
  assert.match(r.stdout, /^CI gate: \S+ (passes|fails) the check/m);
  assert.match(nextLine(r.stdout), /pass\.mjs finish --dir qa-reports\/abc-500 --run \S+$/);
  const g = await run(PASS, ['gate', '--dir', rel], { cwd: root, env: ENV });
  assert.equal(g.code, ['PASS', 'REVIEW'].includes(rep.scorecard.verdict) ? 0 : 4, g.stdout);
  assert.match(g.stdout, /^design-qa: .* · (passes|fails) the check$/m);

  // save-drivers writes the screens (route and prototype) and the drivers.
  const saved = await pass(root, ['save-drivers', '--dir', rel, '--run', id]);
  assert.equal(saved.code, 0, saved.stdout + saved.stderr);
  const after = read(path.join(root, 'design-qa.config.json'));
  const surface = Object.values(after.surfaces ?? {})[0];
  assert.ok(surface, `a surface was written: ${JSON.stringify(after.surfaces)}`);
  assert.deepEqual(surface.screens.shipping, { route: '/checkout/shipping', prototype: `${server.url}/figma/shipping` });
  assert.deepEqual(surface.states['payment/error'], { query: '?error=1' });
});

test('an app that answers 404: the summary says so and names the URL; not "add drivers"', { timeout: 300000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP);
  const server = await mockServer({ appStatus: 404 });
  t.after(() => server.close());
  const root = project(t);
  const s = await agreeAndStart(root, await pass(root, ['start', '--feature', 'abc-501', '--url', `${server.url}/checkout/cart`, '--prototype', `${server.url}/figma/cart`, '--agent', 'figma-mcp=no', '--agent', 'ticket-mcp=no', '--quick']));
  assert.equal(s.code, 0, s.stdout + s.stderr);
  const id = runIdOf(s.stdout);
  const e = await pass(root, ['evidence', '--dir', 'qa-reports/abc-501', '--run', id]);
  assert.equal(e.code, 1, e.stdout + e.stderr);
  assert.match(e.stdout, new RegExp(`^FAILED capture:main: capture \\(app\\) of the screen at ${server.url.replace(/[.]/g, '\\.')}/checkout/cart failed \\(exit 5\\)`, 'm'));
  assert.match(e.stdout, /^PARTIAL: 1 of 1 designed states not captured: 1 failed to capture \(see below\)/m);
  assert.doesNotMatch(e.stdout, /need a driver/);
  assert.match(doLines(e.stdout), new RegExp(`The app at ${server.url.replace(/[.]/g, '\\.')}/checkout/cart did not answer as a page \\(.*404.*\\)\\. Start it`));
  assert.match(nextLine(e.stdout), /pass\.mjs evidence --dir qa-reports\/abc-501 --run \S+$/);
});

test('start --ci never asks: a missing input exits 3 with the list; ready: the pass is ci and report defaults to ci', { timeout: 120000 }, async (t) => {
  const root = project(t, { packageJson: false });
  const s = await pass(root, ['start', '--feature', 'abc-502', '--ci', '--quick']);
  assert.equal(s.code, 3, s.stdout + s.stderr);
  assert.match(s.stdout, /^Setup: not ready/m);
  assert.match(doLines(s.stdout), /^Do: ci never asks: stop this run and report the missing inputs listed above/);
  assert.match(nextLine(s.stdout), /pass\.mjs start --feature abc-502 --dir qa-reports\/abc-502 --ci --quick --run \S+$/);
  writeFileSync(path.join(root, 'design-qa.config.json'), JSON.stringify({ app: { baseUrl: 'http://127.0.0.1:9' }, surfaces: { orders: { route: '/orders', prototype: 'http://127.0.0.1:9/proto' } }, designSystem: { name: 'Acme UI' }, report: { commit: false } }));
  const ok = await pass(root, ['start', '--feature', 'abc-503', '--ci', '--quick']);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /^Setup: ready \(ci\)$/m);
  assert.equal(read(path.join(root, 'qa-reports', 'abc-503', 'pass.json')).stages.start.ci, true);
  assert.doesNotMatch(ok.stdout, /^Do: /m, 'nothing to ask in ci');
});

test('local target: a code change makes captures stale (status says so); --recapture captures again anyway', { timeout: 300000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP);
  const server = await mockServer();
  t.after(() => server.close());
  const root = project(t);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'qa@example.com');
  git('config', 'user.name', 'QA');
  writeFileSync(path.join(root, 'app.js'), 'export const v = 1;\n');
  writeFileSync(path.join(root, '.gitignore'), 'qa-reports/\n');
  writeFileSync(path.join(root, 'design-qa.config.json'), JSON.stringify({ app: { baseUrl: server.url }, surfaces: { cart: { route: '/checkout/cart', prototype: `${server.url}/figma/cart`, states: { empty: { query: '?empty=1' } } } }, designSystem: { name: 'Acme UI' }, report: { commit: false } }));
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  const s = await pass(root, ['start', '--feature', 'abc-504', '--agent', 'figma-mcp=no', '--agent', 'ticket-mcp=no', '--quick']);
  assert.equal(s.code, 0, s.stdout + s.stderr);
  const id = runIdOf(s.stdout);
  const rel = 'qa-reports/abc-504';
  const shot = (st) => statSync(path.join(root, rel, 'evidence', 'app', `${st}.png`)).mtimeMs;
  assert.equal((await pass(root, ['evidence', '--dir', rel, '--run', id])).code, 0);
  const before = shot('with-data');
  const fresh = await pass(root, ['evidence', '--dir', rel, '--run', id]);
  assert.match(fresh.stdout, /capture\s+main 2\/2 captured \(up to date\)/);

  // The app's code changes: status says the captures may predate it; evidence captures again.
  writeFileSync(path.join(root, 'app.js'), 'export const v = 2;\n');
  const st = await pass(root, ['status', '--dir', rel, '--run', id]);
  assert.match(st.stdout, /captures may predate your code changes/);
  assert.match(nextLine(st.stdout), /pass\.mjs evidence --dir qa-reports\/abc-504 --run \S+$/);
  const changed = await pass(root, ['evidence', '--dir', rel, '--run', id]);
  assert.match(changed.stdout, /capture\s+main 2\/2 captured$/m);
  assert.ok(shot('with-data') > before, 'captured again');
  assert.match(changed.stdout, /design\s+main 2\/2 captured \(up to date\)/, 'the prototype side is not recaptured for an app change');

  // --recapture <state>: only that one, whatever the fingerprints say.
  const mid = shot('with-data');
  const re = await pass(root, ['evidence', '--dir', rel, '--run', id, '--recapture', 'empty']);
  assert.match(re.stdout, /capture\s+main 1\/1 captured$/m);
  assert.equal(shot('with-data'), mid);
  const all = await pass(root, ['evidence', '--dir', rel, '--run', id, '--recapture']);
  assert.match(all.stdout, /capture\s+main 2\/2 captured$/m);
});

test('the Do/Next contract: every Next: line printed above is one runnable command, or "nothing: the pass is finished"', () => {
  assert.ok(ALL_NEXT.length > 10 || !CHROMIUM, `${ALL_NEXT.length} Next: lines seen`);
  for (const line of ALL_NEXT) {
    const next = line.slice('Next: '.length);
    if (next === 'nothing: the pass is finished') continue;
    for (const part of next.split(' && ')) {
      assert.match(part, /^node \S+\.mjs( \S+)*$/, `a command: ${line}`);
      assert.doesNotMatch(part, /\(|then:|, then| run it/, `no prose: ${line}`);
    }
  }
});
