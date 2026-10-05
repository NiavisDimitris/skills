// A Figma section with several state frames, through every path that names a state: the
// MCP converter, the REST fetch, state discovery (matrix + census) and the design-PNG
// command the pass prints. One id per frame everywhere; a frame is never dropped quietly.
// All Figma data here is invented and kept small.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createPng, encodePng } from '../skills/design-qa/scripts/lib/png.mjs';
import { stateId } from '../skills/design-qa/scripts/lib/state-discovery.mjs';
import { run, script, sendJson, startServer, tmpDir } from './_helpers.mjs';

const MCP = script('figma-mcp-spec.mjs');
const FETCH = script('figma-fetch.mjs');
const DISCOVER = script('lib/state-discovery.mjs');
const KEY = 'SeCtIoNkEy123';
const link = (node) => `https://www.figma.com/design/${KEY}/Shop?node-id=${node}`;
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const ENV = { DESIGN_QA_COMMIT: 'c', DESIGN_QA_BRANCH: 'b', DESIGN_QA_RUN_ID: '', FIGMA_TOKEN: '', DESIGN_QA_APP_STORAGE_STATE: '', DESIGN_QA_NO_DISPLAY: '1' };

// [id, name, x, height]: five frames beside each other, two pairs sharing a state word.
const FRAMES = [
  ['40:10', 'Catalog', 0, 2000],
  ['40:20', 'Catalog – Invoices – Empty', 1600, 2000],
  ['40:30', 'Catalog – Returns – Empty', 3200, 1500],
  ['40:40', 'Catalog – Hover tile', 4800, 2000],
  ['40:50', 'Catalog – Hover row', 6400, 2000],
];
const IDS = ['with-data', 'invoices-empty', 'returns-empty', 'hover-tile', 'hover-row'];

function metadataXml(frames = FRAMES, { title = '<text id="40:11" name="Title" x="40" y="20" width="200" height="32"/>' } = {}) {
  const inner = frames.map(([id, name, x, h], i) => `  <frame id="${id}" name="${name}" x="${x}" y="0" width="1440" height="${h}">${i === 0 ? title : ''}</frame>`);
  return `<section id="40:1" name="Catalog" x="0" y="0" width="9000" height="2400">\n${inner.join('\n')}\n</section>`;
}

const restSection = () => ({
  id: '40:1',
  name: 'Catalog',
  type: 'SECTION',
  absoluteBoundingBox: { x: 0, y: 0, width: 9000, height: 2400 },
  children: FRAMES.map(([id, name, x, h]) => ({ id, name, type: 'FRAME', absoluteBoundingBox: { x, y: 0, width: 1440, height: h }, children: [] })),
});

/** A fake Figma REST API for the section above (token path). */
async function restServer() {
  const section = restSection();
  const docs = Object.fromEntries([section, ...section.children].map((d) => [d.id, d]));
  const png = encodePng(createPng(4, 4));
  const server = await startServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/cdn/')) return res.writeHead(200, { 'content-type': 'image/png' }).end(png);
    if (url.pathname === `/v1/files/${KEY}/nodes`) {
      const ids = url.searchParams.get('ids').split(',');
      return sendJson(res, 200, { name: 'Shop', nodes: Object.fromEntries(ids.map((id) => [id, docs[id] ? { document: docs[id], components: {}, componentSets: {}, styles: {} } : null])) });
    }
    if (url.pathname === `/v1/images/${KEY}`) {
      const ids = url.searchParams.get('ids').split(',');
      return sendJson(res, 200, { err: null, images: Object.fromEntries(ids.map((id) => [id, `${server.url}/cdn/${id.replace(/\W/g, '_')}.png`])) });
    }
    return sendJson(res, 403, { status: 403 });
  });
  return server;
}

async function discover(spec, extra = []) {
  const dir = path.dirname(spec);
  const matrix = path.join(dir, 'state-matrix.json');
  const res = await run(DISCOVER, ['--figma-spec', spec, '--out', matrix, '--strict', ...extra]);
  return { res, rows: res.code === 0 ? readJson(matrix) : null, census: readJson(path.join(dir, 'design-census.json')) };
}

test('stateId: one normaliser for state ids, idempotent, never cut to a synonym inside the id', () => {
  for (const [value, id] of [['hover-tile', 'hover-tile'], ['Hover tile', 'hover-tile'], ['invoices-empty', 'invoices-empty'], ['With data', 'with-data'], ['  Empty ', 'empty'], ['', null], ['!!', null]]) {
    assert.equal(stateId(value), id, value);
    if (id) assert.equal(stateId(id), id, `${value}: idempotent`);
  }
});

test('a section of five frames: the MCP path, the token path and the matrix give each frame the same id, one row each', async () => {
  // MCP path.
  const mcp = tmpDir();
  const xml = path.join(mcp, 'metadata.xml');
  writeFileSync(xml, metadataXml());
  const conv = await run(MCP, ['--metadata', xml, '--url', link('40-1'), '--out', mcp, '--quiet']);
  assert.equal(conv.code, 0, conv.stderr);
  const mcpIds = readJson(path.join(mcp, 'screens.json')).screens.flatMap((s) => s.states);
  assert.deepEqual(mcpIds, IDS);

  // Token path, same section.
  const server = await restServer();
  const rest = tmpDir();
  try {
    const fetched = await run(FETCH, ['--url', link('40-1'), '--out', rest, '--quiet'], { env: { FIGMA_TOKEN: 'figd_test', FIGMA_API_BASE: server.url } });
    assert.equal(fetched.code, 0, fetched.stderr);
  } finally {
    await server.close();
  }
  const restIndex = readJson(path.join(rest, 'screens.json'));
  assert.deepEqual(restIndex.screens.flatMap((s) => s.states), IDS);
  assert.deepEqual(restIndex.screens[0].images, IDS.map((id) => `screens/catalog/figma/${id}.png`), 'each PNG under its state id');

  // The matrix: every frame the census maps is its own row, with the same id.
  for (const dir of [mcp, rest]) {
    const { res, rows, census } = await discover(path.join(dir, 'figma-spec.json'));
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /5 frame\(s\) under Catalog \(40:1\): 5 mapped, 0 unmapped/);
    assert.deepEqual(rows.map((r) => r.state).sort(), IDS.map((id) => `catalog/${id}`).sort());
    assert.deepEqual(rows.map((r) => r.designed.nodeId).sort(), census.frames.map((f) => f.nodeId).sort(), 'one row per census frame');
  }

  // The design-PNG command takes each matrix id as is.
  const png = path.join(mcp, 'shot.png');
  for (const [i, id] of IDS.entries()) {
    writeFileSync(png, encodePng(createPng(1440, FRAMES[i][3])));
    const saved = await run(MCP, ['--spec', path.join(mcp, 'figma-spec.json'), '--screen', 'catalog', '--state', id, '--png', png]);
    assert.equal(saved.code, 0, `${id}: ${saved.stderr}`);
  }
});

test('two frames that would share one id stop discovery (exit 3) and name both frames', async () => {
  const dir = tmpDir();
  const spec = path.join(dir, 'figma-spec.json');
  writeFileSync(spec, JSON.stringify({
    fileKey: KEY,
    nodeId: '7:1',
    name: 'Inbox',
    type: 'FRAME',
    frame: { width: 800, height: 600 },
    layers: [{ id: '7:1', name: 'Inbox', type: 'FRAME', depth: 0, absoluteBoundingBox: { x: 0, y: 0, width: 800, height: 600 } }],
    siblings: [],
    states: [
      { state: 'with-data', nodeId: '7:1', name: 'Inbox', source: 'frame-name' },
      { state: 'Empty', nodeId: '7:2', name: 'Inbox empty A', source: 'frame-name' },
      { state: 'empty', nodeId: '7:3', name: 'Inbox empty B', source: 'frame-name' },
    ],
  }));
  const { res } = await discover(spec);
  assert.equal(res.code, 3, res.stdout + res.stderr);
  assert.match(res.stderr, /7:2 "Inbox empty A"/);
  assert.match(res.stderr, /7:3 "Inbox empty B"/);
  assert.match(res.stderr, /share the state id "empty"/);
  assert.match(res.stderr, /frame map/);
});

test('variant values: "Hover tile" and "Hover row" are two states; two values with one id stop discovery', async () => {
  const set = (values) => ({
    fileKey: KEY,
    nodeId: '8:1',
    name: 'Tile',
    type: 'COMPONENT_SET',
    frame: { width: 400, height: 300 },
    layers: [
      { id: '8:1', name: 'Tile', type: 'COMPONENT_SET', depth: 0, absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 300 } },
      ...values.map((v, i) => ({ id: `8:${i + 2}`, name: `State=${v}`, type: 'COMPONENT', depth: 1, variantProperties: { State: v }, absoluteBoundingBox: { x: 0, y: i * 100, width: 400, height: 100 } })),
    ],
    siblings: [],
    states: [],
  });
  const dir = tmpDir();
  const spec = path.join(dir, 'figma-spec.json');
  writeFileSync(spec, JSON.stringify(set(['Default', 'Hover tile', 'Hover row', 'Pending orders'])));
  const { res, rows } = await discover(spec);
  assert.equal(res.code, 0, res.stderr);
  for (const id of ['with-data', 'hover-tile', 'hover-row', 'pending-orders']) assert.ok(rows.some((r) => r.state === id), `${id}: ${rows.map((r) => r.state)}`);
  assert.ok(!rows.some((r) => ['hover', 'loading'].includes(r.state)), 'never cut to a synonym inside the value');

  writeFileSync(spec, JSON.stringify(set(['Hover', 'Hovered'])));
  const clash = await discover(spec);
  assert.equal(clash.res.code, 3, clash.res.stdout + clash.res.stderr);
  assert.match(clash.res.stderr, /8:2 "State=Hover"/);
  assert.match(clash.res.stderr, /8:3 "State=Hovered"/);
});

test('figma-mcp-spec: a link to one frame of a saved section keeps the whole section, and says so', async () => {
  const dir = tmpDir();
  const xml = path.join(dir, 'metadata.xml');
  writeFileSync(xml, metadataXml());
  const res = await run(MCP, ['--metadata', xml, '--url', link('40-20'), '--out', dir]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout + res.stderr, /The link points at frame 40:20 .*one of 5 frames in section Catalog \(40:1\)/);
  const root = readJson(path.join(dir, 'figma-spec.json'));
  assert.deepEqual([root.type, root.nodeId], ['SECTION', '40:1']);
  assert.deepEqual(readJson(path.join(dir, 'screens.json')).screens.flatMap((s) => s.states), IDS);

  // Only the linked frame inside its section was saved: fetch the section.
  const one = tmpDir();
  const lone = path.join(one, 'metadata.xml');
  writeFileSync(lone, metadataXml(FRAMES.slice(1, 2)));
  const single = await run(MCP, ['--metadata', lone, '--url', link('40-20'), '--out', one]);
  assert.equal(single.code, 0, single.stderr);
  assert.match(single.stdout, /^Do: .*get_metadata on section Catalog \(40:1\)/m);
});

test('figma-mcp-spec: text content is kept when the metadata has it; a text layer without it gets none', async () => {
  const dir = tmpDir();
  const xml = path.join(dir, 'metadata.xml');
  writeFileSync(xml, metadataXml(FRAMES.slice(0, 1), { title: '<text id="40:11" name="Title" x="40" y="20" width="200" height="32">Spring catalog</text><text id="40:12" name="Subtitle" x="40" y="60" width="200" height="20"/>' }));
  const res = await run(MCP, ['--metadata', xml, '--url', link('40-10'), '--out', dir, '--quiet']);
  assert.equal(res.code, 0, res.stderr);
  const spec = readJson(path.join(dir, 'figma-spec.json'));
  const byId = Object.fromEntries(spec.layers.map((l) => [l.id, l]));
  assert.equal(byId['40:11'].characters, 'Spring catalog');
  assert.equal(byId['40:12'].characters, undefined, 'no text in the metadata: unknown, not the layer name');
  assert.ok(!spec.unavailable.includes('characters'), 'text content is available for this spec');
});

// ---------------------------------------------------------------------------
// The whole pass: discovery stop, a frame map that renames a state, the printed commands
// ---------------------------------------------------------------------------

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

test('pass on a section through MCP: one row per frame, and every printed design-PNG command runs as printed after a frame map', { timeout: 300000 }, async (t) => {
  if (!(await chromiumLaunches())) return t.skip('Chromium is not installed');
  const app = await startServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html><head><style>:root{--color-text:#111}body{margin:0;color:var(--color-text)}</style></head><body><h1>Catalog</h1></body></html>'));
  const assets = await startServer((req, res) => {
    const m = /^\/png\/(\d+)x(\d+)$/.exec(req.url);
    return m ? res.writeHead(200, { 'content-type': 'image/png' }).end(encodePng(createPng(Number(m[1]), Number(m[2])))) : res.writeHead(404).end();
  });
  t.after(() => Promise.all([app.close(), assets.close()]));
  const root = tmpDir('design-qa-section-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const drivers = Object.fromEntries([...IDS.slice(1), 'bulk-actions'].map((id, i) => [id, { query: `?s=${i}` }]));
  writeFileSync(path.join(root, 'design-qa.config.json'), JSON.stringify({
    app: { baseUrl: app.url },
    surfaces: { catalog: { route: '/catalog', screens: { catalog: { route: '/catalog' } }, states: drivers } },
    designSystem: { name: 'Acme UI', libraries: [] },
    report: { commit: false },
  }));
  const pass = (args) => run(script('pass.mjs'), args, { cwd: root, env: ENV, timeout: 180000 });
  let s = await pass(['start', '--feature', 'cat-1', '--design', link('40-1'), '--agent', 'figma-mcp=yes', '--agent', 'ticket-mcp=no', '--quick']);
  // Assumed setup values: the person agrees, the printed command saves them and starts again.
  if (/^Setup: waiting for the person/m.test(s.stdout)) s = await sh(root, s.stdout.trim().split('\n').pop().replace(/^Next: /, ''));
  const startOut = s.stdout ?? s.out;
  assert.equal(s.code, 0, startOut + (s.stderr ?? ''));
  const id = /Run id: (\S+)/.exec(startOut)[1];
  const rel = 'qa-reports/cat-1';
  const dir = path.join(root, rel);
  mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  // A sixth frame with a name of its own: a judgement call the frame map settles.
  writeFileSync(path.join(dir, 'evidence', 'metadata.xml'), metadataXml([...FRAMES, ['40:60', 'Bulk edit', 8000, 2000]]));
  const conv = await run(MCP, ['--metadata', path.join(dir, 'evidence', 'metadata.xml'), '--url', link('40-1'), '--out', path.join(dir, 'evidence'), '--quiet'], { cwd: root });
  assert.equal(conv.code, 0, conv.stderr);

  const e1 = await pass(['evidence', '--dir', rel, '--run', id]);
  assert.equal(e1.code, 3, e1.stdout + e1.stderr);
  assert.match(e1.stdout, /frame 40:60 "Bulk edit"/);
  writeFileSync(path.join(dir, 'frame-map.json'), JSON.stringify({ '40:60': { screen: 'catalog', state: 'bulk-actions' } }));

  const e2 = await pass(['evidence', '--dir', rel, '--run', id]);
  assert.equal(e2.code, 3, e2.stdout + e2.stderr);
  const matrix = readJson(path.join(dir, 'state-matrix.json'));
  const census = readJson(path.join(dir, 'design-census.json'));
  const all = [...IDS, 'bulk-actions'];
  assert.deepEqual(matrix.map((r) => r.state).sort(), all.map((x) => `catalog/${x}`).sort());
  assert.equal(matrix.length, census.frames.filter((f) => f.mappedTo?.screen).length, 'census and matrix agree');
  const lines = e2.stdout.split('\n').filter((l) => / → node .*figma-mcp-spec\.mjs --spec /.test(l));
  assert.equal(lines.length, all.length, e2.stdout);
  for (const line of lines) {
    const state = /^\s+catalog\/(\S+) → /.exec(line)[1];
    const frame = matrix.find((r) => r.state === `catalog/${state}`).designed.frame;
    const cmd = line.slice(line.indexOf('→ ') + 2).replace(`'<get_screenshot url>'`, `'${assets.url}/png/${frame.width}x${frame.height}'`);
    const r = await sh(root, cmd);
    assert.equal(r.code, 0, `${cmd}\n${r.out}`);
  }
  const e3 = await pass(['evidence', '--dir', rel, '--run', id]);
  assert.doesNotMatch(e3.stdout, /Design PNGs missing/, e3.stdout);
});
