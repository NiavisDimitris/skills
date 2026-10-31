import assert from 'node:assert/strict';
import test from 'node:test';
import {
  categoryOf,
  findingIssueId,
  issueId,
  issueStatusOf,
  issueTypeOf,
  screenOf,
} from '../skills/design-qa/scripts/lib/issue-id.mjs';

const f = (extra = {}) => ({
  id: 'DQ-001',
  ledger: 'style',
  property: 'padding',
  state: 'with-data',
  region: 'Card',
  severity: 'WARNING',
  resolution: 'FIX_CODE',
  element: { selector: '.orders-card', figmaLayerPath: null },
  ...extra,
});

test('issue_id is stable and has the iss_ + 16 hex shape', () => {
  const id = findingIssueId(f());
  assert.match(id, /^iss_[0-9a-f]{16}$/);
  assert.equal(findingIssueId(f()), id);
});

test('issue_id ignores the per-pass DQ id, title, values and severity', () => {
  const a = findingIssueId(f());
  const b = findingIssueId(f({ id: 'DQ-042', title: 'other', severity: 'BLOCKER', expected: { value: '16px' }, actual: { value: '12px' } }));
  assert.equal(a, b);
});

test('issue_id normalises case and whitespace', () => {
  assert.equal(
    findingIssueId(f()),
    findingIssueId(f({ ledger: 'STYLE', property: ' Padding ', state: 'With-Data', element: { selector: '  .ORDERS-card ' } })),
  );
});

test('issue_id changes with screen, state, element or type', () => {
  const base = findingIssueId(f());
  assert.notEqual(findingIssueId(f({ state: 'loading' })), base);
  assert.notEqual(findingIssueId(f({ screen: 'cart' })), base);
  assert.notEqual(findingIssueId(f({ element: { selector: '.other' } })), base);
  assert.notEqual(findingIssueId(f({ property: 'gap' })), base);
  assert.notEqual(findingIssueId(f({ ledger: 'structure' })), base);
});

test('element falls back to Figma layer path, then region', () => {
  const byLayer = f({ element: { selector: null, figmaLayerPath: 'Page/Card' } });
  const byRegion = f({ element: { selector: null, figmaLayerPath: null } });
  assert.equal(findingIssueId(byLayer), issueId({ screen: 'default', state: 'with-data', element: 'Page/Card', type: 'style:padding' }));
  assert.equal(findingIssueId(byRegion), issueId({ screen: 'default', state: 'with-data', element: 'Card', type: 'style:padding' }));
});

test('screen comes from the finding, else the state prefix, else default', () => {
  assert.equal(screenOf({ screen: 'cart', state: 'x' }), 'cart');
  assert.equal(screenOf({ state: 'checkout/with-data' }), 'checkout');
  assert.equal(screenOf({ state: 'with-data' }), 'default');
  // A multi-screen finding with and without an explicit screen hashes the same.
  assert.equal(findingIssueId(f({ screen: 'cart', state: 'cart/empty' })), findingIssueId(f({ state: 'cart/empty' })));
});

test('issue type is ledger:property', () => {
  assert.equal(issueTypeOf(f()), 'style:padding');
  assert.equal(issueTypeOf(f({ property: null })), 'style:-');
});

test('categories', () => {
  const cat = (ledger, property, extra) => categoryOf({ ledger, property, ...extra });
  assert.equal(cat('style', 'padding-left'), 'spacing');
  assert.equal(cat('style', 'gap'), 'spacing');
  assert.equal(cat('style', 'background-color'), 'color');
  assert.equal(cat('style', 'color'), 'color');
  assert.equal(cat('style', 'border-color'), 'color');
  assert.equal(cat('style', 'font-weight'), 'typography');
  assert.equal(cat('style', 'line-height'), 'typography');
  assert.equal(cat('style', 'border-radius'), 'shape');
  assert.equal(cat('style', 'box-shadow'), 'shape');
  assert.equal(cat('style', 'width'), 'sizing');
  assert.equal(cat('style', 'mystery', { expected: { token: 'color.brand' } }), 'color');
  assert.equal(cat('style', 'mystery'), 'other');
  assert.equal(cat('component', 'variant'), 'component');
  assert.equal(cat('state', 'presence'), 'missing-state');
  assert.equal(cat('state', 'outline'), 'behavior');
  assert.equal(cat('motion', 'transition-duration'), 'motion');
  assert.equal(cat('structure', 'placeholder'), 'copy');
  assert.equal(cat('structure', 'columns'), 'structure');
  assert.equal(cat('nonsense', 'x'), 'other');
});

test('status: open, dismissed, or not an issue', () => {
  assert.equal(issueStatusOf(f()), 'open');
  assert.equal(issueStatusOf(f({ resolution: 'UNCLASSIFIED' })), 'open');
  assert.equal(issueStatusOf(f({ resolution: 'DISMISSED' })), 'dismissed');
  assert.equal(issueStatusOf(f({ resolution: 'INTENTIONAL' })), 'dismissed');
  assert.equal(issueStatusOf(f({ resolution: 'DATA' })), null);
  assert.equal(issueStatusOf(f({ severity: 'PASS', resolution: 'NONE' })), null);
  assert.equal(issueStatusOf(f({ severity: 'CANNOT_VERIFY', resolution: 'NONE' })), null);
});
