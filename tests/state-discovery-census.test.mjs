import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { validateStateMatrix } from '../skills/design-qa/scripts/lib/schema-check.mjs';
import { fixture, run, script, tmpDir } from './_helpers.mjs';

const MCP = script('figma-mcp-spec.mjs');
const DISCOVER = script('lib/state-discovery.mjs');
const KEY = 'AbCdEfGhIjKlMnOpQrStUv';
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const write = (dir, name, data) => {
  const file = path.join(dir, name);
  writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return file;
};

async function sectionEvidence() {
  const out = tmpDir();
  const res = await run(MCP, ['--metadata', fixture('mcp-metadata-section.xml'), '--url', `https://www.figma.com/design/${KEY}/Acme?node-id=12-300`, '--out', out, '--quiet']);
  assert.equal(res.code, 0, res.stderr);
  return out;
}

const config = (extra = {}) => ({
  surfaces: {
    orders: {
      route: '/orders',
      figma: { fileKey: KEY, nodeId: '12:345' },
      states: { 'with-data': {}, empty: { query: 'empty=1' }, 'row-menu': { action: 'click', selector: '.row-menu' } },
      ...extra,
    },
  },
});

test('state discovery on a section spec: one matrix over every screen, plus design-census.json', async () => {
  const dir = await sectionEvidence();
  const cfg = write(dir, 'config.json', config());
  const matrix = path.join(dir, 'state-matrix.json');
  const res = await run(DISCOVER, ['--figma-spec', path.join(dir, 'figma-spec.json'), '--config', cfg, '--out', matrix, '--backfill-out', path.join(dir, 'bf.json')]);
  assert.equal(res.code, 0, res.stderr);
  const rows = readJson(matrix);
  assert.deepEqual(validateStateMatrix(rows).errors, []);
  assert.deepEqual(rows.map((r) => r.state), [
    'orders/with-data', 'orders/empty', 'orders/loading', 'orders/bulk-edit', 'orders/row-menu', 'orders/side-panel', 'orders-600/with-data',
  ]);
  assert.ok(rows.every((r) => r.screen === r.state.split('/')[0]));
  // designed.frame on both screens: the overlay and the breakpoint keep their own sizes.
  const frameOf = (state) => rows.find((r) => r.state === state).designed.frame;
  assert.deepEqual([frameOf('orders/with-data'), frameOf('orders/row-menu'), frameOf('orders-600/with-data'), frameOf('orders/loading')], [
    { width: 1440, height: 1024 }, { width: 240, height: 180 }, { width: 600, height: 1600 }, { width: 1440, height: 1024 },
  ]);
  const menu = rows.find((r) => r.state === 'orders/row-menu');
  assert.equal(menu.implemented.driver, 'action');
  assert.match(menu.note, /Overlay frame \(240×180\) shown over the screen: drive it with an action driver \(click\)/);
  assert.match(res.stdout, /Wrote .*state-matrix\.json \(7 states across 2 screen\(s\)\)/);
  assert.match(res.stdout, /Design census: 8 frame\(s\) under Orders \(12:300\): 7 mapped, 1 unmapped; 2 screen\(s\)/);
  assert.match(res.stdout, /12:430 Row menu 240×180 → overlay orders\/row-menu on click/);
  assert.match(res.stdout, /12:420 Orders 600 600×1600 → breakpoint orders-600\/with-data \(variant of orders\)/);
  assert.match(res.stdout, /note: config surfaces\.orders\.figma points at frame 12:345 \(Orders\) inside the fetched section 12:300: the wider node wins, so this pass covers all 8 of its frames/);
  assert.match(res.stderr, /warning: frame 12:450 "Bulk edit" \(1440×1024\) is unmapped: .*\{ "12:450": \{ "screen": "orders", "state": "bulk-edit" \} \}/);

  const census = readJson(path.join(dir, 'design-census.json'));
  assert.deepEqual(Object.keys(census), ['generatedAt', 'figmaSpec', 'source', 'multiScreen', 'root', 'frames', 'screens', 'unmapped', 'others', 'outside', 'ticketLinks', 'warnings', 'notes']);
  assert.deepEqual([census.source, census.multiScreen, census.frames.length, census.unmapped.length], ['mcp', true, 8, 1]);
  assert.deepEqual(census.frames.find((f) => f.nodeId === '12:420'), {
    nodeId: '12:420', name: 'Orders 600', type: 'FRAME', section: 'Orders', frame: { width: 600, height: 1600 }, hidden: false,
    mappedTo: { kind: 'breakpoint', screen: 'orders-600', state: 'with-data', trigger: null, variantOf: 'orders' }, by: 'size', confirmed: true,
  });
  const backfill = readJson(path.join(dir, 'bf.json')).candidates;
  assert.ok(backfill.every((c) => c.state.includes('/')), 'backfill candidates carry the screen prefix');
});

test('--strict fails while a frame is unmapped (files still written); a frame map settles it', async () => {
  const dir = await sectionEvidence();
  const matrix = path.join(dir, 'state-matrix.json');
  const spec = path.join(dir, 'figma-spec.json');
  const strict = await run(DISCOVER, ['--figma-spec', spec, '--out', matrix, '--strict', '--quiet']);
  assert.equal(strict.code, 4);
  assert.match(strict.stderr, /--strict: 1 unmapped frame\(s\) and 0 uncovered ticket Figma link\(s\)/);
  assert.ok(existsSync(matrix) && existsSync(path.join(dir, 'design-census.json')));

  const map = write(dir, 'frame-map.json', { '12:450': { screen: 'orders', state: 'bulk-edit' } });
  const ok = await run(DISCOVER, ['--figma-spec', spec, '--out', matrix, '--strict', '--frame-map', map, '--quiet']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(readJson(path.join(dir, 'design-census.json')).unmapped, []);
  // A separate screen instead: the frame becomes its own screen's with-data.
  write(dir, 'frame-map.json', { '12:450': { screen: 'bulk-edit' } });
  const moved = await run(DISCOVER, ['--figma-spec', spec, '--out', matrix, '--strict', '--frame-map', map, '--quiet']);
  assert.equal(moved.code, 0, moved.stderr);
  assert.ok(readJson(matrix).some((r) => r.state === 'bulk-edit/with-data'));
  // --screen keeps one screen of the section.
  const one = await run(DISCOVER, ['--figma-spec', spec, '--out', matrix, '--screen', 'orders-600', '--frame-map', map, '--quiet']);
  assert.equal(one.code, 0, one.stderr);
  assert.deepEqual(readJson(matrix).map((r) => r.state), ['orders-600/with-data']);
  assert.equal((await run(DISCOVER, ['--figma-spec', spec, '--out', matrix, '--screen', 'nope'])).code, 2);
  write(dir, 'bad-map.json', { '12:450': { ignore: '' } });
  assert.equal((await run(DISCOVER, ['--figma-spec', spec, '--out', matrix, '--frame-map', path.join(dir, 'bad-map.json')])).code, 2);
});

test('a single-frame spec warns about ticket Figma links it does not cover, and about configured sizes', async () => {
  const dir = tmpDir();
  const conv = await run(MCP, ['--metadata', fixture('mcp-metadata-frame.xml'), '--url', `https://www.figma.com/design/${KEY}/Acme?node-id=1-2`, '--out', dir, '--quiet']);
  assert.equal(conv.code, 0, conv.stderr);
  const ticket = write(dir, 'ticket.json', {
    figmaUrls: [
      `https://www.figma.com/design/${KEY}/Acme?node-id=1-2`,
      `https://www.figma.com/design/${KEY}/Acme?node-id=27-100`,
      `https://www.figma.com/design/${KEY}/Acme?node-id=27-200`,
      'https://www.figma.com/design/OtherFileKey1/Lib?node-id=3-4',
    ],
  });
  const cfg = write(dir, 'config.json', {
    surfaces: { items: { route: '/items', figma: { fileKey: KEY, nodeId: '1:2', frame: { width: 1920, height: 1080 } }, states: { empty: { query: 'e=1', viewport: { width: 800, height: 400 } } } } },
  });
  const matrix = path.join(dir, 'state-matrix.json');
  const args = ['--figma-spec', path.join(dir, 'figma-spec.json'), '--ticket', ticket, '--config', cfg, '--out', matrix];
  const res = await run(DISCOVER, args);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /warning: the ticket links 2 other Figma node\(s\) not covered by this spec: fetch them \(or the section that contains them\) and run discovery on that spec \(27:100, 27:200\)/);
  assert.match(res.stderr, /warning: the ticket also links 1 node\(s\) in another Figma file \(OtherFileKey1\)/);
  assert.match(res.stderr, /config surfaces\.items\.figma\.frame says 1920×1080 but the fetched frame Items \(1:2\) is 800×600: the fetched size wins; capture with --width 800 --height 600/);
  assert.match(res.stderr, /config surfaces\.items\.states\.empty\.viewport says 800×400 but the fetched frame of state empty \(1:20\) is 800×300/);
  const census = readJson(path.join(dir, 'design-census.json'));
  assert.deepEqual(census.ticketLinks.uncovered.map((l) => l.nodeId), ['27:100', '27:200']);
  assert.deepEqual(census.ticketLinks.covered.map((l) => l.nodeId), ['1:2']);

  assert.equal((await run(DISCOVER, [...args, '--strict', '--quiet'])).code, 4, 'uncovered ticket links fail --strict');
  const map = write(dir, 'map.json', { '27:100': { ignore: 'the design-system page, not this feature' }, '27:200': { ignore: 'old exploration' } });
  const ignored = await run(DISCOVER, [...args, '--strict', '--frame-map', map, '--quiet']);
  assert.equal(ignored.code, 0, ignored.stderr);
  assert.deepEqual(readJson(path.join(dir, 'design-census.json')).ticketLinks.ignored.map((l) => l.reason), ['the design-system page, not this feature', 'old exploration']);
});
