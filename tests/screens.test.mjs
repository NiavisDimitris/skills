import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverScreens, screenFamily, screenId } from '../skills/design-qa/scripts/lib/screens.mjs';

const box = (x, w = 390, h = 844) => ({ x, y: 0, width: w, height: h });

test('screenFamily strips the state segment; screenId is kebab-case', () => {
  assert.deepEqual(screenFamily('Cart'), { family: 'cart', state: 'with-data' });
  assert.deepEqual(screenFamily('Cart – Empty'), { family: 'cart', state: 'empty' });
  assert.deepEqual(screenFamily('Empty / Cart'), { family: 'cart', state: 'empty' });
  assert.deepEqual(screenFamily('Checkout / Payment – Error'), { family: 'checkout payment', state: 'error' });
  assert.deepEqual(screenFamily('Checkout / Payment'), { family: 'checkout payment', state: 'with-data' });
  assert.deepEqual(screenFamily('Loading'), { family: '', state: 'loading' });
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
