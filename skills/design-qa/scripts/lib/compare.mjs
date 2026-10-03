// Design → code comparison of two captures (pure, no IO): the design side (a coded
// prototype captured with capture.mjs --side design, or a Figma spec's prototype
// motion) against the app capture. Produces style, token, component, motion and
// structure rows; FAIL rows become findings. The design is the source of truth:
// anything the app lacks is "missing in app", anything it adds is "extra in app".
import {
  describeMotion,
  figmaMotionSpecs,
  motionMatches,
  normalizeEasing,
  parseDurationMs,
  propertyCompatible,
  splitCssList,
} from './figma-motion.mjs';

const NAMED_COLORS = Object.freeze({
  transparent: [0, 0, 0, 0],
  black: [0, 0, 0, 1],
  white: [255, 255, 255, 1],
  red: [255, 0, 0, 1],
  green: [0, 128, 0, 1],
  blue: [0, 0, 255, 1],
  gray: [128, 128, 128, 1],
  grey: [128, 128, 128, 1],
});

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round = (n, d = 3) => Number(Number(n).toFixed(d));

function channel(v) {
  const s = String(v).trim();
  return s.endsWith('%') ? (Number(s.slice(0, -1)) / 100) * 255 : Number(s);
}
function alpha(v) {
  if (v === undefined) return 1;
  const s = String(v).trim();
  return s.endsWith('%') ? Number(s.slice(0, -1)) / 100 : Number(s);
}
function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** "#2563eb" | "rgb(37, 99, 235)" | "rgba(37 99 235 / 50%)" | "hsl(…)" | named → [r, g, b, a] or null. */
export function parseColor(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (NAMED_COLORS[s]) return [...NAMED_COLORS[s]];
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? round(n(6) / 255, 3) : 1];
  }
  m = /^rgba?\(([^)]*)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const rgb = parts.slice(0, 3).map(channel);
    if (!rgb.every(Number.isFinite)) return null;
    return [...rgb.map((c) => clamp(Math.round(c), 0, 255)), clamp(round(alpha(parts[3]), 3), 0, 1)];
  }
  m = /^hsla?\(([^)]*)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const h = Number(parts[0].replace(/deg$/, ''));
    const sat = Number(parts[1].replace('%', '')) / 100;
    const light = Number(parts[2].replace('%', '')) / 100;
    if (![h, sat, light].every(Number.isFinite)) return null;
    return [...hslToRgb(h, sat, light).map((c) => clamp(Math.round(c), 0, 255)), clamp(round(alpha(parts[3]), 3), 0, 1)];
  }
  return null;
}

/** Canonical "rgba(r,g,b,a)" for any colour syntax; null when not a colour. */
export function canonicalColor(value) {
  const c = parseColor(value);
  return c ? `rgba(${c[0]},${c[1]},${c[2]},${c[3]})` : null;
}

const COLOR_RE = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|\b(?:transparent|black|white)\b/gi;
const WEIGHTS = { normal: '400', bold: '700' };

/** Canonical form of a computed value: colours → rgba(), seconds → ms, quotes and spacing removed. */
export function normalizeValue(property, value) {
  if (value === null || value === undefined) return '';
  let s = String(value).trim().toLowerCase();
  if (property === 'font-weight' && WEIGHTS[s]) return WEIGHTS[s];
  if (/timing-function$|^easing$/.test(property ?? '')) return splitCssList(s).map((e) => normalizeEasing(e)).join(',');
  s = s.replace(COLOR_RE, (m) => canonicalColor(m) ?? m);
  s = s.replace(/(^|[\s,(])(-?\d*\.?\d+)s\b/g, (_, pre, n) => `${pre}${round(Number(n) * 1000, 2)}ms`);
  s = s.replace(/["']/g, '').replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ');
  return s;
}

const TOKEN_RE = /rgba\([^)]*\)|[a-z-]+\([^)]*\)|[^\s,]+/g;
const NUM_RE = /^(-?\d*\.?\d+)(px|ms|%|deg|em|rem)?$/;

/**
 * Compare two computed values: { result: "PASS"|"FAIL", delta }.
 * px within tolerancePx, ms within toleranceMs; colours must match channel for channel
 * (alpha within 0.01): a near-miss hex like #5046e4 for #4f46e5 is a hand-typed value, not rounding.
 * delta: app − design for single numeric values (number), else null.
 */
export function compareValues(property, design, app, { tolerancePx = 1, toleranceMs = 1 } = {}) {
  const d = normalizeValue(property, design);
  const a = normalizeValue(property, app);
  const single = (s) => {
    const m = NUM_RE.exec(s);
    return m ? { n: Number(m[1]), unit: m[2] ?? '' } : null;
  };
  const sd = single(d);
  const sa = single(a);
  const delta = sd && sa && sd.unit === sa.unit ? round(sa.n - sd.n, 3) : null;
  if (d === a) return { result: 'PASS', delta };
  const td = d.match(TOKEN_RE) ?? [];
  const ta = a.match(TOKEN_RE) ?? [];
  if (td.length !== ta.length) return { result: 'FAIL', delta };
  const same = td.every((x, i) => {
    const y = ta[i];
    if (x === y) return true;
    const cx = parseColor(x);
    const cy = parseColor(y);
    if (cx && cy) return cx.slice(0, 3).every((v, j) => Math.round(v) === Math.round(cy[j])) && Math.abs(cx[3] - cy[3]) <= 0.01;
    const nx = single(x);
    const ny = single(y);
    if (nx && ny && nx.unit === ny.unit) {
      const tol = nx.unit === 'px' ? tolerancePx : nx.unit === 'ms' ? toleranceMs : 0.001;
      return Math.abs(nx.n - ny.n) <= tol;
    }
    return false;
  });
  return { result: same ? 'PASS' : 'FAIL', delta };
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * Token map file → { "--token": "value" }. Accepts JSON ({ "--x": "v" }, { "--x": { value,
 * category } } or { tokens: {…}, categories?: {…} }) or the markdown token map (rows with a
 * `--token` code-token cell and a backticked CSS output).
 */
export function parseTokenMap(text, { format = null } = {}) {
  const raw = String(text ?? '');
  if (format === 'json' || /^\s*[{[]/.test(raw)) {
    const json = JSON.parse(raw);
    const src = json && typeof json.tokens === 'object' ? json.tokens : json;
    const value = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof v.value === 'string' ? v.value : null);
    return Object.fromEntries(
      Object.entries(src || {})
        .filter(([k, v]) => k.trim() && k !== 'categories' && value(v) !== null)
        .map(([k, v]) => [k.trim(), value(v)]),
    );
  }
  const out = {};
  for (const line of raw.split('\n')) {
    if (!/^\s*\|/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    const ti = cells.findIndex((c) => /^`--[\w-]+`$/.test(c));
    if (ti === -1) continue;
    const value = cells.slice(ti + 1).find((c) => /^`[^`]+`$/.test(c));
    if (value) out[cells[ti].slice(1, -1)] = value.slice(1, -1);
  }
  return out;
}

// Token categories. A hardcoded value is only traced to a token whose category fits the
// property: 8px on border-radius is never --space-2, 10px of padding never --radius-md.
export const TOKEN_CATEGORIES = Object.freeze(['color', 'space', 'size', 'radius', 'border-width', 'shadow', 'motion', 'font-size', 'line-height', 'font-weight', 'letter-spacing', 'font-family', 'typography', 'opacity', 'z-index']);

const TYPE = ['typography'];
const PROPERTY_CATEGORIES = [
  [/radius/, ['radius']],
  [/shadow/, ['shadow']],
  [/(^|-)(duration|delay)$|timing-function$|^easing$/, ['motion']],
  [/^(border|outline)(-(top|right|bottom|left|block|inline)(-(start|end))?)?-width$|^column-rule-width$/, ['border-width']],
  [/(^|-)colou?r$|^fill$|^stroke$|^background$/, ['color']],
  [/^(padding|margin|scroll-padding|scroll-margin)(-|$)|^(gap|row-gap|column-gap|inset|top|right|bottom|left)$|^inset-/, ['space']],
  [/^(min-|max-)?(width|height|inline-size|block-size)$|^flex-basis$/, ['size', 'space']],
  [/^font-size$/, ['font-size', ...TYPE]],
  [/^line-height$/, ['line-height', ...TYPE]],
  [/^font-weight$/, ['font-weight', ...TYPE]],
  [/^letter-spacing$/, ['letter-spacing', ...TYPE]],
  [/^font-family$/, ['font-family', ...TYPE]],
  [/^opacity$/, ['opacity']],
  [/^z-index$/, ['z-index']],
];

/** Token categories a property accepts, most specific first; null when the property has none. */
export function propertyCategories(property) {
  return PROPERTY_CATEGORIES.find(([re]) => re.test(String(property ?? '')))?.[1] ?? null;
}

// Name hints in priority order; the first one whose category fits the token's value wins.
const NAME_CATEGORIES = [
  ['radius', /radius|rounded|corner/],
  ['shadow', /shadow|elevation/],
  ['motion', /motion|duration|delay|ease|easing|curve|transition|timing|anim/],
  ['border-width', /(border|stroke|outline)-?width|hairline/],
  ['line-height', /line-height|leading/],
  ['letter-spacing', /letter-spacing|tracking/],
  ['font-weight', /font-weight|weight/],
  ['font-family', /font-family|family|typeface|font-(sans|serif|mono)/],
  ['font-size', /font-size|text-size|type-size|(^|-)fs-/],
  ['typography', /font|typography|(^|-)type(-|$)|heading|body|label|caption|display|title|(^|-)text-(2?xs|sm|md|base|lg|[2-9]?xl)$/],
  ['opacity', /opacity|alpha/],
  ['z-index', /z-?index|(^|-)z-|layer/],
  ['space', /space|spacing|gap|gutter|inset|padding|(^|-)pad(-|$)|margin|stack|inline/],
  ['size', /size|width|height|dimension/],
  ['color', /colou?r|(^|-)bg(-|$)|background|surface|(^|-)fg(-|$)|foreground|text|ink|brand|primary|secondary|accent|neutral|gr[ae]y|border|outline|fill|stroke|success|warning|danger|error|info|palette|(^|-)on-/],
];

// Which value kinds each category can hold (a "--color-label" holding rgb() is a colour).
const CATEGORY_KINDS = {
  color: ['color'],
  shadow: ['shadow', 'keyword'],
  motion: ['time', 'easing'],
  radius: ['length'],
  space: ['length'],
  size: ['length'],
  'border-width': ['length'],
  'letter-spacing': ['length'],
  'font-size': ['length'],
  'line-height': ['length', 'number'],
  'font-weight': ['number', 'keyword'],
  'font-family': ['text', 'keyword'],
  typography: ['length', 'number', 'text', 'keyword'],
  opacity: ['number'],
  'z-index': ['number'],
};

/** Kind of a CSS value: color | time | easing | shadow | length | number | keyword | text; null when unknown. */
export function valueKind(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().toLowerCase();
  if (!s) return null;
  if (parseColor(s)) return 'color';
  if (/^-?\d*\.?\d+m?s$/.test(s)) return 'time';
  if (/^(cubic-bezier|steps|linear)\(|^(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end)$/.test(s)) return 'easing';
  if (HAS_COLOR_RE.test(s) && (s.match(/-?\d*\.?\d+px/g) ?? []).length >= 2) return 'shadow';
  if (/^-?\d*\.?\d+(px|rem|em|%|vw|vh|ch|pt)$/.test(s) || s === '0') return 'length';
  if (/^-?\d*\.?\d+$/.test(s)) return 'number';
  if (/^[a-z-]+$/.test(s)) return 'keyword';
  return 'text';
}

const HAS_COLOR_RE = new RegExp(COLOR_RE.source, 'i');
const fitsKind = (category, kind) => !kind || (CATEGORY_KINDS[category] ?? []).includes(kind);

/** Category name from a token-map section heading ("Spacing" → space); null when unknown. */
export function categoryFromHeading(heading) {
  const h = String(heading ?? '').toLowerCase();
  if (/colou?r|palette/.test(h)) return 'color';
  if (/radius|radii|corner/.test(h)) return 'radius';
  if (/elevation|shadow/.test(h)) return 'shadow';
  if (/motion|animation|duration|easing|transition/.test(h)) return 'motion';
  if (/spac|gap/.test(h)) return 'space';
  if (/typo|font|type|text/.test(h)) return 'typography';
  if (/size|dimension/.test(h)) return 'size';
  if (/opacity/.test(h)) return 'opacity';
  if (/z-?index|layer/.test(h)) return 'z-index';
  return TOKEN_CATEGORIES.includes(h.trim()) ? h.trim() : null;
}

/**
 * Explicit token categories from a token map: the markdown map's section headings
 * ("## Spacing" → space) or a JSON map's { categories: {…} } / { "--x": { category } }.
 * → { "--token": category } (only tokens whose category is known).
 */
export function parseTokenCategories(text, { format = null } = {}) {
  const raw = String(text ?? '');
  const out = {};
  if (format === 'json' || /^\s*[{[]/.test(raw)) {
    const json = JSON.parse(raw);
    const src = json && typeof json.tokens === 'object' ? json.tokens : json;
    for (const [k, v] of Object.entries(src || {})) {
      const c = v && typeof v === 'object' ? categoryFromHeading(v.category) : null;
      if (c) out[k.trim()] = c;
    }
    for (const [k, v] of Object.entries(json?.categories ?? {})) {
      const c = categoryFromHeading(v);
      if (c) out[k.trim()] = c;
    }
    return out;
  }
  let section = null;
  for (const line of raw.split('\n')) {
    const h = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      section = categoryFromHeading(h[1]);
      continue;
    }
    if (!section || !/^\s*\|/.test(line)) continue;
    const token = line.split('|').map((c) => c.trim()).find((c) => /^`--[\w-]+`$/.test(c));
    if (token) out[token.slice(1, -1)] = section;
  }
  return out;
}

/**
 * Category of a token: the token map's explicit category, else the first name hint whose
 * category can hold the token's value, else the value's own kind (colour, time / easing,
 * shadow). null when nothing tells.
 */
export function tokenCategory(name, value = undefined, categories = null) {
  if (categories?.[name]) return categories[name];
  const n = String(name ?? '').toLowerCase().replace(/^--/, '');
  const kind = valueKind(value);
  for (const [category, re] of NAME_CATEGORIES) {
    if (re.test(n) && fitsKind(category, kind)) return category;
  }
  if (kind === 'color') return 'color';
  if (kind === 'time' || kind === 'easing') return 'motion';
  if (kind === 'shadow') return 'shadow';
  return null;
}

// Several tokens of a fitting category can share a value (16px is --font-size-md and
// --line-height-tight): prefer the one whose name fits the property.
const TOKEN_HINTS = [
  [/color$|^fill$|^stroke$/, /colou?r|bg|background|surface|text|border|fg|brand|primary|accent|ink/],
  [/radius/, /radius|round|corner/],
  [/^(padding|margin|gap|row-gap|column-gap|inset|top|right|bottom|left)/, /space|spacing|gap|inset|pad|margin/],
  [/^(width|height|min-|max-)/, /size|width|height|dimension/],
  [/^font-size$/, /font|text|type/],
  [/^line-height$/, /line|leading/],
  [/^font-weight$/, /weight/],
  [/^letter-spacing$/, /tracking|letter/],
  [/shadow/, /shadow|elevation/],
  [/duration|delay/, /duration|motion|time|delay/],
  [/timing-function/, /ease|easing|curve|motion/],
];

/**
 * The best-fitting token name for a property among same-valued candidates; null when none.
 * Only tokens whose category fits the property are candidates (tokens with no known
 * category are a last resort); a property with no category accepts any token.
 * ctx: { tokens: { "--token": value } (for value-based categories), categories: explicit map }.
 */
export function pickToken(names, property, { tokens = null, categories = null } = {}) {
  const list = [...new Set((Array.isArray(names) ? names : []).filter(Boolean))];
  if (!list.length) return null;
  const accepts = propertyCategories(property);
  let pool = list;
  if (accepts) {
    const typed = list.map((n) => ({ n, c: tokenCategory(n, tokens?.[n], categories) }));
    const fit = typed.filter((t) => t.c && accepts.includes(t.c)).sort((x, y) => accepts.indexOf(x.c) - accepts.indexOf(y.c));
    pool = (fit.length ? fit : typed.filter((t) => !t.c)).map((t) => t.n);
  }
  if (!pool.length) return null;
  const hint = TOKEN_HINTS.find(([prop]) => prop.test(property ?? ''))?.[1];
  return (hint && pool.find((n) => hint.test(n))) || pool[0];
}

/** Every token whose value equals this value (after normalisation), whatever its category. */
export function tokensForValue(tokens, property, value) {
  const want = normalizeValue(property, value);
  if (!want) return [];
  return Object.entries(tokens || {}).filter(([, v]) => normalizeValue(property, v) === want).map(([name]) => name);
}

/** The token a value resolves to (a category-compatible token, best name for the property); null when none. */
export function tokenForValue(tokens, property, value, { categories = null } = {}) {
  return pickToken(tokensForValue(tokens, property, value), property, { tokens, categories });
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** Minimal selector matcher over a captured __el: tag, #id, .class, [attr], [attr=v], [attr*=v|^=|$=]. */
export function matchesSimpleSelector(el, selector) {
  if (!el) return false;
  return String(selector)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .some((sel) => {
      if (/[\s>+~]|:/.test(sel)) return false;
      const attrs = {
        id: el.id ?? null,
        class: (el.classes ?? []).join(' '),
        role: el.role ?? null,
        'data-component': el.component ?? null,
        'data-ds-component': el.component ?? null,
        'data-variant': el.variant ?? null,
        'data-testid': el.testid ?? null,
      };
      const parts = sel.match(/^[a-z][a-z0-9-]*|#[\w-]+|\.[\w-]+|\[[^\]]+\]/gi);
      if (!parts || parts.join('') !== sel) return false;
      return parts.every((p) => {
        if (p.startsWith('#')) return el.id === p.slice(1);
        if (p.startsWith('.')) return (el.classes ?? []).includes(p.slice(1));
        if (p.startsWith('[')) {
          const m = /^\[\s*([\w-]+)\s*(?:([*^$]?=)\s*["']?([^"'\]]*)["']?)?\s*\]$/.exec(p);
          if (!m || !(m[1] in attrs)) return false;
          const v = attrs[m[1]];
          if (!m[2]) return v !== null && v !== '';
          if (v === null) return false;
          if (m[2] === '=') return v === m[3];
          if (m[2] === '*=') return v.includes(m[3]);
          if (m[2] === '^=') return v.startsWith(m[3]);
          return v.endsWith(m[3]);
        }
        return (el.tag ?? '').toLowerCase() === p.toLowerCase();
      });
    });
}

/**
 * Component identity of a captured element: data-component / data-ds-component, else a
 * catalog entry whose selector, className, testid or testidPrefix matches. A bare
 * data-testid is a test hook, not a component name: without a catalog match it gives no
 * identity. → { component, variant, source: "data-component" | "catalog" } or null.
 */
export function componentIdentity(el, catalog = null) {
  if (!el) return null;
  const variant = el.variant ?? null;
  if (el.component) return { component: el.component, variant, source: 'data-component' };
  const testid = el.testid ? String(el.testid) : null;
  for (const [name, entry] of Object.entries(catalog?.components ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    const byClass = entry.className && (el.classes ?? []).includes(entry.className);
    const bySelector = entry.selector && matchesSimpleSelector(el, entry.selector);
    const byTestid = testid && ((entry.testid && testid === entry.testid) || (entry.testidPrefix && testid.startsWith(entry.testidPrefix)));
    if (byClass || bySelector || byTestid) return { component: entry.component ?? name, variant, source: 'catalog' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

const ACTION_TRIGGERS = { hover: 'hover', focus: 'focus', active: 'press', click: 'click', keyboard: 'focus' };

/** Transition and animation specs from computed longhands (CSS lists repeat cyclically). */
export function motionFromLonghands(sample) {
  if (!sample) return [];
  const out = [];
  const at = (list, i) => (list.length ? list[i % list.length] : undefined);
  const props = splitCssList(sample['transition-property']);
  const durs = splitCssList(sample['transition-duration']);
  const eases = splitCssList(sample['transition-timing-function']);
  const delays = splitCssList(sample['transition-delay']);
  props.forEach((property, i) => {
    const durationMs = parseDurationMs(at(durs, i));
    if (property === 'none' || !durationMs) return;
    out.push({ type: 'transition', property, durationMs, easing: normalizeEasing(at(eases, i)), delayMs: parseDurationMs(at(delays, i)) ?? 0, source: 'computed' });
  });
  const names = splitCssList(sample['animation-name']);
  const adurs = splitCssList(sample['animation-duration']);
  const aeases = splitCssList(sample['animation-timing-function']);
  const adelays = splitCssList(sample['animation-delay']);
  const iters = splitCssList(sample['animation-iteration-count']);
  names.forEach((name, i) => {
    if (!name || name === 'none') return;
    out.push({
      type: 'animation',
      property: 'animation',
      name,
      durationMs: parseDurationMs(at(adurs, i)),
      easing: normalizeEasing(at(aeases, i)),
      delayMs: parseDurationMs(at(adelays, i)) ?? 0,
      iterations: at(iters, i) ?? '1',
      source: 'computed',
    });
  });
  return out;
}

/** A getAnimations() entry as a motion spec. */
export function motionFromRuntime(entry) {
  const base = {
    durationMs: typeof entry.durationMs === 'number' ? round(entry.durationMs, 2) : null,
    easing: normalizeEasing(entry.easing),
    delayMs: typeof entry.delayMs === 'number' ? round(entry.delayMs, 2) : 0,
    source: 'runtime',
    target: entry.target ?? null,
  };
  if (entry.type === 'CSSTransition') return { type: 'transition', property: entry.transitionProperty ?? 'all', ...base };
  const iterations = entry.iterations === null || entry.iterations === undefined ? '1' : String(entry.iterations);
  return { type: 'animation', property: 'animation', name: entry.animationName ?? null, properties: entry.properties ?? [], iterations, ...base };
}

/** Longhand specs of one element plus runtime ones not already declared there. */
function elementMotion(sample, runtime) {
  const specs = motionFromLonghands(sample);
  for (const r of runtime.map(motionFromRuntime)) {
    const dup = specs.some((s) => s.type === r.type && (r.type === 'transition' ? s.property === r.property || s.property === 'all' : !r.name || s.name === r.name));
    if (!dup) specs.push(r);
  }
  return specs;
}

function keyframesBody(text) {
  if (!text) return null;
  return normalizeValue('keyframes', String(text).replace(/^@keyframes\s+[^{]+/i, ''));
}

function shape(m) {
  if (!m) return null;
  const detail = [];
  if (m.type === 'animation') {
    if (m.name) detail.push(`animation ${m.name}`);
    if (m.iterations !== undefined && m.iterations !== null && String(m.iterations) !== '1') detail.push(`iterations ${m.iterations}`);
  }
  if (m.detail) detail.push(m.detail);
  if (m.source === 'runtime' && m.target) detail.push(`running on ${m.target}`);
  return {
    type: m.type ?? null,
    durationMs: m.durationMs ?? null,
    easing: m.easing ?? null,
    delayMs: m.delayMs ?? null,
    detail: detail.length ? detail.join('; ') : null,
  };
}

const NONE = { type: 'none', durationMs: null, easing: null, delayMs: null, detail: null };

function motionRow({ state, selector, trigger, expected, observed, result, reasons, elementClass = null, index = null, figmaNodeId = null, property = null }) {
  const prop = property ?? (expected?.type === 'none' ? observed?.property : expected?.property) ?? (expected?.type === 'animation' ? 'animation' : 'all');
  return {
    state,
    selector,
    figmaNodeId,
    trigger,
    property: prop,
    expected: expected?.type === 'none' ? { ...NONE } : shape(expected),
    observed: observed ? shape(observed) : null,
    result,
    findingIds: [],
    // Keys starting with "_" are ignored by the report validator: safe to paste as is.
    _compare: {
      elementClass,
      index,
      key: `${elementClass ?? ''}#${index ?? 0}|${selector ?? ''}|${prop}`,
      reasons,
      expectedText: expected?.type === 'none' ? 'none' : describeMotion(expected),
      observedText: describeMotion(observed),
    },
  };
}

/**
 * Trigger of a motion seen in a state: the state's action for transitions (and for
 * animations on the action's own target), else "load" for animations and
 * "state-change" for transitions.
 */
function triggerFor(action, type, isTarget = false) {
  if (action && ACTION_TRIGGERS[action] && (type !== 'animation' || isTarget)) return ACTION_TRIGGERS[action];
  return type === 'animation' ? 'load' : 'state-change';
}

/**
 * Motion rows for one design/app element pair (either may be null).
 * expected from the design, observed from the app; extra app motion → expected "none".
 */
export function compareMotion(dSpecs, aSpecs, ctx) {
  const { state, selector, action, elementClass, index, durationToleranceMs, keyframes, isTarget = false } = ctx;
  const rows = [];
  const used = new Set();
  for (const e of dSpecs) {
    if (!aSpecs) {
      rows.push(motionRow({ state, selector, trigger: triggerFor(action, e.type, isTarget), expected: e, observed: null, result: 'FAIL', reasons: ['element missing in app'], elementClass, index }));
      continue;
    }
    const m = motionMatches(e, aSpecs, { durationToleranceMs });
    const reasons = [...m.reasons];
    if (m.observed && e.type === 'animation' && e.name && m.observed.name) {
      const kd = keyframesBody(keyframes.design?.[e.name]);
      const ka = keyframesBody(keyframes.app?.[m.observed.name]);
      if (kd && ka && kd !== ka) reasons.push(`keyframes ${m.observed.name} differ from the design's ${e.name}`);
    }
    if (m.observed) used.add(m.observed);
    rows.push(motionRow({ state, selector, trigger: triggerFor(action, e.type, isTarget), expected: e, observed: m.observed, result: reasons.length ? 'FAIL' : 'PASS', reasons, elementClass, index }));
  }
  for (const a of aSpecs ?? []) {
    if (used.has(a)) continue;
    if (dSpecs.some((d) => propertyCompatible(d, a) || propertyCompatible(a, d))) continue;
    rows.push(motionRow({ state, selector, trigger: triggerFor(action, a.type, isTarget), expected: { type: 'none' }, observed: a, result: 'FAIL', reasons: ['extra motion in app: the design does not animate this'], elementClass, index }));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Pairing and per-state comparison
// ---------------------------------------------------------------------------

const textOf = (s) => String(s?.__el?.text ?? '').trim().toLowerCase();
const propsOf = (s) => Object.keys(s || {}).filter((k) => !k.startsWith('__'));

/** Pair design and app samples of one element class: same text first, then same index. */
export function pairSamples(dSamples = [], aSamples = []) {
  const pairs = [];
  const usedA = new Set();
  const pairedD = new Set();
  dSamples.forEach((d, i) => {
    const t = textOf(d);
    if (!t) return;
    const hits = aSamples.map((a, j) => (textOf(a) === t && !usedA.has(j) ? j : -1)).filter((j) => j !== -1);
    if (!hits.length) return;
    const j = hits.includes(i) ? i : hits[0];
    usedA.add(j);
    pairedD.add(i);
    pairs.push({ d, a: aSamples[j], dIndex: i, aIndex: j });
  });
  dSamples.forEach((d, i) => {
    if (pairedD.has(i)) return;
    const j = !usedA.has(i) && i < aSamples.length ? i : -1;
    if (j === -1) {
      pairs.push({ d, a: null, dIndex: i, aIndex: null });
      return;
    }
    usedA.add(j);
    pairs.push({ d, a: aSamples[j], dIndex: i, aIndex: j });
  });
  pairs.sort((x, y) => x.dIndex - y.dIndex);
  const extra = aSamples.map((a, j) => (usedA.has(j) ? null : { a, aIndex: j })).filter(Boolean);
  return { pairs, extra };
}

const DOM_ROLES = new Set(['heading', 'button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'alert', 'status']);

function domStructure(dDom, aDom, state) {
  const key = (e) => `${e.role}|${String(e.name ?? '').trim().toLowerCase()}`;
  const list = (dom) => (Array.isArray(dom?.elements) ? dom.elements : []).filter((e) => e.visible !== false && DOM_ROLES.has(e.role));
  const remaining = new Map();
  for (const e of list(aDom)) remaining.set(key(e), [...(remaining.get(key(e)) ?? []), e]);
  const rows = [];
  for (const e of list(dDom)) {
    const hits = remaining.get(key(e));
    if (hits?.length) {
      hits.shift();
      continue;
    }
    rows.push({ state, source: 'dom', elementClass: null, index: null, selector: null, role: e.role, name: e.name ?? '', design: 'present', app: 'missing', result: 'FAIL', note: `missing in app: ${e.role} "${e.name ?? ''}"` });
  }
  for (const [, left] of remaining) {
    for (const e of left) {
      rows.push({ state, source: 'dom', elementClass: null, index: null, selector: null, role: e.role, name: e.name ?? '', design: 'missing', app: 'present', result: 'FAIL', note: `extra in app: ${e.role} "${e.name ?? ''}" is not in the design` });
    }
  }
  return rows;
}

/**
 * Compare one state. input: { state, design: { computed, motion, dom, driver },
 * app: { computed, motion, dom, driver }, tokenMap, tokenCategories, catalog, tolerancePx,
 * durationToleranceMs }.
 * → { style, tokens, components, motion, structure }.
 */
export function compareState(input) {
  const { state, design, app, tokenMap = {}, tokenCategories = null, catalog = null, tolerancePx = 1, durationToleranceMs = 20 } = input;
  const out = { style: [], tokens: [], components: [], motion: [], structure: [] };
  const dComputed = design?.computed ?? {};
  const aComputed = app?.computed ?? {};
  const dTokens = { ...tokenMap, ...(dComputed.rootTokens ?? {}) };
  const aTokens = { ...tokenMap, ...(aComputed.rootTokens ?? {}) };
  const action = design?.driver?.action ?? app?.driver?.action ?? null;
  const keyframes = { design: design?.motion?.keyframes ?? {}, app: app?.motion?.keyframes ?? {} };
  const runtime = (side, cls, i) => (side?.motion?.animations ?? []).filter((r) => r.element && r.element.elementClass === cls && r.element.index === i);
  const motionSample = (side, cls, i) => side?.motion?.elements?.[cls]?.samples?.[i] ?? null;
  const grabbedSelectors = { design: new Set(), app: new Set() };
  const targetSelector = design?.motion?.actionTarget?.__selector ?? null;

  for (const [cls, dEntry] of Object.entries(dComputed)) {
    if (cls === 'rootTokens' || !dEntry || !Array.isArray(dEntry.samples)) continue;
    const aEntry = aComputed[cls] && Array.isArray(aComputed[cls].samples) ? aComputed[cls] : { samples: [] };
    const { pairs, extra } = pairSamples(dEntry.samples, aEntry.samples);
    for (const { d, a, dIndex, aIndex } of pairs) {
      const selector = a?.__el?.selector ?? d?.__el?.selector ?? dEntry.selector;
      grabbedSelectors.design.add(motionSample(design, cls, dIndex)?.__selector);
      if (a) grabbedSelectors.app.add(motionSample(app, cls, aIndex)?.__selector);
      const dVisible = d.__visible !== false;
      const aVisible = a ? a.__visible !== false : false;
      if (dVisible && !aVisible) {
        out.structure.push({ state, source: 'computed', elementClass: cls, index: dIndex, selector, text: d.__el?.text ?? null, design: 'present', app: a ? 'hidden' : 'missing', result: 'FAIL', note: a ? 'hidden in app' : 'missing in app' });
      } else if (!dVisible && aVisible) {
        out.structure.push({ state, source: 'computed', elementClass: cls, index: dIndex, selector, text: a.__el?.text ?? null, design: 'hidden', app: 'present', result: 'FAIL', note: 'extra in app: visible in the app, hidden in the design' });
      }
      if (dVisible && aVisible) {
        for (const prop of propsOf(d)) {
          if (!(prop in a)) continue;
          if (d[prop] === '' && a[prop] === '') continue;
          const { result, delta } = compareValues(prop, d[prop], a[prop], { tolerancePx, toleranceMs: 1 });
          out.style.push({ state, elementClass: cls, index: dIndex, selector, property: prop, design: d[prop], app: a[prop], delta, result });
          if (result !== 'FAIL') continue;
          // __vars are root tokens whose value equals the computed value, so they get the
          // same category filter: a value is never traced to a token of another kind.
          const dCtx = { tokens: dTokens, categories: tokenCategories };
          const aCtx = { tokens: aTokens, categories: tokenCategories };
          const expectedToken = pickToken(d.__vars?.[prop], prop, dCtx) ?? tokenForValue(dTokens, prop, d[prop], dCtx);
          if (!expectedToken) continue;
          const actualToken = pickToken(a.__vars?.[prop], prop, aCtx) ?? tokenForValue(aTokens, prop, a[prop], aCtx);
          out.tokens.push({
            state, elementClass: cls, index: dIndex, selector, property: prop,
            expectedToken, expectedValue: d[prop], actualToken: actualToken ?? null, actualValue: a[prop], result: 'FAIL',
            note: actualToken ? `uses ${actualToken} instead of ${expectedToken}` : `hardcoded value: no token resolves to ${a[prop]}; use ${expectedToken}`,
          });
        }
        const di = componentIdentity(d.__el, catalog);
        if (di) {
          const ai = componentIdentity(a.__el, catalog);
          const ok = ai && ai.component === di.component && (di.variant === null || ai.variant === di.variant);
          out.components.push({ state, elementClass: cls, index: dIndex, selector, design: di, app: ai, result: ok ? 'PASS' : 'FAIL' });
        }
      }
      // An element missing or hidden on one side is a structure row only: there is no app
      // element whose component could be compared.
      if (dVisible) {
        const dSpecs = elementMotion(motionSample(design, cls, dIndex), runtime(design, cls, dIndex));
        const aSpecs = a ? elementMotion(motionSample(app, cls, aIndex), runtime(app, cls, aIndex)) : null;
        const isTarget = Boolean(targetSelector) && motionSample(design, cls, dIndex)?.__selector === targetSelector;
        out.motion.push(...compareMotion(dSpecs, aSpecs, { state, selector, action, elementClass: cls, index: dIndex, durationToleranceMs, keyframes, isTarget }));
      }
    }
    for (const { a, aIndex } of extra) {
      if (a.__visible === false) continue;
      out.structure.push({ state, source: 'computed', elementClass: cls, index: aIndex, selector: a.__el?.selector ?? aEntry.selector, text: a.__el?.text ?? null, design: 'missing', app: 'present', result: 'FAIL', note: 'extra in app' });
    }
  }

  // The driver's target when it is not one of the grabbed elements (e.g. a hovered row).
  const dTarget = design?.motion?.actionTarget;
  const aTarget = app?.motion?.actionTarget;
  if (dTarget && !grabbedSelectors.design.has(dTarget.__selector)) {
    const dSpecs = motionFromLonghands(dTarget);
    const aSpecs = aTarget ? motionFromLonghands(aTarget) : null;
    out.motion.push(...compareMotion(dSpecs, aSpecs, { state, selector: dTarget.selector, action, elementClass: '(action target)', index: 0, durationToleranceMs, keyframes, isTarget: true }));
  }

  // Running animations on elements that were not grabbed (toasts, overlays…).
  const loose = (side) => (side?.motion?.animations ?? []).filter((r) => !r.element).map(motionFromRuntime);
  const dLoose = loose(design);
  const aLoose = loose(app);
  if (dLoose.length || aLoose.length) {
    const used = new Set();
    for (const e of dLoose) {
      const sameTarget = aLoose.filter((x) => !used.has(x) && x.target === e.target);
      const m = motionMatches(e, sameTarget.length ? sameTarget : aLoose.filter((x) => !used.has(x)), { durationToleranceMs });
      if (m.observed) used.add(m.observed);
      out.motion.push(motionRow({ state, selector: e.target, trigger: triggerFor(action, e.type, e.target === targetSelector), expected: e, observed: m.observed, result: m.result, reasons: m.reasons, elementClass: '(running)', index: 0 }));
    }
    for (const a of aLoose) {
      if (used.has(a) || dLoose.some((d) => propertyCompatible(d, a))) continue;
      out.motion.push(motionRow({ state, selector: a.target, trigger: triggerFor(action, a.type, a.target === targetSelector), expected: { type: 'none' }, observed: a, result: 'FAIL', reasons: ['extra motion in app: the design does not animate this'], elementClass: '(running)', index: 0 }));
    }
  }

  if (design?.dom && app?.dom) out.structure.push(...domStructure(design.dom, app.dom, state));
  return out;
}

const TRIGGER_ACTIONS = { hover: ['hover'], press: ['active'], click: ['click'], focus: ['focus', 'keyboard'] };
const TRIGGER_DEFAULT_STATE = { hover: 'hover', press: 'active', click: 'with-data', focus: 'focus', timeout: 'loading', load: 'with-data' };

/**
 * Motion rows for a Figma prototype's transitions (figma-spec.json reactions) against the
 * app: each reaction is checked in the app state whose driver performs its trigger
 * (hover → action "hover", press → "active", click → "click"); the app's running
 * animations and the driver target's transitions are the observed motion.
 * appStates: { "<state>": { driver, motion } }.
 */
export function compareFigmaMotion(figmaSpec, appStates, { durationToleranceMs = 20 } = {}) {
  const specs = Array.isArray(figmaSpec?.motion) && figmaSpec.motion.length ? figmaSpec.motion : figmaMotionSpecs(figmaSpec);
  const rows = [];
  for (const spec of specs) {
    if (spec.type === 'instant') continue;
    const actions = TRIGGER_ACTIONS[spec.trigger] ?? [];
    const match = Object.entries(appStates || {}).find(([, s]) => actions.includes(s?.driver?.action));
    const expected = { ...spec, type: spec.type, property: null, delayMs: null };
    const detail = [spec.nodeName ? `Figma ${spec.figmaTrigger ?? spec.trigger} on "${spec.nodeName}"` : null, spec.detail].filter(Boolean).join('; ') || null;
    expected.detail = detail;
    if (!match) {
      rows.push(motionRow({
        state: TRIGGER_DEFAULT_STATE[spec.trigger] ?? 'with-data', selector: null, trigger: spec.trigger, figmaNodeId: spec.nodeId,
        expected, observed: null, result: 'CANNOT_VERIFY', reasons: [`no captured app state drives a ${spec.trigger} (add a state with that action)`],
        elementClass: '(figma)', index: 0, property: spec.property ?? 'all',
      }));
      continue;
    }
    const [state, s] = match;
    const observed = [...(s.motion?.animations ?? []).map(motionFromRuntime), ...motionFromLonghands(s.motion?.actionTarget)];
    const m = motionMatches(expected, observed, { durationToleranceMs });
    rows.push(motionRow({
      state, selector: s.driver?.selector ?? null, trigger: spec.trigger, figmaNodeId: spec.nodeId, expected, observed: m.observed,
      result: m.result, reasons: [...m.reasons, ...(spec.approximate ? ['the Figma easing is a spring, compared as an approximate cubic-bezier'] : [])],
      elementClass: '(figma)', index: 0, property: spec.property ?? m.observed?.property ?? 'all',
    }));
  }
  return rows;
}

const INTERACTIONS = new Set(['hover', 'focus', 'press', 'click']);

/**
 * Drop repeats of the same motion (same element, selector and property) across states:
 * a "state-change"/"load" row is dropped when another state checks the same motion
 * under an interaction trigger (the hover state for a hover transition), and later
 * "load"/"state-change" repeats keep only the first state's row. Mutates and returns states.
 */
export function dedupeMotion(states) {
  const interactive = new Set();
  for (const s of Object.values(states)) for (const r of s.motion) if (INTERACTIONS.has(r.trigger)) interactive.add(r._compare.key);
  const seen = new Set();
  for (const s of Object.values(states)) {
    s.motion = s.motion.filter((r) => {
      const key = r._compare.key;
      if (INTERACTIONS.has(r.trigger)) return true;
      if (interactive.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return states;
}

const REPEAT_KEYS = {
  style: (r) => [r.elementClass, r.index, r.property, r.design, r.app],
  tokens: (r) => [r.elementClass, r.index, r.property, r.expectedValue, r.actualValue],
  components: (r) => [r.elementClass, r.index, JSON.stringify(r.design), JSON.stringify(r.app)],
  structure: (r) => [r.source, r.elementClass, r.index, r.design, r.app, r.text ?? r.name ?? null],
};

/**
 * Drop FAIL rows that repeat an earlier state's row with the same element, property and
 * values (a padding drift seen in with-data shows again in hover): one difference, one row.
 * State-specific differences keep their rows. Returns { dropped } and mutates states.
 */
export function dedupeRepeats(states) {
  let dropped = 0;
  for (const [key, id] of Object.entries(REPEAT_KEYS)) {
    const seen = new Set();
    for (const s of Object.values(states)) {
      s[key] = (s[key] ?? []).filter((r) => {
        if (r.result !== 'FAIL') return true;
        const k = JSON.stringify(id(r));
        if (seen.has(k)) { dropped += 1; return false; }
        seen.add(k);
        return true;
      });
    }
  }
  return { dropped };
}

/** compare.json summary counts. */
export function summarize(states, figmaMotion = []) {
  const count = (rows, pred = () => true) => rows.filter(pred).length;
  const all = (key) => Object.values(states).flatMap((s) => s[key]);
  const motion = [...all('motion'), ...figmaMotion];
  return {
    states: Object.keys(states).length,
    style: { pass: count(all('style'), (r) => r.result === 'PASS'), fail: count(all('style'), (r) => r.result === 'FAIL') },
    tokens: { fail: all('tokens').length, hardcoded: count(all('tokens'), (r) => r.actualToken === null) },
    components: { pass: count(all('components'), (r) => r.result === 'PASS'), fail: count(all('components'), (r) => r.result === 'FAIL') },
    motion: {
      pass: count(motion, (r) => r.result === 'PASS'),
      fail: count(motion, (r) => r.result === 'FAIL'),
      missing: count(motion, (r) => r.result === 'FAIL' && r.observed === null),
      extra: count(motion, (r) => r.result === 'FAIL' && r.expected?.type === 'none'),
      cannotVerify: count(motion, (r) => r.result === 'CANNOT_VERIFY'),
      unique: new Set(motion.filter((r) => r.result === 'FAIL').map((r) => r._compare.key)).size,
    },
    structure: {
      fail: all('structure').length,
      missingInApp: count(all('structure'), (r) => r.app === 'missing' || r.app === 'hidden'),
      extraInApp: count(all('structure'), (r) => r.design === 'missing' || r.design === 'hidden'),
    },
  };
}
