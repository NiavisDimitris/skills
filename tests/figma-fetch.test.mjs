import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parseVariantName, variantPropertiesOf } from '../skills/design-qa/scripts/lib/figma-spec.mjs';
import { createPng, encodePng, readPng } from '../skills/design-qa/scripts/lib/png.mjs';
import { loadFixture, run, script, sendJson, startServer, tmpDir } from './_helpers.mjs';

const FETCH = script('figma-fetch.mjs');
const TOKEN = 'figd_test_token_value';
const LINK = 'https://www.figma.com/design/AbCdEf123456/Items?node-id=1-2';

/** A fake Figma API + image CDN on one ephemeral server. */
async function figmaServer({ nodesStatus = 200, rateLimitOnce = false } = {}) {
  const png = encodePng(createPng(800, 600, [250, 250, 250, 255]));
  let limited = !rateLimitOnce;
  const server = await startServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/cdn/')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(png);
      return;
    }
    if (req.headers['x-figma-token'] !== TOKEN) return sendJson(res, 403, { status: 403, err: 'Invalid token' });
    if (url.pathname === '/v1/files/AbCdEf123456/nodes') {
      if (!limited) {
        limited = true;
        return sendJson(res, 429, { status: 429 }, { 'retry-after': '0' });
      }
      if (nodesStatus !== 200) return sendJson(res, nodesStatus, { status: nodesStatus, err: 'Forbidden' });
      return sendJson(res, 200, loadFixture('figma-nodes.json'));
    }
    if (url.pathname === '/v1/files/AbCdEf123456/variables/local') return sendJson(res, 403, { status: 403, error: true });
    if (url.pathname === '/v1/files/AbCdEf123456') return sendJson(res, 200, loadFixture('figma-file-depth2.json'));
    if (url.pathname === '/v1/images/AbCdEf123456') {
      const ids = url.searchParams.get('ids').split(',');
      const base = `http://127.0.0.1:${server.port}`;
      return sendJson(res, 200, { err: null, images: Object.fromEntries(ids.map((id) => [id, `${base}/cdn/${id.replace(/\W/g, '_')}.png`])) });
    }
    return sendJson(res, 404, { status: 404 });
  });
  return server;
}

test('parseVariantName / variantPropertiesOf', () => {
  assert.deepEqual(parseVariantName('State=Hover, Size=Large'), { State: 'Hover', Size: 'Large' });
  assert.equal(parseVariantName('Just a name'), null);
  assert.deepEqual(variantPropertiesOf({ type: 'COMPONENT', name: 'State=Disabled' }, { type: 'COMPONENT_SET' }), { State: 'Disabled' });
  assert.equal(variantPropertiesOf({ type: 'COMPONENT', name: 'State=Disabled' }, { type: 'FRAME' }), null);
  assert.deepEqual(
    variantPropertiesOf({ type: 'INSTANCE', componentId: '5:2' }, null, { '5:2': { name: 'State=Hover', componentSetId: '5:0' } }),
    { State: 'Hover' },
  );
});

test('figma-fetch: spec, states and one PNG per state; token only sent to the API', async () => {
  const server = await figmaServer({ rateLimitOnce: true });
  try {
    const out = tmpDir();
    const res = await run(FETCH, ['--url', LINK, '--out', out], {
      env: { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: server.url, DESIGN_QA_RETRY_BASE_MS: '5' },
    });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stderr, /nodes: HTTP 429, retry 1\/3/);
    assert.match(res.stderr, /figma-variables: GET variables\/local returned HTTP 403/);
    assert.match(res.stdout, /Capture with: --width 800 --height 600/);
    assert.ok(!res.stdout.includes(TOKEN) && !res.stderr.includes(TOKEN));

    const spec = JSON.parse(readFileSync(path.join(out, 'figma-spec.json'), 'utf8'));
    assert.equal(spec.fileKey, 'AbCdEf123456');
    assert.equal(spec.nodeId, '1:2');
    assert.deepEqual(spec.frame, { width: 800, height: 600 });
    assert.equal(spec.variables, null);
    assert.equal(spec.degradations[0].step, 'figma-variables');
    assert.deepEqual(spec.states.map((s) => `${s.state}:${s.nodeId}`), ['with-data:1:2', 'empty:1:20', 'loading:1:31', 'error:1:50', 'hover:1:10']);
    assert.deepEqual(spec.exports.map((e) => e.path), ['figma/with-data.png', 'figma/empty.png', 'figma/loading.png', 'figma/error.png', 'figma/hover.png']);
    for (const e of spec.exports) {
      assert.ok(existsSync(path.join(out, e.path)), e.path);
      assert.equal(readPng(path.join(out, e.path)).width, 800);
    }

    const nodesCall = server.requests.find((r) => r.url.startsWith('/v1/files/AbCdEf123456/nodes'));
    assert.match(nodesCall.url, /ids=1%3A2&geometry=paths/);
    const cdnCalls = server.requests.filter((r) => r.url.startsWith('/cdn/'));
    assert.equal(cdnCalls.length, 5);
    for (const r of cdnCalls) assert.equal(r.headers['x-figma-token'], undefined, 'no token to the CDN');
    const imagesCall = server.requests.find((r) => r.url.startsWith('/v1/images/'));
    assert.match(decodeURIComponent(imagesCall.url), /format=png&scale=1/);
  } finally {
    await server.close();
  }
});

test('figma-fetch: --states with explicit node ids replaces discovery', async () => {
  const server = await figmaServer();
  try {
    const out = tmpDir();
    // The fake nodes endpoint only knows 1:2; 1:20 is reported as not found.
    const res = await run(FETCH, ['--url', LINK, '--out', out, '--states', '1-20'], { env: { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: server.url } });
    assert.equal(res.code, 0, res.stderr);
    const spec = JSON.parse(readFileSync(path.join(out, 'figma-spec.json'), 'utf8'));
    assert.deepEqual(spec.states.map((s) => s.state), ['with-data']);
    assert.ok(spec.degradations.some((d) => d.step === 'figma-states' && /1:20 not found/.test(d.reason)));
  } finally {
    await server.close();
  }
});

test('figma-fetch: exit 6 when the token is missing or rejected, 2 for bad arguments', async () => {
  const server = await figmaServer({ nodesStatus: 403 });
  try {
    const rejected = await run(FETCH, ['--url', LINK, '--out', tmpDir()], { env: { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: server.url } });
    assert.equal(rejected.code, 6);
    assert.match(rejected.stderr, /file_content:read/);
    assert.ok(!rejected.stderr.includes(TOKEN));
  } finally {
    await server.close();
  }
  const noToken = await run(FETCH, ['--url', LINK, '--out', tmpDir()], { env: { FIGMA_TOKEN: '' } });
  assert.equal(noToken.code, 6);
  assert.match(noToken.stderr, /FIGMA_TOKEN is not set/);
  const env = { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: 'http://127.0.0.1:9' };
  assert.equal((await run(FETCH, ['--url', 'https://example.com/x', '--out', tmpDir()], { env })).code, 2);
  const noNode = await run(FETCH, ['--url', 'https://www.figma.com/design/AbCdEf123456/Items', '--out', tmpDir()], { env });
  assert.equal(noNode.code, 2);
  assert.match(noNode.stderr, /no node-id/);
  assert.equal((await run(FETCH, ['--url', LINK], { env })).code, 2, '--out is required');
  assert.equal((await run(FETCH, ['--url', LINK, '--out', tmpDir(), '--format', 'gif'], { env })).code, 2);
});

test('figma-fetch: figma-spec.json keeps prototype reactions and lists them as motion', async () => {
  const server = await figmaServer();
  try {
    const out = tmpDir();
    const res = await run(FETCH, ['--url', LINK, '--out', out], { env: { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: server.url } });
    assert.equal(res.code, 0, res.stderr);
    const spec = JSON.parse(readFileSync(path.join(out, 'figma-spec.json'), 'utf8'));
    const row = spec.layers.find((l) => l.id === '1:10');
    assert.equal(row.reactions[0].trigger.type, 'ON_HOVER');
    assert.ok(Array.isArray(spec.motion));
    const hover = spec.motion.find((m) => m.nodeId === '1:10');
    assert.deepEqual([hover.trigger, hover.type, hover.durationMs], ['hover', 'instant', 0], 'a reaction without a transition is an instant change');
  } finally {
    await server.close();
  }
});

// A page with three frames: "Cart" + "Cart – Empty" (one screen, two states) and "Profile".
const PAGE_KEY = 'PaGe123';
const frame = (id, name, x, children = []) => ({ id, name, type: 'FRAME', absoluteBoundingBox: { x, y: 0, width: 390, height: 844 }, children });
const CART = frame('1:1', 'Cart', 0, [
  {
    id: '1:5',
    name: 'Checkout button',
    type: 'INSTANCE',
    reactions: [
      {
        trigger: { type: 'ON_HOVER' },
        actions: [{ type: 'NODE', destinationId: '9:2', navigation: 'CHANGE_TO', transition: { type: 'SMART_ANIMATE', easing: { type: 'EASE_OUT' }, duration: 0.2 } }],
      },
    ],
  },
]);
const CART_EMPTY = frame('1:2', 'Cart – Empty', 400);
const PROFILE = frame('3:1', 'Profile', 800);
const PAGE = { id: '0:1', name: 'Checkout', type: 'CANVAS', children: [CART, CART_EMPTY, PROFILE] };

async function pageServer() {
  const png = encodePng(createPng(390, 844, [255, 255, 255, 255]));
  const docs = { '0:1': PAGE, '1:1': CART, '1:2': CART_EMPTY, '3:1': PROFILE };
  const server = await startServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/cdn/')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(png);
      return;
    }
    if (req.headers['x-figma-token'] !== TOKEN) return sendJson(res, 403, { status: 403 });
    if (url.pathname === `/v1/files/${PAGE_KEY}/nodes`) {
      const ids = url.searchParams.get('ids').split(',');
      return sendJson(res, 200, { name: 'Shop', nodes: Object.fromEntries(ids.map((id) => [id, docs[id] ? { document: docs[id], components: {}, componentSets: {}, styles: {} } : null])) });
    }
    if (url.pathname === `/v1/files/${PAGE_KEY}/variables/local`) return sendJson(res, 403, { status: 403 });
    if (url.pathname === `/v1/files/${PAGE_KEY}`) return sendJson(res, 200, { name: 'Shop', document: { id: '0:0', type: 'DOCUMENT', children: [PAGE] } });
    if (url.pathname === `/v1/images/${PAGE_KEY}`) {
      const ids = url.searchParams.get('ids').split(',');
      const base = `http://127.0.0.1:${server.port}`;
      return sendJson(res, 200, { err: null, images: Object.fromEntries(ids.map((id) => [id, `${base}/cdn/${id.replace(/\W/g, '_')}.png`])) });
    }
    return sendJson(res, 404, { status: 404 });
  });
  return server;
}

test('figma-fetch --screens auto: screens.json plus a spec and images per screen', async () => {
  const server = await pageServer();
  try {
    const out = tmpDir();
    const link = `https://www.figma.com/design/${PAGE_KEY}/Shop?node-id=0-1`;
    const res = await run(FETCH, ['--url', link, '--screens', 'auto', '--out', out], { env: { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: server.url } });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /2 screen\(s\)/);
    assert.match(res.stdout, /--out <dir>\/evidence\/screens\/cart/);

    const index = JSON.parse(readFileSync(path.join(out, 'screens.json'), 'utf8'));
    assert.deepEqual(
      index.screens.map((s) => [s.id, s.name, s.nodeId, s.states, s.frame]),
      [
        ['cart', 'Cart', '1:1', ['with-data', 'empty', 'hover'], { width: 390, height: 844 }],
        ['profile', 'Profile', '3:1', ['with-data'], { width: 390, height: 844 }],
      ],
    );
    assert.equal(index.screens[0].spec, 'screens/cart/figma-spec.json');
    // hover comes from the button's ON_HOVER reaction (state discovery, as for one frame).
    assert.deepEqual(index.screens[0].images, ['screens/cart/figma/with-data.png', 'screens/cart/figma/empty.png', 'screens/cart/figma/hover.png']);
    for (const img of [...index.screens[0].images, ...index.screens[1].images]) assert.equal(readPng(path.join(out, img)).width, 390, img);

    const cart = JSON.parse(readFileSync(path.join(out, 'screens', 'cart', 'figma-spec.json'), 'utf8'));
    assert.equal(cart.nodeId, '1:1');
    assert.deepEqual(cart.screen, { id: 'cart', name: 'Cart' });
    assert.deepEqual(cart.motion.map((m) => [m.trigger, m.type, m.durationMs, m.easing]), [['hover', 'smart-animate', 200, 'cubic-bezier(0,0,0.58,1)']]);
    assert.ok(existsSync(path.join(out, 'figma-spec.json')), 'the page spec is kept too');

    const screenNodes = server.requests.filter((r) => r.url.startsWith(`/v1/files/${PAGE_KEY}/nodes`));
    assert.equal(screenNodes.length, 2, 'the page, then every screen frame in one call');
    assert.match(decodeURIComponent(screenNodes[1].url), /ids=1:1,3:1/);
    assert.equal(server.requests.filter((r) => r.url.startsWith(`/v1/images/${PAGE_KEY}`)).length, 1, 'one export call for every screen');
  } finally {
    await server.close();
  }
  const env = { FIGMA_TOKEN: TOKEN, FIGMA_API_BASE: 'http://127.0.0.1:9' };
  assert.equal((await run(FETCH, ['--url', LINK, '--out', tmpDir(), '--screens', 'all'], { env })).code, 2);
  assert.equal((await run(FETCH, ['--url', LINK, '--out', tmpDir(), '--screens', 'auto', '--states', '1:20'], { env })).code, 2);
});
