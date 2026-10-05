// A Figma section through the whole pass.mjs flow with the drivers where the skill says to
// write them (<dir>/states.json) and the app address given once with --url: every designed
// state is implemented, captured, compared and counted in "states verified". A screen
// without a route stops evidence with the place to write it; a states.json key that names
// no designed state stops it too. All Figma data here is invented and kept small.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildStateMatrix, discoverUndesigned } from '../skills/design-qa/scripts/lib/state-discovery.mjs';
import { annotateMatrix, designedIdFor, planEvidence } from '../skills/design-qa/scripts/lib/pass.mjs';
import { run, script, startServer, tmpDir } from './_helpers.mjs';

const KEY = 'OrDeRsKeY42';
const link = `https://www.figma.com/design/${KEY}/Orders?node-id=60-1`;
const ENV = { DESIGN_QA_COMMIT: 'c', DESIGN_QA_BRANCH: 'b', DESIGN_QA_RUN_ID: '', FIGMA_TOKEN: '', DESIGN_QA_APP_STORAGE_STATE: '', DESIGN_QA_NO_DISPLAY: '1' };
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const reviewRecords = dir => Object.fromEntries(Object.entries(readJson(path.join(dir, 'evidence/comparison-review.json')).states).filter(([,r])=>r.complete).map(([s,r])=>[s,{digest:r.digest,images:r.images.map(i=>i.path),valuesReviewed:true}]));

// [id, name]: frames of 1440×900 side by side.
const LIST = [
  ['60:10', 'Orders list'],
  ['60:20', 'Orders list – Empty'],
  ['60:30', 'Hover tile'],
  ['60:40', 'Hover row'],
];
const DETAIL = ['60:50', 'Order detail'];
const metadataXml = (frames) =>
  `<section id="60:1" name="Orders" x="0" y="0" width="${frames.length * 1600}" height="1000">\n${frames
    .map(([id, name], i) => `  <frame id="${id}" name="${name}" x="${i * 1600}" y="0" width="1440" height="900"/>`)
    .join('\n')}\n</section>`;

// The app: every page exactly 1440×900 (so its capture can stand in for the design PNG);
// hover changes pixels, so no state is captured identical to with-data.
const page = (body) =>
  `<!doctype html><html><head><style>html,body{margin:0;height:900px;overflow:hidden;font:16px sans-serif}
.tile{width:200px;height:100px;margin:20px;background:#eee}.tile:hover{background:#c33}
td{padding:8px}tr:hover td{background:#36c;color:#fff}</style></head><body>${body}</body></html>`;
const LIST_HTML = page('<h1>Orders</h1><div class="tile">Energy</div><table><tr><td>Row one</td></tr><tr><td>Row two</td></tr></table>');
const EMPTY_HTML = page('<h1>Orders</h1><p class="empty">No orders yet</p>');
const DETAIL_HTML = page('<h1>Energy storage</h1><p>Detail</p>');

async function chromiumLaunches() {
  try {
    const { chromium } = await import('playwright');
    await (await chromium.launch({ headless: true })).close();
    return true;
  } catch {
    return false;
  }
}

function sh(cwd, line) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', line], { cwd, env: { ...process.env, ...ENV } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

const nextOf = (out) => /^Next: (.+)$/m.exec(out)?.[1] ?? null;

/** start → metadata → the printed conversion + evidence; returns what later steps need. */
async function startPass(t, { frames, frameMap, feature, git = false }) {
  const app = await startServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const body = u.pathname === '/orders' ? (u.searchParams.has('empty') ? EMPTY_HTML : LIST_HTML) : u.pathname === '/orders/1' ? DETAIL_HTML : null;
    return body ? res.writeHead(200, { 'content-type': 'text/html' }).end(body) : res.writeHead(404).end();
  });
  const root = tmpDir('design-qa-figma-drivers-');
  // The design PNGs: the app's own captures (same size, so the pixel diff passes).
  const assets = await startServer((req, res) => {
    const m = /^\/png\/([a-z-]+)\/([a-z-]+)$/.exec(req.url);
    const file = m && path.join(root, 'qa-reports', feature, 'evidence', 'screens', m[1], 'app', `${m[2]}.png`);
    return file && existsSync(file) ? res.writeHead(200, { 'content-type': 'image/png' }).end(readFileSync(file)) : res.writeHead(404).end();
  });
  t.after(() => Promise.all([app.close(), assets.close()]));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'design-qa.config.json'), JSON.stringify({ app: { baseUrl: app.url }, surfaces: {}, designSystem: { name: 'Acme UI', libraries: [] }, report: { commit: false } }));
  if (git) {
    // A local app in a git checkout: code changes make captures stale (the config is not code).
    const g = (...args) => execFileSync('git', ['-c', 'user.name=QA', '-c', 'user.email=qa@example.com', ...args], { cwd: root, stdio: 'ignore' });
    writeFileSync(path.join(root, 'app.js'), '// the app\n');
    g('init', '-q');
    g('add', 'app.js', 'design-qa.config.json');
    g('commit', '-q', '-m', 'app');
  }
  const pass = (args) => run(script('pass.mjs'), args, { cwd: root, env: ENV, timeout: 180000 });
  let s = await pass(['start', '--feature', feature, '--url', `${app.url}/orders`, '--design', link, '--agent', 'figma-mcp=yes', '--agent', 'ticket-mcp=no', '--quick']);
  if (/^Setup: waiting for the person/m.test(s.stdout)) s = await sh(root, nextOf(s.stdout));
  const startOut = s.stdout ?? s.out;
  assert.equal(s.code, 0, startOut + (s.stderr ?? ''));
  const id = /Run id: (\S+)/.exec(startOut)[1];
  const rel = `qa-reports/${feature}`;
  const dir = path.join(root, rel);
  mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  writeFileSync(path.join(dir, 'evidence', 'metadata.xml'), metadataXml(frames));
  writeFileSync(path.join(dir, 'frame-map.json'), JSON.stringify(frameMap));
  return { root, dir, rel, id, pass, assets, startNext: nextOf(startOut) };
}

/** Run each printed design-PNG command with the asset URL filled in. */
async function designPngs(root, out, assets) {
  const lines = out.split('\n').filter((l) => / → node .*figma-mcp-spec\.mjs --spec /.test(l));
  for (const line of lines) {
    const [screen, state] = line.trim().split(' ')[0].split('/');
    const r = await sh(root, line.slice(line.indexOf('→ ') + 2).replace(`'<get_screenshot url>'`, `'${assets.url}/png/${screen}/${state}'`));
    assert.equal(r.code, 0, `${line}\n${r.out}`);
  }
  return lines.length;
}

/** Metadata-only Figma evidence remains unverified despite matching pixels. */
async function reportMissingValues({ dir, rel, id, pass }, ids) {
  writeFileSync(path.join(dir, 'findings.json'), JSON.stringify({ kind: 'design-qa-findings', version: 1, findings: [], comparisons: reviewRecords(dir) }));
  const r = await pass(['report', '--dir', rel, '--run', id]);
  assert.equal(r.code, 3, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`· 0 of ${ids.length} states verified`), r.stdout);
  assert.doesNotMatch(r.stdout, /not implemented in the app|MISSING_IN_CODE/, r.stdout);
  const report = readJson(path.join(dir, 'report.json'));
  for (const state of ids) {
    const row = report.stateMatrix.find((x) => x.state === state);
    assert.ok(row?.implemented, `${state} is implemented`);
    assert.equal(row.result, 'CANNOT_VERIFY', `${state}: ${row.result} ${row.note}`);
    assert.ok(row.captured?.comparison?.pixelDiff, `${state} was compared with its design image`);
  }
  return r;
}

test('Figma section, two screens: --url routes the one screen nothing routes; states.json drivers keyed <screen>/<state> implement all five states; missing Figma values prevent verification', { timeout: 400000 }, async (t) => {
  if (!(await chromiumLaunches())) return t.skip('Chromium is not installed');
  const ctx = await startPass(t, {
    feature: 'mk-1',
    frames: [...LIST, DETAIL],
    frameMap: { '60:30': { screen: 'orders-list', state: 'hover-tile' }, '60:40': { screen: 'orders-list', state: 'hover-row' }, '60:50': { screen: 'order-detail', state: 'with-data' } },
  });
  const { root, dir, rel, id, pass, assets } = ctx;

  // Two screens, one --url: which screen it is cannot be told, so evidence stops (never exit 0)
  // and names both screens and where their routes go.
  const e1 = await sh(root, ctx.startNext);
  assert.equal(e1.code, 3, e1.out);
  const do1 = e1.out.split('\n').find((l) => l.startsWith('Do: '));
  assert.match(do1, /orders-list, order-detail into qa-reports\/mk-1\/states\.json/);
  assert.match(do1, /"screens":\{"orders-list":\{"route":"\/…"\},"order-detail":\{"route":"\/…"\}\}/);
  assert.equal(nextOf(e1.out), `${nextOf(e1.out).split(' evidence ')[0]} evidence --dir ${rel} --run ${id}`, 'Next re-runs evidence');
  // report --check with nothing captured points back to evidence, never at itself.
  const c0 = await sh(root, nextOf(e1.out).replace(/ evidence /, ' report ').concat(' --check'));
  assert.equal(c0.code, 3, c0.out);
  assert.match(c0.out, /Nothing was captured yet/);
  assert.match(nextOf(c0.out), / evidence --dir /);

  // A key that names no designed state is an error naming the designed ids.
  writeFileSync(path.join(dir, 'states.json'), JSON.stringify({ screens: { 'order-detail': { route: '/orders/1' } }, 'orders-list/hover-tlie': { action: 'hover', selector: '.tile' } }));
  const bad = await sh(root, nextOf(e1.out));
  assert.equal(bad.code, 3, bad.out);
  assert.match(bad.out, /1 key names no designed state .*"orders-list\/hover-tlie"/);
  assert.match(bad.out, /Designed states: orders-list\/with-data, orders-list\/empty, orders-list\/hover-row, orders-list\/hover-tile, order-detail\/with-data/);

  // The detail screen's route in states.json; the list screen is the one --url belongs to.
  writeFileSync(
    path.join(dir, 'states.json'),
    JSON.stringify({
      screens: { 'order-detail': { route: '/orders/1' } },
      'orders-list/empty': { query: '?empty=1', wait: '.empty' },
      'orders-list/hover-tile': { action: 'hover', selector: '.tile' },
      'orders-list/hover-row': { action: 'hover', selector: 'tr:nth-of-type(2)' },
    }),
  );
  const e2 = await sh(root, nextOf(e1.out));
  assert.equal(e2.code, 3, e2.out);
  assert.match(e2.out, /capture\s+orders-list 4\/4 captured · order-detail 1\/1 captured/, e2.out);
  assert.doesNotMatch(e2.out, /not a designed state|no route|PARTIAL/);
  const matrix = readJson(path.join(dir, 'state-matrix.json'));
  for (const row of matrix) assert.ok(row.implemented && row.result === 'CANNOT_VERIFY', `${row.state}: ${row.result}`);
  assert.equal(await designPngs(root, e2.out, assets), 5);

  const e3 = await pass(['evidence', '--dir', rel, '--run', id]);
  assert.equal(e3.code, 0, e3.stdout + e3.stderr);
  assert.match(e3.stdout, /Pixel diff: 5 pairs · 5 pass/);
  await reportMissingValues(ctx, matrix.map((r) => r.state));
  // Keeping the drivers for the next pass keeps the route --url gave too.
  const keep = await pass(['save-drivers', '--dir', rel, '--run', id, '--dry-run']);
  assert.match(keep.stdout, /screens\.orders-list\.route \(new\)/, keep.stdout);
  assert.match(keep.stdout, /states\.orders-list\/hover-tile \(new\)/);
});

test('Figma section, one screen: --url is its route, plain states.json keys drive hover-tile and hover-row, all four reached; missing Figma values prevent verification', { timeout: 400000 }, async (t) => {
  if (!(await chromiumLaunches())) return t.skip('Chromium is not installed');
  const ctx = await startPass(t, { feature: 'mk-2', git: true, frames: LIST, frameMap: { '60:30': { screen: 'orders-list', state: 'hover-tile' }, '60:40': { screen: 'orders-list', state: 'hover-row' } } });
  const { root, dir, rel, id, pass, assets } = ctx;
  writeFileSync(path.join(dir, 'states.json'), JSON.stringify({ empty: { query: '?empty=1', wait: '.empty' }, 'hover-tile': { action: 'hover', selector: '.tile' }, 'hover-row': { action: 'hover', selector: 'tr:nth-of-type(2)' } }));
  const e1 = await sh(root, ctx.startNext);
  assert.equal(e1.code, 3, e1.out);
  assert.match(e1.out, /capture\s+orders-list 4\/4 captured/, e1.out);
  assert.doesNotMatch(e1.out, /not a designed state|no route/);
  assert.equal(await designPngs(root, e1.out, assets), 4);
  const e2 = await pass(['evidence', '--dir', rel, '--run', id]);
  assert.equal(e2.code, 0, e2.stdout + e2.stderr);
  const r = await reportMissingValues(ctx, ['orders-list/with-data', 'orders-list/empty', 'orders-list/hover-row', 'orders-list/hover-tile']);
  assert.match(r.stdout, /^INCOMPLETE · /m);

  // Config staleness: what another run's apply writes that cannot change the result (a null
  // ticket address, the Figma access, key order) leaves the evidence up to date ...
  const cfgFile = path.join(root, 'design-qa.config.json');
  const cfg = readJson(cfgFile);
  const status = async () => (await pass(['status', '--dir', rel, '--run', id])).stdout;
  writeFileSync(cfgFile, JSON.stringify({ ticket: { provider: 'jira', baseUrl: null }, figma: { access: ['mcp'] }, ...cfg, app: { ...cfg.app, start: 'npm run dev' } }, null, 4));
  assert.match(await status(), /^ {2}evidence {2}up to date$/m);
  assert.match(await status(), /^ {2}report {4}valid · INCOMPLETE/m);
  // A code change still does.
  writeFileSync(path.join(root, 'app.js'), '// the app, changed\n');
  assert.match(await status(), /^ {2}evidence {2}stale: capture/m);
  writeFileSync(path.join(root, 'app.js'), '// the app\n');
  // ... a changed token path or a new driver does not.
  writeFileSync(cfgFile, JSON.stringify({ ...cfg, designSystem: { ...cfg.designSystem, tokens: ['tokens.json'] } }));
  assert.match(await status(), /^ {2}evidence {2}stale: /m);
  writeFileSync(cfgFile, JSON.stringify({ ...cfg, surfaces: { mk: { route: '/orders', states: { 'orders-list/empty': { query: '?empty=2' } } } } }));
  assert.match(await status(), /^ {2}evidence {2}stale: /m);
});

test('Figma section, one screen, only with-data captured (the rest recorded as unreachable): INCOMPLETE, and report and render name what to capture next', { timeout: 400000 }, async (t) => {
  if (!(await chromiumLaunches())) return t.skip('Chromium is not installed');
  const ctx = await startPass(t, { feature: 'mk-3', frames: LIST, frameMap: { '60:30': { screen: 'orders-list', state: 'hover-tile' }, '60:40': { screen: 'orders-list', state: 'hover-row' } } });
  const { root, dir, rel, id, pass, assets } = ctx;
  const why = { result: 'CANNOT_VERIFY', note: 'The test app cannot be put into this state.' };
  const findings = { kind: 'design-qa-findings', version: 1, findings: [], states: { 'orders-list/empty': why, 'orders-list/hover-row': why, 'orders-list/hover-tile': why } };
  writeFileSync(path.join(dir, 'findings.json'), JSON.stringify(findings));
  const e1 = await sh(root, ctx.startNext);
  assert.equal(e1.code, 3, e1.out);
  assert.equal(await designPngs(root, e1.out, assets), 1);
  const e2 = await pass(['evidence', '--dir', rel, '--run', id]);
  assert.equal(e2.code, 0, e2.stdout + e2.stderr);
  const current = readJson(path.join(dir, 'findings.json'));
  current.comparisons = reviewRecords(dir);
  writeFileSync(path.join(dir, 'findings.json'), JSON.stringify(current));
  const r = await pass(['report', '--dir', rel, '--run', id]);
  assert.equal(r.code, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /^INCOMPLETE · .* · 0 of 4 states verified$/m);
  assert.match(r.stdout, /^Do: INCOMPLETE is not a result: resolve the missing Figma\/code values and counterparts/m);
  assert.match(nextOf(r.stdout), / evidence --dir /, 'Next goes back to the evidence, not to a review');
  const st = await pass(['status', '--dir', rel, '--run', id]);
  assert.match(nextOf(st.stdout), / evidence --dir /);
  const html = path.join(dir, 'logs', 'again.html');
  const rr = await run(script('render-report.mjs'), ['--in', path.join(dir, 'report.json'), '--out', html, '--run', id], { cwd: root, env: ENV });
  assert.match(rr.stderr, /verdict INCOMPLETE: resolve the missing Figma\/code values and counterparts/);
  assert.doesNotMatch(rr.stderr, /nothing was captured and compared/);
});

test('drivers saved in the config ("<screen>/<state>" keys) reach exactly the state they spell; never a backfill candidate; states.json wins', () => {
  const figmaSpec = {
    nodeId: '60:10',
    name: 'Orders list',
    states: [
      { state: 'with-data', nodeId: '60:10' },
      { state: 'empty', nodeId: '60:20' },
      { state: 'hover-tile', nodeId: '60:30' },
      { state: 'hover-row', nodeId: '60:40' },
    ],
  };
  const config = {
    surfaces: {
      s: {
        route: '/orders',
        states: { 'orders-list/empty': { query: '?empty=1' }, 'orders-list/hover-tile': { action: 'hover', selector: '.tile' }, 'orders-list/hover-row': { action: 'hover', selector: 'tr' }, 'other/hover-row': { action: 'click', selector: '#x' } },
      },
    },
  };
  const rows = buildStateMatrix({ figmaSpec, config, surface: 's', screen: 'orders-list' });
  assert.deepEqual(rows.map((r) => [r.state, r.implemented?.detail ?? null, r.result]), [
    ['orders-list/with-data', 'default render of /orders', 'CANNOT_VERIFY'],
    ['orders-list/empty', 'query ?empty=1', 'CANNOT_VERIFY'],
    ['orders-list/hover-row', 'hover tr', 'CANNOT_VERIFY'],
    ['orders-list/hover-tile', 'hover .tile', 'CANNOT_VERIFY'],
  ]);
  assert.deepEqual(discoverUndesigned({ figmaSpec, config, surface: 's', screen: 'orders-list' }), [], 'no "hover" backfill state folded out of hover-tile');
  // The pass's file wins over the config for the same state.
  const won = buildStateMatrix({ figmaSpec, config, surface: 's', screen: 'orders-list', passStates: { 'hover-row': { action: 'hover', selector: 'tr:nth-of-type(2)' } } });
  assert.equal(won.find((r) => r.state === 'orders-list/hover-row').implemented.detail, 'hover tr:nth-of-type(2)');

  // A row the plan drives is implemented even when discovery did not see the driver.
  const missing = [{ state: 'a/hover-tile', screen: 'a', implemented: null, result: 'MISSING_IN_CODE', note: 'x', designed: { frame: { width: 10, height: 10 } } }];
  const plan = planEvidence({ matrix: missing, passDrivers: { states: { 'a/hover-tile': { action: 'hover', selector: '.t' } }, screens: { a: { route: '/a' } } } });
  const [row] = annotateMatrix(missing, plan);
  assert.equal(row.result, 'CANNOT_VERIFY');
  assert.equal(row.implemented.driver, 'action');

  // states.json keys: exact ids, names that map to one, and strays.
  const ids = ['m/with-data', 'm/empty', 'm/hover-tile', 'd/with-data'];
  assert.equal(designedIdFor('m/hover-tile', ids), 'm/hover-tile');
  assert.equal(designedIdFor('hover-tile', ids), 'm/hover-tile');
  assert.equal(designedIdFor('Empty', ids), 'm/empty');
  assert.equal(designedIdFor('m/hover-row', ids), null);
  assert.equal(designedIdFor('d/empty', ids), null);
  assert.equal(designedIdFor('hover-tile', ['with-data', 'hover-tile']), 'hover-tile');
});
