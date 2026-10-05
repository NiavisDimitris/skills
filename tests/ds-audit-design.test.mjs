// Design-system audit, design check: an off-token value the design uses too is not a
// parity difference (designAlso, no candidate); another value in the design makes a
// candidate whose expected is the design's value; no design data leaves it "unknown".
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  auditState,
  buildCandidates,
  buildTokenSet,
  designMatcher,
  designSide,
  normalizeLibraries,
  parseJsonTokens,
  sameValue,
} from '../skills/design-qa/scripts/lib/ds-audit.mjs';
import { createPng, writePng } from '../skills/design-qa/scripts/lib/png.mjs';
import { loadSchema, validateAgainstSchema } from '../skills/design-qa/scripts/lib/schema-check.mjs';
import { fixture, loadFixture, run, script, tmpDir } from './_helpers.mjs';

const set = () => buildTokenSet([{ kind: 'tokens-file', file: null, parsed: parseJsonTokens(loadFixture('ds-audit-tokens.json')) }]);
const TEXT = { 'font-size': '16px', 'line-height': '24px', 'font-weight': '400', 'font-family': 'Arial', 'letter-spacing': 'normal' };

function el(i, over) {
  const rect = over.rect ?? { x: 0, y: i * 60, w: 300, h: 40 };
  return { i, p: 0, d: 2, path: `main > div:nth-of-type(${i})`, tag: 'div', id: null, cls: [], role: null, type: null, attrs: {}, text: null, control: null, own: false, rect, vis: rect, partial: false, clip: null, r: -1, sel: null, s: {}, v: null, inh: null, ...over };
}
// The collector's i is the element's position in the list: keep it so.
const audit = (elements) => ({ version: 1, fullPage: true, page: { w: 800, h: 1000 }, rootFontSize: 16, bodyText: null, rootTokens: {}, regions: [], selectors: [], stats: {}, truncated: null, elements: elements.map((e, k) => ({ ...e, i: k })) });
const root = { i: 0, p: -1, d: 1, path: 'main', tag: 'main', id: null, cls: [], role: null, type: null, attrs: {}, text: null, control: null, own: false, rect: { x: 0, y: 0, w: 800, h: 1000 }, vis: { x: 0, y: 0, w: 800, h: 1000 }, partial: false, clip: null, r: -1, sel: null, s: {}, v: null, inh: null };

// The app: four groups the audit flags against the tokens.
function appPage() {
  return audit([
    root,
    // 13px card padding: the design uses it too (same path).
    el(1, { cls: ['card'], s: { 'padding-top': '13px', 'padding-left': '13px' } }),
    el(2, { cls: ['card'], s: { 'padding-top': '13px', 'padding-left': '13px' } }),
    // A select's 10px side padding: the design has 12px (space.3).
    el(3, { tag: 'select', path: 'main > select', control: 'select', s: { 'padding-left': '10px', 'padding-right': '10px' } }),
    // A hand-typed colour on an element the design does not have.
    el(4, { path: 'main > p.only-in-app', tag: 'p', own: true, text: 'App only', rect: { x: 400, y: 700, w: 120, h: 24 }, s: { color: 'rgb(180, 35, 24)', ...TEXT } }),
    // A label both sides have (matched by its text), 40px lower in the design: it gives the shift.
    el(8, { path: 'main > p.summary', tag: 'p', own: true, text: 'Summary', rect: { x: 20, y: 450, w: 200, h: 24 }, s: { color: 'rgb(26, 29, 35)', ...TEXT } }),
    // Matched by geometry after that 40px shift (a banner above it in the design): same 26px heading.
    el(5, { path: 'main > h2.title', tag: 'h2', own: true, text: 'Totals', rect: { x: 20, y: 500, w: 200, h: 32 }, s: { color: 'rgb(26, 29, 35)', 'font-size': '26px', 'line-height': '32px', 'font-weight': '700', 'font-family': 'Arial', 'letter-spacing': 'normal' } }),
    // Components: a native button the design has too; a third-party button where the design has the DS one.
    el(6, { tag: 'button', path: 'main > button.plain', cls: ['plain'], control: 'button', own: true, text: 'Raw', rect: { x: 0, y: 800, w: 80, h: 32 } }),
    el(7, { tag: 'button', path: 'main > button.MuiButton-root', cls: ['MuiButtonBase-root', 'MuiButton-root'], control: 'button', own: true, text: 'Export', rect: { x: 100, y: 800, w: 80, h: 32 } }),
  ]);
}
function designPage() {
  return audit([
    root,
    el(1, { cls: ['card'], s: { 'padding-top': '13px', 'padding-left': '13px' } }),
    el(2, { cls: ['card'], s: { 'padding-top': '13px', 'padding-left': '13px' } }),
    el(3, { tag: 'select', path: 'main > select', control: 'select', s: { 'padding-left': '12px', 'padding-right': '12px' }, v: { 'padding-left': '--space-3' } }),
    el(8, { path: 'main > div.banner-wrap > p', tag: 'p', own: true, text: 'Summary', rect: { x: 20, y: 490, w: 200, h: 24 }, s: { color: 'rgb(26, 29, 35)', ...TEXT } }),
    // Another heading path and text, the same box 40px lower: found by geometry.
    el(5, { path: 'main > div.banner-wrap > h2', tag: 'h2', own: true, text: 'Order totals', rect: { x: 20, y: 540, w: 200, h: 32 }, s: { color: 'rgb(26, 29, 35)', 'font-size': '26px', 'line-height': '32px', 'font-weight': '700', 'font-family': 'Arial', 'letter-spacing': 'normal' } }),
    el(6, { tag: 'button', path: 'main > button.plain', cls: ['plain'], control: 'button', own: true, text: 'Raw', rect: { x: 0, y: 840, w: 80, h: 32 } }),
    el(7, { tag: 'button', path: 'main > button.MuiButton-root', cls: ['ds-btn'], control: 'button', own: true, text: 'Export', attrs: { 'data-ds-component': 'Button' }, rect: { x: 100, y: 840, w: 80, h: 32 } }),
  ]);
}

const catalog = () => JSON.parse(readFileSync(fixture('ds-audit-catalog.json'), 'utf8'));
const libraries = () => normalizeLibraries([{ name: 'Mui', kind: 'third-party', classPrefix: 'Mui' }], { dsName: 'Acme DS', catalog: catalog() });

function runPair(design, { screen = null } = {}) {
  const state = { id: screen ? `${screen}/with-data` : 'with-data', name: 'with-data', screen };
  const r = auditState({ audit: appPage(), state, set: set(), libraries: libraries(), catalog: catalog(), image: { width: 800, height: 1000 }, design });
  return buildCandidates([r], { evidencePaths: () => ({ screenshot: 'evidence/app/with-data.png', audit: 'evidence/audit/with-data.json' }) });
}

test('prototype design: shared token drift remains a candidate; shared components and design differences stay distinct', () => {
  const design = designSide({ audit: designPage() });
  const { candidates, designAlso } = runPair(design);
  const keys = Object.fromEntries(candidates.map((c) => [c.key, c]));
  const also = Object.fromEntries(designAlso.map((d) => [d.key, d]));

  assert.equal(also['style:space:13px'], undefined);
  assert.equal(keys['style:space:13px']._audit.count, 2);
  assert.equal(keys['style:space:13px']._audit.designCheck, 'same');
  assert.equal(keys['style:space:13px'].resolution, 'FIX_CODE');

  const select = keys['style:space:10px'];
  assert.ok(select, 'a value the design does not have is a candidate');
  assert.equal(select._audit.designCheck, 'different');
  assert.equal(select._audit.designValue, '12px');
  assert.deepEqual([select.expected.value, select.expected.token, select.expected.source], ['12px', 'space.3', 'prototype']);
  assert.match(select.title, /^Padding 10px; the design has 12px \(space\.3\) on 1 element · nearest token space\.2 8px$/);
  assert.equal(select.severity, 'WARNING');

  const onlyApp = keys['style:color:#b42318'];
  assert.equal(onlyApp._audit.designCheck, 'unknown');
  assert.equal(onlyApp._audit.designValue, 'unknown');
  assert.match(onlyApp._audit.designHint, /semantic token/);
  assert.equal(onlyApp.expected.source, 'design-rules', 'no design value: the nearest token, as before');

  assert.ok(also['component:raw:button>acme-button'], 'the design has the same native button');
  const mui = keys['component:mui:mui-button>acme-button'];
  assert.equal(mui._audit.designCheck, 'different');
  assert.equal(mui.expected.value, 'Button (design)');
  assert.equal(mui.severity, 'BLOCKER');
  assert.match(mui.title, /renders where the design has Button/);

  // Every candidate is still a report finding once given an id and a rank.
  const schema = loadSchema('report');
  for (const [k, c] of candidates.entries()) {
    const { key, _audit, ...f } = c;
    const { errors } = validateAgainstSchema({ id: `DQ-${900 + k}`, ...f, rank: null }, { definitions: schema.definitions, $ref: '#/definitions/finding' });
    assert.deepEqual(errors, [], key);
  }
});

test('geometry match after a vertical shift; ambiguity is no match', () => {
  const app = appPage();
  const design = designSide({ audit: designPage() });
  const match = designMatcher(app.elements, design);
  assert.equal(match(app.elements[1]).via, 'path');
  assert.equal(match(app.elements.find((e) => e.text === 'Summary')).via, 'text');
  const heading = match(app.elements.find((e) => e.text === 'Totals'));
  assert.equal(heading.via, 'geometry', 'another path and text, the same box 40px lower');
  assert.equal(heading.nodes[0].path, 'main > div.banner-wrap > h2');
  const { candidates } = runPair(design);
  assert.ok(candidates.some((d) => d.key === 'style:text:26px/32px-700-arial'), 'shared off-token typography still needs fixing');
  // Two design boxes at the same place with nothing to tell them apart: no match.
  const twins = designSide({ audit: audit([root, el(1, { path: 'x', tag: 'span', rect: { x: 5, y: 5, w: 10, h: 10 } }), el(2, { path: 'y', tag: 'span', rect: { x: 5, y: 5, w: 10, h: 10 } })]) });
  assert.equal(designMatcher([el(1, { path: 'z', tag: 'span', rect: { x: 5, y: 5, w: 10, h: 10 } })], twins)(el(1, { path: 'z', tag: 'span', rect: { x: 5, y: 5, w: 10, h: 10 } })), null);
});

test('keys stay stable: a group that moves to designAlso just leaves candidates', () => {
  const none = runPair(designSide()).candidates.map((c) => c.key);
  const withDesign = runPair(designSide({ audit: designPage() })).candidates.map((c) => c.key);
  assert.ok(withDesign.every((k) => none.includes(k.split(':required:')[0])), 'semantic bindings refine usage candidate keys without changing the value key');
  assert.deepEqual(withDesign, runPair(designSide({ audit: designPage() })).candidates.map((c) => c.key), 'keys stay stable for the same evidence');
  assert.ok(none.includes('component:raw:button>acme-button'));
  assert.ok(!withDesign.includes('component:raw:button>acme-button'), 'only shared component candidates are suppressed');
  assert.ok(withDesign.includes('style:space:13px'), 'shared token drift is retained');
  assert.ok(runPair(designSide()).candidates.every((c) => c._audit.designCheck === 'unknown'), 'no design data: every candidate is unknown');
});

// A Figma REST spec: one frame, layers with values and bound variables.
function restSpec({ mcp = false } = {}) {
  const box = (x, y, width, height) => ({ x: 1000 + x, y: 2000 + y, width, height });
  const layers = [
    { id: '1:1', name: 'Cart', type: 'FRAME', depth: 0, absoluteBoundingBox: box(0, 0, 800, 1000) },
    { id: '1:2', name: 'Select', type: 'FRAME', depth: 1, absoluteBoundingBox: box(0, 180, 300, 40), paddingLeft: 12, paddingRight: 12, boundVariables: { paddingLeft: { id: 'v1' } } },
    { id: '1:3', name: 'Card', type: 'FRAME', depth: 1, absoluteBoundingBox: box(0, 60, 300, 40), paddingLeft: 13, paddingTop: 13 },
    { id: '1:4', name: 'Card', type: 'FRAME', depth: 1, absoluteBoundingBox: box(0, 120, 300, 40), paddingLeft: 13, paddingTop: 13 },
    { id: '1:5', name: 'Note', type: 'TEXT', depth: 1, characters: 'App only', absoluteBoundingBox: box(400, 700, 120, 24), fills: [{ type: 'SOLID', color: { r: 180 / 255, g: 35 / 255, b: 24 / 255, a: 1 } }], style: { fontFamily: 'Arial', fontSize: 16, fontWeight: 400, lineHeightPx: 24 } },
  ];
  return { nodeId: '1:1', layers, variables: { v1: { name: 'space/3' } }, ...(mcp ? { source: 'mcp', unavailable: ['fills', 'style', 'characters'] } : {}) };
}

test('Figma REST spec: layer values decide same, different and the bound variable', () => {
  const design = designSide({ spec: restSpec(), nodeId: '1:1' });
  assert.equal(design.kind, 'figma');
  assert.equal(design.values, true);
  const { candidates, designAlso } = runPair(design);
  const keys = Object.fromEntries(candidates.map((c) => [c.key, c]));
  assert.ok(candidates.some((d) => d.key === 'style:space:13px'), 'shared off-token padding remains a candidate');
  assert.ok(candidates.some((d) => d.key === 'style:color:#b42318'), 'shared off-token colour remains a candidate');
  const select = keys['style:space:10px'];
  assert.deepEqual([select._audit.designCheck, select.expected.value, select.expected.token, select.expected.source], ['different', '12px', 'space/3', 'figma']);
});

test('Figma MCP spec (no values): every candidate is design unknown', () => {
  const design = designSide({ spec: restSpec({ mcp: true }), nodeId: '1:1' });
  assert.equal(design.values, false);
  const { candidates, designAlso } = runPair(design);
  assert.equal(designAlso.length, 0);
  assert.ok(candidates.length > 0);
  for (const c of candidates) assert.equal(c._audit.designValue, 'unknown', c.key);
});

test('sameValue: colours within ΔE, lengths within px, families by their first name', () => {
  assert.equal(sameValue('color', 'rgb(37, 99, 235)', 'rgba(37, 99, 235, 1)'), true);
  assert.equal(sameValue('color', 'rgb(37, 99, 235)', 'rgb(25, 118, 210)'), false);
  assert.equal(sameValue('space', '12px', '12.4px'), true);
  assert.equal(sameValue('space', '10px', '12px'), false);
  assert.equal(sameValue('font-family', '"Inter", sans-serif', 'Inter'), true);
  assert.equal(sameValue('letter-spacing', 'normal', '0px'), true);
});

test('CLI: design-audit/ beside audit/ (prototype layout), the three numbers in the summary and on stdout', async () => {
  const dir = tmpDir();
  const ev = path.join(dir, 'evidence');
  for (const sub of ['audit', 'design-audit', 'app', 'design']) mkdirSync(path.join(ev, sub), { recursive: true });
  writeFileSync(path.join(ev, 'audit', 'with-data.json'), JSON.stringify(appPage()));
  writeFileSync(path.join(ev, 'design-audit', 'with-data.json'), JSON.stringify(designPage()));
  writePng(path.join(ev, 'app', 'with-data.png'), createPng(800, 1000));
  writeFileSync(path.join(ev, 'capture.json'), JSON.stringify({ states: { 'with-data': { screenshot: 'app/with-data.png', audit: 'audit/with-data.json' } } }));
  writeFileSync(path.join(ev, 'design-capture.json'), JSON.stringify({ side: 'design', states: { 'with-data': { screenshot: 'design/with-data.png', audit: 'design-audit/with-data.json' } } }));
  writeFileSync(path.join(dir, 'tokens.json'), readFileSync(fixture('ds-audit-tokens.json')));
  writeFileSync(path.join(dir, 'catalog.json'), readFileSync(fixture('ds-audit-catalog.json')));
  const config = { app: { baseUrl: 'http://localhost:3000' }, surfaces: { s: { route: '/' } }, designSystem: { name: 'Acme DS', tokens: ['tokens.json'], componentCatalog: 'catalog.json', libraries: [{ name: 'Mui', kind: 'third-party', classPrefix: 'Mui' }] } };
  writeFileSync(path.join(dir, 'design-qa.config.json'), JSON.stringify(config));
  const res = await run(script('ds-audit.mjs'), ['--evidence', ev, '--config', path.join(dir, 'design-qa.config.json')]);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(readFileSync(path.join(ev, 'ds-audit.json'), 'utf8'));
  const { designDifferent, designAlso, designUnknown, offTokenValues } = out.summary;
  assert.equal(designAlso, out.designAlso.length);
  assert.ok(designAlso >= 1 && designDifferent >= 2 && designUnknown >= 1, JSON.stringify(out.summary));
  assert.equal(designDifferent + designUnknown + out.summary.designSame, out.candidates.length);
  assert.equal(offTokenValues, out.candidates.filter((c) => c.ledger === 'style' && !['token-usage', 'wrong-token'].includes(c._audit.kind)).length, 'value deviations exclude unverified usage and semantic-only mismatches');
  assert.equal(out.states['with-data'].designData, 'evidence/design-audit/with-data.json');
  assert.match(res.stdout, new RegExp(`Design check: ${designDifferent} real difference\\(s\\).*${designAlso} shared component groups.*${designUnknown} design unknown`));
  assert.match(res.stdout, /Token compliance:/);
  // A failed design state (audit null in design-capture.json) falls back to unknown, with a warning.
  writeFileSync(path.join(ev, 'design-capture.json'), JSON.stringify({ side: 'design', states: { 'with-data': { screenshot: null, audit: null } } }));
  const res2 = await run(script('ds-audit.mjs'), ['--evidence', ev, '--config', path.join(dir, 'design-qa.config.json'), '--out', path.join(dir, 'b.json')]);
  assert.equal(res2.code, 0, res2.stderr);
  const b = JSON.parse(readFileSync(path.join(dir, 'b.json'), 'utf8'));
  assert.equal(b.summary.designAlso, 0);
  assert.equal(b.summary.designUnknown, b.candidates.length);
  assert.match(res2.stdout, /no design-side data/);
});
