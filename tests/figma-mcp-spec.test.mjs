import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildFigmaSpec, siblingFrames } from '../skills/design-qa/scripts/lib/figma-spec.mjs';
import { checkAssetUrl, decodeEntities, mcpResultText, parseMetadataXml, readMetadata } from '../skills/design-qa/scripts/lib/figma-mcp.mjs';
import { createPng, encodePng, readPng } from '../skills/design-qa/scripts/lib/png.mjs';
import { validateStateMatrix } from '../skills/design-qa/scripts/lib/schema-check.mjs';
import { fixture, loadFixture, run, script, startServer, tmpDir } from './_helpers.mjs';

const MCP = script('figma-mcp-spec.mjs');
const DISCOVER = script('lib/state-discovery.mjs');
const KEY = 'AbCdEfGhIjKlMnOpQrStUv';
const FRAME_LINK = `https://www.figma.com/design/${KEY}/Acme?node-id=1-2`;
const SECTION_LINK = `https://www.figma.com/design/${KEY}/Acme?node-id=12-300`;
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

async function convert(args) {
  const out = tmpDir();
  const res = await run(MCP, [...args, '--out', out]);
  return { out, res };
}

test('the metadata reader tolerates wrapper text, unknown tags, entities, self-closing and unquoted attributes', () => {
  const text = [
    'Currently selected nodes:\n- 1:2 Home  (a < b, see <b>notes</b>)',
    '<?xml version="1.0"?><!-- comment <frame id="9:9"> -->',
    "<wrapper><frame id='1:2' name=\"Home &amp; away &#8211; &#x41;\" x=10 y=20 width=\"300\" height=\"200\">",
    '<widget id="1:3" name="Gizmo" x="5" y="5" width="10" height="10" data-extra="x"/>',
    '<text id="1:4" name="Title" x="1" y="2" width="3" height="4" hidden></frame></wrapper>',
    '</orphan> trailing notes',
  ].join('\n');
  const { docs } = readMetadata(text);
  assert.equal(docs.length, 1);
  const [home] = docs;
  assert.deepEqual([home.id, home.name, home.type], ['1:2', 'Home & away – A', 'FRAME']);
  assert.deepEqual(home.absoluteBoundingBox, { x: 10, y: 20, width: 300, height: 200 });
  assert.deepEqual(home.children.map((c) => [c.id, c.type, c.visible ?? true, c.absoluteBoundingBox.x]), [
    ['1:3', 'WIDGET', true, 15],
    ['1:4', 'TEXT', false, 11],
  ], 'unknown tags keep their name as type; x/y are summed down the tree; a bare hidden attribute hides');
  assert.equal(decodeEntities('&lt;a&gt; &bogus; &#0;'), '<a> &bogus; &#0;');
  assert.equal(mcpResultText(JSON.stringify({ content: [{ type: 'text', text: '<frame id="1:2"/>' }] })), '<frame id="1:2"/>');
  assert.equal(mcpResultText(JSON.stringify('<frame id="1:2"/>')), '<frame id="1:2"/>');
  // An unterminated tag is text, not an element; nesting is capped instead of overflowing the stack.
  assert.equal(parseMetadataXml('<frame id="1:2" name="x').roots.length, 0);
  const deep = parseMetadataXml(`${'<frame id="1:1">'.repeat(500)}`);
  assert.equal(deep.truncated, true);
});

test('figma-mcp-spec: a frame becomes the same figma-spec.json shape as the REST fetch, marked source "mcp"', async () => {
  const vars = path.join(tmpDir(), 'vars.json');
  writeFileSync(vars, JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ 'color/bg/default': '#FFFFFF', 'space/4': 16 }) }] }));
  const cc = path.join(tmpDir(), 'cc.json');
  writeFileSync(cc, JSON.stringify({ '1:10': { codeConnectSrc: 'src/Row.tsx', codeConnectName: 'Row', extra: 1 }, junk: {} }));
  const { out, res } = await convert(['--metadata', fixture('mcp-metadata-frame.xml'), '--url', FRAME_LINK, '--variables', vars, '--code-connect', cc]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Capture with: --width 800 --height 600/);
  assert.match(res.stdout, /get_screenshot\(fileKey "AbCdEfGhIjKlMnOpQrStUv", nodeId, maxDimension\)/);
  assert.match(res.stdout, /--spec \S*figma-spec\.json --state <state> --asset-url '<url>'/);
  assert.match(res.stdout, /\n  with-data: nodeId "1:2", maxDimension 800\n/);
  assert.equal(res.stdout.split('--spec').length, 2, 'the spec path is printed once, not per state');
  const spec = readJson(path.join(out, 'figma-spec.json'));
  const rest = buildFigmaSpec({ fileKey: 'AbCdEf123456', nodeId: '1:2', url: 'x', response: loadFixture('figma-nodes.json'), siblings: siblingFrames(loadFixture('figma-file-depth2.json'), '1:2') });
  for (const key of Object.keys(rest)) assert.ok(key in spec, `the MCP spec has "${key}"`);
  assert.deepEqual([spec.source, spec.fileKey, spec.nodeId, spec.type, spec.frame], ['mcp', KEY, '1:2', 'FRAME', { width: 800, height: 600 }]);
  assert.deepEqual([spec.variables, spec.motion, spec.components], [null, [], {}], 'what MCP metadata lacks is explicitly empty');
  assert.ok(spec.unavailable.includes('fills') && spec.unavailable.includes('reactions') && !spec.unavailable.includes('variables'));
  assert.deepEqual(spec.variableDefs, { 'color/bg/default': '#FFFFFF', 'space/4': '16' });
  assert.deepEqual(spec.codeConnect, { '1:10': { codeConnectSrc: 'src/Row.tsx', codeConnectName: 'Row' } });
  assert.deepEqual(spec.layers.map((l) => l.path).slice(0, 3), ['Items', 'Items/Header', 'Items/Header/Title']);
  assert.deepEqual(spec.states.map((s) => `${s.state}:${s.nodeId}`), ['with-data:1:2', 'empty:1:20', 'hover:5:1']);

  // Through state discovery: the same row shape as the REST fixture path.
  const restFile = path.join(out, 'rest-spec.json');
  writeFileSync(restFile, JSON.stringify(rest));
  const rows = {};
  for (const [name, file] of [['mcp', path.join(out, 'figma-spec.json')], ['rest', restFile]]) {
    const matrix = path.join(out, `${name}-matrix.json`);
    const r = await run(DISCOVER, ['--figma-spec', file, '--config', fixture('config.json'), '--surface', 'items', '--out', matrix, '--quiet']);
    assert.equal(r.code, 0, r.stderr);
    rows[name] = readJson(matrix);
    assert.deepEqual(validateStateMatrix(rows[name]).errors, [], name);
  }
  assert.deepEqual(Object.keys(rows.mcp[0]), Object.keys(rows.rest[0]));
  const byState = (list) => Object.fromEntries(list.map((r) => [r.state, [r.implemented?.driver ?? null, r.result]]));
  for (const state of ['with-data', 'empty', 'hover']) assert.deepEqual(byState(rows.mcp)[state], byState(rows.rest)[state], state);
});

test('figma-mcp-spec: a section becomes screens.json and per-screen specs; every frame is accounted for', async () => {
  const { out, res } = await convert(['--metadata', fixture('mcp-metadata-section.xml'), '--url', SECTION_LINK]);
  assert.equal(res.code, 0, res.stderr);
  const index = readJson(path.join(out, 'screens.json'));
  assert.deepEqual(index.screens.map((s) => [s.id, s.nodeId, s.frame, s.variantOf ?? null, s.states]), [
    ['orders', '12:345', { width: 1440, height: 1024 }, null, ['with-data', 'empty', 'side-panel', 'bulk-edit', 'row-menu', 'loading']],
    ['orders-600', '12:420', { width: 600, height: 1600 }, 'orders', ['with-data']],
  ]);
  assert.equal(index.source, 'mcp');
  const root = readJson(path.join(out, 'figma-spec.json'));
  assert.deepEqual([root.type, root.screens], ['SECTION', ['orders', 'orders-600']]);
  const orders = readJson(path.join(out, 'screens', 'orders', 'figma-spec.json'));
  assert.deepEqual([orders.nodeId, orders.frame, orders.screen], ['12:345', { width: 1440, height: 1024 }, { id: 'orders', name: 'Orders' }]);
  const menu = orders.states.find((s) => s.state === 'row-menu');
  assert.deepEqual([menu.kind, menu.trigger, menu.frame], ['overlay', 'click', { width: 240, height: 180 }]);
  assert.match(res.stdout, /get_screenshot\(fileKey "AbCdEfGhIjKlMnOpQrStUv", nodeId, maxDimension\)/);
  assert.match(res.stdout, /\n    row-menu: nodeId "12:430", maxDimension 240\n/);
  assert.match(res.stdout, /orders: Orders \(12:345\) 1440×1024; .*; spec \S*screens\/orders\/figma-spec\.json\n/);
  assert.match(res.stdout, /orders-600: Orders 600 \(12:420\) 600×1600 — breakpoint variant of orders/);
  assert.match(res.stderr, /frame 12:450 "Bulk edit" \(1440×1024\) is unmapped: .*Provisionally orders\/bulk-edit/);
  assert.ok(!/12:460/.test(index.screens.flatMap((s) => s.states).join()), 'the hidden draft is ignored, not a state');
});

test('figma-mcp-spec: several sections convert into one pass; garbage fails with a clear message', async () => {
  const dir = tmpDir();
  const second = path.join(dir, 'detail.xml');
  writeFileSync(second, '<section id="13:1" name="Order detail" x="0" y="3000" width="2000" height="1200"><frame id="13:2" name="Order detail" x="0" y="0" width="1440" height="2400"/><frame id="13:3" name="Order detail – Error" x="1500" y="0" width="1440" height="2400"/></section>');
  const { out, res } = await convert(['--metadata', fixture('mcp-metadata-section.xml'), '--metadata', second, '--url', SECTION_LINK, '--name', 'Orders feature']);
  assert.equal(res.code, 0, res.stderr);
  const root = readJson(path.join(out, 'figma-spec.json'));
  assert.deepEqual([root.type, root.name, root.nodeId, root.nodes], ['NODE_SET', 'Orders feature', '12:300', ['12:300', '13:1']]);
  assert.deepEqual(readJson(path.join(out, 'screens.json')).screens.map((s) => s.id), ['orders', 'orders-600', 'order-detail']);

  const junk = path.join(dir, 'junk.txt');
  writeFileSync(junk, 'Sorry, I could not read that file. {"error": true}');
  const bad = await convert(['--metadata', junk, '--url', SECTION_LINK]);
  assert.equal(bad.res.code, 2);
  assert.match(bad.res.stderr, /is not a Figma get_metadata result: no element with a Figma node id \(expected XML such as <frame id="1:23"/);
  assert.match(bad.res.stderr, /The input starts: "Sorry, I could not read that file\. \{\\"error\\": true\}"/);
  const noisy = path.join(dir, 'noisy.txt');
  writeFileSync(noisy, `line one\n\u0007line two\u2028${'x'.repeat(500)}`);
  const noisyRes = await convert(['--metadata', noisy, '--url', SECTION_LINK]);
  const start = /The input starts: "(.*)"/.exec(noisyRes.res.stderr)[1];
  assert.ok(start.startsWith('line one line two x') && start.length <= 200, 'one line, control characters stripped, about 200 characters');
  assert.equal(noisyRes.res.stderr.trim().split('\n').length, 1);
  const pages = path.join(dir, 'pages.txt');
  writeFileSync(pages, 'Pages in this file:\n- 0:1 Page 1\n- 0:2 Archive');
  assert.match((await convert(['--metadata', pages, '--url', SECTION_LINK])).res.stderr, /looks like the page list: call get_metadata with the nodeId/);
  assert.equal((await convert(['--metadata', junk])).res.code, 2, '--url is required');
  assert.equal((await run(MCP, ['--metadata', fixture('mcp-metadata-frame.xml'), '--url', 'https://example.com/x', '--out', tmpDir()])).code, 2);
});

test('figma-mcp-spec --asset-url: a 1x PNG of the frame size is saved; another size is refused with the maxDimension to ask for', async () => {
  const right = encodePng(createPng(1440, 1024, [250, 250, 250, 255]));
  const scaled = encodePng(createPng(1024, 728, [250, 250, 250, 255]));
  const server = await startServer((req, res) => {
    if (req.url === '/asset/right') return res.writeHead(200, { 'content-type': 'image/png' }).end(right);
    if (req.url === '/asset/scaled') return res.writeHead(200, { 'content-type': 'image/png' }).end(scaled);
    if (req.url === '/asset/hop') return res.writeHead(302, { location: '/asset/right' }).end();
    if (req.url === '/asset/away') return res.writeHead(302, { location: 'https://images.example.com/x.png' }).end();
    return res.writeHead(404).end();
  });
  try {
    const { out } = await convert(['--metadata', fixture('mcp-metadata-section.xml'), '--url', SECTION_LINK, '--quiet']);
    const rootSpec = path.join(out, 'figma-spec.json');
    const ordersSpec = path.join(out, 'screens', 'orders', 'figma-spec.json');

    const ok = await run(MCP, ['--spec', rootSpec, '--screen', 'orders', '--state', 'with-data', '--asset-url', `${server.url}/asset/hop`]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /Saved .*screens\/orders\/figma\/with-data\.png \(1440×1024, scale 1\)/);
    assert.equal(readPng(path.join(out, 'screens', 'orders', 'figma', 'with-data.png')).width, 1440);
    const spec = readJson(ordersSpec);
    assert.deepEqual(spec.exports, [{ state: 'with-data', nodeId: '12:345', name: 'Orders', path: 'figma/with-data.png', width: 1440, height: 1024, source: 'mcp-get_screenshot' }]);
    assert.deepEqual(readJson(path.join(out, 'screens.json')).screens[0].images, ['screens/orders/figma/with-data.png']);

    const wrong = await run(MCP, ['--spec', ordersSpec, '--state', 'empty', '--asset-url', `${server.url}/asset/scaled`]);
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /the image is 1024×728 but the frame of "empty" \(12:400\) is 1440×1024 at scale 1 \(scale 0\.711/);
    assert.match(wrong.stderr, /with maxDimension 1440 and save the returned URL; never rescale or upscale/);
    assert.ok(!existsSync(path.join(out, 'screens', 'orders', 'figma', 'empty.png')), 'nothing is written for a wrong size');

    const before = server.requests.length;
    const foreign = await run(MCP, ['--spec', ordersSpec, '--state', 'empty', '--asset-url', 'https://images.example.com/secret-asset-id/x.png?sig=abc']);
    assert.equal(foreign.code, 2);
    assert.match(foreign.stderr, /refusing to download from images\.example\.com: images\.example\.com is not an allowed Figma asset host/);
    assert.match(foreign.stderr, /allow it with DESIGN_QA_FIGMA_ASSET_HOSTS=images\.example\.com and run this again/);
    assert.match(foreign.stderr, /download the file with the curl command get_screenshot printed and pass it with --png <file> \(the size check still applies\)/);
    assert.ok(!/secret-asset-id|sig=abc/.test(foreign.stderr), 'never the path or query of the URL');
    const away = await run(MCP, ['--spec', ordersSpec, '--state', 'empty', '--asset-url', `${server.url}/asset/away`]);
    assert.equal(away.code, 2);
    assert.match(away.stderr, /refusing to download a redirect from images\.example\.com/);
    const gone = await run(MCP, ['--spec', ordersSpec, '--state', 'empty', '--asset-url', `${server.url}/asset/expired-secret`]);
    assert.equal(gone.code, 1);
    assert.match(gone.stderr, /HTTP 404 from 127\.0\.0\.1:\d+ \(get_screenshot URLs are short-lived/);
    assert.ok(!gone.stderr.includes('expired-secret'));
    assert.equal(server.requests.length, before + 2, 'only allowed hosts were requested (the redirect start and the 404)');

    // A PNG already on disk goes through the same size check.
    const file = path.join(tmpDir(), 'export.png');
    writeFileSync(file, encodePng(createPng(240, 180)));
    const fromFile = await run(MCP, ['--spec', ordersSpec, '--state', 'row-menu', '--png', file]);
    assert.equal(fromFile.code, 0, fromFile.stderr);
    assert.equal(readJson(ordersSpec).exports.find((e) => e.state === 'row-menu').source, 'file');

    const multi = await run(MCP, ['--spec', rootSpec, '--state', 'with-data', '--png', file]);
    assert.equal(multi.code, 2);
    assert.match(multi.stderr, /covers 2 screen\(s\): pass --screen <id>/);
    const notPng = path.join(tmpDir(), 'x.png');
    writeFileSync(notPng, 'not a png');
    assert.equal((await run(MCP, ['--spec', ordersSpec, '--state', 'row-menu', '--png', notPng])).code, 3);
    assert.equal((await run(MCP, ['--spec', ordersSpec, '--state', 'nope', '--png', file])).code, 2);
  } finally {
    await server.close();
  }
});

test('checkAssetUrl: Figma hosts over https, localhost, and DESIGN_QA_FIGMA_ASSET_HOSTS only', () => {
  assert.equal(checkAssetUrl('https://www.figma.com/api/mcp/asset/abc', []).ok, true);
  assert.equal(checkAssetUrl('https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/x', []).ok, true);
  assert.equal(checkAssetUrl('http://127.0.0.1:3845/assets/x.png', []).ok, true);
  assert.equal(checkAssetUrl('http://www.figma.com/x', []).ok, false, 'https only off localhost');
  assert.equal(checkAssetUrl('https://figma.com.evil.example/x', []).ok, false);
  assert.equal(checkAssetUrl('https://user:pw@www.figma.com/x', []).ok, false);
  assert.equal(checkAssetUrl('https://cdn.example.net/x', ['*.example.net']).ok, true);
  assert.equal(checkAssetUrl('file:///etc/passwd', []).ok, false);
});

test('figma-mcp-spec: the get_screenshot size report is checked before any download; frames over 65536 px get no 1x export', async () => {
  const server = await startServer((req, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(encodePng(createPng(1440, 1024))));
  try {
    const out = tmpDir();
    assert.equal((await run(MCP, ['--metadata', fixture('mcp-metadata-section.xml'), '--url', SECTION_LINK, '--out', out, '--quiet'])).code, 0);
    const spec = path.join(out, 'screens', 'orders', 'figma-spec.json');
    const asset = `${server.url}/asset/x`;
    // The saved tool result: a URL line, curl instructions and the JSON metadata entry.
    const clamped = path.join(out, 'shot.txt');
    writeFileSync(clamped, JSON.stringify({ content: [{ type: 'text', text: 'Download: https://example.invalid/…' }, { type: 'text', text: JSON.stringify({ width: 1024, height: 728, original_width: 1440, original_height: 1024 }) }] }));
    const early = await run(MCP, ['--spec', spec, '--state', 'with-data', '--asset-url', asset, '--screenshot-meta', clamped]);
    assert.equal(early.code, 1);
    assert.match(early.stderr, /get_screenshot rendered 1024×728 but the node is 1440×1024: maxDimension clamped it, so it is not scale 1\. Call get_screenshot for node 12:345 with maxDimension 1440/);
    assert.equal(server.requests.length, 0, 'refused before downloading');
    const typed = await run(MCP, ['--spec', spec, '--state', 'with-data', '--asset-url', asset, '--rendered', '1024x728', '--original', '1440x1024']);
    assert.equal(typed.code, 1);
    const other = await run(MCP, ['--spec', spec, '--state', 'with-data', '--asset-url', asset, '--rendered', '800x600', '--original', '800x600']);
    assert.equal(other.code, 1);
    assert.match(other.stderr, /reports the node as 800×600 but the frame of "with-data" \(12:345\) is 1440×1024 in the spec: another node was captured, or the spec is out of date/);
    assert.equal(server.requests.length, 0);
    assert.equal((await run(MCP, ['--spec', spec, '--state', 'with-data', '--asset-url', asset, '--rendered', '1440x1024'])).code, 2, 'the two go together');
    const good = path.join(out, 'good.json');
    writeFileSync(good, JSON.stringify({ width: 1440, height: 1024, original_width: 1440, original_height: 1024 }));
    const ok = await run(MCP, ['--spec', spec, '--state', 'with-data', '--asset-url', asset, '--screenshot-meta', good]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(server.requests.length, 1);

    // A frame beyond get_screenshot's limit: no 1x export, a degradation, never a rescale.
    const huge = path.join(out, 'huge.json');
    writeFileSync(huge, JSON.stringify({ nodeId: '1:2', name: 'Long page', frame: { width: 1440, height: 70000 }, states: [{ state: 'with-data', nodeId: '1:2', name: 'Long page', frame: { width: 1440, height: 70000 } }] }));
    const tooBig = await run(MCP, ['--spec', huge, '--state', 'with-data', '--asset-url', asset]);
    assert.equal(tooBig.code, 1);
    assert.match(tooBig.stderr, /longer edge \(70000 px\) is over get_screenshot's 65536 limit, so no 1x export exists in one call: this state has no design PNG and no pixel diff \(record a degradation\); never rescale/);
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});
