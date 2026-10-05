// Design-system audit, Node half: token sources, value checks, component classification,
// grouping, candidates and the CLI on synthetic audit files (no browser needed).
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  auditState,
  buildCandidates,
  buildTokenSet,
  checkTextStyle,
  checkValue,
  classifyComponents,
  componentKind,
  cropInImage,
  hexOf,
  knownDriftHint,
  matchSelector,
  normalizeLibraries,
  pageTokens,
  parseCssTokens,
  parseJsonTokens,
  parseKnownDrifts,
  parseShadow,
  parseTokenMapFile,
  scanSourceImports,
  tokenForVar,
} from '../skills/design-qa/scripts/lib/ds-audit.mjs';
import { createPng, writePng } from '../skills/design-qa/scripts/lib/png.mjs';
import { loadSchema, validateAgainstSchema, validateReport } from '../skills/design-qa/scripts/lib/schema-check.mjs';
import { SKILL, fixture, loadFixture, run, script, tmpDir } from './_helpers.mjs';

const DS_AUDIT = script('ds-audit.mjs');
const jsonTokens = () => parseJsonTokens(loadFixture('ds-audit-tokens.json'), { file: 'tokens.json' });
const setFrom = (...parsed) => buildTokenSet(parsed.map((p, k) => ({ kind: `s${k}`, file: null, parsed: p })));

// A recorded element, as audit-collect.mjs writes it.
let nextI = 0;
function el(over = {}) {
  const i = over.i ?? nextI++;
  const rect = over.rect ?? { x: 0, y: i * 40, w: 200, h: 32 };
  return { i, p: -1, d: 2, path: `div:nth-of-type(${i + 1})`, tag: 'div', id: null, cls: [], role: null, type: null, attrs: {}, text: null, control: null, own: false, rect, vis: rect, partial: false, clip: null, r: -1, sel: null, s: {}, v: null, inh: null, ...over };
}
function audit(elements, extra = {}) {
  return { version: 1, fullPage: true, scroll: { x: 0, y: 0 }, viewport: { w: 800, h: 600 }, page: { w: 800, h: 2000 }, rootFontSize: 16, bodyText: null, rootTokens: {}, regions: [], selectors: [], stats: {}, truncated: null, elements, ...extra };
}
function reindex(elements) {
  elements.forEach((e, k) => (e.i = k));
  return elements;
}

// ---------------------------------------------------------------------------
// Token sources
// ---------------------------------------------------------------------------

test('W3C design tokens: $type inherited from groups, aliases, dimension objects, typography composites', () => {
  const parsed = jsonTokens();
  const byName = Object.fromEntries(parsed.tokens.map((t) => [t.name, t]));
  assert.equal(byName['color.text.primary'].category, 'color');
  assert.equal(byName['color.text.inverse'].value, '#ffffff', 'the {color.surface.default} alias is resolved');
  assert.equal(byName['space.4'].px, 16, '{ value: 1, unit: rem } is 16px');
  assert.equal(byName['space.3'].category, 'space');
  assert.equal(byName['radius.full'].category, 'radius');
  assert.equal(byName['font.family.sans'].family, 'arial');
  assert.deepEqual(byName['color.text.primary'].vars, ['--color-text-primary']);
  const body = parsed.textStyles.find((s) => s.name === 'typography.body.md');
  assert.deepEqual({ size: body.size, lineHeight: body.lineHeight, weight: body.weight, family: body.family }, { size: 16, lineHeight: 24, weight: 400, family: 'arial' }, 'a unitless line height is × the size');
});

test('flat JSON maps and theme objects exported to JSON', () => {
  const flat = parseJsonTokens({ '--brand': '#2563eb', '--gap-m': { value: '12px', category: 'spacing' } });
  assert.deepEqual(flat.tokens.map((t) => [t.name, t.category]), [['--brand', 'color'], ['--gap-m', 'space']]);
  // A theme object (as a JS theme module exports to JSON): nested plain values, unitless lengths, typography objects.
  const theme = parseJsonTokens({
    palette: { primary: { main: '#1976d2' }, text: { secondary: 'rgba(0, 0, 0, 0.6)' } },
    shape: { borderRadius: 4 },
    typography: { h1: { fontSize: '6rem', fontWeight: 300, lineHeight: 1.167, letterSpacing: '-0.01562em' }, fontFamily: 'Roboto, sans-serif' },
  });
  const names = Object.fromEntries(theme.tokens.map((t) => [t.name, t]));
  assert.equal(names['palette.primary.main'].category, 'color');
  assert.equal(names['shape.borderRadius'].category, 'radius');
  assert.equal(names['shape.borderRadius'].px, 4, 'a unitless radius is px');
  const h1 = theme.textStyles.find((s) => s.name === 'typography.h1');
  assert.equal(h1.size, 96);
  assert.equal(Math.round(h1.lineHeight), 112);
  assert.ok(Math.abs(h1.letterSpacing - -1.5) < 0.01, 'em letter spacing × the size');
});

test('CSS custom properties: :root wins, var() resolved, theme-only names counted, font shorthands become text styles', () => {
  const parsed = parseCssTokens(readFileSync(fixture('ds-audit-tokens.css'), 'utf8'), { file: 'tokens.css' });
  const byName = Object.fromEntries(parsed.tokens.map((t) => [t.name, t]));
  assert.equal(byName['--acme-color-text'].value, '#1a1d23', 'the :root value, not the dark theme');
  assert.equal(byName['--acme-color-brand'].value, '#2563eb', 'var(--acme-blue-600) resolved');
  assert.equal(byName['--acme-space-3'].px, 12, '0.75rem');
  assert.equal(byName['--acme-shadow-raised'].category, 'shadow');
  assert.equal(byName['--acme-color-dark-only'].value, '#000000');
  assert.equal(parsed.modes, 1, 'one name exists only under a theme selector');
  assert.deepEqual(parsed.textStyles.map((s) => [s.name, s.size, s.lineHeight, s.weight]), [['--acme-font-body', 16, 24, 400]]);
});

test('the markdown token map: backticked rows by section, Typography rows as text styles', () => {
  const md = readFileSync(path.join(SKILL, 'references', 'templates', 'token-map.template.md'), 'utf8');
  const parsed = parseTokenMapFile(md, { file: 'token-map.md' });
  const byName = Object.fromEntries(parsed.tokens.map((t) => [t.name, t]));
  assert.equal(byName['--ds-color-text-primary'].category, 'color');
  assert.equal(byName['--ds-space-4'].px, 16);
  assert.equal(byName['--ds-radius-control'].category, 'radius');
  assert.equal(byName['--ds-shadow-raised'].category, 'shadow');
  assert.equal(byName['--ds-duration-fast'], undefined, 'motion is not audited');
  const micro = parsed.textStyles.find((s) => s.name === '--ds-font-label-micro');
  assert.deepEqual({ size: micro.size, lh: micro.lineHeight, w: micro.weight, t: micro.transform, ls: micro.letterSpacing }, { size: 11, lh: 16, w: 600, t: 'uppercase', ls: 0.44 });
});

test('page :root tokens; merging keeps the first value and lists conflicts', () => {
  const page = pageTokens({ '--brand': 'rgb(37, 99, 235)', '--gap': '12px', '--z-modal': '1000' });
  const set = setFrom(parseJsonTokens({ '--brand': '#ff0000' }), page);
  assert.equal(set.tokens.find((t) => t.name === '--brand').value, '#ff0000');
  assert.equal(set.conflicts.length, 1);
  assert.equal(set.pools.space.length, 1, '--gap is a spacing token by its name');
  assert.equal(tokenForVar(set, '--gap').name, '--gap');
  const json = setFrom(jsonTokens());
  assert.equal(tokenForVar(json, '--acme-color-text-primary')?.name, 'color.text.primary', 'a build prefix in front of the --kebab path still names the token');
});

// ---------------------------------------------------------------------------
// Value checks
// ---------------------------------------------------------------------------

test('colours: exact match, near miss within ΔE, off-token with the nearest token and distance; transparent skipped', () => {
  const set = setFrom(jsonTokens());
  assert.equal(checkValue(set, 'color', 'rgb(37, 99, 235)').status, 'match');
  const near = checkValue(set, 'color', 'rgb(38, 100, 235)');
  assert.equal(near.status, 'near');
  assert.equal(near.token.name, 'color.brand.primary');
  assert.ok(near.distance > 0 && near.distance <= 1.5);
  const off = checkValue(set, 'color', 'rgb(58, 63, 71)');
  assert.equal(off.status, 'off');
  assert.equal(off.token.name, 'color.text.primary');
  assert.equal(off.unit, 'ΔE');
  assert.equal(checkValue(set, 'color', 'rgba(0, 0, 0, 0)').status, 'skip');
  assert.equal(checkValue(set, 'color', 'rgba(37, 99, 235, 0.5)').status, 'off', 'a different alpha is not the token');
  assert.equal(checkValue(set, 'color', 'rgb(37, 99, 235)', { colorDeltaE: 0 }).status, 'match');
});

test('lengths: spacing and radius by category only, px tolerance, zero and pills', () => {
  const set = setFrom(jsonTokens());
  assert.equal(checkValue(set, 'space', '12px').status, 'match');
  assert.equal(checkValue(set, 'space', '13px').status, 'near');
  const off = checkValue(set, 'space', '20px');
  assert.deepEqual([off.status, off.token.name, off.distance], ['off', 'space.4', 4]);
  assert.equal(checkValue(set, 'space', '0px').status, 'skip');
  assert.equal(checkValue(set, 'space', '-12px').status, 'match', 'a negative margin is checked by size');
  assert.equal(checkValue(set, 'radius', '8px').status, 'off', '8px is a spacing value, never a radius token');
  assert.equal(checkValue(set, 'radius', '16px', { box: { w: 32, h: 32 } }).token.name, 'radius.full', 'a circle is the full radius');
  assert.equal(checkValue(set, 'radius', '50%').status, 'skip');
  assert.equal(checkValue(set, 'shadow', '0px 1px 2px rgb(0,0,0)').why, 'no-tokens', 'no shadow tokens: not checked');
  const css = setFrom(parseCssTokens(readFileSync(fixture('ds-audit-tokens.css'), 'utf8')));
  assert.equal(checkValue(css, 'shadow', 'rgba(16, 24, 40, 0.08) 0px 1px 2px 0px').status, 'match', 'computed shadow order (colour first) matches the authored one');
  assert.equal(checkValue(css, 'shadow', 'rgba(16, 24, 40, 0.08) 0px 2px 2px 0px').status, 'near');
  assert.equal(checkValue(css, 'shadow', 'rgba(16, 24, 40, 0.08) 0px 8px 24px 0px').status, 'off');
  assert.deepEqual(parseShadow('inset 0 0 0 1px #ccc')[0].lengths, [0, 0, 0, 1]);
});

test('typography: checked as a set against text styles', () => {
  const set = setFrom(jsonTokens());
  const t = (size, lh, weight, extra = {}) => ({ 'font-size': size, 'line-height': lh, 'font-weight': weight, 'letter-spacing': 'normal', 'font-family': 'Arial, sans-serif', ...extra });
  assert.equal(checkTextStyle(set, t('16px', '24px', '400')).style.name, 'typography.body.md');
  assert.equal(checkTextStyle(set, t('16px', '24px', '400')).status, 'match');
  assert.equal(checkTextStyle(set, t('16px', '25px', '400')).status, 'near');
  const off = checkTextStyle(set, t('15px', '22px', '500'));
  assert.equal(off.status, 'off');
  assert.ok(off.diffs.some((d) => /weight 500/.test(d)));
  assert.equal(checkTextStyle(set, t('16px', '24px', '400', { 'font-family': 'Georgia, serif' })).status, 'off', 'the family is part of the style');
  assert.equal(checkTextStyle(setFrom(parseJsonTokens({ '--brand': '#000' })), t('16px', '24px', '400')).status, 'skip', 'no text styles: typography is checked one property at a time');
});

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

test('selectors over recorded elements: compound, attribute operators, :not, lists; null for combinators', () => {
  const e = el({ tag: 'button', cls: ['btn', 'MuiButton-root'], attrs: { 'data-ds-component': 'Button', type: 'submit' }, type: null });
  assert.equal(matchSelector(e, 'button.btn'), true);
  assert.equal(matchSelector(e, "[data-ds-component='Button']"), true);
  assert.equal(matchSelector(e, '[class^=Mui]'), false, 'the class attribute starts with "btn"');
  assert.equal(matchSelector(e, '[class*=MuiButton]'), true);
  assert.equal(matchSelector(e, 'button:not([data-ds-component])'), false);
  assert.equal(matchSelector(el({ tag: 'button' }), 'button:not([data-ds-component])'), true);
  assert.equal(matchSelector(e, 'a, button.btn'), true);
  assert.equal(matchSelector(e, 'main button'), null);
  assert.equal(matchSelector(e, 'button:hover'), null);
  assert.equal(componentKind('MuiChip'), 'tag');
  assert.equal(componentKind('Text field'), 'textbox');
  assert.equal(componentKind('DataTable'), 'table');
  assert.equal(componentKind('Tabs'), 'tab');
});

test('components: per-library counts, third-party and legacy substitutions, the raw-primitive rule, native controls', () => {
  nextI = 0;
  const catalog = JSON.parse(readFileSync(fixture('ds-audit-catalog.json'), 'utf8'));
  const els = reindex([
    el({ tag: 'main', rect: { x: 0, y: 0, w: 800, h: 2000 } }),
    el({ tag: 'button', p: 0, cls: ['ds-btn'], attrs: { 'data-ds-component': 'Button' }, control: 'button' }),
    el({ tag: 'span', p: 1, rect: { x: 0, y: 40, w: 60, h: 20 } }), // inside the DS button
    el({ tag: 'button', p: 0, cls: ['MuiButtonBase-root', 'MuiButton-root'], control: 'button' }),
    el({ tag: 'span', p: 3, cls: ['MuiButton-label'], rect: { x: 0, y: 120, w: 60, h: 20 } }),
    el({ tag: 'div', p: 0, cls: ['MuiBox-root'] }), // third-party layout: counted, not a candidate
    el({ tag: 'span', p: 0, cls: ['legacy-tag'] }),
    el({ tag: 'button', p: 0, cls: ['plain'], control: 'button' }), // raw primitive
    el({ tag: 'input', p: 0, type: 'text', control: 'textbox' }), // native control with a DS equivalent
    el({ tag: 'input', p: 0, type: 'range', control: 'slider' }), // native control without one: listed, not a candidate
    el({ tag: 'div', p: 0, attrs: { 'data-ds-component': 'Select' } }),
    el({ tag: 'button', p: 10, control: 'button', rect: { x: 0, y: 400, w: 200, h: 32 } }), // inside a DS select: part of it
  ]);
  const libraries = normalizeLibraries([{ name: 'Mui', kind: 'third-party', classPrefix: 'Mui' }, { name: 'Old UI', kind: 'legacy', classPrefix: 'legacy-' }], { dsName: 'Acme DS', catalog });
  assert.equal(libraries[0].implicit, true, 'an implicit design-system library from [data-ds-component] and the catalog');
  const r = classifyComponents(audit(els), { libraries, catalog, selectorIndex: new Map(), unsupported: new Set() });
  assert.deepEqual(r.libraries.Mui, { kind: 'third-party', elements: 3, instances: 2 });
  assert.equal(r.libraries['Acme DS'].instances, 2);
  const by = Object.fromEntries(r.members.map((m) => [m.i, m]));
  assert.equal(by[3].component, 'MuiButton');
  assert.equal(by[3].ds.component, 'AcmeButton');
  assert.equal(by[3].severity, 'BLOCKER');
  assert.equal(by[4], undefined, 'the label is part of the Mui button');
  assert.equal(by[5], undefined, 'a layout box is no widget');
  assert.equal(by[6].origin, 'legacy');
  assert.equal(by[6].ds.component, 'AcmeTag');
  assert.equal(by[7].origin, 'raw-primitive');
  assert.equal(by[7].rawSelector, 'button:not([data-ds-component])');
  assert.equal(by[8].origin, 'native-control');
  assert.equal(by[8].ds.component, 'AcmeTextField');
  assert.equal(by[9].severity, null, 'no design-system slider: listed only');
  assert.equal(by[11], undefined, 'a native button inside a design-system select is part of it');
  assert.equal(by[1], undefined);
});

// ---------------------------------------------------------------------------
// Grouping, candidates, keys
// ---------------------------------------------------------------------------

function stylePage() {
  nextI = 0;
  const els = reindex([
    el({ tag: 'body', rect: { x: 0, y: 0, w: 800, h: 2000 } }),
    // Three cards: 13px padding (near miss) and a hand-typed text colour, one far down the page.
    el({ p: 0, cls: ['card'], own: true, text: 'Card', rect: { x: 0, y: 1500, w: 800, h: 50 }, s: { 'padding-top': '13px', 'padding-left': '13px', color: 'rgb(58, 63, 71)', 'font-size': '16px', 'line-height': '24px', 'font-weight': '400', 'font-family': 'Arial' } }),
    el({ p: 0, cls: ['card'], own: true, text: 'Card', rect: { x: 0, y: 100, w: 800, h: 50 }, s: { 'padding-top': '13px', 'padding-left': '13px', color: 'rgb(58, 63, 71)', 'font-size': '16px', 'line-height': '24px', 'font-weight': '400', 'font-family': 'Arial' } }),
    el({ p: 0, cls: ['card'], own: true, text: 'Card', rect: { x: 0, y: 200, w: 800, h: 50 }, vis: { x: 0, y: 200, w: 800, h: 10 }, partial: true, s: { 'padding-top': '13px', color: 'rgb(58, 63, 71)', 'font-size': '16px', 'line-height': '24px', 'font-weight': '400', 'font-family': 'Arial' } }),
    // Authored var(--ds) on an off value cannot happen; on the right value it is proof.
    el({ p: 0, rect: { x: 0, y: 300, w: 100, h: 20 }, s: { 'background-color': 'rgb(37, 99, 235)' }, v: { 'background-color': '--color-brand-primary' } }),
    // A text style off the scale and a near-miss colour.
    el({ p: 0, own: true, rect: { x: 0, y: 400, w: 100, h: 20 }, s: { color: 'rgb(38, 100, 235)', 'font-size': '15px', 'line-height': '22px', 'font-weight': '500', 'font-family': 'Arial' } }),
    // Inside a scroll container, scrolled out of the screenshot: pinned to the container.
    el({ p: 0, cls: ['scroller'], rect: { x: 0, y: 1700, w: 800, h: 120 }, s: { 'border-top-width': '1px', 'border-top-color': 'rgb(208, 212, 218)' } }),
    el({ p: 6, own: true, rect: { x: 0, y: 1900, w: 800, h: 60 }, vis: null, clip: 6, s: { color: 'rgb(180, 35, 24)', 'font-size': '16px', 'line-height': '24px', 'font-weight': '400', 'font-family': 'Arial' } }),
  ]);
  return audit(els);
}

function runAudit({ states = [{ id: 'with-data', name: 'with-data', screen: null }], image = { width: 800, height: 1800 }, page = stylePage } = {}) {
  const set = setFrom(jsonTokens());
  const libraries = normalizeLibraries([], {});
  const results = states.map((state) => auditState({ audit: page(), state, set, libraries, catalog: null, image }));
  return buildCandidates(results, { evidencePaths: (st) => ({ screenshot: `evidence/${st.screen ? `screens/${st.screen}/` : ''}app/${st.name}.png`, audit: `evidence/${st.screen ? `screens/${st.screen}/` : ''}audit/${st.name}.json` }), samples: 5 });
}

test('identical problems are one candidate with a count; samples most visible first; crops inside the image', () => {
  const { candidates, groups } = runAudit();
  const keys = candidates.map((c) => c.key);
  assert.deepEqual([...keys].sort(), ['style:border-width:1px', 'style:color:#2664eb', 'style:color:#3a3f47', 'style:color:#b42318', 'style:color:#d0d4da', 'style:space:13px', 'style:text:15px/22px-500-arial', 'style:text:16px/24px-400-arial'].sort());
  const pad = candidates.find((c) => c.key === 'style:space:13px');
  assert.equal(pad._audit.count, 3, 'three cards, padding-top and padding-left counted once per element');
  assert.deepEqual(pad._audit.properties, ['padding-left', 'padding-top']);
  assert.equal(pad._audit.kind, 'near-miss');
  assert.equal(pad.severity, 'WARNING');
  // Fully visible first (top of the page first among equals), the half-hidden card last.
  assert.deepEqual(pad._audit.samples.map((s) => s.rect.y), [100, 1500, 200]);
  assert.equal(pad.evidence[0].crop.y, 100);
  for (const c of candidates) {
    for (const s of [...c.evidence.filter((e) => e.crop).map((e) => e.crop), ...c._audit.samples.map((s) => s.crop).filter(Boolean)]) {
      assert.ok(s.x >= 0 && s.y >= 0 && s.w >= 1 && s.h >= 1 && s.x + s.w <= 800 && s.y + s.h <= 1800, `${c.key} crop inside the image: ${JSON.stringify(s)}`);
    }
  }
  const deep = candidates.find((c) => c.key === 'style:color:#b42318');
  assert.equal(deep._audit.samples[0].pinnedTo, 'scroll-container');
  assert.deepEqual(deep.evidence[0].crop, { x: 0, y: 1700, w: 800, h: 100 }, 'the container box, clipped to the image');
  assert.equal(groups.matches.find((m) => m.token === 'color.brand.primary').verified, 1, 'an authored var() is a proven match');
  const ink = candidates.find((c) => c.key === 'style:color:#3a3f47');
  assert.equal(ink.expected.token, 'color.text.primary');
  assert.equal(ink.actual.value, 'rgb(58, 63, 71)');
  assert.equal(ink.ledger, 'style');
  assert.match(ink.title, /matches no colour token/);
});

test('keys are stable across runs, unique, and screen-prefixed in a multi-screen pass', () => {
  const a = runAudit().candidates.map((c) => c.key);
  const b = runAudit().candidates.map((c) => c.key);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length);
  const multi = runAudit({ states: [{ id: 'cart/with-data', name: 'with-data', screen: 'cart' }, { id: 'checkout/with-data', name: 'with-data', screen: 'checkout' }] });
  const keys = multi.candidates.map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes('cart/style:space:13px') && keys.includes('checkout/style:space:13px'));
  const c = multi.candidates.find((x) => x.key === 'checkout/style:space:13px');
  assert.equal(c.screen, 'checkout');
  assert.equal(c.state, 'checkout/with-data');
  assert.equal(c.evidence[0].path, 'evidence/screens/checkout/app/with-data.png');
  // Across states of one screen, a problem is one candidate counting both states.
  const twoStates = runAudit({ states: [{ id: 'with-data', name: 'with-data', screen: null }, { id: 'hover', name: 'hover', screen: null }] });
  const pad = twoStates.candidates.find((x) => x.key === 'style:space:13px');
  assert.deepEqual(pad._audit.states, { hover: 3, 'with-data': 3 });
});

test('candidates are report findings once given an id and a rank', () => {
  const { candidates } = runAudit();
  const schema = loadSchema('report');
  const findingSchema = { definitions: schema.definitions, $ref: '#/definitions/finding' };
  const strip = ({ key, _audit, ...f }) => f;
  candidates.forEach((c, k) => {
    const finding = { id: `DQ-${String(900 + k).padStart(3, '0')}`, ...strip(c), rank: null };
    const { errors } = validateAgainstSchema(finding, findingSchema);
    assert.deepEqual(errors, [], `${c.key}: ${JSON.stringify(errors)}`);
  });
  // In a whole report: no error names an audit finding (pins, crops, ids…).
  const report = loadFixture('report-valid.json');
  const ids = candidates.map((c, k) => `DQ-${String(900 + k).padStart(3, '0')}`);
  report.findings.push(...candidates.map((c, k) => ({ id: ids[k], ...strip(c), rank: null })));
  const res = validateReport(report, { skipScorecard: true, skipRanks: true });
  const mine = res.errors.filter((e) => report.findings.some((f, i) => ids.includes(f.id) && String(e.path).startsWith(`findings[${i}]`)));
  assert.deepEqual(mine, []);
});

test('the page default text is checked once, not on every element that inherits it', () => {
  nextI = 0;
  const body = { color: 'rgb(58, 63, 71)', 'font-family': 'Arial', 'font-size': '16px', 'font-weight': '400', 'line-height': '24px', 'letter-spacing': 'normal', 'text-transform': 'none' };
  const els = reindex(Array.from({ length: 30 }, (_, k) => el({ own: true, rect: { x: 0, y: k * 30, w: 300, h: 20 }, s: { ...body }, inh: ['color', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing'] })));
  const set = setFrom(jsonTokens());
  const r = auditState({ audit: audit(els, { bodyText: body }), state: { id: 's', name: 's', screen: null }, set, libraries: normalizeLibraries([], {}), catalog: null, image: { width: 800, height: 1000 } });
  const { candidates } = buildCandidates([r], { evidencePaths: () => ({ screenshot: 'evidence/app/s.png', audit: 'evidence/audit/s.json' }) });
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((c) => c._audit.count === 1), 'page defaults are audited once per property/composite');
  assert.ok(candidates.some((c) => /^Page default text colour #3a3f47/.test(c.title)));
  assert.ok(candidates.some((c) => c._audit.kind === 'token-usage'), 'the matching default type style still requires source verification');
});

test('known drifts: parsed from the template and attached as hints', () => {
  const drifts = parseKnownDrifts(readFileSync(path.join(SKILL, 'references', 'templates', 'known-drifts.template.md'), 'utf8'));
  assert.deepEqual(drifts.map((d) => [d.id, d.retired]), [['KD-1', false], ['KD-2', false], ['KD-3', true]]);
  assert.equal(knownDriftHint(drifts, { actual: ['12px'], expected: ['11px'] })?.id, 'KD-1');
  assert.equal(knownDriftHint(drifts, { actual: ['13px'], expected: ['11px'] }), null);
  assert.equal(knownDriftHint(drifts, { actual: ['single-layer'], expected: ['shadow/raised'] }), null, 'a retired drift is never hinted');
});

test('source scan: which files import each library package (a hint), symlinks not followed', () => {
  const dir = tmpDir();
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  mkdirSync(path.join(dir, 'node_modules', '@mui'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'a.tsx'), "import { Button, Chip as C } from '@mui/material';\nimport { AcmeButton } from '@acme/ds';\n");
  writeFileSync(path.join(dir, 'src', 'b.jsx'), "import TextField from '@mui/material/TextField';\n");
  writeFileSync(path.join(dir, 'node_modules', '@mui', 'x.js'), "import { Button } from '@mui/material';\n");
  const libs = normalizeLibraries([{ name: 'Mui', kind: 'third-party', classPrefix: 'Mui', package: '@mui/material' }, { name: 'Acme DS', kind: 'design-system', selector: '[data-ds-component]', package: ['@acme/ds'] }]);
  const r = scanSourceImports(dir, libs);
  assert.equal(r.libraries.Mui.files, 2);
  assert.deepEqual(r.libraries.Mui.imports, { Button: 1, Chip: 1, TextField: 1 });
  assert.equal(r.libraries['Acme DS'].files, 1);
  assert.match(r.note, /local checkout/);
});

test('helpers: hex form, crops clipped to the image', () => {
  assert.equal(hexOf('rgb(58, 63, 71)'), '#3a3f47');
  assert.equal(hexOf('rgba(0, 0, 0, 0.5)'), '#00000080');
  assert.deepEqual(cropInImage({ x: -10, y: 790, w: 100, h: 50 }, { width: 800, height: 800 }), { x: 0, y: 790, w: 90, h: 10 });
  assert.equal(cropInImage({ x: 0, y: 900, w: 100, h: 50 }, { width: 800, height: 800 }), null);
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function writeEvidence(dir, { screen = null, state = 'with-data', page = stylePage() } = {}) {
  const base = screen ? path.join(dir, 'evidence', 'screens', screen) : path.join(dir, 'evidence');
  mkdirSync(path.join(base, 'audit'), { recursive: true });
  mkdirSync(path.join(base, 'app'), { recursive: true });
  writeFileSync(path.join(base, 'audit', `${state}.json`), JSON.stringify(page));
  writePng(path.join(base, 'app', `${state}.png`), createPng(800, 1800));
  writeFileSync(path.join(base, 'capture.json'), JSON.stringify({ states: { [state]: { screenshot: `app/${state}.png`, audit: `audit/${state}.json` } } }));
}

test('CLI: no token source at all is exit 2, recorded as skipped with why and how to turn it on', async () => {
  const dir = tmpDir();
  writeEvidence(dir);
  const res = await run(DS_AUDIT, ['--evidence', path.join(dir, 'evidence')]);
  assert.equal(res.code, 2, res.stderr);
  assert.match(res.stderr, /audit skipped: no style values to check against: no token file is configured and the page defines no CSS variables\. Pass --tokens <file> or --config\./);
  const skipped = JSON.parse(readFileSync(path.join(dir, 'evidence', 'ds-audit.json'), 'utf8'));
  assert.deepEqual([skipped.skipped.reason.slice(0, 32), skipped.candidates, skipped.summary.candidates], ['no style values to check against', [], 0]);
  const none = await run(DS_AUDIT, ['--evidence', tmpDir()]);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /no audit file/);
});

test('CLI: a JS theme is never run: skipped with the export command; config paths must stay inside its folder', async () => {
  const dir = tmpDir();
  writeEvidence(dir);
  writeFileSync(path.join(dir, 'theme.ts'), 'export default {}');
  const js = await run(DS_AUDIT, ['--evidence', path.join(dir, 'evidence'), '--tokens', path.join(dir, 'theme.ts')]);
  assert.equal(js.code, 2);
  assert.match(js.stderr, /theme\.ts is a theme in code, which the audit never runs\. With the person's agreement \(it runs that file once\): node \S*setup\.mjs export-theme --from \S*theme\.ts/);
  const config = { app: { baseUrl: 'http://localhost:3000' }, surfaces: { s: { route: '/' } }, designSystem: { tokens: ['../outside.json'] } };
  writeFileSync(path.join(dir, 'design-qa.config.json'), JSON.stringify(config));
  const out = await run(DS_AUDIT, ['--evidence', path.join(dir, 'evidence'), '--config', path.join(dir, 'design-qa.config.json')]);
  assert.equal(out.code, 2);
  assert.match(out.stderr, /designSystem\.tokens points outside the folder of the config file/);
});

test('CLI: multi-screen evidence, config tokens, keys on stdout, summary names for meta.dsAudit', async () => {
  const dir = tmpDir();
  writeEvidence(dir, { screen: 'cart' });
  writeEvidence(dir, { screen: 'checkout' });
  writeFileSync(path.join(dir, 'tokens.json'), readFileSync(fixture('ds-audit-tokens.json')));
  const config = { app: { baseUrl: 'http://localhost:3000' }, surfaces: { s: { route: '/' } }, designSystem: { name: 'Acme DS', tokens: ['tokens.json'] }, tolerances: { px: 1, colorDeltaE: 1.5 } };
  writeFileSync(path.join(dir, 'design-qa.config.json'), JSON.stringify(config));
  const res = await run(DS_AUDIT, ['--evidence', path.join(dir, 'evidence'), '--config', path.join(dir, 'design-qa.config.json')]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /cart\/style:space:13px/);
  const out = JSON.parse(readFileSync(path.join(dir, 'evidence', 'ds-audit.json'), 'utf8'));
  assert.deepEqual(Object.keys(out.states).sort(), ['cart/with-data', 'checkout/with-data']);
  for (const k of ['elementsChecked', 'offTokenValues', 'nonSystemComponents', 'output']) assert.ok(k in out.summary, k);
  assert.equal(out.summary.output, 'evidence/ds-audit.json');
  assert.equal(out.summary.elementsChecked, 16);
  assert.equal(out.candidates.find((c) => c.key === 'checkout/style:space:13px').evidence[0].path, 'evidence/screens/checkout/app/with-data.png');
  const only = await run(DS_AUDIT, ['--evidence', path.join(dir, 'evidence'), '--config', path.join(dir, 'design-qa.config.json'), '--screen', 'cart', '--out', path.join(dir, 'one.json'), '--quiet']);
  assert.equal(only.code, 0, only.stderr);
  assert.equal(only.stdout, '');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(dir, 'one.json'), 'utf8')).states), ['cart/with-data']);
});

// ---------------------------------------------------------------------------
// MUI themes, framework variables, a design system built on a third-party library
// ---------------------------------------------------------------------------

const MUI_THEME = {
  breakpoints: { values: { xs: 0, sm: 600, md: 900 } },
  palette: { mode: 'light', primary: { main: '#1976d2' }, text: { primary: 'rgba(0, 0, 0, 0.87)' }, contrastThreshold: 3 },
  shape: { borderRadius: 4 },
  mixins: { toolbar: { minHeight: 56 } },
  shadows: ['none', '0px 2px 1px -1px rgba(0,0,0,0.2),0px 1px 1px 0px rgba(0,0,0,0.14)'],
  typography: {
    fontFamily: '"Roboto", "Helvetica", sans-serif',
    fontSize: 14,
    fontWeightMedium: 500,
    h6: { fontFamily: '"Roboto", "Helvetica", sans-serif', fontWeight: 500, fontSize: '1.25rem', lineHeight: 1.6, letterSpacing: '0.0075em' },
    body2: { fontWeight: 400, fontSize: '0.875rem', lineHeight: 1.43, letterSpacing: '0.01071em' },
  },
  zIndex: { appBar: 1100 },
};

test('an MUI theme: typography variants are text styles, shadows and the spacing scale are tokens; breakpoints, zIndex and mixins are not spacing', () => {
  const t = parseJsonTokens(MUI_THEME, { file: 'mui.json' });
  const by = Object.fromEntries(t.tokens.map((x) => [x.name, x]));
  const h6 = t.textStyles.find((s) => s.name === 'typography.h6');
  assert.deepEqual([h6.size, h6.lineHeight, Number(h6.letterSpacing.toFixed(2)), h6.weight, h6.family], [20, 32, 0.15, 500, 'roboto']);
  assert.equal(t.textStyles.find((s) => s.name === 'typography.body2').family, 'roboto', 'a variant without a family takes the theme one');
  assert.equal(by['shadows.1'].category, 'shadow');
  assert.equal(by['typography.fontWeightMedium'].weight, 500);
  // No spacing in a theme saved with JSON.stringify (the function is lost): MUI's default unit.
  assert.deepEqual(['spacing(0.5)', 'spacing(1)', 'spacing(3)'].map((n) => by[n].px), [4, 8, 24]);
  for (const v of [600, 900, 1100, 56]) assert.ok(!t.tokens.some((x) => x.px === v), `${v} is not a style value`);
  // setup.mjs export-theme records { factor: value }; an array scale is theme.spacing(i).
  const exported = Object.fromEntries(parseJsonTokens({ ...MUI_THEME, spacing: { 0.5: '2px', 1: '4px' } }).tokens.map((x) => [x.name, x.px]));
  assert.deepEqual([exported['spacing(0.5)'], exported['spacing(1)'], exported['spacing(3)']], [2, 4, undefined]);
  const array = Object.fromEntries(parseJsonTokens({ ...MUI_THEME, spacing: [0, 4, 8, 16] }).tokens.map((x) => [x.name, x.px]));
  assert.deepEqual([array['spacing(1)'], array['spacing(3)']], [4, 16]);
  // The theme's own h6 on the page is no candidate.
  nextI = 0;
  const page = audit(reindex([
    el({ tag: 'body', rect: { x: 0, y: 0, w: 800, h: 2000 } }),
    el({ p: 0, tag: 'h6', own: true, text: 'Orders', rect: { x: 0, y: 10, w: 300, h: 32 }, s: { color: 'rgba(0, 0, 0, 0.87)', 'font-size': '20px', 'line-height': '32px', 'font-weight': '500', 'letter-spacing': '0.15px', 'font-family': 'Roboto, Helvetica, sans-serif' } }),
  ]));
  const set = buildTokenSet([{ kind: 'tokens-file', file: 'mui.json', parsed: t }]);
  const r = auditState({ audit: page, state: { id: 'default', name: 'default', screen: null }, set, libraries: normalizeLibraries([], {}), catalog: null, image: { width: 800, height: 1800 } });
  const { candidates } = buildCandidates([r], { evidencePaths: () => ({ screenshot: 'evidence/app/default.png', audit: null }), samples: 5 });
  assert.deepEqual(candidates.map((c) => c.key), ['style:color:#000000de', 'style:text:20px/32px-500-ls-0.15px-roboto']);
  assert.ok(candidates.every((c) => c._audit.kind === 'token-usage'));
});

test("page variables: a framework's own (--tw-…) are not tokens; too few left skips the audit with why and how to turn it on", async () => {
  const parsed = pageTokens({ '--tw-ring-color': 'rgb(59 130 246 / .5)', '--tw-shadow': '0 0 #0000', '--radix-popper-anchor-width': '120px', '--brand': '#123456' });
  assert.deepEqual([parsed.tokens.map((t) => t.name), parsed.internal], [['--brand'], 3]);
  const dir = tmpDir();
  const page = stylePage();
  page.rootTokens = { '--tw-ring-color': 'rgb(59 130 246 / .5)', '--tw-ring-offset-width': '0px', '--tw-shadow': '0 0 #0000', '--brand': '#123456' };
  writeEvidence(dir, { page });
  writeFileSync(path.join(dir, 'design-qa.config.json'), JSON.stringify({ app: { baseUrl: 'http://localhost:3000' }, surfaces: { s: { route: '/' } } }));
  const res = await run(DS_AUDIT, ['--evidence', path.join(dir, 'evidence'), '--config', path.join(dir, 'design-qa.config.json')]);
  assert.equal(res.code, 2, res.stdout);
  assert.match(res.stderr, /audit skipped: the page defines only 1 CSS variable of its own \(and 3 of the framework's: --tw-… and the like\), too few to check against; the style source is unknown\. Turn it on: ask the person "Style values" again \(node \S*setup\.mjs check --ask ds-tokens\)/);
  const out = JSON.parse(readFileSync(path.join(dir, 'evidence', 'ds-audit.json'), 'utf8'));
  assert.match(out.skipped.reason, /too few to check against/);
  assert.match(out.skipped.fix, /check --ask ds-tokens/);
});

test('a design system built on MUI: wrapper and raw MUI are not one candidate; the local source lists raw imports by file and line; a deployed page says it cannot tell', async () => {
  const dir = tmpDir();
  nextI = 0;
  const page = audit(reindex([
    el({ tag: 'body', rect: { x: 0, y: 0, w: 800, h: 2000 } }),
    el({ p: 0, tag: 'button', control: 'button', cls: ['MuiButtonBase-root', 'MuiButton-root'], rect: { x: 0, y: 10, w: 100, h: 36 } }),
    el({ p: 0, tag: 'button', control: 'button', cls: ['MuiButtonBase-root', 'MuiButton-root'], rect: { x: 0, y: 60, w: 100, h: 36 } }),
  ]));
  page.rootTokens = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((k, i) => [`--c-${k}`, `#${String(i + 1).repeat(6)}`]));
  writeEvidence(dir, { state: 'default', page });
  const manifest = path.join(dir, 'evidence', 'capture.json');
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), url: 'http://localhost:5421/cart' }));
  writeFileSync(path.join(dir, 'components.json'), JSON.stringify({ components: { button: { component: 'Button', kind: 'button' } } }));
  const libraries = [{ name: 'Acme kit', kind: 'design-system', selector: '[data-component]', package: ['@acme/kit', 'src/kit'], wraps: 'MUI' }, { name: 'MUI', kind: 'third-party', classPrefix: 'Mui', package: '@mui/material' }];
  writeFileSync(path.join(dir, 'design-qa.config.json'), JSON.stringify({ app: { baseUrl: 'http://localhost:5421' }, surfaces: { s: { route: '/' } }, designSystem: { libraries, componentCatalog: 'components.json' } }));
  const files = {
    'src/features/Cart.tsx': "import { Button } from '@acme/kit';\n",
    'src/features/Promo.tsx': "import React from 'react';\nimport { Button as MuiButton, Box, type SxProps } from '@mui/material';\nimport TextField from '@mui/material/TextField';\nimport { Chip } from '@mui/material';\n",
    'src/kit/Button.tsx': "import { Button } from '@mui/material';\n",
    'src/theme/theme.ts': "import { createTheme, ThemeProvider } from '@mui/material/styles';\n",
    'src/features/Promo.test.tsx': "import { Button } from '@mui/material';\n",
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  const res = await run(DS_AUDIT, ['--evidence', path.join(dir, 'evidence'), '--config', path.join(dir, 'design-qa.config.json')]);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(readFileSync(path.join(dir, 'evidence', 'ds-audit.json'), 'utf8'));
  const components = out.candidates.filter((c) => c.ledger === 'component');
  assert.deepEqual(components.map((c) => [c.key, c.severity, c.actual.source.file, c.actual.source.line]), [
    ['source:mui:src-features-promo:button', 'BLOCKER', 'src/features/Promo.tsx', 2],
    ['source:mui:src-features-promo:text-field', 'BLOCKER', 'src/features/Promo.tsx', 3],
    ['source:mui:src-features-promo:chip', 'WARNING', 'src/features/Promo.tsx', 4],
  ]);
  assert.ok(components.every((c) => c.unpinnedReason.length >= 20 && c.expected.value && c.fix.files.length === 1));
  assert.equal(out.libraries.find((l) => l.name === 'MUI').wrappedBy, 'Acme kit');
  assert.equal(out.states.default.libraries['Acme kit'].instances, 2, 'the MUI buttons on the page count as the design system');
  // A deployed page: no source to read, one line says so.
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), url: 'https://staging.example.com/cart' }));
  const deployed = await run(DS_AUDIT, ['--evidence', path.join(dir, 'evidence'), '--config', path.join(dir, 'design-qa.config.json')]);
  assert.equal(deployed.code, 0, deployed.stderr);
  assert.match(deployed.stdout, /Warning: MUI \(Acme kit is built on it\): on a deployed page wrapper and raw use look the same, so raw use cannot be told apart/);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'evidence', 'ds-audit.json'), 'utf8')).candidates.filter((c) => c.ledger === 'component').length, 0);
});
