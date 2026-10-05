// The pass's own drivers (<dir>/states.json): merged over the config, validated, only the
// affected states captured again; driver suggestions from the with-data capture; the
// partial-coverage line; pass.mjs save-drivers into the config.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createPng, writePng } from '../skills/design-qa/scripts/lib/png.mjs';
import { actionFor, driverFor, mockKind, planEvidence, readPassDrivers, shortSelector, suggestDrivers } from '../skills/design-qa/scripts/lib/pass.mjs';
import { fixture, run, script, sendJson, startServer, tmpDir } from './_helpers.mjs';

const PASS = script('pass.mjs');
const OTHER_RUN = '20261004T000000Z-abcdef';
const ENV = { DESIGN_QA_COMMIT: 'c', DESIGN_QA_BRANCH: 'b', DESIGN_QA_RUN_ID: '', FIGMA_TOKEN: '', DESIGN_QA_APP_STORAGE_STATE: '', DESIGN_QA_NO_DISPLAY: '1' };
const pass = (cwd, args) => run(PASS, args, { cwd, env: ENV, timeout: 180000 });
const nextLine = (out) => out.trim().split('\n').filter((l) => l.startsWith('Next: ')).pop() ?? '';
const doLines = (out) => out.trim().split('\n').filter((l) => l.startsWith('Do: ')).join('\n');

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

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

test('readPassDrivers: drivers checked like the config\'s, mistakes named by key, routes, comments', () => {
  const dir = tmpDir();
  assert.equal(readPassDrivers(dir).exists, false);
  writeFileSync(
    path.join(dir, 'states.json'),
    JSON.stringify({
      $comment: 'drivers for this pass',
      'orders/empty': { query: '?empty=1' },
      hover: { action: 'hover' },
      ghost: { wait: '.x' },
      loading: 'slow',
      'orders/typo-state': { query: '?x=1' },
      screens: { help: { route: '/help' }, Bad_Id: { route: '/x' }, faq: {} },
    }),
  );
  const r = readPassDrivers(dir, { designed: ['orders/with-data', 'orders/empty', 'orders/hover', 'orders/loading'] });
  assert.deepEqual(Object.keys(r.states).sort(), ['orders/empty', 'orders/typo-state']);
  assert.deepEqual(r.screens, { help: { route: '/help' } });
  const problems = r.problems.join('\n');
  assert.match(problems, /states\.json "hover": action "hover" needs a "selector"/);
  assert.match(problems, /states\.json "ghost": drives nothing/);
  assert.match(problems, /states\.json "loading": the driver must be an object/);
  assert.match(problems, /states\.json "screens"\.Bad_Id: a screen id is kebab-case/);
  assert.match(problems, /states\.json "screens"\.faq: expected \{ "route"/);
  assert.match(r.warnings.join('\n'), /"orders\/typo-state": not a designed state/);
  writeFileSync(path.join(dir, 'states.json'), '{ nope');
  assert.match(readPassDrivers(dir).problems[0], /states\.json: not valid JSON/);
  rmSync(dir, { recursive: true, force: true });
});

test('driverFor / planEvidence: the pass file wins over the config, its routes complete unrouted screens', () => {
  const surface = { route: '/', screens: { orders: { route: '/orders' } }, states: { empty: { query: '?config=1' } } };
  const passStates = { empty: { query: '?pass=1' } };
  assert.deepEqual(driverFor(surface, { screen: 'orders', state: 'empty', passStates }), { key: 'empty', driver: { query: '?pass=1' }, from: 'pass' });
  assert.equal(driverFor(surface, { screen: 'orders', state: 'empty' }).from, 'config');
  const matrix = [
    { state: 'orders/empty', screen: 'orders', designed: { frame: { width: 1440, height: 900 } } },
    { state: 'help/with-data', screen: 'help', designed: { frame: { width: 1440, height: 900 } } },
  ];
  const census = { screens: [{ id: 'orders', frame: { width: 1440, height: 900 }, states: [] }, { id: 'help', frame: { width: 1440, height: 900 }, states: [] }] };
  const without = planEvidence({ matrix, census, surface, surfaceName: 'shop' });
  assert.equal(without.screens[1].states[0].status, 'no-route');
  assert.match(without.screens[1].states[0].note, /"screens": \{ "help": \{ "route"/);
  const plan = planEvidence({ matrix, census, surface, surfaceName: 'shop', passDrivers: { states: passStates, screens: { help: { route: '/help' } } } });
  assert.deepEqual(plan.screens[0].states[0].driver, { query: '?pass=1' });
  assert.equal(plan.screens[0].states[0].driverFrom, 'pass');
  assert.equal(plan.screens[1].states[0].status, 'planned');
  assert.equal(plan.screens[1].passRoute, '/help');
  assert.equal(plan.screens[0].passRoute, null, 'a config route stays the config\'s (--screen)');
});

const el = (i, p, tag, extra = {}) => ({ i, p, tag, id: null, cls: [], role: null, attrs: {}, text: null, control: null, rect: { x: 0, y: i * 40, w: 100, h: 30 }, vis: { x: 0, y: i * 40, w: 100, h: 30 }, path: `body > ${tag}:nth-of-type(${i})`, ...extra });
const AUDIT = {
  elements: [
    el(0, -1, 'body'),
    el(1, 0, 'button', { control: 'button', text: 'Export' }),
    el(2, 0, 'button', { control: 'button', attrs: { 'data-testid': 'open-side-panel' } }),
    el(3, 2, 'span', { text: 'Details' }),
    el(4, 0, 'button', { control: 'tab', role: 'tab', text: 'Archived orders' }),
    el(5, 0, 'a', { control: 'link', text: 'Order 1042', rect: { x: 600, y: 400, w: 120, h: 24 } }),
    el(6, 0, 'button', { control: 'button', text: 'Row actions', attrs: { 'aria-label': 'Row actions' }, rect: { x: 1300, y: 410, w: 24, h: 24 } }),
  ],
};

test('suggestDrivers: a click state by its words, a tab, an overlay by its position, a hover target, a mock from the data requests', () => {
  assert.equal(actionFor('side-panel'), 'click');
  assert.equal(actionFor('row-hover'), 'hover');
  assert.equal(actionFor('row-menu', 'hover'), 'hover');
  assert.deepEqual(['empty', 'no-results', 'loading', 'error', 'side-panel'].map(mockKind), ['empty', 'empty', 'loading', 'error', null]);
  assert.equal(shortSelector(AUDIT.elements[4], 'Archived orders'), '[role=tab]:has-text("Archived orders")');

  const side = suggestDrivers({ id: 'orders/side-panel', local: 'side-panel', designName: 'Orders – Side panel', screenName: 'orders', audit: AUDIT });
  assert.deepEqual(side.lines, ['"orders/side-panel": {"action":"click","selector":"[data-testid=\\"open-side-panel\\"]"}']);
  const tab = suggestDrivers({ id: 'orders/archived', local: 'archived', designName: 'Orders – Archived tab', screenName: 'orders', audit: AUDIT });
  assert.match(tab.lines[0], /"selector":"\[role=tab\]:has-text\(\\"Archived orders\\"\)"/);
  const overlay = suggestDrivers({ id: 'orders/row-menu', local: 'row-menu', designName: 'Menu', screenName: 'orders', trigger: 'click', audit: AUDIT, anchor: { x: 1290, y: 440 } });
  assert.match(overlay.lines[0], /"action":"click","selector":"button\[aria-label=\\"Row actions\\"\]"/);
  assert.match(overlay.how, /nearest where the design places the overlay first/);
  const placed = suggestDrivers({ id: 'orders/popper', local: 'popper', designName: 'Popper', screenName: 'orders', trigger: 'hover', audit: AUDIT, anchor: { x: 650, y: 430 } });
  assert.match(placed.lines[0], /"action":"hover","selector":"a:has-text\(\\"Order 1042\\"\)"/, 'no name match: the control nearest the overlay');
  assert.match(placed.how, /nearest where the design places the hover overlay/);
  const hover = suggestDrivers({ id: 'hover', local: 'hover', audit: AUDIT });
  assert.equal(hover.lines.length, 3);
  assert.match(hover.lines[0], /^"hover": \{"action":"hover","selector":/);
  const none = suggestDrivers({ id: 'orders/bulk-edit', local: 'bulk-edit', designName: 'Bulk edit', screenName: 'orders', audit: AUDIT });
  assert.deepEqual(none.lines, []);
  assert.match(none.how, /no control matches "bulk edit"/);

  const empty = suggestDrivers({ id: 'orders/empty', local: 'empty', requests: ['/api/orders', '/api/me'] });
  assert.equal(empty.lines[0], '"orders/empty": {"mock":{"urlPattern":"**/api/orders*","status":200,"body":[]}}');
  assert.match(suggestDrivers({ id: 'loading', local: 'loading', requests: ['/api/orders'] }).lines[0], /"delayMs":60000/);
  assert.match(suggestDrivers({ id: 'error', local: 'error', requests: ['/api/orders'] }).lines[0], /"status":500/);
  assert.match(suggestDrivers({ id: 'empty', local: 'empty', requests: [] }).how, /no data request was seen/);
});

// ---------------------------------------------------------------------------
// End to end on a Figma section (spec from saved MCP metadata)
// ---------------------------------------------------------------------------

const ORDERS = `<!doctype html><html><head><meta charset="utf-8"><title>Orders</title>
<style>body{margin:0;font:16px/1.5 Arial,sans-serif}header{padding:16px 24px;border-bottom:1px solid #ddd}.row{padding:12px 24px;border-bottom:1px solid #eee}.empty{padding:24px}aside{padding:24px;border-left:1px solid #ddd}</style></head>
<body><header><h1>Orders</h1><button type="button" id="panel-toggle">Open side panel</button><button type="button">Export</button></header><main id="app"><p>Loading…</p></main><aside hidden>Details</aside>
<script>
document.getElementById('panel-toggle').addEventListener('click', () => { document.querySelector('aside').hidden = false; });
fetch('/api/orders?page=1').then((r) => r.json()).then((items) => {
  document.getElementById('app').innerHTML = items.length ? items.map((i) => '<div class="row">' + i.name + '</div>').join('') : '<p class="empty">No orders yet</p>';
});
</script></body></html>`;

test('pass.mjs evidence with states.json: partial line, suggestions, only affected states captured again, mistakes named; save-drivers', { timeout: 300000 }, async (t) => {
  if (!CHROMIUM) return t.skip('Chromium is not installed (run `npx playwright install chromium`)');
  const server = await startServer((req, res) => {
    if (req.url.startsWith('/api/orders')) return sendJson(res, 200, Array.from({ length: 20 }, (_, i) => ({ name: `Order ${i + 1}` })));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(ORDERS);
  });
  const root = tmpDir('design-qa-drivers-');
  t.after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const config = { app: { baseUrl: server.url }, surfaces: { orders: { route: '/orders', screens: { orders: { route: '/orders' } } } }, designSystem: { name: 'Acme UI' }, report: { commit: false } };
  const configFile = path.join(root, 'design-qa.config.json');
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  const figmaUrl = 'https://www.figma.com/design/AbCdEf123/Acme?node-id=12-300';
  const s = await pass(root, ['start', '--feature', 'abc-400', '--design', figmaUrl, '--agent', 'figma-mcp=yes', '--agent', 'ticket-mcp=no', '--quick']);
  assert.equal(s.code, 0, s.stdout + s.stderr);
  const id = /Run id: (\S+)/.exec(s.stdout)[1];
  const rel = 'qa-reports/abc-400';
  const dir = path.join(root, rel);
  mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  const spec = await run(script('figma-mcp-spec.mjs'), ['--metadata', fixture('mcp-metadata-section.xml'), '--url', figmaUrl, '--out', path.join(dir, 'evidence')], { cwd: root });
  assert.equal(spec.code, 0, spec.stderr);
  writeFileSync(path.join(dir, 'frame-map.json'), JSON.stringify({ '12:450': { screen: 'orders', state: 'bulk-edit' } }));
  for (const [screen, state, w, h] of [['orders', 'with-data', 1440, 1024], ['orders', 'empty', 1440, 1024], ['orders', 'side-panel', 1440, 1024], ['orders-600', 'with-data', 600, 1600]]) {
    const f = path.join(dir, 'evidence', 'screens', screen, 'figma', `${state}.png`);
    mkdirSync(path.dirname(f), { recursive: true });
    writePng(f, createPng(w, h, [255, 255, 255, 255]));
  }

  // First pass: only with-data is driven; the rest is partial, with suggestions.
  const e1 = await pass(root, ['evidence', '--dir', rel, '--run', id]);
  assert.equal(e1.code, 3, e1.stdout + e1.stderr);
  const lines = e1.stdout.trim().split('\n');
  assert.ok(lines.length <= 43, `${lines.length} lines`);
  assert.match(e1.stdout, /^PARTIAL: 5 of 7 designed states not captured: 5 need a driver \(add it to qa-reports\/abc-400\/states\.json\)\. Until they are, the report says the match covers 2 of 7 states\.$/m);
  assert.match(e1.stdout, /^Driver suggestions \(all 5 in qa-reports\/abc-400\/driver-suggestions\.md/m);
  assert.match(nextLine(e1.stdout), /pass\.mjs evidence --dir qa-reports\/abc-400 --run \S+$/, 'designed states nothing drives stop the stage');
  assert.match(doLines(e1.stdout), /^Do: For each of orders\/empty, orders\/loading, orders\/bulk-edit, orders\/row-menu, orders\/side-panel: write its driver to qa-reports\/abc-400\/states\.json/m);
  const capture = JSON.parse(readFileSync(path.join(dir, 'evidence', 'screens', 'orders', 'capture.json'), 'utf8'));
  assert.deepEqual(capture.states['with-data'].requests, ['/api/orders'], 'paths only, no query');
  const md = readFileSync(path.join(dir, 'driver-suggestions.md'), 'utf8');
  assert.match(md, /"orders\/side-panel": \{"action":"click","selector":"#panel-toggle"\}/);
  assert.match(md, /"orders\/empty": \{"mock":\{"urlPattern":"\*\*\/api\/orders\*","status":200,"body":\[\]\}\}/);
  assert.match(md, /"orders\/loading": \{"mock":\{"urlPattern":"\*\*\/api\/orders\*","delayMs":60000\}\}/);
  assert.match(md, /## orders\/bulk-edit\n\nNo suggestion: no control matches "bulk edit"\. Look one up: node \S*scripts\/inspect\.mjs --dir qa-reports\/abc-400 --state orders\/with-data --text '<label>'/);

  // A mistake in states.json stops the stage and names the key.
  writeFileSync(path.join(dir, 'states.json'), JSON.stringify({ 'orders/side-panel': { action: 'click' } }));
  const bad = await pass(root, ['evidence', '--dir', rel, '--run', id]);
  assert.equal(bad.code, 3, bad.stdout);
  assert.match(bad.stdout, /states\.json "orders\/side-panel": action "click" needs a "selector"/);
  assert.match(doLines(bad.stdout), /Fix them in qa-reports\/abc-400\/states\.json/);
  assert.match(nextLine(bad.stdout), /pass\.mjs evidence --dir qa-reports\/abc-400 --run \S+$/);

  // The suggested drivers, pasted: only those two states are captured; with-data is not.
  const shot = () => statSync(path.join(dir, 'evidence', 'screens', 'orders', 'app', 'with-data.png')).mtimeMs;
  const before = shot();
  writeFileSync(
    path.join(dir, 'states.json'),
    JSON.stringify({ 'orders/side-panel': { action: 'click', selector: '#panel-toggle' }, 'orders/empty': { mock: { urlPattern: '**/api/orders*', status: 200, body: [] }, wait: '.empty' } }, null, 2),
  );
  const e2 = await pass(root, ['evidence', '--dir', rel, '--run', id]);
  assert.equal(e2.code, 3, e2.stdout + e2.stderr);
  assert.match(doLines(e2.stdout), /For each of orders\/loading, orders\/bulk-edit, orders\/row-menu: write its driver/);
  assert.match(e2.stdout, /^PARTIAL: 3 of 7 designed states not captured/m);
  assert.equal(shot(), before, 'with-data was not captured again');
  const logs = ['side-panel', 'empty'].map((st) => readFileSync(path.join(dir, 'logs', `capture-orders-${st}.log`), 'utf8'));
  assert.match(logs[0], /--state side-panel/);
  assert.match(logs[1], /--state empty/);
  const cap2 = JSON.parse(readFileSync(path.join(dir, 'evidence', 'screens', 'orders', 'capture.json'), 'utf8'));
  assert.ok(cap2.states['side-panel'].screenshot && cap2.states.empty.screenshot);
  const dom = JSON.parse(readFileSync(path.join(dir, 'evidence', 'screens', 'orders', 'dom', 'empty.json'), 'utf8'));
  assert.match(JSON.stringify(dom), /No orders yet/);
  const again = await pass(root, ['evidence', '--dir', rel, '--run', id]);
  assert.match(again.stdout, /capture\s+orders \d\/\d captured \(up to date\)/);

  // save-drivers: offered, dry run first, refused for another run, then written and validated.
  const original = readFileSync(configFile, 'utf8');
  const foreign = await pass(root, ['save-drivers', '--dir', rel, '--run', OTHER_RUN]);
  assert.equal(foreign.code, 5);
  const dry = await pass(root, ['save-drivers', '--dir', rel, '--run', id, '--dry-run']);
  assert.equal(dry.code, 0, dry.stdout + dry.stderr);
  assert.match(dry.stdout, /^Would change design-qa\.config\.json \(2 changes\):/m);
  assert.match(dry.stdout, /surfaces\.orders\.states\.orders\/empty \(new\)/);
  assert.equal(readFileSync(configFile, 'utf8'), original, 'a dry run writes nothing');
  assert.match(nextLine(dry.stdout), /^Next: node \S*scripts\/pass\.mjs save-drivers --dir qa-reports\/abc-400 --run \S+$/);
  assert.match(doLines(dry.stdout), /run the next command only if they agree/);
  const saved = await pass(root, ['save-drivers', '--dir', rel, '--run', id]);
  assert.equal(saved.code, 0, saved.stdout + saved.stderr);
  const after = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.deepEqual(after.surfaces.orders.states['orders/side-panel'], { action: 'click', selector: '#panel-toggle' });
  const nothing = await pass(root, ['save-drivers', '--dir', rel, '--run', id]);
  assert.match(nothing.stdout, /already has every driver/);
  const fin = await pass(root, ['finish', '--dir', rel, '--run', id]);
  assert.equal(fin.code, 0);
  assert.doesNotMatch(fin.stdout, /for this pass only/, 'nothing left to offer');

  // A secret in states.json never reaches the tracked config.
  writeFileSync(path.join(dir, 'states.json'), JSON.stringify({ 'orders/loading': { action: 'click', selector: '#reload', storage: { localStorage: { auth: 'Bearer abcdefghijklmnop0123' } } } }));
  const kept = readFileSync(configFile, 'utf8');
  const secret = await pass(root, ['save-drivers', '--dir', rel, '--run', id]);
  assert.equal(secret.code, 3, secret.stdout + secret.stderr);
  assert.match(secret.stdout, /^Not saved: states\.json "orders\/loading" looks like it holds an authorization header value\.$/m);
  assert.doesNotMatch(secret.stdout, /abcdefghijklmnop0123/);
  assert.equal(readFileSync(configFile, 'utf8'), kept);
});

test('pass.mjs finish offers save-drivers once when states.json has drivers the config lacks', { timeout: 120000 }, async () => {
  const root = tmpDir();
  writeFileSync(path.join(root, 'design-qa.config.json'), JSON.stringify({ app: { baseUrl: 'http://127.0.0.1:9' }, surfaces: { orders: { route: '/orders' } } }));
  const s = await pass(root, ['start', '--feature', 'abc-401', '--prototype', 'http://127.0.0.1:9/proto', '--agent', 'figma-mcp=no', '--agent', 'ticket-mcp=no', '--quick']);
  const id = /Run id: (\S+)/.exec(s.stdout)?.[1];
  assert.ok(id, s.stdout + s.stderr);
  writeFileSync(path.join(root, 'qa-reports', 'abc-401', 'states.json'), JSON.stringify({ empty: { query: '?empty=1' } }));
  const fin = await pass(root, ['finish', '--dir', 'qa-reports/abc-401', '--run', id]);
  assert.equal(fin.code, 0, fin.stdout + fin.stderr);
  // The pass is over: something to tell the person, not a step pending before "Next: nothing".
  assert.match(fin.stdout, /^Tell the person: the 1 state driver in qa-reports\/abc-401\/states\.json was for this pass only; if they want them kept for the next pass, that changes design-qa\.config\.json, a tracked file \(node \S*scripts\/pass\.mjs save-drivers --dir qa-reports\/abc-401 --run \S+ --dry-run shows the changes\)\.$/m);
  assert.doesNotMatch(fin.stdout, /ask the person first/);
  assert.equal(nextLine(fin.stdout), 'Next: nothing: the pass is finished');
  assert.equal(existsSync(path.join(root, 'qa-reports', 'abc-401', 'pass.json')), true);
  rmSync(root, { recursive: true, force: true });
});
