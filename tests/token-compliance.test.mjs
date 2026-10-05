import assert from 'node:assert/strict';
import test from 'node:test';
import { auditState, buildCandidates, buildTokenSet, designSide, parseJsonTokens, pageTokens, tokenComplianceSummary } from '../skills/design-qa/scripts/lib/ds-audit.mjs';
const set = buildTokenSet([{ kind: 'tokens-file', parsed: parseJsonTokens({ '--space-small': '8px', '--space-medium': '12px', '--color-ink': '#111111', '--color-brand': '#111111' }) }]);
const element = (s, v = null) => ({ i: 0, p: -1, path: 'main', tag: 'main', cls: [], attrs: {}, rect: { x: 0, y: 0, w: 100, h: 100 }, vis: { x: 0, y: 0, w: 100, h: 100 }, r: -1, s, v });
function run(el, designEl) {
  const audit = { elements: [el], regions: [], selectors: [] };
  const r = auditState({ audit, state: { id: 'with-data', name: 'with-data' }, set, libraries: [], catalog: null, image: { width: 100, height: 100 }, design: designEl ? designSide({ audit: { ...audit, elements: [designEl] } }) : null });
  return { r, ...buildCandidates([r], { evidencePaths: () => ({ screenshot: 'app.png', audit: 'audit.json' }) }) };
}
test('equal literals remain usage-unverified candidates, with zero visual delta', () => {
  const { r, candidates } = run(element({ 'padding-left': '8px' }), element({ 'padding-left': '8px' }));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]._audit.kind, 'token-usage');
  assert.equal(candidates[0]._audit.tokenRequired, true);
  assert.equal(candidates[0].resolution, 'FIX_CODE');
  assert.match(candidates[0].delta, /0 visual difference/);
  assert.deepEqual(tokenComplianceSummary([r]), { tokenChecks: 1, tokenUsageVerified: 0, tokenUsageUnverified: 1, tokenDeviationChecks: 0 });
});
test('shared off-token values remain mandatory implementation fixes', () => {
  const { r, candidates, designAlso } = run(element({ 'padding-left': '13px' }), element({ 'padding-left': '13px' }));
  assert.equal(designAlso.length, 0);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]._audit.designCheck, 'same');
  assert.equal(candidates[0].resolution, 'FIX_CODE');
  assert.notEqual(candidates[0].severity, 'DS_CANDIDATE');
  assert.equal(tokenComplianceSummary([r]).tokenDeviationChecks, 1);
});
test('a traced required token is verified; a different design-bound token is not', () => {
  const app = element({ 'background-color': 'rgb(17, 17, 17)' }, { 'background-color': '--color-ink' });
  const correct = run(app, element(app.s, app.v));
  assert.equal(correct.candidates.length, 0);
  assert.equal(tokenComplianceSummary([correct.r]).tokenUsageVerified, 1);
  const wrong = run(app, element(app.s, { 'background-color': '--color-brand' }));
  assert.equal(wrong.candidates.length, 1);
  assert.equal(wrong.candidates[0]._audit.kind, 'wrong-token');
  assert.equal(wrong.candidates[0].expected.token, '--color-brand');
  assert.equal(tokenComplianceSummary([wrong.r]).tokenUsageVerified, 0);
});
test('a stale or overridden token value cannot be counted as verified usage', () => {
  const { r, candidates } = run(element({ 'padding-left': '13px' }, { 'padding-left': '--space-small' }));
  assert.equal(candidates.length, 1);
  assert.equal(tokenComplianceSummary([r]).tokenUsageVerified, 0);
});

test('equal aliases do not imply the design binds the first token by name', () => {
  const app = element({ 'background-color': 'rgb(17, 17, 17)' }, { 'background-color': '--color-ink' });
  const { r, candidates } = run(app, element(app.s));
  assert.equal(candidates.length, 0, 'no explicit design binding: do not invent a semantic mismatch');
  assert.equal(tokenComplianceSummary([r]).tokenUsageVerified, 1);
});

test('app-defined variables cannot expand an authoritative design-token scale', () => {
  const canonical = buildTokenSet([{ kind: 'tokens-file', parsed: parseJsonTokens({ '--space-small': '8px' }) }, { kind: 'page', parsed: pageTokens({ '--space-local': '13px' }) }]);
  const r = auditState({ audit: { elements: [element({ 'padding-left': '13px' }, { 'padding-left': '--space-local' })] }, state: { id: 'with-data', name: 'with-data' }, set: canonical, libraries: [], catalog: null });
  assert.equal(tokenComplianceSummary([r]).tokenUsageVerified, 0);
  assert.equal(r.styleMembers[0].status, 'off');
  assert.equal(r.styleMembers[0].token.name, '--space-small');
});

test('a matching variable-name suffix is a hint, not proof of the token reference', () => {
  const { r, candidates } = run(element({ 'padding-left': '8px' }, { 'padding-left': '--invented-space-small' }));
  assert.equal(tokenComplianceSummary([r]).tokenUsageVerified, 0);
  assert.equal(candidates[0]._audit.kind, 'token-usage');
});
