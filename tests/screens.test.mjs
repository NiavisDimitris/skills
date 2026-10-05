import assert from 'node:assert/strict';
import test from 'node:test';
import { designCensus, discoverScreens, mergeScreenStates, normalizeFrameMap, screenFamily, screenId, screenSpecFrom } from '../skills/design-qa/scripts/lib/screens.mjs';

const box = (x, w = 390, h = 844) => ({ x, y: 0, width: w, height: h });

test('screenFamily strips the state segment; screenId is kebab-case', () => {
  assert.deepEqual(screenFamily('Cart'), { family: 'cart', state: 'with-data' });
  assert.deepEqual(screenFamily('Cart – Empty'), { family: 'cart', state: 'empty' });
  assert.deepEqual(screenFamily('Empty / Cart'), { family: 'cart', state: 'empty' });
  assert.deepEqual(screenFamily('Checkout / Payment – Error'), { family: 'checkout payment', state: 'error' });
  assert.deepEqual(screenFamily('Checkout / Payment'), { family: 'checkout payment', state: 'with-data' });
  assert.deepEqual(screenFamily('Loading'), { family: '', state: 'loading' });
  // A negated segment is not the state it negates: "Not empty" is its own screen name.
  assert.deepEqual(screenFamily('Cart – Not empty'), { family: 'cart not empty', state: 'with-data' });
  assert.deepEqual(screenFamily('Orders – Data table'), { family: 'orders data table', state: 'with-data' });
  assert.equal(screenId('Checkout / Payment'), 'checkout-payment');
  assert.equal(screenId('  '), 'screen');
});

test('discoverScreens: frames of a page grouped into screens with their states', () => {
  const spec = {
    nodeId: '0:1',
    type: 'CANVAS',
    layers: [
      { id: '0:1', name: 'Checkout flow', type: 'CANVAS', depth: 0, path: 'Checkout flow' },
      { id: '1:1', name: 'Cart', type: 'FRAME', depth: 1, path: 'Checkout flow/Cart', absoluteBoundingBox: box(0) },
      { id: '1:2', name: 'Cart – Empty', type: 'FRAME', depth: 1, path: 'Checkout flow/Cart – Empty', absoluteBoundingBox: box(400) },
      { id: '1:3', name: 'Header', type: 'TEXT', depth: 2, path: 'Checkout flow/Cart/Header' },
      { id: '2:0', name: 'Payment', type: 'SECTION', depth: 1, path: 'Checkout flow/Payment' },
      { id: '2:1', name: 'Checkout / Payment', type: 'FRAME', depth: 2, path: 'Checkout flow/Payment/Checkout / Payment', absoluteBoundingBox: box(800) },
      { id: '2:2', name: 'Checkout / Payment – Error', type: 'FRAME', depth: 2, path: 'Checkout flow/Payment/Checkout / Payment – Error', absoluteBoundingBox: box(1200) },
      { id: '3:1', name: 'Confirmation', type: 'FRAME', depth: 1, path: 'Checkout flow/Confirmation', absoluteBoundingBox: box(1600, 390, 900) },
      { id: '3:2', name: 'Old draft', type: 'FRAME', depth: 1, path: 'Checkout flow/Old draft', visible: false, absoluteBoundingBox: box(2000) },
    ],
  };
  const screens = discoverScreens(spec);
  assert.deepEqual(
    screens.map((s) => [s.id, s.name, s.nodeId, s.states.map((x) => `${x.state}:${x.nodeId}`)]),
    [
      ['cart', 'Cart', '1:1', ['with-data:1:1', 'empty:1:2']],
      ['checkout-payment', 'Checkout / Payment', '2:1', ['with-data:2:1', 'error:2:2']],
      ['confirmation', 'Confirmation', '3:1', ['with-data:3:1']],
    ],
  );
  assert.deepEqual(screens[2].frame, { width: 390, height: 900 });
});

test('discoverScreens: a fetched frame plus the frames beside it on its page', () => {
  const spec = {
    nodeId: '1:2',
    type: 'FRAME',
    layers: [{ id: '1:2', name: 'Items', type: 'FRAME', depth: 0, path: 'Items', absoluteBoundingBox: box(0, 800, 600) }],
    siblings: [
      { id: '1:50', name: 'Items – Error', type: 'FRAME', absoluteBoundingBox: box(900, 800, 600) },
      { id: '1:60', name: 'Settings – Empty', type: 'FRAME', absoluteBoundingBox: box(1800, 800, 600) },
      { id: '1:70', name: 'Notes', type: 'TEXT' },
    ],
  };
  const screens = discoverScreens(spec);
  assert.deepEqual(screens.map((s) => [s.id, s.nodeId, s.states.map((x) => x.state)]), [
    ['items', '1:2', ['with-data', 'error']],
    ['settings', '1:60', ['empty']],
  ]);
  assert.equal(screens[1].name, 'Settings', 'a screen known only from a state frame is named from its family');
  assert.deepEqual(discoverScreens({ layers: [] }), []);
});

// A section as Figma returns it: one screen's states side by side, a narrower
// breakpoint frame, a small overlay, a frame named only after a state, a frame with a
// name of its own (a judgement call) and a hidden draft.
const at = (x, y, w, h) => ({ x, y, width: w, height: h });
const sectionSpec = () => ({
  fileKey: 'AbCdEfGhIjKlMnOp',
  nodeId: '12:300',
  name: 'Orders',
  type: 'SECTION',
  layers: [
    { id: '12:300', name: 'Orders', type: 'SECTION', depth: 0, path: 'Orders', absoluteBoundingBox: at(0, 0, 4000, 2400) },
    { id: '12:345', name: 'Orders', type: 'FRAME', depth: 1, path: 'Orders/Orders', absoluteBoundingBox: at(0, 0, 1440, 1024) },
    { id: '12:346', name: 'Header', type: 'FRAME', depth: 2, path: 'Orders/Orders/Header', absoluteBoundingBox: at(0, 0, 1440, 72) },
    { id: '12:400', name: 'Orders – Empty', type: 'FRAME', depth: 1, path: 'Orders/Orders – Empty', absoluteBoundingBox: at(1500, 0, 1440, 1024) },
    { id: '12:405', name: 'Orders – No results', type: 'FRAME', depth: 1, path: 'Orders/Orders – No results', absoluteBoundingBox: at(3000, 0, 1440, 1024) },
    { id: '12:410', name: 'Orders – Side panel', type: 'FRAME', depth: 1, path: 'Orders/Orders – Side panel', absoluteBoundingBox: at(4500, 0, 1440, 1024) },
    { id: '12:420', name: 'Orders 600', type: 'FRAME', depth: 1, path: 'Orders/Orders 600', absoluteBoundingBox: at(0, 1100, 600, 1600) },
    { id: '12:425', name: 'Orders 600 – Empty', type: 'FRAME', depth: 1, path: 'Orders/Orders 600 – Empty', absoluteBoundingBox: at(700, 1100, 600, 1600) },
    { id: '12:430', name: 'Hover popper', type: 'FRAME', depth: 1, path: 'Orders/Hover popper', absoluteBoundingBox: at(1400, 1100, 320, 180) },
    { id: '12:440', name: 'Loading', type: 'FRAME', depth: 1, path: 'Orders/Loading', absoluteBoundingBox: at(1800, 1100, 1440, 1024) },
    { id: '12:450', name: 'Bulk edit', type: 'FRAME', depth: 1, path: 'Orders/Bulk edit', absoluteBoundingBox: at(3300, 1100, 1440, 1024) },
    { id: '12:460', name: 'Old draft', type: 'FRAME', depth: 1, path: 'Orders/Old draft', visible: false, absoluteBoundingBox: at(4800, 1100, 1440, 1024) },
    { id: '12:470', name: 'Notes', type: 'TEXT', depth: 1, path: 'Orders/Notes', absoluteBoundingBox: at(0, -80, 400, 40) },
  ],
});

test('designCensus: every top-level frame of a section is a screen, a state, a breakpoint, an overlay or ignored', () => {
  const census = designCensus(sectionSpec());
  const to = Object.fromEntries(census.frames.map((f) => [f.nodeId, [f.mappedTo.kind, f.mappedTo.screen ? `${f.mappedTo.screen}/${f.mappedTo.state}` : f.mappedTo.reason, f.confirmed]]));
  assert.deepEqual(to, {
    '12:345': ['screen', 'orders/with-data', true],
    '12:400': ['state', 'orders/empty', true],
    '12:405': ['state', 'orders/no-results', true],
    '12:410': ['state', 'orders/side-panel', true],
    '12:420': ['breakpoint', 'orders-600/with-data', true],
    '12:425': ['breakpoint', 'orders-600/empty', true],
    '12:430': ['overlay', 'orders/hover-popper', true],
    '12:440': ['state', 'orders/loading', true],
    '12:450': ['state', 'orders/bulk-edit', false],
    '12:460': ['ignored', 'hidden in Figma', true],
  });
  assert.equal(census.frames.length, 10, 'no frame vanishes');
  assert.deepEqual(census.others, [{ nodeId: '12:470', name: 'Notes', type: 'TEXT', section: null }]);
  assert.deepEqual(census.screens.map((s) => [s.id, s.nodeId, s.frame, s.variantOf ?? null]), [
    ['orders', '12:345', { width: 1440, height: 1024 }, null],
    ['orders-600', '12:420', { width: 600, height: 1600 }, 'orders'],
  ]);
  const popper = census.screens[0].states.find((s) => s.state === 'hover-popper');
  assert.deepEqual([popper.kind, popper.trigger, popper.frame], ['overlay', 'hover', { width: 320, height: 180 }]);
  assert.deepEqual(census.unmapped.map((u) => [u.nodeId, u.suggestion.screen, u.suggestion.state]), [['12:450', 'orders', 'bulk-edit']]);
  assert.match(census.unmapped[0].reason, /a state of screen "orders" \(provisional\) or a separate screen\?/);
});

test('designCensus: a frame map confirms, moves or ignores frames; bad entries are refused', () => {
  const frameMap = { '12:450': { screen: 'bulk-edit' }, '12:430': { screen: 'orders', state: 'row-popper', trigger: 'hover' }, '12:405': { ignore: 'exploration, not for build' } };
  const census = designCensus(sectionSpec(), { frameMap });
  assert.deepEqual(census.unmapped, []);
  const row = (id) => census.frames.find((f) => f.nodeId === id);
  assert.deepEqual([row('12:450').mappedTo.kind, row('12:450').mappedTo.screen, row('12:450').by], ['screen', 'bulk-edit', 'frame-map']);
  assert.deepEqual([row('12:430').mappedTo.state, row('12:430').mappedTo.trigger], ['row-popper', 'hover']);
  assert.deepEqual(row('12:405').mappedTo, { kind: 'ignored', reason: 'exploration, not for build' });
  assert.ok(census.screens.some((s) => s.id === 'bulk-edit' && s.states[0].state === 'with-data'));
  assert.throws(() => normalizeFrameMap({ '1:2': { ignore: ' ' } }), /needs a written reason/);
  assert.throws(() => normalizeFrameMap({ '1:2': { screen: 'Not Kebab' } }), /kebab-case/);
  assert.throws(() => designCensus(sectionSpec(), { frameMap: { '12:400': { screen: 'orders', state: 'with-data' } } }), /already has a "with-data" state/);
});

test('designCensus: breakpoints across families, duplicates numbered and flagged, single frames keep their page', () => {
  const page = {
    nodeId: '0:1',
    type: 'CANVAS',
    layers: [
      { id: '0:1', name: 'Login', type: 'CANVAS', depth: 0, path: 'Login' },
      { id: '1:1', name: 'Login desktop', type: 'FRAME', depth: 1, path: 'Login/Login desktop', absoluteBoundingBox: at(0, 0, 1440, 900) },
      { id: '1:2', name: 'Login mobile', type: 'FRAME', depth: 1, path: 'Login/Login mobile', absoluteBoundingBox: at(1500, 0, 390, 844) },
      { id: '1:3', name: 'Login desktop – Error', type: 'FRAME', depth: 1, path: 'Login/Login desktop – Error', absoluteBoundingBox: at(0, 1000, 1440, 900) },
      { id: '1:4', name: 'Login desktop – Error', type: 'FRAME', depth: 1, path: 'Login/x', absoluteBoundingBox: at(0, 2000, 1440, 900) },
    ],
  };
  const census = designCensus(page);
  assert.deepEqual(census.screens.map((s) => [s.id, s.variantOf ?? null, s.states.map((x) => x.state)]), [
    ['login-desktop', null, ['with-data', 'error', 'error-2']],
    ['login-desktop-390', 'login-desktop', ['with-data']],
  ]);
  assert.deepEqual(census.unmapped.map((u) => [u.nodeId, u.suggestion.state]), [['1:4', 'error-2']], 'a true duplicate is numbered and left to confirm');

  // A single frame (state discovery without --screens): its family siblings are states, the rest of the page is outside.
  const single = designCensus({
    nodeId: '1:2',
    type: 'FRAME',
    layers: [{ id: '1:2', name: 'Items', type: 'FRAME', depth: 0, path: 'Items', absoluteBoundingBox: at(0, 0, 800, 600) }],
    siblings: [
      { id: '1:50', name: 'Items – Error', type: 'FRAME', absoluteBoundingBox: at(900, 0, 800, 600) },
      { id: '1:60', name: 'Settings – Empty', type: 'FRAME', absoluteBoundingBox: at(1800, 0, 800, 600) },
    ],
  });
  assert.deepEqual(single.screens.map((s) => [s.id, s.states.map((x) => x.state)]), [['items', ['with-data', 'error']]]);
  assert.deepEqual(single.outside.map((o) => o.nodeId), ['1:60']);
});

test('screenSpecFrom cuts one screen out of a section spec; census states come first', () => {
  const spec = sectionSpec();
  const census = designCensus(spec);
  const orders = screenSpecFrom(spec, census.screens[0]);
  assert.equal(orders.nodeId, '12:345');
  assert.deepEqual(orders.layers.map((l) => [l.id, l.depth, l.path]), [['12:345', 0, 'Orders'], ['12:346', 1, 'Orders/Header']]);
  assert.deepEqual(orders.screen, { id: 'orders', name: 'Orders' });
  assert.deepEqual(orders.states.map((s) => s.state), ['with-data', 'empty', 'no-results', 'side-panel', 'bulk-edit', 'hover-popper', 'loading']);
  assert.match(orders.url, /node-id=12-345/);
  assert.deepEqual(
    mergeScreenStates([{ state: 'empty', nodeId: '9:9' }, { state: 'hover', nodeId: '9:8' }], [{ state: 'empty', nodeId: '12:400' }]).map((s) => `${s.state}:${s.nodeId}`),
    ['empty:12:400', 'hover:9:8'],
  );
});
