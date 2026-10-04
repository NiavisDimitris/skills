import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  canonicalColor,
  colorDifference,
  colorsMatch,
  compareFigmaMotion,
  compareState,
  compareValues,
  componentIdentity,
  dedupeMotion,
  dedupeRepeats,
  deltaE2000,
  matchesSimpleSelector,
  motionFromLonghands,
  normalizeValue,
  pairSamples,
  parseColor,
  parseColorDetailed,
  parseTokenMap,
  parseTokenCategories,
  pickToken,
  propertyCategories,
  summarize,
  tokenCategory,
  tokenForValue,
} from '../skills/design-qa/scripts/lib/compare.mjs';
import { fixture, loadFixture, run, script, startServer, tmpDir } from './_helpers.mjs';

const COMPARE = script('compare.mjs');
const CAPTURE = script('capture.mjs');

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

test('colours, durations and values normalise before comparing', () => {
  assert.equal(canonicalColor('#2563eb'), 'rgba(37,99,235,1)');
  assert.equal(canonicalColor('rgb(37, 99, 235)'), 'rgba(37,99,235,1)');
  assert.equal(canonicalColor('rgba(37 99 235 / 50%)'), 'rgba(37,99,235,0.5)');
  assert.equal(canonicalColor('#0000'), 'rgba(0,0,0,0)');
  assert.equal(canonicalColor('transparent'), 'rgba(0,0,0,0)');
  assert.equal(canonicalColor('hsl(0, 100%, 50%)'), 'rgba(255,0,0,1)');
  assert.equal(canonicalColor('nope'), null);
  assert.equal(normalizeValue('transition-duration', '0.2s, 0.15s'), '200ms,150ms');
  assert.equal(normalizeValue('font-family', '"Inter", Arial, sans-serif'), 'inter,arial,sans-serif');
  assert.equal(normalizeValue('font-weight', 'bold'), '700');
  assert.equal(normalizeValue('box-shadow', 'rgba(0, 0, 0, 0.1) 0px 1px 2px 0px'), 'rgba(0,0,0,0.1) 0px 1px 2px 0px');

  assert.deepEqual(compareValues('background-color', '#2563eb', 'rgb(37, 99, 235)'), { result: 'PASS', delta: null, deltaE: 0 });
  assert.equal(compareValues('background-color', 'rgb(37, 99, 235)', 'rgb(29, 78, 216)').result, 'FAIL');
  // A near-miss hex renders within ΔE 1.5: the style row passes (a token row still flags a
  // hand-typed value, see the compareState near-miss test); a tight tolerance fails it.
  assert.equal(compareValues('background-color', '#4f46e5', '#5046e4').result, 'PASS');
  assert.equal(compareValues('background-color', '#4f46e5', '#5046e4', { colorDeltaE: 0.1 }).result, 'FAIL');
  assert.equal(compareValues('background-color', 'rgba(0, 0, 0, 0.5)', 'rgba(0, 0, 0, 0.505)').result, 'PASS', 'alpha keeps its 0.01 tolerance');
  assert.deepEqual(compareValues('padding-top', '16px', '17px'), { result: 'PASS', delta: 1 }, 'within the 1px tolerance');
  assert.deepEqual(compareValues('padding-top', '16px', '18px'), { result: 'FAIL', delta: 2 });
  assert.equal(compareValues('padding-top', '16px', '18px', { tolerancePx: 2 }).result, 'PASS');
  assert.equal(compareValues('box-shadow', 'rgba(0,0,0,0.1) 0px 1px 2px 0px', 'rgba(0, 0, 0, 0.1) 0px 1px 3px 0px').result, 'PASS');
  assert.equal(compareValues('transition-duration', '0.2s', '200ms').result, 'PASS');
  assert.equal(compareValues('transition-timing-function', 'ease-out', 'cubic-bezier(0, 0, 0.58, 1)').result, 'PASS');
  assert.equal(compareValues('font-weight', '700', 'bold').result, 'PASS');
});

test('colours: every CSS Color 4 syntax converts to the same CIELAB colour', () => {
  // CSS Color 4 reference conversions of sRGB red.
  for (const red of [
    'red', '#f00', 'rgb(255 0 0)', 'rgb(100% 0% 0%)', 'hsl(0 100% 50%)', 'hsl(0turn 100 50)', 'hwb(0 0% 0%)',
    'oklch(0.628 0.2577 29.23)', 'oklch(62.8% 0.2577 29.23deg)', 'oklab(0.628 0.2249 0.1258)', 'lab(54.29 80.8 69.89)',
    'lch(54.29 106.84 40.85)', 'color(srgb 1 0 0)', 'color(srgb-linear 1 0 0)', 'color(display-p3 0.9175 0.2 0.1387)',
    'color(a98-rgb 0.8585 0 0)', 'color(rec2020 0.792 0.231 0.0738)', 'color(prophoto-rgb 0.7023 0.2757 0.1036)',
    'color(xyz 0.4124 0.2126 0.0193)', 'color(xyz-d50 0.4361 0.2225 0.0139)',
  ]) {
    assert.deepEqual(parseColor(red), [255, 0, 0, 1], red);
    assert.ok(colorDifference(red, 'rgb(255, 0, 0)').deltaE < 0.1, red);
  }
  assert.deepEqual(parseColor('hsl(0.5turn 50% 50%)'), parseColor('hsl(180deg 50% 50%)'));
  assert.deepEqual(parseColor('hwb(120 20% 20% / 50%)'), [51, 204, 51, 0.5]);
  assert.deepEqual(parseColor('rgb(none 0 0)'), [0, 0, 0, 1], '"none" components are 0');
  assert.equal(parseColor('oklch(0.5 none none / none)')[3], 0, '"none" alpha is 0');
  assert.equal(parseColor('oklch(0.5 0.1 200 / 40%)')[3], 0.4);
  assert.equal(parseColor('color(foo 1 0 0)'), null);
  assert.equal(parseColor('oklch(0.5 0.1)'), null);
  assert.equal(parseColor('currentcolor'), null);

  // display-p3 red is outside sRGB: its CIELAB value keeps the wider chroma (no clipping).
  const p3 = parseColorDetailed('color(display-p3 1 0 0)');
  assert.equal(p3.inGamut, false);
  assert.deepEqual(p3.rgba, [255, 0, 0, 1], 'rgba is clamped to sRGB');
  assert.ok(colorDifference('color(display-p3 1 0 0)', 'rgb(255, 0, 0)').deltaE > 5);
  assert.equal(compareValues('color', 'color(display-p3 1 0 0)', 'color(display-p3 0.95 0 0)').result, 'FAIL', 'two reds that both clip to rgb(255,0,0) still differ');
  assert.equal(normalizeValue('color', 'color(display-p3 1 0 0)'), 'color(display-p3 1 0 0)', 'out-of-gamut colours are never canonicalised onto an sRGB value');
  assert.equal(normalizeValue('color', 'oklch(0.628 0.2577 29.23)'), 'rgba(255,0,0,1)');
  assert.equal(canonicalColor('lab(54.29 80.8 69.89)'), 'rgba(255,0,0,1)');
});

test('colours: CIEDE2000 within colorDeltaE, alpha within 0.01, transparent equals transparent', () => {
  // Sharma, Wu & Dalal (2005) CIEDE2000 test data.
  for (const [x, y, e] of [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
  ]) assert.equal(Number(deltaE2000(x, y).toFixed(4)), e);

  assert.deepEqual(compareValues('color', 'oklch(0.511 0.262 276.966)', 'rgb(79, 57, 246)'), { result: 'PASS', delta: null, deltaE: 0.08 }, 'Tailwind v4 oklch vs its rgb');
  assert.equal(compareValues('color', 'rgb(79, 70, 229)', 'rgb(80, 70, 229)').result, 'PASS', 'one channel step is below ΔE 1.5');
  assert.equal(compareValues('color', 'rgb(79, 70, 229)', 'rgb(90, 70, 229)').result, 'FAIL', 'ΔE 1.7');
  assert.equal(compareValues('color', 'rgb(79, 70, 229)', 'rgb(90, 70, 229)', { colorDeltaE: 2 }).result, 'PASS');
  assert.equal(compareValues('color', 'oklch(0.628 0.2577 29.23)', 'rgb(37, 99, 235)').result, 'FAIL', 'red is not blue');
  assert.equal(compareValues('background-color', 'rgba(0, 0, 0, 0)', 'rgba(255, 255, 255, 0)').result, 'PASS', 'transparent equals transparent');
  assert.equal(compareValues('background-color', 'transparent', 'oklch(0.9 0.1 120 / 0)').result, 'PASS');
  assert.equal(compareValues('background-color', 'rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0.05)').result, 'FAIL', 'alpha differs by more than 0.01');
  assert.equal(colorsMatch('rgb(1 2 3)', 'nope'), null);

  // Colours inside shorthand values.
  assert.equal(compareValues('box-shadow', 'oklab(0 0 0 / 0.1) 0px 1px 2px 0px', 'rgba(0, 0, 0, 0.1) 0px 1px 2px 0px').result, 'PASS');
  assert.equal(compareValues('box-shadow', 'oklab(0 0 0 / 0.1) 0px 1px 2px 0px, oklch(0.2 0 0 / 0.2) 0px 4px 8px 0px', 'rgba(0, 0, 0, 0.1) 0px 1px 3px 0px, rgb(22 22 22 / 0.2) 0px 4px 8px 0px').result, 'PASS');
  assert.equal(compareValues('box-shadow', 'oklab(0 0 0 / 0.1) 0px 1px 2px 0px', 'rgba(0, 0, 0, 0.3) 0px 1px 2px 0px').result, 'FAIL', 'shadow alpha');
  assert.equal(compareValues('box-shadow', 'oklab(0 0 0 / 0.1) 0px 1px 2px 0px', 'rgba(0, 0, 0, 0.1) 0px 4px 2px 0px').result, 'FAIL', 'shadow offset');
  assert.equal(compareValues('border-top', '1px solid oklch(0.628 0.2577 29.23)', '1px solid rgb(255, 0, 0)').result, 'PASS');
  assert.equal(compareValues('outline', 'rgb(79, 70, 229) solid 2px', 'rgb(80, 70, 229) solid 2px').result, 'PASS');
  assert.equal(compareValues('background-image', 'linear-gradient(rgb(79, 70, 229), oklch(0.5 0.1 200))', 'linear-gradient(rgb(80, 70, 229), oklch(0.5 0.1 200))').result, 'PASS', 'colours inside gradients');
  assert.equal(compareValues('background-image', 'linear-gradient(rgb(79, 70, 229), red)', 'linear-gradient(rgb(79, 70, 229), blue)').result, 'FAIL');
});

test('compareState: a colour within ΔE passes; a hand-typed near miss still gets a hardcoded token row', () => {
  const sample = (bg, vars) => ({ 'background-color': bg, __visible: true, __el: { tag: 'button', text: 'Save', selector: 'button' }, __vars: vars });
  const sideOf = (s) => ({ driver: {}, computed: { button: { selector: 'button', count: 1, samples: [s] }, rootTokens: { '--brand': 'rgb(79, 70, 229)' } } });
  const nearMiss = compareState({ state: 'with-data', design: sideOf(sample('rgb(79, 70, 229)', { 'background-color': ['--brand'] })), app: sideOf(sample('rgb(80, 70, 229)', {})) });
  assert.equal(nearMiss.style[0].result, 'PASS');
  assert.equal(nearMiss.style[0].deltaE, 0.15);
  assert.deepEqual(nearMiss.tokens.map((r) => [r.expectedToken, r.actualToken]), [['--brand', null]]);
  assert.match(nearMiss.tokens[0].note, /hardcoded value: no token resolves to rgb\(80, 70, 229\) \(within ΔE 0.15 of the design\); use --brand/);
  const sameToken = compareState({ state: 'with-data', design: sideOf(sample('oklch(0.511 0.262 276.966)', { 'background-color': ['--brand'] })), app: sideOf(sample('rgb(79, 57, 246)', { 'background-color': ['--brand'] })) });
  assert.deepEqual([sameToken.style[0].result, sameToken.tokens.length], ['PASS', 0], 'within ΔE and on a token: nothing to report');
  const tight = compareState({ state: 'with-data', colorDeltaE: 0.1, design: sideOf(sample('rgb(79, 70, 229)', { 'background-color': ['--brand'] })), app: sideOf(sample('rgb(80, 70, 229)', {})) });
  assert.equal(tight.style[0].result, 'FAIL', 'compareState passes colorDeltaE through');
});

test('tokens: token maps, value lookup and the best-fitting name', () => {
  const md = [
    '| Figma variable / style | Code token | CSS output | Tolerance | Notes |',
    '|---|---|---|---|---|',
    '| `color/text/primary` | `--ds-color-text-primary` | `rgb(26, 29, 35)` | ΔE 1.5 | x |',
    '| `space/4` | `--ds-space-4` | `16px` | ±1px | |',
    '| `heading/lg` | `--ds-font-heading-lg` | 24px / 32px, weight 600 | exact | |',
  ].join('\n');
  assert.deepEqual(parseTokenMap(md), { '--ds-color-text-primary': 'rgb(26, 29, 35)', '--ds-space-4': '16px' });
  assert.deepEqual(parseTokenMap('{ "tokens": { "--a": "#fff", "--n": 3 } }'), { '--a': '#fff' });
  const tokens = { '--radius-md': '8px', '--space-2': '8px', '--color-primary': '#2563eb' };
  assert.equal(tokenForValue(tokens, 'background-color', 'rgb(37, 99, 235)'), '--color-primary');
  assert.equal(tokenForValue(tokens, 'padding-top', '8px'), '--space-2', 'spacing property → spacing token');
  assert.equal(tokenForValue(tokens, 'border-radius', '8px'), '--radius-md');
  assert.equal(tokenForValue(tokens, 'color', 'rgb(1, 2, 3)'), null);
  assert.equal(pickToken([], 'color'), null);
  assert.deepEqual(parseTokenMap('{ "--r": { "value": "8px", "category": "radius" }, "--c": "#fff" }'), { '--r': '8px', '--c': '#fff' });
});

// The Acme DS root tokens of the five-screen mock: same px values across scales.
const ADS = {
  '--ads-space-2': '8px',
  '--ads-space-3': '12px',
  '--ads-radius-sm': '6px',
  '--ads-radius-md': '10px',
  '--ads-radius-pill': '999px',
  '--ads-color-brand': 'rgb(79, 70, 229)',
  '--ads-color-text-primary': 'rgb(17, 24, 39)',
  '--ads-font-size-md': '15px',
  '--ads-font-sans': '"Inter", ui-sans-serif, sans-serif',
  '--ads-motion-fast': '120ms',
  '--ads-ease-out': 'cubic-bezier(0, 0, 0.58, 1)',
  '--ads-shadow-card': '0 1px 2px rgba(17, 24, 39, 0.04)',
};

test('tokens: categories come from the token map, else the name, else the value', () => {
  assert.equal(tokenCategory('--ads-space-2', '8px'), 'space');
  assert.equal(tokenCategory('--ads-radius-md', '10px'), 'radius');
  assert.equal(tokenCategory('--ads-color-text-primary', 'rgb(17, 24, 39)'), 'color');
  assert.equal(tokenCategory('--ads-color-label', 'rgb(17, 24, 39)'), 'color', '"label" is a type hint, but the value is a colour');
  assert.equal(tokenCategory('--ads-text-sm', '13px'), 'typography', 'a length named text-sm is a type size, not a colour');
  assert.equal(tokenCategory('--ads-font-size-md', '15px'), 'font-size');
  assert.equal(tokenCategory('--ads-font-sans', '"Inter", sans-serif'), 'font-family');
  assert.equal(tokenCategory('--ads-motion-fast', '120ms'), 'motion');
  assert.equal(tokenCategory('--ads-ease-out', 'cubic-bezier(0, 0, 0.58, 1)'), 'motion');
  assert.equal(tokenCategory('--ads-shadow-card', '0 1px 2px rgba(0, 0, 0, 0.1)'), 'shadow');
  assert.equal(tokenCategory('--brand-500', '#4f46e5'), 'color', 'value kind when the name is silent');
  assert.equal(tokenCategory('--x-1', '8px'), null);
  assert.equal(tokenCategory('--x-1', '8px', { '--x-1': 'radius' }), 'radius', 'an explicit category wins');
  assert.deepEqual(propertyCategories('padding-left'), ['space']);
  assert.deepEqual(propertyCategories('border-top-left-radius'), ['radius']);
  assert.deepEqual(propertyCategories('border-top-color'), ['color']);
  assert.deepEqual(propertyCategories('border-top-width'), ['border-width']);
  assert.deepEqual(propertyCategories('transition-duration'), ['motion']);
  assert.deepEqual(propertyCategories('font-size'), ['font-size', 'typography']);
  assert.equal(propertyCategories('transform'), null);

  const md = [
    '## Spacing',
    '| Figma variable | Code token | CSS output |',
    '|---|---|---|',
    '| `space/2` | `--x-2` | `8px` |',
    '## Radius',
    '| `radius/control` | `--x-control` | `8px` |',
    '## Unmapped values',
    '| `odd` | `--x-odd` | `8px` |',
  ].join('\n');
  const categories = parseTokenCategories(md);
  assert.deepEqual(categories, { '--x-2': 'space', '--x-control': 'radius' });
  const tokens = parseTokenMap(md);
  assert.equal(tokenForValue(tokens, 'border-radius', '8px', { categories }), '--x-control');
  assert.equal(tokenForValue(tokens, 'padding-top', '8px', { categories }), '--x-2');
  assert.deepEqual(parseTokenCategories('{ "tokens": { "--a": "8px" }, "categories": { "--a": "Radius" } }', { format: 'json' }), { '--a': 'radius' });
});

test('tokens: a value is never traced to a token of another category (expected and actual side)', () => {
  // The mock's drift: 8px border-radius matched --ads-space-2, 10px padding --ads-radius-md.
  assert.equal(tokenForValue(ADS, 'border-radius', '8px'), null, 'only a space token is 8px: hardcoded radius');
  assert.equal(tokenForValue(ADS, 'padding-left', '10px'), null, 'only a radius token is 10px: hardcoded padding');
  assert.equal(tokenForValue(ADS, 'border-radius', '10px'), '--ads-radius-md');
  assert.equal(tokenForValue(ADS, 'padding-left', '8px'), '--ads-space-2');
  assert.equal(tokenForValue(ADS, 'gap', '12px'), '--ads-space-3');
  assert.equal(tokenForValue(ADS, 'font-size', '15px'), '--ads-font-size-md');
  assert.equal(tokenForValue(ADS, 'margin-top', '15px'), null);
  assert.equal(tokenForValue(ADS, 'color', 'rgb(79, 70, 229)'), '--ads-color-brand');
  assert.equal(tokenForValue(ADS, 'transition-duration', '0.12s'), '--ads-motion-fast');
  assert.equal(tokenForValue(ADS, 'transition-timing-function', 'ease-out'), '--ads-ease-out');
  assert.equal(tokenForValue(ADS, 'box-shadow', '0 1px 2px rgba(17, 24, 39, 0.04)'), '--ads-shadow-card');
  assert.equal(pickToken(['--ads-space-2'], 'border-radius', { tokens: ADS }), null, '__vars get the same filter');
  assert.equal(pickToken(['--ads-space-2', '--ads-radius-x'], 'border-radius', { tokens: { ...ADS, '--ads-radius-x': '8px' } }), '--ads-radius-x');
  assert.equal(tokenForValue({ '--foo': '8px', '--ads-space-2': '8px' }, 'border-radius', '8px'), '--foo', 'an uncategorised token is a last resort, never a cross-category one');

  const sample = (props, vars) => ({ ...props, __rect: { x: 0, y: 0, w: 40, h: 40 }, __visible: true, __el: { tag: 'div', classes: ['thumb'], text: '' }, __vars: vars });
  const sideOf = (s) => ({ driver: {}, computed: { thumb: { selector: '.thumb', samples: [s] }, rootTokens: ADS } });
  const rows = compareState({
    state: 'with-data',
    design: sideOf(sample({ 'border-radius': '10px', 'padding-left': '8px', 'margin-top': '8px' }, { 'border-radius': ['--ads-radius-md'], 'padding-left': ['--ads-space-2'], 'margin-top': ['--ads-space-2'] })),
    app: sideOf(sample({ 'border-radius': '8px', 'padding-left': '10px', 'margin-top': '6px' }, { 'border-radius': ['--ads-space-2'], 'padding-left': ['--ads-radius-md'], 'margin-top': ['--ads-radius-sm'] })),
  });
  assert.deepEqual(
    rows.tokens.map((r) => [r.property, r.expectedToken, r.actualToken]),
    [['border-radius', '--ads-radius-md', null], ['padding-left', '--ads-space-2', null], ['margin-top', '--ads-space-2', null]],
  );
  assert.ok(rows.tokens.every((r) => /hardcoded value/.test(r.note)));

  // Expected side: a design value only a cross-category token produces has no expected token.
  const noRadius = compareState({
    state: 'with-data',
    design: sideOf(sample({ 'border-radius': '8px' }, { 'border-radius': ['--ads-space-2'] })),
    app: sideOf(sample({ 'border-radius': '6px' }, { 'border-radius': ['--ads-radius-sm'] })),
  });
  assert.equal(noRadius.style[0].result, 'FAIL');
  assert.deepEqual(noRadius.tokens, [], 'no radius token is 8px: no token row, the style row carries the difference');
});

test('components: data-component, catalog selector / className / testid; a bare data-testid is not a component', () => {
  assert.deepEqual(componentIdentity({ tag: 'button', component: 'Button', variant: 'primary' }), { component: 'Button', variant: 'primary', source: 'data-component' });
  const catalog = {
    components: {
      Button: { component: 'Button', selector: "[data-ds-component='Button'], button.ds-btn" },
      Tag: { component: 'Tag', className: 'ds-tag' },
    },
  };
  assert.deepEqual(componentIdentity({ tag: 'button', classes: ['ds-btn', 'x'] }, catalog), { component: 'Button', variant: null, source: 'catalog' });
  assert.equal(componentIdentity({ tag: 'span', classes: ['ds-tag'] }, catalog).component, 'Tag');
  assert.equal(componentIdentity({ tag: 'div', testid: 'order-row-3' }), null, 'a test hook is not a component name');
  assert.equal(componentIdentity({ tag: 'div', testid: 'review-items' }, catalog), null, 'no catalog entry claims this test id');
  const byTestid = { components: { OrderRow: { component: 'OrderRow', testidPrefix: 'order-row' }, Total: { testid: 'cart-total' } } };
  assert.deepEqual(componentIdentity({ tag: 'div', testid: 'order-row-3' }, byTestid), { component: 'OrderRow', variant: null, source: 'catalog' });
  assert.equal(componentIdentity({ tag: 'div', testid: 'cart-total' }, byTestid).component, 'Total');
  assert.equal(componentIdentity({ tag: 'div', testid: 'cart-total-2' }, byTestid), null, 'testid matches exactly; testidPrefix by prefix');
  assert.equal(componentIdentity({ tag: 'div', classes: [] }, catalog), null);
  assert.ok(matchesSimpleSelector({ tag: 'span', classes: ['pill-x'] }, "span[class*='pill']"));
  assert.ok(!matchesSimpleSelector({ tag: 'button', classes: [] }, 'button:not([data-ds-component])'), 'pseudo-classes are not evaluated');
});

test('pairSamples: same text first, then the remaining samples in order; leftovers are extra', () => {
  const s = (text) => ({ __el: { text } });
  const { pairs, extra } = pairSamples([s('Save'), s('Cancel')], [s('Cancel'), s('Save'), s('Delete')]);
  assert.deepEqual(pairs.map((p) => [p.dIndex, p.aIndex]), [[0, 1], [1, 0]]);
  assert.deepEqual(extra.map((e) => [e.aIndex, e.notSampled]), [[2, false]]);
  const byIndex = pairSamples([s('Alpha'), s('Beta')], [s('Item 1')]);
  assert.deepEqual(byIndex.pairs.map((p) => [p.dIndex, p.aIndex, p.notSampled]), [[0, 0, false], [1, null, false]]);
  // A textless icon button swapped with a labelled one: not the same index, still a pair.
  const swapped = pairSamples([s('Save'), s('')], [s(''), s('Save')]);
  assert.deepEqual(swapped.pairs.map((p) => [p.dIndex, p.aIndex]), [[0, 1], [1, 0]]);
  assert.deepEqual(swapped.extra, []);
  // The app matched 5 elements but sampled 2: a design leftover may be one it did not sample.
  const truncated = pairSamples([s('A'), s('B'), s('C')], [s('A'), s('B')], { dCount: 3, aCount: 5 });
  assert.deepEqual(truncated.pairs.map((p) => [p.dIndex, p.aIndex, p.notSampled]), [[0, 0, false], [1, 1, false], [2, null, true]]);
  const designTruncated = pairSamples([s('A')], [s('A'), s('X')], { dCount: 4, aCount: 2 });
  assert.deepEqual(designTruncated.extra.map((e) => [e.aIndex, e.notSampled]), [[1, true]]);
});

test('compareState: pairing across a reorder and a sampling limit raises no false missing / extra rows', () => {
  const b = (text) => ({ 'font-size': '16px', __visible: true, __el: { tag: 'button', text, selector: 'button' } });
  const sideOf = (texts, count) => ({ driver: {}, computed: { button: { selector: 'button', count, samples: texts.map(b) } } });
  // Design [Export, Filter, New]; the app adds Help first and samples 3 of its 4 buttons.
  const toolbar = compareState({ state: 'with-data', design: sideOf(['Export', 'Filter', 'New'], 3), app: sideOf(['Help', 'Export', 'Filter'], 4) });
  assert.ok(!toolbar.structure.some((r) => r.note === 'missing in app'), 'New is not missing: the app has a fourth, unsampled button');
  assert.ok(toolbar.style.every((r) => r.result === 'PASS'));
  // An icon-only button reordered: paired with the app's icon-only button, not missing.
  const icons = compareState({ state: 'with-data', design: sideOf(['Save', ''], 2), app: sideOf(['', 'Save'], 2) });
  assert.deepEqual(icons.structure, []);
  // The design sampled 3, the app only 2 of 6: the third design element cannot be verified.
  const limited = compareState({ state: 'with-data', design: sideOf(['A', 'B', 'C'], 3), app: sideOf(['A', 'B'], 6) });
  assert.deepEqual(limited.structure.map((r) => [r.text, r.design, r.app, r.result]), [['C', 'present', 'not sampled', 'CANNOT_VERIFY']]);
  assert.match(limited.structure[0].note, /not sampled in the app: its selector matched 6 elements and only the first 2 were captured/);
  assert.deepEqual(limited.motion, [], 'no "element missing in app" motion row for an unsampled element');
  const extraUnsampled = compareState({ state: 'with-data', design: sideOf(['A'], 4), app: sideOf(['A', 'Z'], 2) });
  assert.deepEqual(extraUnsampled.structure.map((r) => [r.text, r.design, r.app, r.result]), [['Z', 'not sampled', 'present', 'CANNOT_VERIFY']]);
  // Without truncation a leftover is still missing / extra.
  const missing = compareState({ state: 'with-data', design: sideOf(['A', 'B', 'C'], 3), app: sideOf(['A', 'B'], 2) });
  assert.deepEqual(missing.structure.map((r) => [r.text, r.note, r.result]), [['C', 'missing in app', 'FAIL']]);
  const summary = summarize({ limited, missing });
  assert.deepEqual(summary.structure, { fail: 1, missingInApp: 1, extraInApp: 0, cannotVerify: 1 });
});

const longhands = (over = {}) => ({
  'transition-property': 'all',
  'transition-duration': '0s',
  'transition-timing-function': 'ease',
  'transition-delay': '0s',
  'animation-name': 'none',
  'animation-duration': '0s',
  'animation-timing-function': 'ease',
  'animation-delay': '0s',
  'animation-iteration-count': '1',
  ...over,
});

test('motionFromLonghands repeats CSS lists and skips 0s transitions and "none" animations', () => {
  assert.deepEqual(motionFromLonghands(longhands()), []);
  const specs = motionFromLonghands(longhands({ 'transition-property': 'opacity, transform', 'transition-duration': '0.2s', 'transition-timing-function': 'ease-out', 'animation-name': 'spin', 'animation-duration': '0.8s', 'animation-timing-function': 'linear', 'animation-iteration-count': 'infinite' }));
  assert.deepEqual(specs.map((m) => [m.type, m.property, m.durationMs, m.easing]), [
    ['transition', 'opacity', 200, 'cubic-bezier(0,0,0.58,1)'],
    ['transition', 'transform', 200, 'cubic-bezier(0,0,0.58,1)'],
    ['animation', 'animation', 800, 'linear'],
  ]);
  assert.equal(specs[2].iterations, 'infinite');
});

function side({ bg, token, component, transition, toast = true, extraButton = false, action = null }) {
  const button = (text, i) => ({
    'background-color': bg,
    'border-radius': '8px',
    __rect: { x: 0, y: i * 40, w: 80, h: 40 },
    __visible: true,
    __el: { tag: 'button', classes: [], component, variant: component === 'Button' ? 'primary' : null, text, selector: 'button' },
    __vars: token ? { 'background-color': [token], 'border-radius': ['--radius-md'] } : { 'border-radius': ['--radius-md'] },
  });
  const buttons = [button('Save', 0), ...(extraButton ? [button('Try again', 1)] : [])];
  return {
    driver: action ? { action, selector: 'button' } : {},
    computed: {
      button: { selector: 'button', count: buttons.length, samples: buttons },
      rootTokens: { '--color-primary': 'rgb(37, 99, 235)', '--radius-md': '8px' },
    },
    motion: {
      elements: {
        button: { samples: buttons.map(() => longhands(transition)) },
      },
      actionTarget: null,
      animations: toast ? [{ type: 'CSSAnimation', target: 'div.toast', element: null, animationName: 'toast-in', durationMs: 300, delayMs: 0, easing: 'ease-out', iterations: 1 }] : [],
      keyframes: {},
    },
    dom: { elements: [{ role: 'heading', name: 'Profile', visible: true }, { role: 'button', name: 'Save', visible: true }] },
  };
}

test('compareState: token, component, motion and structure rows (design → code)', () => {
  const design = side({ bg: 'rgb(37, 99, 235)', token: '--color-primary', component: 'Button', transition: { 'transition-property': 'background-color, transform', 'transition-duration': '0.2s, 0.15s', 'transition-timing-function': 'ease-out' } });
  const app = side({ bg: 'rgb(29, 78, 216)', token: null, component: 'LegacyButton', transition: { 'transition-property': 'transform', 'transition-duration': '0.3s', 'transition-timing-function': 'ease-out' }, toast: false, extraButton: true });
  app.dom.elements.push({ role: 'button', name: 'Try again', visible: true });
  const rows = compareState({ state: 'with-data', design, app });

  const bg = rows.style.find((r) => r.property === 'background-color');
  assert.equal(bg.result, 'FAIL');
  assert.equal(rows.style.find((r) => r.property === 'border-radius').result, 'PASS');

  assert.deepEqual(rows.tokens.map((r) => [r.property, r.expectedToken, r.actualToken]), [['background-color', '--color-primary', null]]);
  assert.match(rows.tokens[0].note, /hardcoded value/);

  assert.equal(rows.components.length, 1);
  assert.deepEqual([rows.components[0].design.component, rows.components[0].app.component, rows.components[0].result], ['Button', 'LegacyButton', 'FAIL']);

  const motion = Object.fromEntries(rows.motion.map((r) => [r.property, r]));
  assert.equal(motion['background-color'].observed, null, 'missing transition');
  assert.equal(motion['background-color'].result, 'FAIL');
  assert.equal(motion.transform.result, 'FAIL');
  assert.deepEqual(motion.transform._compare.reasons, ['duration 300ms, expected 150ms']);
  assert.equal(motion.transform.expected.durationMs, 150);
  assert.equal(motion.transform.observed.durationMs, 300);
  assert.equal(motion.animation.observed, null, 'the toast animation is missing in the app');
  assert.equal(motion.animation.trigger, 'load');
  // ledgers.motion row shape
  assert.deepEqual(Object.keys(motion.transform), ['state', 'selector', 'figmaNodeId', 'trigger', 'property', 'expected', 'observed', 'result', 'findingIds', '_compare']);
  assert.deepEqual(Object.keys(motion.transform.expected), ['type', 'durationMs', 'easing', 'delayMs', 'detail']);

  const extra = rows.structure.filter((r) => r.design === 'missing');
  assert.equal(extra.length, 2, 'the extra button, by element class and by role');
  assert.ok(extra.every((r) => /extra in app/.test(r.note)));
  assert.ok(rows.structure.every((r) => r.result === 'FAIL'));

  const summary = summarize({ 'with-data': rows });
  assert.equal(summary.tokens.hardcoded, 1);
  assert.equal(summary.motion.missing, 2);
  assert.equal(summary.components.fail, 1);
  assert.equal(summary.structure.extraInApp, 2);
});

test('compareState: extra motion in the app and elements missing in the app', () => {
  const design = side({ bg: 'rgb(37, 99, 235)', token: '--color-primary', component: 'Button', transition: {}, toast: false, extraButton: true });
  const app = side({ bg: 'rgb(37, 99, 235)', token: '--color-primary', component: 'Button', transition: { 'transition-property': 'opacity', 'transition-duration': '0.5s' }, toast: false });
  const rows = compareState({ state: 'with-data', design, app });
  const extraMotion = rows.motion.find((r) => r.expected.type === 'none');
  assert.equal(extraMotion.result, 'FAIL');
  assert.equal(extraMotion.observed.durationMs, 500);
  assert.match(extraMotion._compare.reasons[0], /extra motion in app/);
  const missing = rows.structure.find((r) => r.source === 'computed');
  assert.deepEqual([missing.app, missing.note, missing.index], ['missing', 'missing in app', 1]);
  assert.equal(rows.tokens.length, 0, 'equal values raise no token row');
  assert.deepEqual(rows.components.map((r) => [r.index, r.result]), [[0, 'PASS']], 'the missing button is a structure row, not a component FAIL');
});

test('compareState: a region missing in the app, identified only by data-testid, gives a structure row only', () => {
  const region = (visible) => ({ display: 'block', __rect: { x: 0, y: 0, w: 400, h: 200 }, __visible: visible, __el: { tag: 'div', classes: ['review-items'], component: null, testid: 'review-items', text: 'Items in this order', selector: 'div.review-items' } });
  const sideOf = (samples) => ({ driver: {}, computed: { reviewItems: { selector: '.review-items', samples } } });
  const missing = compareState({ state: 'with-data', design: sideOf([region(true)]), app: sideOf([]) });
  assert.deepEqual(missing.structure.map((r) => [r.elementClass, r.app, r.note]), [['reviewItems', 'missing', 'missing in app']]);
  assert.deepEqual(missing.components, []);
  const hidden = compareState({ state: 'with-data', design: sideOf([region(true)]), app: sideOf([region(false)]) });
  assert.deepEqual(hidden.structure.map((r) => r.note), ['hidden in app']);
  assert.deepEqual(hidden.components, []);
  const both = compareState({ state: 'with-data', design: sideOf([region(true)]), app: sideOf([region(true)]) });
  assert.deepEqual(both.components, [], 'a data-testid alone names no component, so there is nothing to compare');
});

test('dedupeMotion keeps interaction rows and the first repeat of load/state-change rows', () => {
  const row = (state, trigger, key) => ({ state, trigger, _compare: { key } });
  const states = {
    'with-data': { motion: [row('with-data', 'state-change', 'b|bg'), row('with-data', 'load', 'spin')] },
    hover: { motion: [row('hover', 'hover', 'b|bg'), row('hover', 'load', 'spin')] },
  };
  dedupeMotion(states);
  assert.deepEqual(states['with-data'].motion.map((r) => r._compare.key), ['spin']);
  assert.deepEqual(states.hover.motion.map((r) => r._compare.key), ['b|bg']);
});

test('compareFigmaMotion: Figma reactions vs the app state that performs the trigger', () => {
  const figmaSpec = {
    motion: [
      { nodeId: '1:10', nodeName: 'Button', trigger: 'hover', figmaTrigger: 'ON_HOVER', type: 'smart-animate', durationMs: 200, easing: 'cubic-bezier(0,0,0.58,1)', delayMs: null, property: null, approximate: false, detail: null },
      { nodeId: '1:11', nodeName: 'Card', trigger: 'press', figmaTrigger: 'ON_PRESS', type: 'dissolve', durationMs: 150, easing: 'linear', delayMs: null, property: 'opacity', approximate: false, detail: null },
      { nodeId: '1:12', nodeName: 'Link', trigger: 'click', type: 'instant', durationMs: 0 },
    ],
  };
  const appStates = {
    'with-data': { driver: {}, motion: { animations: [] } },
    hover: { driver: { action: 'hover', selector: '.btn' }, motion: { animations: [{ type: 'CSSTransition', transitionProperty: 'background-color', durationMs: 300, delayMs: 0, easing: 'ease-out', target: 'button.btn' }], actionTarget: null } },
  };
  const rows = compareFigmaMotion(figmaSpec, appStates);
  assert.equal(rows.length, 2, 'instant changes are not motion');
  assert.deepEqual([rows[0].state, rows[0].figmaNodeId, rows[0].trigger, rows[0].result], ['hover', '1:10', 'hover', 'FAIL']);
  assert.deepEqual(rows[0]._compare.reasons, ['duration 300ms, expected 200ms']);
  assert.equal(rows[0].selector, '.btn');
  assert.deepEqual([rows[1].trigger, rows[1].result, rows[1].observed], ['press', 'CANNOT_VERIFY', null]);
});

test('compare CLI: usage errors', async () => {
  assert.equal((await run(COMPARE, [])).code, 2, '--app is required');
  assert.equal((await run(COMPARE, ['--app', tmpDir()])).code, 2, 'no capture in the folder');
  assert.match((await run(COMPARE, ['--help'])).stdout, /--figma-spec/);
});

test('compare CLI: tolerances from --config, overridden by --tolerance-px / --color-delta-e, recorded in options', async () => {
  const dir = tmpDir();
  const sample = (color, pad) => ({ color, 'padding-top': pad, __visible: true, __el: { tag: 'button', text: 'Save', selector: 'button' } });
  for (const [folder, s] of [['design-computed', sample('rgb(79, 70, 229)', '16px')], ['computed', sample('rgb(90, 70, 229)', '18px')]]) {
    mkdirSync(path.join(dir, folder), { recursive: true });
    writeFileSync(path.join(dir, folder, 'with-data.json'), JSON.stringify({ button: { selector: 'button', count: 1, samples: [s] } }));
  }
  const config = loadFixture('config.json');
  config.tolerances = { ...config.tolerances, px: 2, colorDeltaE: 2 };
  const configFile = path.join(dir, 'design-qa.config.json');
  writeFileSync(configFile, JSON.stringify(config));
  const out = path.join(dir, 'compare.json');
  const compare = async (...flags) => {
    const res = await run(COMPARE, ['--app', dir, '--out', out, '--quiet', ...flags]);
    assert.equal(res.code, 0, res.stderr);
    const result = JSON.parse(readFileSync(out, 'utf8'));
    return { options: result.options, results: Object.fromEntries(result.states['with-data'].style.map((r) => [r.property, r.result])) };
  };

  const defaults = await compare();
  assert.deepEqual([defaults.options.tolerancePx, defaults.options.colorDeltaE, defaults.options.alphaTolerance], [1, 1.5, 0.01]);
  assert.deepEqual(defaults.options.tolerancesFrom, { px: 'default', colorDeltaE: 'default' });
  assert.deepEqual(defaults.results, { color: 'FAIL', 'padding-top': 'FAIL' }, 'ΔE 1.7 and 2px are over the defaults');

  const fromConfig = await compare('--config', configFile);
  assert.deepEqual([fromConfig.options.tolerancePx, fromConfig.options.colorDeltaE, fromConfig.options.config], [2, 2, configFile]);
  assert.deepEqual(fromConfig.options.tolerancesFrom, { px: 'config', colorDeltaE: 'config' });
  assert.deepEqual(fromConfig.results, { color: 'PASS', 'padding-top': 'PASS' });

  const flagsWin = await compare('--config', configFile, '--color-delta-e', '1', '--tolerance-px', '0');
  assert.deepEqual(flagsWin.options.tolerancesFrom, { px: 'flag', colorDeltaE: 'flag' });
  assert.deepEqual(flagsWin.results, { color: 'FAIL', 'padding-top': 'FAIL' });
  assert.deepEqual((await compare('--color-delta-e', '2')).results, { color: 'PASS', 'padding-top': 'FAIL' });

  assert.equal((await run(COMPARE, ['--app', dir, '--out', out, '--color-delta-e', 'abc'])).code, 2);
  assert.equal((await run(COMPARE, ['--app', dir, '--out', out, '--color-delta-e=-1'])).code, 2);
  config.tolerances.colorDeltaE = -1;
  writeFileSync(configFile, JSON.stringify(config));
  const bad = await run(COMPARE, ['--app', dir, '--out', out, '--config', configFile]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /colorDeltaE/);
});

// ---------------------------------------------------------------------------
// End to end: capture a coded prototype (design) and a drifting app, then compare
// ---------------------------------------------------------------------------

async function chromiumLaunches() {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}
const CHROMIUM = await chromiumLaunches();

test('end to end: prototype (--side design) vs drifting app → token, component and motion mismatches', { timeout: 120000 }, async (t) => {
  if (!CHROMIUM) {
    t.skip('Chromium is not installed (run `npx playwright install chromium`)');
    return;
  }
  const appHtml = readFileSync(fixture('app-drift.html'));
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(appHtml);
  });
  try {
    const dir = tmpDir();
    const evidence = path.join(dir, 'evidence');
    const states = path.join(dir, 'states.json');
    // One states file for both sides: selectors must exist in the prototype and the app.
    writeFileSync(states, JSON.stringify({ 'with-data': { wait: 'h1' }, hover: { action: 'hover', selector: 'button', wait: 'h1' } }));
    const env = { DESIGN_QA_COMMIT: 'c', DESIGN_QA_BRANCH: 'b' };
    const common = ['--width', '640', '--height', '480', '--states', states, '--out', evidence];
    const design = await run(CAPTURE, ['--side', 'design', '--url', pathToFileURL(fixture('prototype.html')).href, ...common], { env, cwd: dir });
    assert.equal(design.code, 0, design.stderr);
    const app = await run(CAPTURE, ['--url', `${server.url}/profile`, ...common], { env, cwd: dir });
    assert.equal(app.code, 0, app.stderr);

    const designManifest = JSON.parse(readFileSync(path.join(evidence, 'design-capture.json'), 'utf8'));
    assert.equal(designManifest.side, 'design');
    assert.deepEqual(designManifest.source, { kind: 'prototype', url: pathToFileURL(fixture('prototype.html')).href, label: 'HTML prototype', tool: 'html', frame: { width: 640, height: 480 } });
    assert.equal(designManifest.states.hover.screenshot, 'design/hover.png');
    assert.equal(designManifest.states.hover.motion, 'design-motion/hover.json');
    const designMotion = JSON.parse(readFileSync(path.join(evidence, 'design-motion', 'hover.json'), 'utf8'));
    assert.deepEqual(designMotion.animations.find((a) => a.animationName === 'spin')?.element, { elementClass: 'feedback', index: 0 }, 'running animations are mapped to grabbed elements');
    // Transitions started by the hover are usually still running when the trace is taken.
    for (const a of designMotion.animations.filter((x) => x.type === 'CSSTransition')) {
      assert.ok(['background-color', 'transform'].includes(a.transitionProperty), a.transitionProperty);
      assert.deepEqual(a.element, { elementClass: 'button', index: 0 });
    }
    assert.equal(designMotion.elements.button.samples[0]['transition-duration'], '0.2s, 0.15s');
    assert.match(designMotion.keyframes['toast-in'], /@keyframes toast-in/);
    const designComputed = JSON.parse(readFileSync(path.join(evidence, 'design-computed', 'with-data.json'), 'utf8'));
    assert.equal(designComputed.rootTokens['--color-primary'], 'rgb(37, 99, 235)');
    assert.deepEqual(designComputed.button.samples[0].__vars['background-color'], ['--color-primary']);
    assert.equal(designComputed.button.samples[0].__el.component, 'Button');

    const out = path.join(evidence, 'compare.json');
    const cmp = await run(COMPARE, ['--design', evidence, '--app', evidence, '--out', out], { cwd: dir });
    assert.equal(cmp.code, 0, cmp.stderr);
    assert.match(cmp.stdout, /tokens 2 mismatch/);
    const result = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(Object.keys(result.states), ['with-data', 'hover']);
    const base = result.states['with-data'];

    // Token mismatch: the app hardcodes a colour where the design uses --color-primary.
    const token = base.tokens.find((r) => r.property === 'background-color');
    assert.equal(token.expectedToken, '--color-primary');
    assert.equal(token.actualToken, null);
    assert.equal(token.expectedValue, 'rgb(37, 99, 235)');
    assert.equal(token.actualValue, 'rgb(29, 78, 216)');

    // Component mismatch: Button (primary) in the design, LegacyButton in the app.
    const component = base.components.find((r) => r.elementClass === 'button');
    assert.equal(component.result, 'FAIL');
    assert.deepEqual(component.design, { component: 'Button', variant: 'primary', source: 'data-component' });
    assert.equal(component.app.component, 'LegacyButton');

    // Motion: the hover transition on background-color is missing, transform is slower.
    const hover = result.states.hover.motion;
    const missing = hover.find((r) => r.property === 'background-color');
    assert.equal(missing.trigger, 'hover');
    assert.equal(missing.observed, null);
    assert.equal(missing.result, 'FAIL');
    assert.equal(missing.expected.durationMs, 200);
    assert.equal(missing.expected.easing, 'cubic-bezier(0,0,0.58,1)');
    const slower = hover.find((r) => r.property === 'transform');
    assert.equal(slower.result, 'FAIL');
    assert.equal(slower.expected.durationMs, 150);
    assert.equal(slower.observed.durationMs, 300);
    assert.deepEqual(slower._compare.reasons, ['duration 300ms, expected 150ms']);
    // The toast's entrance animation is missing; the spinner matches.
    const anims = base.motion.filter((r) => r.property === 'animation');
    assert.ok(anims.some((r) => r.expected.detail?.includes('toast-in') && r.observed === null && r.result === 'FAIL'));
    assert.ok(anims.some((r) => r.expected.detail?.includes('spin') && r.result === 'PASS'));

    assert.equal(result.summary.motion.missing, 2);
    assert.equal(result.summary.components.fail, 1, 'the swap shows in every state but is one difference');
    assert.ok(result.summary.repeatsDropped > 0);
    assert.equal(result.summary.structure.fail, 0, 'same elements on both sides');
  } finally {
    await server.close();
  }
});

test('dedupeRepeats: a different element with the same values in another state keeps its row', () => {
  const heading = (text, fs) => ({ 'font-size': fs, __visible: true, __el: { tag: 'h1', text, selector: 'h1' } });
  const mk = (state, text) => compareState({ state, design: { computed: { heading: { selector: 'h1', count: 1, samples: [heading(text, '24px')] } } }, app: { computed: { heading: { selector: 'h1', count: 1, samples: [heading(text, '20px')] } } } });
  const states = { 'with-data': mk('with-data', 'Orders'), empty: mk('empty', 'No orders yet'), hover: mk('hover', 'Orders') };
  assert.deepEqual(dedupeRepeats(states), { dropped: 1 }, 'only the hover repeat of the with-data heading drops');
  assert.deepEqual(states.empty.style.map((r) => [r.text, r.result]), [['No orders yet', 'FAIL']], "the empty state's heading is a different element");
  assert.deepEqual(states.hover.style, []);
  assert.equal(summarize(states).style.fail, 2);
});

test('dedupeRepeats keeps one row per difference across states', () => {
  const pad = { state: 'with-data', elementClass: 'card', index: 0, property: 'padding-top', design: '24px', app: '20px', result: 'FAIL' };
  const states = {
    'with-data': { style: [pad, { ...pad, property: 'color', design: 'red', app: 'red', result: 'PASS' }], tokens: [], components: [], structure: [] },
    hover: { style: [{ ...pad, state: 'hover' }, { ...pad, state: 'hover', property: 'background-color', design: '#eee', app: '#ddd' }], tokens: [], components: [], structure: [] },
  };
  assert.deepEqual(dedupeRepeats(states), { dropped: 1 });
  assert.equal(states['with-data'].style.length, 2, 'PASS rows and first occurrences stay');
  assert.deepEqual(states.hover.style.map((r) => r.property), ['background-color'], 'the hover-only difference stays');
});
