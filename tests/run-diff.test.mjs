import assert from 'node:assert/strict';
import test from 'node:test';
import { diffRuns } from '../skills/design-qa/scripts/lib/run-diff.mjs';

const issue = (issue_id, status = 'open', state = 'with-data', screen = 'default') => ({
  issue_id,
  status,
  screen,
  state,
  type: 'style:padding',
  category: 'spacing',
  severity: 'WARNING',
});
const checked = (...states) => states.map((s) => ({ screen: 'default', state: s, verified: true }));
const byId = (issues) => Object.fromEntries(issues.map((i) => [i.issue_id, i]));

test('first run: every open issue is new, nothing fixed', () => {
  const { diff, issues } = diffRuns(null, { issues: [issue('a'), issue('b', 'dismissed')], checked: checked('with-data') });
  assert.equal(diff.first_run, true);
  assert.deepEqual(diff.new, ['a']);
  assert.deepEqual(diff.fixed, []);
  assert.deepEqual(diff.dismissed, ['b']);
  assert.equal(issues.length, 2);
});

test('open before, gone now in a verified state: fixed, and recorded as fixed', () => {
  const prev = { issues: [issue('a'), issue('b')] };
  const { diff, issues } = diffRuns(prev, { issues: [issue('b')], checked: checked('with-data') });
  assert.deepEqual(diff.fixed, ['a']);
  assert.deepEqual(diff.new, []);
  assert.equal(byId(issues).a.status, 'fixed');
  assert.equal(byId(issues).b.status, 'open');
});

test('gone now but the state was not verified: not re-checked, carried forward open', () => {
  const prev = { issues: [issue('a', 'open', 'loading')] };
  const current = { issues: [], checked: [...checked('with-data'), { screen: 'default', state: 'loading', verified: false }] };
  const { diff, issues } = diffRuns(prev, current);
  assert.deepEqual(diff.fixed, []);
  assert.deepEqual(diff.not_rechecked, ['a']);
  assert.equal(byId(issues).a.status, 'open');
  assert.equal(byId(issues).a.carried, true);
});

test('a state missing from checked entirely is not re-checked either', () => {
  const { diff } = diffRuns({ issues: [issue('a', 'open', 'hover')] }, { issues: [], checked: checked('with-data') });
  assert.deepEqual(diff.not_rechecked, ['a']);
});

test('a carried issue is fixed later once its state is verified', () => {
  const run2 = diffRuns({ issues: [issue('a', 'open', 'loading')] }, { issues: [], checked: [] });
  const run3 = diffRuns({ issues: run2.issues }, { issues: [], checked: checked('loading') });
  assert.deepEqual(run3.diff.fixed, ['a']);
});

test('open before, dismissed now: dismissed', () => {
  const { diff } = diffRuns({ issues: [issue('a')] }, { issues: [issue('a', 'dismissed')], checked: checked('with-data') });
  assert.deepEqual(diff.dismissed, ['a']);
  assert.deepEqual(diff.fixed, []);
});

test('dismissed in both runs is not counted again', () => {
  const { diff } = diffRuns({ issues: [issue('a', 'dismissed')] }, { issues: [issue('a', 'dismissed')], checked: checked('with-data') });
  assert.deepEqual(diff.dismissed, []);
});

test('dismissed before, open now: reopened, not new', () => {
  const { diff } = diffRuns({ issues: [issue('a', 'dismissed')] }, { issues: [issue('a')], checked: checked('with-data') });
  assert.deepEqual(diff.reopened, ['a']);
  assert.deepEqual(diff.new, []);
});

test('dismissed before, gone now: drops out, not a fix', () => {
  const { diff, issues } = diffRuns({ issues: [issue('a', 'dismissed')] }, { issues: [], checked: checked('with-data') });
  assert.deepEqual(diff.fixed, []);
  assert.equal(issues.length, 0);
});

test('fixed before and back again: new (a regression), fixed entries are history', () => {
  const { diff } = diffRuns({ issues: [issue('a', 'fixed')] }, { issues: [issue('a')], checked: checked('with-data') });
  assert.deepEqual(diff.new, ['a']);
  const again = diffRuns({ issues: [issue('a', 'fixed')] }, { issues: [], checked: checked('with-data') });
  assert.deepEqual(again.diff.fixed, [], 'a fix is counted once');
});

test('multi-screen: verification is per screen and state', () => {
  const prev = { issues: [issue('a', 'open', 'cart/empty', 'cart'), issue('b', 'open', 'checkout/empty', 'checkout')] };
  const { diff } = diffRuns(prev, { issues: [], checked: [{ screen: 'cart', state: 'cart/empty', verified: true }] });
  assert.deepEqual(diff.fixed, ['a']);
  assert.deepEqual(diff.not_rechecked, ['b']);
});
