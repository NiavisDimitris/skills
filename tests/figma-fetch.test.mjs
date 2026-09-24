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
