// Design-system audit, Node half (pure, no IO except scanSourceImports): token sources →
// one token set; every element recorded by audit-collect.mjs checked against it (match,
// near miss, off-token) and classified by component library; identical problems grouped
// into finding candidates (report.schema.json findings without id and rank).
//
// Candidates are candidates: the agent still decides DATA, INTENTIONAL or a known drift
// before filing one. A value equal to a token's value does not prove the code uses the
// token (SKILL.md rules): only an authored var(--token) the collector traced is proof.
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_COLOR_DELTA_E,
  colorDifference,
  componentIdentity,
  parseColorDetailed,
  parseTokenCategories,
  parseTokenMap,
  propertyCategories,
  tokenCategory,
} from './compare.mjs';
import { nodesFromAudit, nodesFromSpec } from './worklist.mjs';

export const AUDIT_NOTE =
  'Candidates, not findings: for each one decide FIX_CODE, DATA, INTENTIONAL or a known drift before filing it. ' +
  'A value equal to a token does not prove the code uses the token; trace it to source (SKILL.md rules).';

/** Categories the audit checks, in report order. */
export const AUDIT_CATEGORIES = Object.freeze(['color', 'space', 'radius', 'border-width', 'shadow', 'opacity', 'font-family', 'font-size', 'line-height', 'font-weight', 'letter-spacing']);
const LENGTH_CATEGORIES = new Set(['space', 'size', 'radius', 'border-width', 'font-size', 'letter-spacing']);
const CATEGORY_LABEL = {
  color: 'colour', space: 'spacing', radius: 'radius', 'border-width': 'border width', shadow: 'shadow', opacity: 'opacity',
  'font-family': 'font family', 'font-size': 'font size', 'line-height': 'line height', 'font-weight': 'font weight', 'letter-spacing': 'letter spacing',
};
const EXACT_DELTA_E = 0.3;
const EXACT_PX = 0.02;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const round = (n, d = 2) => Number(Number(n).toFixed(d));
const kebab = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[\s_./]+/g, '-').toLowerCase();
const one = (s, n = 120) => String(s ?? '').replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, n);

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

/** A CSS length → px (rem / em at rootFontSize, pt); null when not a plain length. */
export function toPx(value, rootFontSize = 16) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (isObj(value) && typeof value.value === 'number') return toPx(`${value.value}${value.unit ?? 'px'}`, rootFontSize);
  const m = /^\s*(-?\d*\.?\d+)(px|rem|em|pt)?\s*$/i.exec(String(value ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  if (unit === 'rem' || unit === 'em') return n * rootFontSize;
  if (unit === 'pt') return (n * 4) / 3;
  return n;
}

/** First family of a font stack, lower-case, unquoted. */
export function firstFamily(value) {
  const first = String(value ?? '').split(',')[0] ?? '';
  return first.trim().replace(/^["']|["']$/g, '').trim().toLowerCase() || null;
}

const WEIGHT_WORDS = { thin: 100, hairline: 100, extralight: 200, 'extra-light': 200, ultralight: 200, light: 300, normal: 400, regular: 400, book: 400, medium: 500, semibold: 600, 'semi-bold': 600, demibold: 600, bold: 700, extrabold: 800, 'extra-bold': 800, heavy: 800, black: 900 };
export function toWeight(value) {
  if (typeof value === 'number') return value;
  const s = String(value ?? '').trim().toLowerCase();
  if (/^\d{3}$/.test(s)) return Number(s);
  return WEIGHT_WORDS[s.replace(/\s+/g, '')] ?? null;
}

/** Colour → "#rrggbb" or "#rrggbbaa" (sRGB-clamped), the stable form used in keys and titles. */
export function hexOf(value) {
  const c = parseColorDetailed(value);
  if (!c) return null;
  const h = (n) => n.toString(16).padStart(2, '0');
  const [r, g, b] = c.rgba;
  const a = Math.round(c.alpha * 255);
  return `#${h(r)}${h(g)}${h(b)}${a < 255 ? h(a) : ''}`;
}

/** box-shadow (computed or authored) → [{ inset, lengths: [x, y, blur, spread], color }]; null when unparseable; [] for none. */
export function parseShadow(value) {
  const s = String(value ?? '').trim();
  if (!s || s === 'none') return [];
  const layers = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      layers.push(cur);
      cur = '';
    } else cur += ch;
  }
  layers.push(cur);
  const out = [];
  for (const layer of layers) {
    const parts = layer.trim().match(/[a-z-]+\([^()]*(?:\([^()]*\)[^()]*)*\)|#[0-9a-f]+|[^\s]+/gi) ?? [];
    let inset = false;
    let color = null;
    const lengths = [];
    for (const p of parts) {
      if (p.toLowerCase() === 'inset') inset = true;
      else if (toPx(p) !== null) lengths.push(toPx(p));
      else if (parseColorDetailed(p)) color = p;
      else return null;
    }
    if (lengths.length < 2) return null;
    while (lengths.length < 4) lengths.push(0);
    out.push({ inset, lengths, color: color ?? 'rgba(0, 0, 0, 1)' });
  }
  return out;
}

/** Distance of two parsed shadows (Infinity when the layer structure differs) and its worst parts. */
function shadowDistance(a, b) {
  if (!a || !b || a.length !== b.length) return { distance: Infinity, px: Infinity, deltaE: Infinity };
  let px = 0;
  let deltaE = 0;
  let alpha = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].inset !== b[i].inset) return { distance: Infinity, px: Infinity, deltaE: Infinity };
    for (let k = 0; k < 4; k += 1) px = Math.max(px, Math.abs(a[i].lengths[k] - b[i].lengths[k]));
    const d = colorDifference(a[i].color, b[i].color);
    deltaE = Math.max(deltaE, d ? d.deltaE : Infinity);
    alpha = Math.max(alpha, d ? d.alpha : 1);
  }
  return { distance: px + deltaE + alpha * 100, px, deltaE, alpha };
}

/** CSS font shorthand ("600 14px/20px Inter, sans-serif") → text style fields, or null. */
export function parseFontShorthand(value) {
  const m = /^\s*(?:(italic|oblique|normal)\s+)?(?:(\d{3}|bold|normal|light|medium)\s+)?(\d*\.?\d+(?:px|rem|em|pt))(?:\s*\/\s*(\d*\.?\d+(?:px|rem|em|%)?))?\s+(.+)$/i.exec(String(value ?? ''));
  if (!m) return null;
  return { fontWeight: m[2] ?? null, fontSize: m[3], lineHeight: m[4] ?? null, fontFamily: m[5] };
}

// ---------------------------------------------------------------------------
// Token sources
// ---------------------------------------------------------------------------

const W3C_TYPES = { color: 'color', fontFamily: 'font-family', fontWeight: 'font-weight', shadow: 'shadow', duration: 'motion', cubicBezier: 'motion', number: null, dimension: null };

/** A raw token (name, value, category hint) → a typed token, or null when it cannot be checked. */
function typedToken({ name, value, category, source, vars, rootFontSize = 16 }) {
  let cat = category ?? tokenCategory(name, typeof value === 'string' ? value : String(value), null);
  if (!cat) return null;
  if (cat === 'size') cat = 'space'; // padding / gap accept space only; a size token stays out of spacing
  const base = { name, value: typeof value === 'string' ? value : String(value), category: cat, source, vars: vars ?? [] };
  if (cat === 'color') {
    const c = parseColorDetailed(base.value);
    return c ? { ...base, value: base.value.trim() } : null;
  }
  if (LENGTH_CATEGORIES.has(cat) || cat === 'typography') {
    if (cat === 'letter-spacing' && /em$/.test(base.value.trim()) && !/rem$/.test(base.value.trim())) {
      return { ...base, em: Number.parseFloat(base.value) };
    }
    const px = toPx(typeof value === 'number' ? value : base.value, rootFontSize);
    if (px !== null) return { ...base, px };
    if (cat === 'typography') {
      const font = parseFontShorthand(base.value);
      return font ? { ...base, font } : null;
    }
    return null;
  }
  if (cat === 'line-height') {
    const s = base.value.trim();
    if (/^\d*\.?\d+$/.test(s)) return { ...base, mult: Number(s) };
    if (/%$/.test(s)) return { ...base, mult: Number.parseFloat(s) / 100 };
    const px = toPx(s, rootFontSize);
    return px === null ? null : { ...base, px };
  }
  if (cat === 'font-weight') {
    const w = toWeight(value);
    return w === null ? null : { ...base, weight: w };
  }
  if (cat === 'font-family') {
    const f = firstFamily(base.value);
    return f ? { ...base, family: f } : null;
  }
  if (cat === 'shadow') {
    const layers = parseShadow(base.value);
    return layers && layers.length ? { ...base, layers } : null;
  }
  if (cat === 'opacity') {
    const s = base.value.trim();
    const n = /%$/.test(s) ? Number.parseFloat(s) / 100 : Number(s);
    return Number.isFinite(n) ? { ...base, opacity: n } : null;
  }
  return null; // motion, z-index…: not audited
}

/** A text style from its parts (any of them may be missing). */
function textStyle({ name, fontSize, lineHeight, fontWeight, letterSpacing, fontFamily, textTransform, source, rootFontSize = 16 }) {
  const size = toPx(fontSize, rootFontSize);
  if (size === null) return null;
  const style = { name, source, size };
  if (lineHeight !== undefined && lineHeight !== null && String(lineHeight).trim() !== '' && String(lineHeight) !== 'normal') {
    const s = typeof lineHeight === 'number' ? String(lineHeight) : String(lineHeight).trim();
    if (/^\d*\.?\d+$/.test(s)) style.lineHeight = Number(s) * size;
    else if (/%$/.test(s)) style.lineHeight = (Number.parseFloat(s) / 100) * size;
    else {
      const px = toPx(isObj(lineHeight) ? lineHeight : s, rootFontSize);
      if (px !== null) style.lineHeight = px;
    }
  }
  if (fontWeight !== undefined && fontWeight !== null) {
    const w = toWeight(fontWeight);
    if (w !== null) style.weight = w;
  }
  if (letterSpacing !== undefined && letterSpacing !== null) {
    const s = typeof letterSpacing === 'number' ? `${letterSpacing}px` : String(letterSpacing).trim();
    if (s === 'normal' || s === '0') style.letterSpacing = 0;
    else if (/^-?\d*\.?\d+em$/.test(s)) style.letterSpacing = Number.parseFloat(s) * size;
    else if (/%$/.test(s)) style.letterSpacing = (Number.parseFloat(s) / 100) * size;
    else if (toPx(isObj(letterSpacing) ? letterSpacing : s, rootFontSize) !== null) style.letterSpacing = toPx(isObj(letterSpacing) ? letterSpacing : s, rootFontSize);
  }
  if (fontFamily) style.family = firstFamily(Array.isArray(fontFamily) ? fontFamily.join(', ') : fontFamily);
  if (textTransform) style.transform = String(textTransform).toLowerCase();
  return style;
}

const TYPO_KEYS = { fontSize: ['fontSize', 'font-size', 'size'], lineHeight: ['lineHeight', 'line-height'], fontWeight: ['fontWeight', 'font-weight', 'weight'], letterSpacing: ['letterSpacing', 'letter-spacing'], fontFamily: ['fontFamily', 'font-family', 'family'], textTransform: ['textTransform', 'text-transform', 'textCase'] };
const typoField = (obj, field) => TYPO_KEYS[field].map((k) => obj[k]).find((v) => v !== undefined && !isObj(v)) ?? TYPO_KEYS[field].map((k) => obj[k]).find((v) => v !== undefined);
const looksTypographic = (obj) => isObj(obj) && typoField(obj, 'fontSize') !== undefined && ['lineHeight', 'fontWeight', 'fontFamily', 'letterSpacing'].some((f) => typoField(obj, f) !== undefined);

/**
 * A JSON token file → { tokens, textStyles, skipped }. Accepts a flat { "--x": "v" } /
 * { tokens: {…} } map (the token-map JSON form), W3C design tokens (groups with $value,
 * $type inherited from groups, {alias.references}, composite typography and shadow
 * values), Style Dictionary ({ value }) and a theme object exported to JSON (nested
 * plain values; objects with fontSize plus lineHeight / fontWeight / fontFamily become
 * text styles). Names are the dot path; vars lists the custom property names it may
 * be authored as (--kebab-path).
 */
export function parseJsonTokens(json, { file = null, rootFontSize = 16 } = {}) {
  const source = { kind: 'tokens-file', file };
  const out = { tokens: [], textStyles: [], skipped: 0 };
  if (!isObj(json)) return out;
  if (isMuiTheme(json)) return parseMuiTheme(json, { source, rootFontSize });
  const flat = Object.keys(json.tokens && isObj(json.tokens) ? json.tokens : json).some((k) => k.startsWith('--'));
  if (flat) {
    const text = JSON.stringify(json);
    const values = parseTokenMap(text, { format: 'json' });
    const categories = parseTokenCategories(text, { format: 'json' });
    for (const [name, value] of Object.entries(values)) {
      const t = typedToken({ name, value, category: categories[name] ?? null, source, vars: [name], rootFontSize });
      if (t) out.tokens.push(t);
      else out.skipped += 1;
    }
    return out;
  }
  // Nested: collect leaves first (aliases need every path), then type them.
  const leaves = new Map(); // dot path → { value, type }
  const styles = [];
  const walk = (node, trail, inheritedType) => {
    if (!isObj(node)) return;
    const type = typeof node.$type === 'string' ? node.$type : inheritedType;
    if ('$value' in node || ('value' in node && !Object.values(node).some(isObj) && Object.keys(node).every((k) => ['value', 'type', 'description', 'comment', 'attributes', 'name', 'original', 'filePath', 'isSource', 'path'].includes(k)))) {
      leaves.set(trail.join('.'), { value: '$value' in node ? node.$value : node.value, type: '$value' in node ? type : node.type ?? type });
      return;
    }
    if (looksTypographic(node) && !trail.some((t) => t.startsWith('$'))) {
      styles.push({ trail, obj: node });
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('$')) continue;
      if (isObj(v)) walk(v, [...trail, k], type);
      else if (typeof v === 'string' || typeof v === 'number') leaves.set([...trail, k].join('.'), { value: v, type });
    }
  };
  walk(json, [], null);
  const resolve = (value, depth = 0) => {
    if (typeof value !== 'string' || depth > 8) return value;
    const m = /^\{([^{}]+)\}$/.exec(value.trim());
    if (!m) return value;
    const hit = leaves.get(m[1]);
    return hit ? resolve(hit.value, depth + 1) : null;
  };
  for (const [dot, { value: raw, type }] of leaves) {
    const value = isObj(raw) ? Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, resolve(v)])) : resolve(raw);
    const name = dot;
    const vars = [`--${kebab(dot)}`];
    if (value === null || value === undefined) {
      out.skipped += 1;
      continue;
    }
    if (type === 'typography' && isObj(value)) {
      const st = textStyle({ name, ...Object.fromEntries(Object.keys(TYPO_KEYS).map((f) => [f, typoField(value, f)])), source, rootFontSize });
      if (st) out.textStyles.push(st);
      continue;
    }
    if (type === 'shadow') {
      const layers = (Array.isArray(value) ? value : [value]).map((l) => (isObj(l) ? `${l.inset ? 'inset ' : ''}${l.offsetX ?? 0} ${l.offsetY ?? 0} ${l.blur ?? 0} ${l.spread ?? 0} ${resolve(l.color) ?? ''}`.trim() : String(l)));
      const t = typedToken({ name, value: layers.join(', '), category: 'shadow', source, vars, rootFontSize });
      if (t) out.tokens.push(t);
      else out.skipped += 1;
      continue;
    }
    let v = value;
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) v = v.join(', '); // a font stack
    if (isObj(v) && typeof v.hex === 'string') v = v.hex; // W3C colour object
    if (isObj(v) && typeof v.value === 'number') v = `${v.value}${v.unit ?? 'px'}`; // W3C dimension object
    if (isObj(v) || Array.isArray(v)) {
      out.skipped += 1;
      continue;
    }
    let category = W3C_TYPES[type] ?? null;
    if (category === 'motion') {
      out.skipped += 1;
      continue;
    }
    const hint = `--${kebab(dot)}`;
    category ??= tokenCategory(hint, typeof v === 'number' ? (/(weight)/i.test(dot) ? String(v) : `${v}px`) : String(v), null);
    if (category === 'motion' || category === null) {
      out.skipped += 1;
      continue;
    }
    // A unitless number is px for lengths (a theme's spacing: 8), a weight, an opacity or a multiplier.
    const t = typedToken({ name, value: typeof v === 'number' && LENGTH_CATEGORIES.has(category === 'size' ? 'space' : category) ? `${v}px` : v, category, source, vars, rootFontSize });
    if (t) out.tokens.push(t);
    else out.skipped += 1;
  }
  for (const { trail, obj } of styles) {
    const st = textStyle({ name: trail.join('.'), ...Object.fromEntries(Object.keys(TYPO_KEYS).map((f) => [f, typoField(obj, f)])), source, rootFontSize });
    if (st) out.textStyles.push(st);
  }
  return out;
}

/** An MUI theme (createTheme's result, exported or written by setup.mjs export-theme). */
const isMuiTheme = (j) => isObj(j.typography) && (isObj(j.palette) || isObj(j.colorSchemes)) && (Array.isArray(j.shadows) || isObj(j.breakpoints) || j.spacing !== undefined || isObj(j.shape));
/** theme.spacing(n) for these n is the scale a numeric spacing unit stands for. */
export const MUI_SPACING_FACTORS = Object.freeze([0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12]);

/**
 * An MUI theme → tokens: palette colours, typography variants (h1…caption) as text styles
 * plus the base family and weights, shadows[1…], the spacing scale (a number, an array or
 * { factor: value } as export-theme records it; absent: MUI's default 8px), shape.borderRadius. Breakpoints, zIndex, transitions
 * and mixins are not style values the audit checks: skipped, never read as spacing.
 */
function parseMuiTheme(json, { source, rootFontSize }) {
  const out = { tokens: [], textStyles: [], skipped: 0 };
  const push = (trail, value, category) => {
    const name = trail.join('.');
    const t = typedToken({ name, value: typeof value === 'number' && category !== 'font-weight' ? `${value}px` : value, category, source, vars: [`--mui-${kebab(trail.join('-'))}`, `--${kebab(trail.join('-'))}`], rootFontSize });
    if (t) out.tokens.push(t);
    else out.skipped += 1;
  };
  const colours = (node, trail) => {
    for (const [k, v] of Object.entries(node ?? {})) {
      if (isObj(v)) colours(v, [...trail, k]);
      else if (typeof v === 'string' && parseColorDetailed(v)) push([...trail, k], v, 'color');
    }
  };
  colours(isObj(json.palette) ? json.palette : json.colorSchemes?.light?.palette, ['palette']);
  const ty = json.typography;
  if (typeof ty.fontFamily === 'string') push(['typography', 'fontFamily'], ty.fontFamily, 'font-family');
  for (const k of ['fontWeightLight', 'fontWeightRegular', 'fontWeightMedium', 'fontWeightBold']) if (ty[k] !== undefined) push(['typography', k], ty[k], 'font-weight');
  for (const [k, v] of Object.entries(ty)) {
    if (!isObj(v) || v.fontSize === undefined) continue;
    const st = textStyle({ name: `typography.${k}`, ...Object.fromEntries(Object.keys(TYPO_KEYS).map((f) => [f, typoField(v, f)])), fontFamily: typoField(v, 'fontFamily') ?? ty.fontFamily, source, rootFontSize });
    if (st) out.textStyles.push(st);
  }
  (Array.isArray(json.shadows) ? json.shadows : []).forEach((v, i) => {
    if (typeof v === 'string' && v !== 'none') push(['shadows', String(i)], v, 'shadow');
  });
  const sp = json.spacing ?? 8;
  const scale = Array.isArray(sp) ? sp.map((v, i) => [String(i), v]) : isObj(sp) ? Object.entries(sp) : MUI_SPACING_FACTORS.map((f) => [String(f), typeof sp === 'number' ? sp * f : typeof sp === 'string' && toPx(sp) !== null ? toPx(sp) * f : null]);
  for (const [k, v] of scale) if (v !== null && v !== undefined && toPx(v, rootFontSize) !== 0) push([`spacing(${k})`], v, 'space');
  if (json.shape?.borderRadius !== undefined) push(['shape', 'borderRadius'], json.shape.borderRadius, 'radius');
  return out;
}

/** Strip /* comments *\/ and split a stylesheet into custom-property declarations with their selector context. */
function cssDeclarations(text) {
  const src = String(text ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const stack = [];
  let buf = '';
  let depth = 0;
  let quote = null;
  const flush = () => {
    const m = /^\s*(--[\w-]+)\s*:\s*([\s\S]*?)\s*(!important)?\s*$/.exec(buf);
    if (m) out.push({ name: m[1], value: m[2].trim(), context: stack.slice() });
    buf = '';
  };
  for (const ch of src) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === '(') {
      depth += 1;
      buf += ch;
    } else if (ch === ')') {
      depth -= 1;
      buf += ch;
    } else if (depth > 0) buf += ch;
    else if (ch === '{') {
      stack.push(buf.trim());
      buf = '';
    } else if (ch === '}') {
      flush();
      stack.pop();
    } else if (ch === ';') flush();
    else buf += ch;
  }
  return out;
}

/**
 * A CSS file's custom properties → { tokens, textStyles, skipped, modes }. Declarations
 * on :root, html, :host or * win; a property declared only in another context (a theme
 * selector, a media query) is used and counted under modes. var() references are
 * resolved within the file (with their fallbacks). A font shorthand token whose name
 * says typography ("--font-body: 400 14px/20px Inter") becomes a text style.
 */
export function parseCssTokens(text, { file = null, rootFontSize = 16 } = {}) {
  const source = { kind: 'tokens-file', file };
  const decls = cssDeclarations(text);
  const primary = (ctx) => ctx.length === 1 && ctx[0].split(',').every((s) => /^(:root|html|:host|\*)$/i.test(s.trim()));
  const values = new Map();
  let modes = 0;
  for (const d of decls) {
    const cur = values.get(d.name);
    if (!cur) {
      values.set(d.name, { value: d.value, primary: primary(d.context) });
      if (!primary(d.context)) modes += 1;
    } else if (!cur.primary && primary(d.context)) {
      values.set(d.name, { value: d.value, primary: true });
    }
  }
  const resolve = (value, depth = 0) => {
    if (depth > 8) return null;
    let ok = true;
    const s = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (_, name, fallback) => {
      const hit = values.get(name);
      const r = hit ? resolve(hit.value, depth + 1) : fallback !== undefined ? resolve(fallback.trim(), depth + 1) : null;
      if (r === null) ok = false;
      return r ?? '';
    });
    return ok ? s.trim() : null;
  };
  const out = { tokens: [], textStyles: [], skipped: 0, modes };
  for (const [name, { value }] of values) {
    const v = resolve(value);
    if (v === null || v === '') {
      out.skipped += 1;
      continue;
    }
    const font = /font|type|text|typo|heading|body|label/i.test(name) ? parseFontShorthand(v) : null;
    if (font) {
      const st = textStyle({ name, ...font, source, rootFontSize });
      if (st) {
        out.textStyles.push(st);
        continue;
      }
    }
    const t = typedToken({ name, value: v, category: null, source, vars: [name], rootFontSize });
    if (t) out.tokens.push(t);
    else out.skipped += 1;
  }
  return out;
}

/**
 * The markdown token map (templates/token-map.template.md) → { tokens, textStyles }:
 * rows with a `--token` cell and a backticked CSS output (compare.mjs parseTokenMap, its
 * section headings as categories), plus Typography rows whose CSS output reads
 * "24px / 32px, weight 600, letter-spacing -0.24px[, uppercase]".
 */
export function parseTokenMapFile(text, { file = null, rootFontSize = 16 } = {}) {
  const source = { kind: 'token-map', file };
  const raw = String(text ?? '');
  const values = parseTokenMap(raw);
  const categories = parseTokenCategories(raw);
  const out = { tokens: [], textStyles: [], skipped: 0 };
  for (const [name, value] of Object.entries(values)) {
    const cat = categories[name] === 'typography' ? null : categories[name] ?? null;
    const t = typedToken({ name, value, category: cat, source, vars: [name], rootFontSize });
    if (t) out.tokens.push(t);
    else out.skipped += 1;
  }
  let section = null;
  for (const line of raw.split('\n')) {
    const h = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      section = /typo|font|type|text/i.test(h[1]) ? 'typography' : 'other';
      continue;
    }
    if (section !== 'typography' || !/^\s*\|/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    const spec = cells.find((c) => /\d+(?:\.\d+)?px\s*\/\s*\d/.test(c));
    if (!spec) continue;
    const name = (cells.find((c) => /^`--[\w-]+`$/.test(c)) ?? cells[0] ?? '').replace(/`/g, '');
    const m = /(\d+(?:\.\d+)?)px\s*\/\s*(\d+(?:\.\d+)?)(px|%)?/.exec(spec);
    const lh = m[3] === '%' ? `${m[2]}%` : m[3] === 'px' ? `${m[2]}px` : m[2];
    const weight = /weight\s*(\d{3})/i.exec(spec)?.[1] ?? null;
    const ls = /letter-spacing\s*(-?\d*\.?\d+(?:px|em|%)?)/i.exec(spec)?.[1] ?? null;
    const transform = /\b(uppercase|lowercase|capitalize)\b/i.exec(spec)?.[1] ?? null;
    const st = textStyle({ name, fontSize: `${m[1]}px`, lineHeight: lh, fontWeight: weight, letterSpacing: ls === null ? null : /^-?[\d.]+$/.test(ls) ? `${ls}px` : ls, textTransform: transform, source, rootFontSize });
    if (st) out.textStyles.push(st);
  }
  return out;
}

/** Variables a framework sets for its own use (Tailwind's --tw-*, Radix's measurements…): never the design system's tokens. */
export const FRAMEWORK_VAR = /^--(?:tw|radix|headlessui|reach|floating|rdp|toastify|swiper)-/;

/** The page's :root custom properties (capture's rootTokens, already resolved) → { tokens, internal }. */
export function pageTokens(rootTokens, { rootFontSize = 16 } = {}) {
  const source = { kind: 'page', file: null };
  const out = { tokens: [], textStyles: [], skipped: 0, internal: 0 };
  for (const [name, value] of Object.entries(rootTokens ?? {})) {
    if (FRAMEWORK_VAR.test(name)) {
      out.internal += 1;
      continue;
    }
    const t = typedToken({ name, value: String(value), category: null, source, vars: [name], rootFontSize });
    if (t) out.tokens.push(t);
    else out.skipped += 1;
  }
  return out;
}

/**
 * Merge parsed sources (highest priority first) into a token set: { tokens, textStyles,
 * pools: { <category>: [token] }, byVar: Map, conflicts, sources }. A name seen twice
 * keeps its first value; a different later value is listed under conflicts.
 */
export function buildTokenSet(sources) {
  const byName = new Map();
  const conflicts = [];
  const textStyles = [];
  const seenStyles = new Set();
  const summary = [];
  sources.forEach((src, rank) => {
    const counts = {};
    for (const t0 of src.parsed.tokens) {
      const t = { ...t0, rank };
      const prev = byName.get(t.name);
      if (prev) {
        const equal = prev.value === t.value || (t.category === 'color' ? (colorDifference(prev.value, t.value)?.deltaE ?? 1) < 0.01 : prev.px !== undefined && prev.px === t.px);
        if (!equal && prev.category === t.category) conflicts.push({ name: t.name, kept: { value: prev.value, source: prev.source }, ignored: { value: t.value, source: t.source } });
        continue;
      }
      byName.set(t.name, t);
      counts[t.category] = (counts[t.category] ?? 0) + 1;
    }
    for (const s of src.parsed.textStyles) {
      if (seenStyles.has(s.name)) continue;
      seenStyles.add(s.name);
      textStyles.push(s);
    }
    summary.push({ kind: src.kind, file: src.file ?? null, tokens: src.parsed.tokens.length, textStyles: src.parsed.textStyles.length, skipped: src.parsed.skipped ?? 0, byCategory: counts, ...(src.parsed.modes ? { modeOnly: src.parsed.modes } : {}) });
  });
  const tokens = [...byName.values()];
  const pools = {};
  for (const cat of AUDIT_CATEGORIES) pools[cat] = [];
  for (const t of tokens) {
    if (pools[t.category]) pools[t.category].push(t);
    // A "typography" token joins the pool its value fits.
    if (t.category === 'typography') {
      if (t.px !== undefined) {
        pools['font-size'].push(t);
        pools['line-height'].push(t);
      } else if (t.font) {
        // a font shorthand stored as a token: its parts
      }
    }
  }
  // Page-local variables cannot expand an authoritative token contract for a category.
  for (const [category, pool] of Object.entries(pools)) {
    if (pool.some((t) => t.source?.kind !== 'page')) pools[category] = pool.filter((t) => t.source?.kind !== 'page');
  }
  const byVar = new Map();
  for (const t of tokens) for (const v of t.vars) if (!byVar.has(v)) byVar.set(v, t);
  return { tokens, textStyles, pools, byVar, conflicts, sources: summary };
}

/** The token an authored var(--x) names: exact, else a token whose --kebab-path the name ends with (a build prefix). */
export function tokenForVar(set, name) {
  if (!name) return null;
  if (set.byVar.has(name)) return set.byVar.get(name);
  for (const [v, t] of set.byVar) if (v.length > 3 && name.endsWith(`-${v.slice(2)}`)) return t;
  return null;
}

// ---------------------------------------------------------------------------
// Checking one value
// ---------------------------------------------------------------------------

/** Audit category of a recorded property; null when it is not checked one by one. */
export function auditCategory(prop) {
  if (prop === 'text-transform') return null;
  const cats = propertyCategories(prop);
  if (!cats) return null;
  const c = cats[0] === 'size' ? null : cats[0];
  return AUDIT_CATEGORIES.includes(c) ? c : null;
}

/**
 * Check one computed value against a category's tokens.
 * → { status: "match" | "near" | "off" | "skip", token, distance, unit, value } where
 * distance is ΔE (colours) or px; skip = a default (transparent, 0, normal, none) or no
 * tokens of that category.
 */
export function checkValue(set, category, value, { tolerancePx = 1, colorDeltaE = DEFAULT_COLOR_DELTA_E, fontSize = 16, box = null } = {}) {
  const pool = set.pools[category] ?? [];
  const skip = (why) => ({ status: 'skip', why, token: null, distance: null });
  if (!pool.length) return skip('no-tokens');
  const v = String(value ?? '').trim();
  const best = (scored, exact, near, unit) => {
    // Equal distance: the higher-priority source (token files before the page's own variables), then the name.
    scored.sort((a, b) => a.d - b.d || (a.t.rank ?? 0) - (b.t.rank ?? 0) || a.t.name.localeCompare(b.t.name));
    const top = scored[0];
    if (!top || !Number.isFinite(top.d)) return { status: 'off', token: null, distance: null, unit };
    const status = exact(top) ? 'match' : near(top) ? 'near' : 'off';
    return { status, token: top.t, distance: round(top.dist ?? top.d, 2), unit };
  };
  if (category === 'color') {
    const c = parseColorDetailed(v);
    if (!c || c.alpha < 0.0005) return skip('transparent');
    const scored = pool.map((t) => {
      const d = colorDifference(v, t.value);
      return { t, d: d ? d.deltaE + d.alpha * 100 : Infinity, dist: d?.deltaE ?? Infinity, alpha: d?.alpha ?? 1 };
    });
    return best(scored, (x) => x.dist <= EXACT_DELTA_E && x.alpha <= 0.01, (x) => x.dist <= colorDeltaE + 1e-9 && x.alpha <= 0.01, 'ΔE');
  }
  if (category === 'shadow') {
    const layers = parseShadow(v);
    if (!layers || !layers.length) return layers ? skip('none') : { status: 'off', token: null, distance: null, unit: null };
    const scored = pool.map((t) => ({ t, ...shadowDistance(layers, t.layers), d: shadowDistance(layers, t.layers).distance }));
    return best(scored, (x) => x.px <= EXACT_PX && x.deltaE <= EXACT_DELTA_E && x.alpha <= 0.01, (x) => x.px <= tolerancePx && x.deltaE <= colorDeltaE && x.alpha <= 0.01, null);
  }
  if (category === 'font-family') {
    const f = firstFamily(v);
    if (!f) return skip('none');
    const scored = pool.map((t) => ({ t, d: t.family === f ? 0 : 1 }));
    return best(scored, (x) => x.d === 0, () => false, null);
  }
  if (category === 'font-weight') {
    const w = toWeight(v);
    if (w === null) return skip('none');
    const scored = pool.filter((t) => t.weight !== undefined).map((t) => ({ t, d: Math.abs(t.weight - w) }));
    return best(scored, (x) => x.d === 0, () => false, null);
  }
  if (category === 'opacity') {
    const n = Number(v);
    if (!Number.isFinite(n) || n >= 1) return skip('default');
    const scored = pool.map((t) => ({ t, d: Math.abs(t.opacity - n) }));
    return best(scored, (x) => x.d <= 0.001, (x) => x.d <= 0.01, null);
  }
  // Lengths.
  if (v === 'normal' || v === 'auto' || v === 'none' || !v) return skip('default');
  if (/%$/.test(v) || /\s/.test(v)) return skip('relative');
  let px = toPx(v);
  if (px === null) return skip('unparsed');
  px = Math.abs(px);
  if (px < EXACT_PX) return skip('zero');
  const tolerance = category === 'letter-spacing' ? Math.min(tolerancePx, 0.25) : tolerancePx;
  if (category === 'radius' && box && px >= Math.min(box.w, box.h) / 2 - 0.5) {
    // A pill or circle: any "full" radius token covers it.
    const full = pool.find((t) => (t.px ?? 0) >= 999 || /full|pill|round|circle/i.test(t.name));
    if (full) return { status: 'match', token: full, distance: 0, unit: 'px' };
  }
  const expected = (t) => {
    if (t.px !== undefined) return t.px;
    if (t.mult !== undefined) return t.mult * fontSize;
    if (t.em !== undefined) return t.em * fontSize;
    return null;
  };
  const scored = pool.map((t) => ({ t, d: expected(t) === null ? Infinity : Math.abs(Math.abs(expected(t)) - px) }));
  return best(scored, (x) => x.d <= EXACT_PX, (x) => x.d <= tolerance + 1e-9, 'px');
}

/** Typography as a set against text styles: { status, style, distance, diffs }. */
export function checkTextStyle(set, values, { tolerancePx = 1 } = {}) {
  const size = toPx(values['font-size']);
  if (size === null || !set.textStyles.length) return { status: 'skip', style: null, diffs: [] };
  const lh = values['line-height'] && values['line-height'] !== 'normal' ? toPx(values['line-height']) : null;
  const weight = toWeight(values['font-weight']);
  const ls = !values['letter-spacing'] || values['letter-spacing'] === 'normal' ? 0 : toPx(values['letter-spacing']);
  const family = firstFamily(values['font-family']);
  const transform = values['text-transform'] || 'none';
  const lsTol = Math.min(tolerancePx, 0.25);
  const scored = set.textStyles.map((st) => {
    const diffs = [];
    let score = 0;
    let exact = true;
    let near = true;
    const len = (field, actual, expected, tol, weightFactor) => {
      if (expected === undefined || actual === null) return;
      const d = Math.abs(actual - expected);
      score += d * weightFactor;
      if (d > EXACT_PX) exact = false;
      if (d > tol + 1e-9) {
        near = false;
        diffs.push(`${field} ${round(actual)}px vs ${round(expected)}px`);
      } else if (d > EXACT_PX) diffs.push(`${field} ${round(actual)}px vs ${round(expected)}px (within tolerance)`);
    };
    len('size', size, st.size, tolerancePx, 4);
    len('line-height', lh, st.lineHeight, tolerancePx, 1);
    len('letter-spacing', ls, st.letterSpacing, lsTol, 2);
    if (st.weight !== undefined && weight !== null && st.weight !== weight) {
      score += Math.abs(st.weight - weight) / 50;
      exact = false;
      near = false;
      diffs.push(`weight ${weight} vs ${st.weight}`);
    }
    if (st.family && family && st.family !== family) {
      score += 3;
      exact = false;
      near = false;
      diffs.push(`family ${family} vs ${st.family}`);
    }
    if (st.transform && st.transform !== transform) {
      score += 2;
      exact = false;
      near = false;
      diffs.push(`text-transform ${transform} vs ${st.transform}`);
    }
    return { st, score, exact, near, diffs };
  });
  scored.sort((a, b) => a.score - b.score || a.st.name.localeCompare(b.st.name));
  const top = scored.find((s) => s.exact) ?? scored.find((s) => s.near) ?? scored[0];
  return { status: top.exact ? 'match' : top.near ? 'near' : 'off', style: top.st, distance: round(top.score, 2), diffs: top.diffs };
}

/** "15px/22px 500" (+ letter-spacing / family / transform when set): the text-style value used in keys and titles. */
export function textStyleValue(values) {
  const size = round(toPx(values['font-size']) ?? 0);
  const lh = values['line-height'] && values['line-height'] !== 'normal' ? `${round(toPx(values['line-height']))}px` : 'normal';
  const ls = !values['letter-spacing'] || values['letter-spacing'] === 'normal' ? 0 : round(toPx(values['letter-spacing']) ?? 0);
  const parts = [`${size}px/${lh}`, `${toWeight(values['font-weight']) ?? values['font-weight']}`];
  if (ls) parts.push(`ls ${ls}px`);
  const fam = firstFamily(values['font-family']);
  if (fam) parts.push(fam);
  if (values['text-transform'] && values['text-transform'] !== 'none') parts.push(values['text-transform']);
  return parts.join(' ');
}

const describeStyle = (st) => `${st.name} (${round(st.size)}px${st.lineHeight !== undefined ? `/${round(st.lineHeight)}px` : ''}${st.weight !== undefined ? ` ${st.weight}` : ''}${st.letterSpacing ? ` ls ${round(st.letterSpacing)}px` : ''}${st.transform ? ` ${st.transform}` : ''})`;

// ---------------------------------------------------------------------------
// Selectors over recorded elements (no browser)
// ---------------------------------------------------------------------------

const attrValue = (e, name) => {
  if (name === 'class') return (e.cls ?? []).join(' ');
  if (name === 'id') return e.id ?? null;
  if (name === 'role') return e.role ?? e.attrs?.role ?? null;
  if (name === 'type') return e.type ?? e.attrs?.type ?? null;
  return e.attrs?.[name] ?? null;
};

function splitList(text) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function matchCompound(e, sel) {
  let rest = sel.trim();
  if (!rest) return null;
  const tag = /^(\*|[a-z][a-z0-9-]*)/i.exec(rest);
  let ok = true;
  if (tag) {
    if (tag[1] !== '*' && tag[1].toLowerCase() !== e.tag) ok = false;
    rest = rest.slice(tag[0].length);
  }
  while (rest) {
    let m;
    if ((m = /^\.((?:\\.|[\w-])+)/.exec(rest))) {
      if (!(e.cls ?? []).includes(m[1].replace(/\\(.)/g, '$1'))) ok = false;
    } else if ((m = /^#((?:\\.|[\w-])+)/.exec(rest))) {
      if (e.id !== m[1].replace(/\\(.)/g, '$1')) ok = false;
    } else if ((m = /^\[\s*([\w-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*))\s*(i)?\s*)?\]/.exec(rest))) {
      const actual = attrValue(e, m[1]);
      const want = m[3] ?? m[4] ?? m[5];
      const ci = m[6] === 'i';
      const a = actual === null || actual === undefined ? null : ci ? String(actual).toLowerCase() : String(actual);
      const w = want === undefined ? undefined : ci ? want.toLowerCase() : want;
      const pass = !m[2]
        ? a !== null
        : a !== null &&
          (m[2] === '=' ? a === w : m[2] === '~=' ? a.split(/\s+/).includes(w) : m[2] === '|=' ? a === w || a.startsWith(`${w}-`) : m[2] === '^=' ? Boolean(w) && a.startsWith(w) : m[2] === '$=' ? Boolean(w) && a.endsWith(w) : Boolean(w) && a.includes(w));
      if (!pass) ok = false;
    } else if ((m = /^:not\(((?:[^()]|\([^()]*\))*)\)/.exec(rest))) {
      const inner = splitList(m[1]).map((s) => matchCompound(e, s));
      if (inner.some((x) => x === null)) return null;
      if (inner.some(Boolean)) ok = false;
    } else {
      return null; // a pseudo-class or combinator this matcher does not handle
    }
    rest = rest.slice(m[0].length);
  }
  return ok;
}

/**
 * Match a recorded element against a CSS selector list without a browser: tag, *, #id,
 * .class, [attr], [attr=|~=|^=|$=|*=||= v] and :not(…) over the attributes the collector
 * records (class, id, role, type, data-*, aria-label). null when the selector needs more
 * (combinators, other pseudo-classes): pass it to the collector to evaluate in the page.
 */
export function matchSelector(e, selector) {
  let unknown = false;
  for (const part of splitList(String(selector ?? ''))) {
    if (/[\s>+~]/.test(part.replace(/\[[^\]]*\]|\([^()]*\)/g, ''))) {
      unknown = true;
      continue;
    }
    const r = matchCompound(e, part);
    if (r === true) return true;
    if (r === null) unknown = true;
  }
  return unknown ? null : false;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

const KIND_RULES = [
  ['button', /button|btn|\bcta\b/i],
  ['textbox', /text[\s-]?field|input(?!-?group)|textbox|search(?:box|field)?|textarea/i],
  ['select', /select|dropdown|combo-?box|autocomplete|listbox/i],
  ['checkbox', /check-?box/i],
  ['radio', /radio/i],
  ['switch', /switch|toggle/i],
  ['tab', /\btabs?\b|(^|[^a-z])tab(?!le)/i],
  ['slider', /slider|range/i],
  ['tag', /\b(chip|tag|badge|pill)s?\b|chip|badge|pill/i],
  ['link', /\blink\b/i],
  ['dialog', /dialog|modal|drawer/i],
  ['tooltip', /tooltip|popover/i],
  ['menu', /\bmenu/i],
  ['alert', /alert|banner|toast|snackbar/i],
  ['table', /table|data-?grid/i],
];
/** Widget kind named by a component name, class stem or selector ("MuiChip" → tag); null when unknown. */
export function componentKind(text) {
  const s = String(text ?? '').replace(/([a-z])([A-Z])/g, '$1 $2');
  return KIND_RULES.find(([, re]) => re.test(s))?.[0] ?? null;
}

/** Controls a design system replaces; links are only flagged through rawPrimitives. */
export const RAW_CONTROL_KINDS = Object.freeze(['button', 'textbox', 'select', 'checkbox', 'radio', 'switch', 'tab', 'slider']);

/** Design-system equivalents by widget kind, from the catalog's components (an entry's "kind", else its name). */
export function catalogEquivalents(catalog) {
  const out = {};
  for (const [key, entry] of Object.entries(catalog?.components ?? {})) {
    if (!isObj(entry)) continue;
    const kind = (typeof entry.kind === 'string' && entry.kind) || componentKind(`${key} ${entry.component ?? ''}`) || componentKind(entry.selector ?? '');
    if (kind && !out[kind]) out[kind] = { catalogKey: key, component: entry.component ?? key };
  }
  return out;
}

const area = (r) => (r ? Math.max(0, r.w) * Math.max(0, r.h) : 0);

/**
 * Normalised libraries: designSystem.libraries plus, when none is a design system, an
 * implicit one ([data-ds-component] and the catalog's component selectors).
 */
export function normalizeLibraries(libraries, { dsName = null, catalog = null } = {}) {
  const libs = (Array.isArray(libraries) ? libraries : []).filter((l) => isObj(l) && typeof l.name === 'string' && l.name.trim()).map((l) => ({
    name: l.name.trim(),
    kind: ['design-system', 'third-party', 'legacy'].includes(l.kind) ? l.kind : 'third-party',
    classPrefix: typeof l.classPrefix === 'string' && l.classPrefix ? l.classPrefix : null,
    selector: typeof l.selector === 'string' && l.selector.trim() ? l.selector.trim() : null,
    package: Array.isArray(l.package) ? l.package.filter((p) => typeof p === 'string') : typeof l.package === 'string' ? [l.package] : [],
    ...(l.kind === 'design-system' && typeof l.wraps === 'string' && l.wraps.trim() ? { wraps: l.wraps.trim() } : {}),
  }));
  // A design system built on a third-party library renders that library's classes: those elements are the design system's.
  for (const l of libs) {
    const w = l.kind === 'third-party' && libs.find((d) => d.wraps && (d.wraps === l.name || l.package.includes(d.wraps)));
    if (w) l.wrappedBy = w.name;
  }
  if (!libs.some((l) => l.kind === 'design-system')) {
    const sels = ['[data-ds-component]', ...Object.values(catalog?.components ?? {}).map((c) => c?.selector).filter((s) => typeof s === 'string' && s.trim())];
    libs.unshift({ name: dsName || 'design system', kind: 'design-system', classPrefix: null, selector: [...new Set(sels)].join(', '), package: [], implicit: true });
  }
  return libs;
}

/**
 * Classify a state's elements. ctx: { libraries (normalised), catalog, selectorIndex: Map
 * (selector → index in the collector's list), unsupported: Set (selectors the node
 * matcher could not evaluate) }. → { perElement: [{ lib, name, instance }], libraries:
 * { <name>: { kind, elements, instances } }, members: [component members] }.
 */
export function classifyComponents(audit, ctx) {
  const els = audit.elements ?? [];
  const { libraries, catalog, selectorIndex, unsupported } = ctx;
  const equivalents = catalogEquivalents(catalog);
  const matches = (e, selector) => {
    if (!selector) return false;
    if (selectorIndex.has(selector)) return (e.sel ?? []).includes(selectorIndex.get(selector));
    const r = matchSelector(e, selector);
    if (r === null) {
      // A list mixes parts: try each part on its own before giving up.
      const parts = splitList(selector);
      let any = false;
      for (const p of parts) {
        const pr = matchSelector(e, p);
        if (pr === true) return true;
        if (pr === null) any = true;
      }
      if (any) unsupported.add(selector);
      return false;
    }
    return r;
  };
  const stem = (e, lib) => {
    if (lib.classPrefix) {
      // "MuiButtonBase-root MuiButton-root MuiButton-contained" → MuiButton; "legacy-tag" → legacy-tag.
      const own = (e.cls ?? []).filter((c) => c.startsWith(lib.classPrefix));
      const root = [...own].reverse().find((c) => /-root$/.test(c));
      const cls = root ?? own[0];
      if (!cls) return lib.name;
      const rest = cls.slice(lib.classPrefix.length).replace(/-root$/, '');
      return `${lib.classPrefix}${rest.split(/-|__/)[0] || rest}`;
    }
    return e.attrs?.['data-ds-component'] || e.attrs?.['data-component'] || null;
  };
  const seenAs = [];
  const libOf = els.map((e, i) => {
    for (const lib of libraries) {
      const byPrefix = lib.classPrefix && (e.cls ?? []).some((c) => c.startsWith(lib.classPrefix));
      if (byPrefix || matches(e, lib.selector)) {
        seenAs[i] = lib;
        return (lib.wrappedBy && libraries.find((d) => d.name === lib.wrappedBy)) || lib;
      }
    }
    // A catalog component is the design system's even without a library entry.
    const id = componentIdentity({ tag: e.tag, id: e.id, classes: e.cls, component: e.attrs?.['data-ds-component'] || e.attrs?.['data-component'] || null, testid: e.attrs?.['data-testid'] ?? null, role: e.role }, catalog);
    if (id) return libraries.find((l) => l.kind === 'design-system') ?? null;
    return null;
  });
  // The component an element is part of: an ancestor within 4 levels, at most 4× its area.
  // (anyArea: an ancestor of the same component, such as a label inside its button.)
  const partOf = (i, pred, { anyArea = false } = {}) => {
    const own = Math.max(1, area(els[i].rect));
    let cur = els[i].p;
    for (let step = 0; step < 4 && cur !== undefined && cur !== null && cur >= 0; step += 1) {
      if (pred(cur) && (anyArea || area(els[cur].rect) <= own * 4)) return cur;
      cur = els[cur].p;
    }
    return null;
  };
  const perElement = els.map(() => ({ lib: null, name: null, instance: false }));
  const libraryCounts = {};
  for (const lib of libraries) libraryCounts[lib.name] = { kind: lib.kind, elements: 0, instances: 0 };
  const members = [];
  const claimed = new Set();
  const names = els.map((e, i) => (libOf[i] ? stem(e, seenAs[i] ?? libOf[i]) ?? componentIdentity({ tag: e.tag, id: e.id, classes: e.cls, component: null, testid: e.attrs?.['data-testid'] ?? null, role: e.role }, catalog)?.component ?? libOf[i].name : null));
  els.forEach((e, i) => {
    const lib = libOf[i];
    if (!lib) return;
    const name = names[i];
    const instance = partOf(i, (a) => libOf[a] === lib && names[a] === name, { anyArea: true }) === null && partOf(i, (a) => libOf[a] === lib) === null;
    perElement[i] = { lib: lib.name, name, instance };
    libraryCounts[lib.name].elements += 1;
    if (instance) libraryCounts[lib.name].instances += 1;
    if (lib.kind === 'design-system' || !instance) return;
    if (partOf(i, (a) => libOf[a]?.kind === 'design-system') !== null) return; // inside a design-system component
    const kind = e.control && e.control !== 'link' ? e.control : componentKind(name);
    const ds = kind ? equivalents[kind] ?? null : null;
    if (ds) members.push({ i, origin: lib.kind, library: lib.name, component: name, kind, ds, severity: 'BLOCKER' });
    else if (lib.kind === 'legacy') members.push({ i, origin: 'legacy', library: lib.name, component: name, kind, ds: null, severity: 'WARNING' });
    else if (kind) members.push({ i, origin: 'third-party', library: lib.name, component: name, kind, ds: null, severity: 'DS_CANDIDATE' });
    claimed.add(i);
  });
  const inAnyLibrary = (i) => libOf[i] !== null || partOf(i, (a) => libOf[a] !== null) !== null;
  const raws = Array.isArray(catalog?.rawPrimitives) ? catalog.rawPrimitives.filter((r) => isObj(r) && typeof r.selector === 'string') : [];
  els.forEach((e, i) => {
    if (claimed.has(i) || libOf[i]?.kind === 'design-system') return;
    if (partOf(i, (a) => libOf[a]?.kind === 'design-system') !== null) return;
    const raw = raws.find((r) => matches(e, r.selector));
    if (raw && !libOf[i]) {
      const entry = catalog.components?.[raw.use];
      members.push({ i, origin: 'raw-primitive', library: null, component: `<${e.tag}>`, kind: e.control ?? componentKind(raw.use), ds: { catalogKey: raw.use ?? null, component: entry?.component ?? raw.use ?? 'a design-system component' }, rawSelector: raw.selector, note: raw.note ?? null, severity: 'BLOCKER' });
      claimed.add(i);
      return;
    }
    if (!e.control || !RAW_CONTROL_KINDS.includes(e.control) || inAnyLibrary(i)) return;
    const ds = equivalents[e.control] ?? null;
    members.push({ i, origin: 'native-control', library: null, component: `<${e.tag}${e.type ? ` type=${e.type}` : ''}>`, kind: e.control, ds, severity: ds ? 'BLOCKER' : null });
  });
  return { perElement, libraries: libraryCounts, members };
}

// ---------------------------------------------------------------------------
// Known drifts (hints only: matching free-form entries is not reliable enough to cite)
// ---------------------------------------------------------------------------

/** known-drifts.md → [{ id, title, status, scope, design, code, retired }]. */
export function parseKnownDrifts(text) {
  const out = [];
  let cur = null;
  for (const line of String(text ?? '').split('\n')) {
    const h = /^\s*#{2,4}\s+(KD-\d+)\s*[—–-]?\s*(.*)$/.exec(line);
    if (h) {
      cur = { id: h[1], title: h[2].trim(), status: '', scope: '', design: '', code: '' };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const f = /^\s*[-*]\s*\*\*(Scope|Design|Code|Status)\*\*\s*:?\s*(.*)$/i.exec(line);
    if (f) cur[f[1].toLowerCase()] = f[2].trim();
  }
  return out.map((d) => ({ ...d, retired: /^retired/i.test(d.status) }));
}

const squash = (s) => String(s ?? '').toLowerCase().replace(/[`'"]/g, '').replace(/\s+/g, ' ');

/** The active drift a candidate probably is: its actual value in the entry's Code line and its expectation in Design or Scope. */
export function knownDriftHint(drifts, { actual = [], expected = [] }) {
  for (const d of drifts) {
    if (d.retired) continue;
    const code = squash(d.code);
    const design = squash(`${d.design} ${d.scope} ${d.title}`);
    const hitA = actual.filter(Boolean).find((a) => code.includes(squash(a)));
    const hitE = expected.filter(Boolean).find((x) => design.includes(squash(x)));
    if (hitA && hitE) return { id: d.id, title: one(d.title, 100), why: `"${one(hitA, 40)}" is in its Code line and "${one(hitE, 40)}" in its Design or Scope line; confirm before citing it` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Source import scan (a hint from the local checkout)
// ---------------------------------------------------------------------------

const SOURCE_EXT = /\.(m?[jt]sx?|cjs|vue|svelte)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.cache', 'storybook-static', '.turbo', 'vendor', 'qa-reports']);

/**
 * Which local source files import each library's package: { note, root, filesScanned,
 * truncated, libraries: { <name>: { packages, files, sample, imports: { <name>: n } } } }.
 * Symbolic links are not followed. A hint only: the checkout may differ from the build.
 */
export function scanSourceImports(root, libraries, { maxFiles = 20000, maxBytes = 1024 * 1024 } = {}) {
  const libs = libraries.filter((l) => l.package?.length);
  const result = { note: 'From the local checkout; it may differ from the deployed build. A hint, never evidence.', root, filesScanned: 0, truncated: false, libraries: {} };
  for (const l of libs) result.libraries[l.name] = { packages: l.package, files: 0, sample: [], imports: {} };
  if (!libs.length) return result;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, d.name);
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name) && !d.name.startsWith('.')) stack.push(p);
        continue;
      }
      if (!d.isFile() || !SOURCE_EXT.test(d.name)) continue;
      if (result.filesScanned >= maxFiles) {
        result.truncated = true;
        return result;
      }
      let text;
      try {
        if (lstatSync(p).size > maxBytes) continue;
        text = readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      result.filesScanned += 1;
      const rel = path.relative(root, p).split(path.sep).join('/');
      const specs = [];
      for (const m of text.matchAll(/import\s+(?:type\s+)?([\s\S]{0,400}?)\s+from\s+['"]([^'"]+)['"]|(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)|export\s+[\s\S]{0,200}?\s+from\s+['"]([^'"]+)['"]/g)) {
        specs.push({ clause: m[1] ?? '', spec: m[2] ?? m[3] ?? m[4] });
      }
      for (const lib of libs) {
        const hits = specs.filter((s) => lib.package.some((pkg) => s.spec === pkg || s.spec.startsWith(`${pkg}/`)));
        if (!hits.length) continue;
        const entry = result.libraries[lib.name];
        entry.files += 1;
        if (entry.sample.length < 10) entry.sample.push(rel);
        for (const h of hits) {
          const names = [];
          const braces = /\{([^}]*)\}/.exec(h.clause);
          if (braces) for (const n of braces[1].split(',')) names.push(n.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, ''));
          const def = /^([A-Za-z_$][\w$]*)/.exec(h.clause.trim());
          const sub = lib.package.map((pkg) => (h.spec.startsWith(`${pkg}/`) ? h.spec.slice(pkg.length + 1).split('/')[0] : null)).find(Boolean);
          if (def && !braces) names.push(sub && /^[A-Z]/.test(sub) ? sub : def[1]);
          for (const n of names.filter((x) => x && /^[\w$]+$/.test(x))) entry.imports[n] = (entry.imports[n] ?? 0) + 1;
        }
      }
    }
  }
  return result;
}

/**
 * The import and export statements of a source file, linear in its length: { keyword
 * (import | export | null for require() and import()), type, clause, spec, index }.
 */
export function importsIn(text) {
  const out = [];
  for (const m of String(text).matchAll(/\b(from|import)\s*['"]([^'"\n]{1,300})['"]|\b(?:require|import)\(\s*['"]([^'"\n]{1,300})['"]\s*\)/g)) {
    if (m[3]) {
      out.push({ keyword: null, type: false, clause: '', spec: m[3], index: m.index });
      continue;
    }
    if (m[1] === 'import') {
      out.push({ keyword: 'import', type: false, clause: '', spec: m[2], index: m.index });
      continue;
    }
    const before = text.slice(Math.max(0, m.index - 400), m.index);
    const k = [...before.matchAll(/\b(import|export)\b/g)].pop();
    if (!k) continue;
    const clause = before.slice(k.index + k[1].length).trim();
    out.push({ keyword: k[1], type: /^type\s/.test(clause), clause: clause.replace(/^type\s+/, ''), spec: m[2], index: m.index - before.length + k.index });
  }
  return out;
}

/** Imports that are not components to replace: theming, providers, layout boxes, transitions. */
const NOT_A_COMPONENT = /Provider$|^(?:CssBaseline|ScopedCssBaseline|GlobalStyles|Box|Stack|Grid2?|Container|Fade|Grow|Slide|Collapse|Zoom|Portal|NoSsr|ClickAwayListener|Theme\w*)$/;
const NOT_APP_SOURCE = /(?:^|\/)(?:__tests__|__mocks__|e2e|cypress|tests?)\/|\.(?:test|spec|stories|story|d)\.[cm]?[jt]sx?$/i;

const ENTRY_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs', '/index.d.ts'];
const isFile = (f) => {
  try {
    return statSync(f).isFile();
  } catch {
    return false;
  }
};
const resolveModule = (base) => ENTRY_SUFFIXES.map((x) => base + x).find(isFile) ?? null;

/** The entry file of an installed package (node_modules/<name>): types, module, main or exports["."]. */
function packageEntry(root, name) {
  const dir = path.join(root, 'node_modules', name);
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const dot = isObj(pkg.exports) ? pkg.exports['.'] ?? pkg.exports : pkg.exports;
  const fromExports = typeof dot === 'string' ? dot : isObj(dot) ? [dot.types, dot.import, dot.default, dot.require].find((x) => typeof x === 'string') : null;
  for (const rel of [pkg.types, pkg.typings, pkg.module, fromExports, pkg.main, 'index'].filter((x) => typeof x === 'string')) {
    const f = resolveModule(path.resolve(dir, rel));
    if (f) return f;
  }
  return null;
}

/**
 * The names a design-system library exports: its package entry (node_modules) or its
 * folder's index, following "export … from './x'" a few files deep. null when no entry
 * can be read or it exports nothing that can be read.
 */
export function wrapperExports(root, lib) {
  const names = new Set();
  const seen = new Set();
  const walk = (file, depth) => {
    if (!file || seen.has(file) || depth > 4) return;
    seen.add(file);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    for (const m of text.matchAll(/\bexport\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|enum)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of text.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}/g)) {
      for (const part of m[1].split(',')) {
        const n = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
      }
    }
    for (const m of text.matchAll(/\bexport\s+\*\s+(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s+['"]([^'"\n]+)['"]/g)) {
      if (m[1]) names.add(m[1]);
      else if (m[2].startsWith('.')) walk(resolveModule(path.resolve(path.dirname(file), m[2])), depth + 1);
    }
  };
  for (const pkg of lib.package ?? []) {
    const local = !pkg.startsWith('@') && (pkg.startsWith('.') || pkg.includes('/'));
    walk(local ? resolveModule(path.resolve(root, pkg)) : packageEntry(root, pkg), 0);
  }
  return names.size ? names : null;
}

/**
 * Where the app's own code imports a library its design system wraps, straight from the
 * library: one hit per file and component, { file, line, component, library, package,
 * snippet }. The wrapper's own code (its folder, or a workspace package of that name) and
 * test or story files are left out. A component the wrapper has no export of that name for
 * is not a hit (skipped lists them); when the wrapper's exports cannot be read every import
 * is a hit and unreadExports names the wrapper. → { hits, filesScanned, truncated, skipped, unreadExports }.
 */
export function scanRawImports(root, libraries, { maxFiles = 20000, maxBytes = 1024 * 1024 } = {}) {
  const wrapped = libraries.filter((l) => l.wrappedBy && l.package?.length);
  const out = { hits: [], filesScanned: 0, truncated: false, skipped: [], unreadExports: [] };
  if (!wrapped.length) return out;
  const exportsOf = new Map();
  for (const l of wrapped) {
    if (exportsOf.has(l.wrappedBy)) continue;
    const w = libraries.find((d) => d.name === l.wrappedBy);
    exportsOf.set(l.wrappedBy, w ? wrapperExports(root, w) : null);
    if (!exportsOf.get(l.wrappedBy)) out.unreadExports.push(l.wrappedBy);
  }
  const own = libraries.filter((l) => l.wraps).flatMap((l) => l.package);
  const ownDirs = own.filter((p) => !p.startsWith('@') && p.includes('/')).map((p) => p.replace(/^\.\//, '').replace(/\/+$/, ''));
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (dir !== root && entries.some((d) => d.name === 'package.json')) {
      try {
        if (own.includes(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).name)) continue;
      } catch {
        // not a manifest: scanned as usual
      }
    }
    for (const d of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      const p = path.join(dir, d.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (d.isSymbolicLink() || ownDirs.some((w) => rel === w || rel.startsWith(`${w}/`))) continue;
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name) && !d.name.startsWith('.')) stack.push(p);
        continue;
      }
      if (!d.isFile() || !SOURCE_EXT.test(d.name) || NOT_APP_SOURCE.test(rel)) continue;
      if (out.filesScanned >= maxFiles) {
        out.truncated = true;
        return out;
      }
      let text;
      try {
        if (lstatSync(p).size > maxBytes) continue;
        text = readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      out.filesScanned += 1;
      const seen = new Set();
      for (const m of importsIn(text)) {
        if (m.keyword !== 'import' || m.type || !m.clause) continue;
        const lib = wrapped.find((l) => l.package.some((pkg) => m.spec === pkg || m.spec.startsWith(`${pkg}/`)));
        if (!lib) continue;
        const sub = m.spec.split('/').slice(m.spec.startsWith('@') ? 2 : 1)[0];
        const braces = /\{([^}]*)\}/.exec(m.clause);
        const names = braces ? braces[1].split(',').map((n) => n.trim()).filter((n) => n && !/^type\s/.test(n)).map((n) => n.split(/\s+as\s+/)[0]) : [];
        const def = /^\s*([A-Za-z_$][\w$]*)/.exec(m.clause.replace(/\{[^}]*\}/, ''));
        if (def && def[1] !== 'as') names.push(sub && /^[A-Z]/.test(sub) ? sub : def[1]);
        const line = text.slice(0, m.index).split('\n').length;
        const m0 = text.slice(m.index, text.indexOf('\n', m.index) < 0 ? undefined : text.indexOf('\n', m.index));
        for (const name of names.filter((n) => /^[A-Z][\w$]*$/.test(n) && !NOT_A_COMPONENT.test(n))) {
          if (seen.has(name)) continue;
          seen.add(name);
          const has = exportsOf.get(lib.wrappedBy);
          if (has && !has.has(name)) {
            if (!out.skipped.includes(name)) out.skipped.push(name);
            continue;
          }
          out.hits.push({ file: rel, line, component: name, library: lib.name, wrappedBy: lib.wrappedBy, package: m.spec, snippet: one(m0, 160) });
        }
      }
    }
  }
  out.hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.component.localeCompare(b.component));
  return out;
}

/** Raw-import hits → component candidates (no capture marks them: the classes are the wrapper's too). */
function sourceCandidates(hits, { catalog = null, states = [] } = {}) {
  const equivalents = catalogEquivalents(catalog);
  return hits.map((h) => {
    const kind = componentKind(h.component);
    const ds = kind ? equivalents[kind] ?? null : null;
    const severity = ds || RAW_CONTROL_KINDS.includes(kind) ? 'BLOCKER' : 'WARNING';
    const use = ds ? ds.component : `${h.wrappedBy}'s ${h.component}`;
    return {
      key: `source:${kebab(h.library)}:${kebab(h.file.replace(/\.[^.]+$/, ''))}:${kebab(h.component)}`,
      title: `${h.file} imports ${h.component} straight from ${h.package}, not through ${h.wrappedBy} (line ${h.line})`,
      ledger: 'component',
      severity,
      resolution: 'FIX_CODE',
      region: 'Page',
      element: { selector: null, figmaLayerPath: null, figmaNodeId: null },
      property: null,
      expected: { value: `${use} (design system)`, token: null, source: 'design-rules' },
      actual: { value: `${h.component} (third-party: ${h.library})`, token: null, source: { file: h.file, line: h.line, snippet: h.snippet } },
      delta: null,
      tolerance: null,
      fix: { summary: `Import ${h.component} from ${h.wrappedBy} instead of ${h.package}`, patchHint: null, files: [h.file], effort: 2 },
      state: states.length === 1 ? states[0] : null,
      evidence: [],
      signoff: null,
      knownDrift: null,
      acRef: null,
      unpinnedReason: `Found in the source (${h.file}:${h.line}); ${h.wrappedBy} renders ${h.library}'s classes too, so no capture tells this use apart. Pin it if you find the element.`,
      _audit: { kind: 'component', origin: 'source-import', count: 1, elements: 0, states: {}, samples: [], library: h.library, component: h.component, controlKind: kind, dsEquivalent: ds?.component ?? null, designCheck: 'unknown', designValue: 'unknown', designToken: null, design: { same: 0, different: 0, unknown: 0, source: null }, knownDriftHint: null },
    };
  });
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

/** Clip a rect to the image: an integer crop of at least 1×1, or null. */
export function cropInImage(rect, size) {
  if (!rect || !size) return null;
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(size.width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(size.height, Math.ceil(rect.y + rect.h));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ---------------------------------------------------------------------------
// The design side: is an off-token value a parity difference at all?
// ---------------------------------------------------------------------------
//
// The audit checks the app against the tokens. A value the design uses too (an 8px radius
// in both) is not a parity difference, and the skill never points back at the design. So
// each off-token element is matched to its design counterpart and its value compared:
// same → designAlso (nothing to file), different → a candidate whose expected value is the
// design's, no design data → a candidate marked designValue "unknown".

/** Design data of one state: a coded prototype's audit file, a Figma REST spec, or none. */
export function designSide({ audit = null, spec = null, nodeId = null, includeRoot = false } = {}) {
  if (audit && Array.isArray(audit.elements)) {
    const nodes = nodesFromAudit(audit, 'design');
    return { kind: 'prototype', nodes, audit, values: true, text: true, note: nodes.length ? null : 'the design audit file has no elements' };
  }
  if (spec && typeof spec === 'object') {
    const s = nodesFromSpec(spec, nodeId, { includeRoot });
    return { kind: 'figma', nodes: s.nodes, audit: null, values: Boolean(s.values), text: Boolean(s.text), note: s.values ? s.note : 'the Figma spec carries no style values (MCP path): every design value is unknown' };
  }
  return { kind: 'none', nodes: [], audit: null, values: false, text: false, note: 'no design-side data for this state' };
}

const GEOMETRY_PX = 2;
const GEOMETRY_DY = 4;
const lower = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Find an app element's design counterpart. Prototype: the same selector path (same tag,
 * a similar width), else the same test id, a unique id, or the same tag + text. Figma: a
 * text layer with the same text. A key several elements share pairs them in document
 * order, only when both sides have as many. Else geometry: a design box at the same place and size, after the
 * vertical shift of the nearest identified element above it (a section added or missing
 * higher up). Conservative: an ambiguous match is no match.
 * → (appElement) → { nodes: [node…], via } | null.
 */
export function designMatcher(appEls, design) {
  const nodes = design?.nodes ?? [];
  if (!nodes.length) return () => null;
  const proto = design.kind === 'prototype';
  const index = (key) => {
    const m = new Map();
    for (const n of nodes) {
      const k = key(n);
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(n);
    }
    return m;
  };
  const byPath = proto ? index((n) => n.path || null) : new Map();
  const byTestid = proto ? index((n) => n.attrs?.['data-testid'] || null) : new Map();
  const byId = proto ? index((n) => n.id || null) : new Map();
  const textKey = (tag, text) => (text ? `${proto ? tag : ''}|${lower(text)}` : null);
  const byText = index((n) => (n.own || !proto ? textKey(n.tag, n.text) : null));
  // The k-th app element with a key pairs with the k-th design node with it, only when
  // both sides have the same number (three "stock-badge" rows on each side).
  const appRank = (key) => {
    const m = new Map();
    for (const e of appEls) {
      const k = key(e);
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(e.i);
    }
    return m;
  };
  const pathKey = (e) => e.path || null;
  const testidKey = (e) => e.attrs?.['data-testid'] || null;
  const ownTextKey = (e) => (e.own ? textKey(e.tag, e.text) : null);
  const appPaths = proto ? appRank(pathKey) : new Map();
  const appTestids = proto ? appRank(testidKey) : new Map();
  const appTexts = appRank(ownTextKey);
  const paired = (e, key, appIdx, designIdx) => {
    const k = key(e);
    const d = k ? designIdx.get(k) : null;
    const a = k ? appIdx.get(k) : null;
    if (!d || !a || d.length !== a.length) return null;
    return d[a.indexOf(e.i)] ?? null;
  };
  const similar = (e, n) => n && n.tag === e.tag && Math.abs(n.rect.w - e.rect.w) <= Math.max(8, 0.25 * e.rect.w);
  const identity = (e) => {
    if (proto) {
      const p = paired(e, pathKey, appPaths, byPath);
      if (similar(e, p)) return { nodes: [p], via: 'path' };
      const t = paired(e, testidKey, appTestids, byTestid);
      if (t && t.tag === e.tag) return { nodes: [t], via: 'test-id' };
      const i = e.id ? byId.get(e.id) : null;
      if (i?.length === 1 && i[0].tag === e.tag) return { nodes: i, via: 'id' };
    }
    const x = paired(e, ownTextKey, appTexts, byText);
    if (x) return { nodes: [x], via: 'text' };
    return null;
  };
  const cache = new Map();
  const anchors = [];
  for (const e of appEls) {
    const m = identity(e);
    cache.set(e.i, m);
    if (m && e.rect) anchors.push({ y: e.rect.y, dy: m.nodes[0].rect.y - e.rect.y });
  }
  anchors.sort((a, b) => a.y - b.y);
  const shiftAt = (y) => {
    let dy = 0;
    for (const a of anchors) {
      if (a.y > y) break;
      dy = a.dy;
    }
    return dy;
  };
  return (e) => {
    if (!e?.rect) return null;
    const hit = cache.get(e.i);
    if (hit) return hit;
    const dys = [...new Set([shiftAt(e.rect.y), 0])];
    for (const dy of dys) {
      let found = nodes.filter((n) => Math.abs(n.rect.x - e.rect.x) <= GEOMETRY_PX && Math.abs(n.rect.w - e.rect.w) <= GEOMETRY_PX && Math.abs(n.rect.h - e.rect.h) <= GEOMETRY_PX && Math.abs(n.rect.y - (e.rect.y + dy)) <= GEOMETRY_DY);
      if (proto && found.length > 1) found = found.filter((n) => n.tag === e.tag);
      if (proto && found.length > 1) found = found.filter((n) => (n.cls ?? []).join(' ') === (e.cls ?? []).join(' '));
      if (found.length === 1 || (!proto && found.length > 1)) return { nodes: found, via: 'geometry' };
      if (found.length > 1) return null; // ambiguous
    }
    return null;
  };
}

// Properties the collector records only when they apply: on a prototype element, a
// missing one has its default value. The others (radius, gap, border colours, text) are
// recorded only under conditions, so a missing one is unknown.
const DEFAULT_WHEN_MISSING = {
  'background-color': 'rgba(0, 0, 0, 0)',
  'box-shadow': 'none',
  opacity: '1',
  'margin-top': '0px',
  'margin-bottom': '0px',
};
const defaultWhenMissing = (prop) => DEFAULT_WHEN_MISSING[prop] ?? (/^padding-(top|right|bottom|left)$|^border-(top|right|bottom|left)-width$/.test(prop) ? '0px' : undefined);

/** A design node's value for an app property; undefined when the design does not say. */
export function designValueOf(node, prop, design) {
  const p = node?.props ?? {};
  if (design.kind === 'prototype') {
    if (p[prop] !== undefined) return p[prop];
    if (/radius$/.test(prop) && p['border-radius'] !== undefined) return p['border-radius'];
    if (/^(row|column)-gap$/.test(prop) && p.gap !== undefined) return p.gap;
    if (prop === 'text-transform' && p['font-size'] !== undefined) return 'none';
    return defaultWhenMissing(prop);
  }
  if (design.kind !== 'figma' || !design.values) return undefined;
  const key = /^border-(top|right|bottom|left)-color$/.test(prop) ? 'border-top-color'
    : /^border-(top|right|bottom|left)-width$/.test(prop) ? 'border-top-width'
      : /radius$/.test(prop) ? 'border-radius'
        : /^(row|column)-gap$/.test(prop) ? 'gap'
          : prop;
  if (p[key] !== undefined) return p[key];
  if (prop === 'letter-spacing' && p['font-size'] !== undefined) return '0px';
  if (prop === 'opacity') return '1';
  return undefined;
}

/** The design variable a node binds for a property (prototype: a traced var(); Figma: a bound variable). */
function designVarOf(node, prop) {
  const v = node?.vars ?? {};
  return v[prop] ?? (/radius$/.test(prop) ? v['border-radius'] : /gap$/.test(prop) ? v.gap : /^border-.*-color$/.test(prop) ? v['border-top-color'] : null) ?? null;
}

/** Whether an app value and a design value are the same, within the tolerances. */
export function sameValue(category, appValue, designValue, { tolerancePx = 1, colorDeltaE = DEFAULT_COLOR_DELTA_E } = {}) {
  const a = String(appValue ?? '').trim();
  const d = String(designValue ?? '').trim();
  if (a === d) return true;
  if (category === 'color') {
    const diff = colorDifference(a, d);
    return Boolean(diff) && diff.deltaE <= colorDeltaE + 1e-9 && diff.alpha <= 0.01 + 1e-9;
  }
  if (category === 'shadow') {
    const x = shadowDistance(parseShadow(a), parseShadow(d));
    return (parseShadow(a)?.length === 0 && parseShadow(d)?.length === 0) || (x.px <= tolerancePx && x.deltaE <= colorDeltaE && x.alpha <= 0.01);
  }
  if (category === 'font-family') return firstFamily(a) === firstFamily(d);
  if (category === 'font-weight') return toWeight(a) !== null && toWeight(a) === toWeight(d);
  if (category === 'opacity') return Math.abs(Number(a) - Number(d)) <= 0.01;
  const pa = toPx(a === 'normal' && category === 'letter-spacing' ? '0px' : a);
  const pd = toPx(d === 'normal' && category === 'letter-spacing' ? '0px' : d);
  if (pa === null || pd === null) return false;
  return Math.abs(Math.abs(pa) - Math.abs(pd)) <= (category === 'letter-spacing' ? Math.min(tolerancePx, 0.25) : tolerancePx) + 1e-9;
}

const TEXT_STYLE_PARTS = [['font-size', 'font-size'], ['line-height', 'line-height'], ['font-weight', 'font-weight'], ['letter-spacing', 'letter-spacing'], ['font-family', 'font-family']];

/**
 * The design's verdict on one app value. → { status: "same" | "different" | "unknown",
 * value, token, via, node } (value: the design's CSS value; token: the design-system token
 * whose value equals it, else the variable the design binds).
 */
export function designVerdict(e, prop, category, appValue, { match, design, set, tolerancePx = 1, colorDeltaE = DEFAULT_COLOR_DELTA_E }) {
  const unknown = (why) => ({ status: 'unknown', value: null, token: null, via: null, why });
  if (!design || design.kind === 'none') return unknown('no design data');
  if (design.kind === 'figma' && !design.values) return unknown('the design spec has no style values');
  const m = match(e);
  if (!m) return unknown('no design counterpart found');
  const opts = { tolerancePx, colorDeltaE };
  const verdicts = [];
  for (const node of m.nodes) {
    if (category === 'text-style') {
      const dv = {};
      for (const [p] of TEXT_STYLE_PARTS) dv[p] = designValueOf(node, p, design);
      if (dv['font-size'] === undefined) continue;
      const parts = TEXT_STYLE_PARTS.filter(([p]) => dv[p] !== undefined && e.s?.[p] !== undefined);
      const same = parts.every(([p]) => sameValue(auditCategory(p), e.s[p], dv[p], opts) || (p === 'line-height' && dv[p] === e.s[p]));
      const r = checkTextStyle(set, { ...dv, 'text-transform': designValueOf(node, 'text-transform', design) }, opts);
      verdicts.push({ status: same ? 'same' : 'different', value: textStyleValue(dv), token: r.status === 'match' ? r.style.name : null, via: m.via, node });
      continue;
    }
    const dv = designValueOf(node, prop, design);
    if (dv === undefined) continue;
    const same = sameValue(category, appValue, dv, opts);
    const r = checkValue(set, category, dv, { ...opts, fontSize: toPx(e.s?.['font-size']) ?? 16, box: node.rect });
    const dvar = designVarOf(node, prop);
    const token = dvar ? tokenForVar(set, dvar)?.name ?? dvar : r.status === 'match' ? r.token.name : null;
    verdicts.push({ status: same ? 'same' : 'different', value: String(dv).trim(), token, tokenBound: Boolean(dvar), via: m.via, node });
  }
  if (!verdicts.length) return unknown('the design counterpart has no value for this property');
  // Several design layers at one place (Figma frame + background): any that agrees settles it.
  return verdicts.find((v) => v.status === 'same') ?? verdicts[0];
}

/**
 * The design's verdict on a component member: the design shows the same raw / third-party
 * element (same), a design-system component or library instance (different, naming it),
 * or nothing that says (unknown).
 */
function componentVerdict(e, member, { match, design, designComponents }) {
  const unknown = (why) => ({ status: 'unknown', value: null, token: null, via: null, why });
  if (!design || design.kind === 'none') return unknown('no design data');
  const m = match(e);
  if (!m) return unknown('no design counterpart found');
  if (design.kind === 'figma') {
    const inst = m.nodes.find((n) => n.instance && n.component);
    return inst ? { status: 'different', value: inst.component, token: null, via: m.via, node: inst } : unknown('the design layer is not a component instance');
  }
  const node = m.nodes[0];
  const dm = designComponents?.members.find((x) => x.i === node.i);
  const de = designComponents?.perElement[node.i];
  if (dm && dm.origin === member.origin && dm.component === member.component && (dm.library ?? null) === (member.library ?? null)) return { status: 'same', value: dm.component, token: null, via: m.via, node };
  if (de?.lib && designComponents.libraries[de.lib]?.kind === 'design-system') return { status: 'different', value: de.name ?? de.lib, token: null, via: m.via, node };
  if (de?.lib && de.lib === member.library && de.name === member.component) return { status: 'same', value: de.name, token: null, via: m.via, node };
  return unknown('the design element is neither the same component nor a design-system one');
}

const TEXT_SET = ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform'];

/**
 * Audit one captured state. input: { audit (collector output), state: { id, name,
 * screen }, set (token set), libraries, catalog, image: { width, height } | null,
 * design (designSide(): the design's data, for the design check), tolerancePx,
 * colorDeltaE }. → { stats, styleMembers, componentMembers (each with .design: the
 * design's verdict), matches,
 * unchecked, libraries, unsupportedSelectors, elements }.
 */
export function auditState(input) {
  const { audit, state, set, libraries, catalog, image = null, design = null, tolerancePx = 1, colorDeltaE = DEFAULT_COLOR_DELTA_E } = input;
  const els = audit.elements ?? [];
  const opts = { tolerancePx, colorDeltaE };
  const styleMembers = [];
  const matches = new Map(); // token name → { token, verified, unverified }
  const unchecked = {};
  const verifiedVar = (e, prop) => {
    const name = e.v?.[prop];
    const t = name ? tokenForVar(set, name) : null;
    return { name: name ?? null, token: t, exact: Boolean(name && set.byVar.get(name) === t) };
  };
  const noteMatch = (token, verified) => {
    const m = matches.get(token.name) ?? { token, verified: 0, unverified: 0 };
    if (verified) m.verified += 1;
    else m.unverified += 1;
    matches.set(token.name, m);
  };
  const body = audit.bodyText ?? null;
  let pageDefault = null; // first element inheriting the page's default text
  const pageDefaultProps = new Set();
  let valuesChecked = 0;
  const useTextStyles = set.textStyles.length > 0;

  const visit = (e, prop, category, value, extra = {}) => {
    const authored = verifiedVar(e, prop);
    const r = checkValue(set, category, value, { ...opts, fontSize: toPx(e.s?.['font-size']) ?? 16, box: e.rect });
    if (r.status === 'skip') {
      if (r.why === 'no-tokens') unchecked[category] = (unchecked[category] ?? 0) + 1;
      return;
    }
    valuesChecked += 1;
    // An authored var(--token) of the design system is proof, whatever the nearest value says.
    if (authored.exact && authored.token && (set.pools[category] ?? []).includes(authored.token) && checkValue({ ...set, pools: { ...set.pools, [category]: [authored.token] } }, category, value, { ...opts, fontSize: toPx(e.s?.['font-size']) ?? 16, box: e.rect }).status === 'match') {
      styleMembers.push({ i: e.i, prop, category, value: String(value).trim(), status: 'token-used', token: authored.token, distance: 0, unit: r.unit, authoredVar: authored.name, ...extra });
      return;
    }
    if (r.status === 'match') {
      noteMatch(r.token, false);
      styleMembers.push({ i: e.i, prop, category, value: String(value).trim(), status: 'usage-unverified', token: r.token, distance: 0, unit: r.unit, authoredVar: authored.name, ...extra });
      return;
    }
    styleMembers.push({ i: e.i, prop, category, value: String(value).trim(), status: r.status, token: r.token, distance: r.distance, unit: r.unit, authoredVar: authored.name, ...extra });
  };

  for (const e of els) {
    const s = e.s ?? {};
    for (const [prop, value] of Object.entries(s)) {
      if (TEXT_SET.includes(prop) || prop === 'color') continue;
      const category = auditCategory(prop);
      if (category) visit(e, prop, category, value);
    }
    if (s['font-size'] === undefined) continue;
    // Text: colour on its own; typography as a set when the tokens define text styles.
    const inh = new Set(e.inh ?? []);
    const fromBody = (p) => body && inh.has(p) && s[p] === body[p];
    if (fromBody('color')) {
      pageDefaultProps.add('color');
      pageDefault ??= e;
    } else if (s.color !== undefined) visit(e, 'color', 'color', s.color);
    const typoFromBody = ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing'].every(fromBody);
    if (typoFromBody) {
      pageDefaultProps.add('typography');
      pageDefault ??= e;
      continue;
    }
    if (useTextStyles) {
      const r = checkTextStyle(set, s, opts);
      if (r.status === 'skip') continue;
      valuesChecked += 1;
      if (r.status === 'match') {
        noteMatch({ name: r.style.name, category: 'text-style', value: describeStyle(r.style), source: r.style.source }, false);
        styleMembers.push({ i: e.i, prop: 'font', category: 'text-style', value: textStyleValue(s), status: 'usage-unverified', token: { name: r.style.name, value: describeStyle(r.style), source: r.style.source, category: 'text-style' }, distance: 0, unit: null, authoredVar: null });
        continue;
      }
      styleMembers.push({ i: e.i, prop: 'font', category: 'text-style', value: textStyleValue(s), status: r.status, token: { name: r.style.name, value: describeStyle(r.style), size: r.style.size, source: r.style.source, category: 'text-style' }, distance: r.distance, unit: null, diffs: r.diffs, authoredVar: null });
    } else {
      for (const p of ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing']) if (s[p] !== undefined) visit(e, p, auditCategory(p), s[p]);
    }
  }
  // The page's default text, once: what every element inheriting it shows.
  if (pageDefault && body) {
    const synthetic = { ...pageDefault, s: { ...body }, v: null, inh: null };
    const before = styleMembers.length;
    if (pageDefaultProps.has('color')) visit(synthetic, 'color', 'color', body.color, { pageDefault: true });
    if (pageDefaultProps.has('typography')) {
      if (useTextStyles) {
        const r = checkTextStyle(set, body, opts);
        if (r.status !== 'skip') {
          valuesChecked += 1;
          if (r.status === 'match') {
            noteMatch({ name: r.style.name, category: 'text-style', value: describeStyle(r.style), source: r.style.source }, false);
            styleMembers.push({ i: pageDefault.i, prop: 'font', category: 'text-style', value: textStyleValue(body), status: 'usage-unverified', token: { name: r.style.name, value: describeStyle(r.style), source: r.style.source, category: 'text-style' }, distance: 0, unit: null, authoredVar: null, pageDefault: true });
          } else styleMembers.push({ i: pageDefault.i, prop: 'font', category: 'text-style', value: textStyleValue(body), status: r.status, token: { name: r.style.name, value: describeStyle(r.style), size: r.style.size, source: r.style.source, category: 'text-style' }, distance: r.distance, unit: null, diffs: r.diffs, authoredVar: null, pageDefault: true });
        }
      } else {
        for (const p of ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing']) visit(synthetic, p, auditCategory(p), body[p], { pageDefault: true });
      }
    }
    for (const m of styleMembers.slice(before)) m.pageDefault = true;
  }

  const selectorIndex = new Map((audit.selectors ?? []).filter((s) => !s.error).map((s, k) => [s.selector, (audit.selectors ?? []).indexOf(s)]));
  const unsupported = new Set();
  const comp = classifyComponents(audit, { libraries, catalog, selectorIndex, unsupported });
  // A component that is the wrong one (a candidate) carries its own styles: its values,
  // and those of the elements inside it, are not raised again as token candidates.
  const flagged = new Set(comp.members.filter((m) => m.severity).map((m) => m.i));
  const insideFlagged = (i) => {
    for (let cur = i, step = 0; cur !== null && cur !== undefined && cur >= 0 && step < 4; cur = els[cur].p, step += 1) if (flagged.has(cur)) return true;
    return false;
  };
  const before = styleMembers.length;
  let kept = styleMembers.filter((m) => !insideFlagged(m.i));
  const coveredByComponents = before - kept.length;
  // What the design does at each flagged element: same value, another value, or unknown.
  const side = design ?? designSide();
  const match = designMatcher(els, side);
  let designComponents = null;
  if (side.kind === 'prototype' && side.audit) {
    const dSel = new Map((side.audit.selectors ?? []).filter((x) => !x.error).map((x) => [x.selector, (side.audit.selectors ?? []).indexOf(x)]));
    designComponents = classifyComponents(side.audit, { libraries, catalog, selectorIndex: dSel, unsupported: new Set() });
  }
  const ctx = { match, design: side, set, tolerancePx, colorDeltaE, designComponents };
  for (const m of kept) {
    m.design = designVerdict(els[m.i], m.prop, m.category, m.value, ctx);
    if (m.status === 'token-used') {
      if (m.design.status === 'different' || (m.design.tokenBound && m.design.token && m.design.token !== m.token.name)) m.status = 'wrong-token';
      else noteMatch(m.token, true);
    }
  }
  kept = kept.filter((m) => m.status !== 'token-used');
  for (const m of comp.members) m.design = componentVerdict(els[m.i], m, ctx);
  const verdicts = [...kept, ...comp.members].map((m) => m.design.status);
  return {
    state,
    image,
    elements: els,
    regions: audit.regions ?? [],
    styleMembers: kept,
    componentMembers: comp.members,
    libraries: comp.libraries,
    matches,
    unchecked,
    unsupportedSelectors: [...unsupported],
    stats: {
      elementsChecked: els.length,
      walked: audit.stats?.walked ?? null,
      rendered: audit.stats?.rendered ?? null,
      truncated: audit.truncated ?? null,
      valuesChecked,
      coveredByComponents,
      design: {
        kind: side.kind,
        note: side.note ?? null,
        same: verdicts.filter((v) => v === 'same').length,
        different: verdicts.filter((v) => v === 'different').length,
        unknown: verdicts.filter((v) => v === 'unknown').length,
      },
      authoredVars: audit.stats?.authoredVars ?? null,
      page: audit.page ?? null,
      fullPage: audit.fullPage !== false,
    },
  };
}

/** Visible part of an element in the image: the crop, its share of the element and its area. */
function placement(e, image, els) {
  const crop = cropInImage(e.vis, image);
  if (crop) return { crop, share: area(crop) / Math.max(1, area(e.rect)), via: 'element' };
  // Scrolled out of an inner container: pin the container's visible box instead.
  const box = e.clip !== null && e.clip !== undefined ? els[e.clip] : null;
  const boxCrop = box ? cropInImage(box.vis, image) : null;
  if (boxCrop) return { crop: boxCrop, share: 0, via: 'scroll-container' };
  return { crop: null, share: -1, via: null };
}

const valueKey = (category, value) => {
  if (category === 'color') return hexOf(value) ?? one(value, 40);
  if (category === 'font-family') return kebab(firstFamily(value) ?? value);
  if (category === 'text-style') return one(value, 80).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9.#/-]/g, '');
  if (category === 'shadow') {
    const layers = parseShadow(value) ?? [];
    return layers.map((l) => `${l.inset ? 'inset-' : ''}${l.lengths.map((n) => round(n)).join('-')}-${(hexOf(l.color) ?? '').slice(1)}`).join('+') || one(value, 40);
  }
  if (category === 'font-weight') return String(toWeight(value) ?? value);
  const px = toPx(value);
  return px === null ? one(value, 40) : `${round(Math.abs(px))}px`;
};

const STYLE_TITLE_PROP = (props) => {
  const set = new Set(props.map((p) => p.replace(/-(top|right|bottom|left)(-(left|right))?(?=-|$)/g, '').replace(/^(row|column)-gap$/, 'gap')));
  return [...set].map((p) => ({ color: 'text colour', 'background-color': 'background', 'border-color': 'border colour', 'border-width': 'border width', 'border-radius': 'radius', 'box-shadow': 'shadow', font: 'text style' }[p] ?? p)).join(', ');
};

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Group state results into groups and finding candidates. results: auditState outputs;
 * ctx: { evidencePaths: (state) → { screenshot, audit } (paths relative to the report
 * folder), samples, drifts, tolerancePx, colorDeltaE }.
 * Each member carries the design's verdict (auditState): a group the design shares on
 * every component goes to designAlso; token contracts remain candidates.
 * → { groups: { tokens, components, matches }, candidates, designAlso }.
 */
export function buildCandidates(results, ctx) {
  const { evidencePaths, samples = 5, drifts = [], tolerancePx = 1, colorDeltaE = DEFAULT_COLOR_DELTA_E, rawImports = [], catalog = null } = ctx;
  const groups = new Map();
  const add = (key, base, member) => {
    if (!groups.has(key)) groups.set(key, { ...base, members: [] });
    groups.get(key).members.push(member);
  };
  for (const r of results) {
    const screen = r.state.screen ?? null;
    const prefix = screen ? `${screen}/` : '';
    const dk = r.stats?.design?.kind;
    const designSource = dk === 'figma' || dk === 'prototype' ? dk : null;
    for (const m of r.styleMembers) {
      const cat = m.category;
      const vk = valueKey(cat, m.value);
      const required = ['usage-unverified', 'wrong-token'].includes(m.status) && m.design?.tokenBound && m.design?.token ? `:required:${encodeURIComponent(m.design.token)}` : '';
      add(`${prefix}style:${cat === 'text-style' ? 'text' : cat}:${vk}${required}`, { kind: cat === 'text-style' ? 'text-style' : 'token', screen, category: cat, status: m.status, value: m.value, token: m.token, distance: m.distance, unit: m.unit, diffs: m.diffs ?? null, designSource }, { r, m });
    }
    for (const m of r.componentMembers) {
      const lib = m.library ? kebab(m.library) : m.origin === 'raw-primitive' ? 'raw' : 'native';
      const comp = kebab(m.component.replace(/[<>]/g, '').replace(/\s+type=/, '-'));
      const ds = m.ds ? `>${kebab(m.ds.component)}` : '';
      add(`${prefix}component:${lib}:${comp}${ds}`, { kind: 'component', screen, origin: m.origin, library: m.library, component: m.component, controlKind: m.kind, ds: m.ds, severity: m.severity, rawSelector: m.rawSelector ?? null, note: m.note ?? null, designSource }, { r, m });
    }
  }

  const candidates = [];
  const designAlso = [];
  const tokenGroups = [];
  const componentGroups = [];
  for (const [key, g] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // Members: one per element per state, most visible first, then top of the page first.
    const seen = new Map();
    for (const { r, m } of g.members) {
      const k = `${r.state.id}#${m.i}`;
      const prev = seen.get(k);
      if (prev) {
        if (m.prop && !prev.props.includes(m.prop)) prev.props.push(m.prop);
        continue;
      }
      const e = r.elements[m.i];
      const place = placement(e, r.image, r.elements);
      seen.set(k, { r, m, e, place, props: m.prop ? [m.prop] : [], verdicts: [] });
    }
    for (const { r, m } of g.members) seen.get(`${r.state.id}#${m.i}`).verdicts.push(m.design ?? { status: 'unknown', why: 'no design check' });
    // One verdict per element: another value anywhere decides; the same everywhere is same.
    for (const x of seen.values()) {
      x.dv = x.verdicts.find((v) => v.status === 'different') ?? (x.verdicts.every((v) => v.status === 'same') ? x.verdicts[0] : x.verdicts.find((v) => v.status === 'unknown'));
    }
    const all = [...seen.values()];
    const isCandidate = g.kind === 'component' ? g.severity !== null : ['near', 'off', 'usage-unverified', 'wrong-token'].includes(g.status);
    const tally = { same: all.filter((x) => x.dv.status === 'same').length, different: all.filter((x) => x.dv.status === 'different').length, unknown: all.filter((x) => x.dv.status === 'unknown').length };
    // Design and code agree on every element: not a parity difference, nothing to file.
    const agrees = g.kind === 'component' && isCandidate && tally.same > 0 && !tally.different && !tally.unknown;
    const chosen = g.kind !== 'component' || !isCandidate || agrees ? all : all.filter((x) => x.dv.status !== 'same');
    const designCheck = tally.different ? 'different' : tally.same && !tally.unknown ? 'same' : 'unknown';
    const list = [...chosen].sort((a, b) => b.place.share - a.place.share || area(b.place.crop) - area(a.place.crop) || a.e.rect.y - b.e.rect.y || a.e.rect.x - b.e.rect.x || a.r.state.id.localeCompare(b.r.state.id));
    const byDoc = [...chosen].sort((a, b) => a.r.state.id.localeCompare(b.r.state.id) || a.m.i - b.m.i);
    const props = [...new Set(list.flatMap((x) => x.props))].sort();
    const states = {};
    for (const x of list) states[x.r.state.id] = (states[x.r.state.id] ?? 0) + 1;
    const uniquePaths = new Set(list.map((x) => x.e.path)).size;
    const sampleList = list.slice(0, samples).map((x) => ({
      state: x.r.state.id,
      selector: x.e.path,
      text: x.e.text ? one(x.e.text, 60) : null,
      rect: x.e.rect,
      crop: x.place.crop,
      pinnedTo: x.place.via,
      region: x.e.r >= 0 ? one(x.r.regions[x.e.r], 60) : null,
      properties: x.props,
    }));
    // A real difference leads with the elements that differ from the design.
    if (designCheck === 'different') list.sort((a, b) => (a.dv.status === 'different' ? 0 : 1) - (b.dv.status === 'different' ? 0 : 1));
    const primary = list[0];
    const summaryGroup = { key, kind: g.kind, count: list.length, elements: uniquePaths, states, samples: sampleList, candidate: isCandidate && !agrees, design: tally };
    if (g.kind === 'component') {
      componentGroups.push({ ...summaryGroup, origin: g.origin, library: g.library, component: g.component, controlKind: g.controlKind, dsEquivalent: g.ds?.component ?? null, severity: g.severity });
    } else {
      tokenGroups.push({ ...summaryGroup, category: g.category, status: g.status, value: g.value, properties: props, nearest: g.token ? { name: g.token.name, value: g.token.value, source: g.token.source?.kind ?? null } : null, distance: g.distance, unit: g.unit, diffs: g.diffs, pageDefault: list.some((x) => x.m.pageDefault) });
    }
    if (agrees) {
      const d = primary.dv;
      designAlso.push({
        key,
        kind: g.kind,
        ...(g.kind === 'component' ? { component: g.component, library: g.library, origin: g.origin } : { category: g.category, properties: props }),
        value: g.kind === 'component' ? g.component : g.value,
        count: list.length,
        elements: uniquePaths,
        states,
        sample: { ...sampleList[0], design: d.node ? { selector: d.node.path || d.node.label || null, value: d.value, via: d.via } : null },
        nearest: g.token ? { name: g.token.name, value: g.token.value } : null,
      });
      continue;
    }
    if (!isCandidate) continue;
    // The design's value: the most common one among the elements that differ.
    const diffs = list.filter((x) => x.dv.status === 'different' || (g.kind !== 'component' && x.dv.token));
    const byValue = new Map();
    for (const x of diffs) byValue.set(x.dv.value, [...(byValue.get(x.dv.value) ?? []), x]);
    const dWin = [...byValue.values()].sort((a, b) => b.length - a.length || String(a[0].dv.value).localeCompare(String(b[0].dv.value)))[0]?.[0]?.dv ?? null;

    const st = primary.r.state;
    const paths = evidencePaths(st);
    const evidence = [];
    if (paths.screenshot) evidence.push({ type: 'screenshot', path: paths.screenshot, crop: primary.place.crop, state: st.id });
    if (paths.audit) evidence.push({ type: 'computed', path: paths.audit, crop: null, state: st.id });
    const region = primary.e.r >= 0 ? one(primary.r.regions[primary.e.r], 60) : 'Page';
    const n = list.length;
    const where = `${plural(n, 'element')}${Object.keys(states).length > 1 ? ` in ${Object.keys(states).length} states` : ''}`;
    let finding;
    if (g.kind === 'component') {
      const what = g.origin === 'native-control' || g.origin === 'raw-primitive' ? `Native ${g.component}` : `${g.origin === 'legacy' ? 'Legacy' : 'Third-party'} ${g.component} (${g.library})`;
      const usage = g.status === 'usage-unverified';
      const wrong = g.status === 'wrong-token';
      const title = usage
        ? `${lead} ${shown} equals ${tok.name}, but token usage is unverified on ${where}`
        : wrong
        ? `${lead} uses the wrong design token on ${where}: expected ${dWin?.token ?? tok.name}`
        : dWin
        ? `${what} renders where the design has ${dWin.value} (${where})`
        : g.ds
        ? `${what} renders where the design system has ${g.ds.component} (${where})`
        : g.origin === 'legacy'
          ? `${what} renders instead of a design-system component (${where})`
          : `${what} renders; the design system has no ${g.controlKind ?? 'matching'} component in the catalog (${where})`;
      finding = {
        title,
        ledger: 'component',
        severity: g.severity,
        resolution: 'FIX_CODE',
        region,
        element: { selector: byDoc[0].e.path, figmaLayerPath: null, figmaNodeId: null },
        property: null,
        expected: dWin
          ? { value: `${dWin.value} (design)`, token: null, source: g.designSource ?? 'prototype' }
          : { value: g.ds ? `${g.ds.component} (design system)` : 'a design-system component', token: null, source: 'design-rules' },
        actual: { value: g.origin === 'native-control' || g.origin === 'raw-primitive' ? `native ${g.component}` : `${g.component} (${g.origin}: ${g.library})`, token: null, source: { file: null, line: null, snippet: null } },
        delta: g.rawSelector ? `matches the catalog's raw primitive ${g.rawSelector}` : null,
        tolerance: null,
        fix: { summary: dWin ? `Replace ${g.component} with ${dWin.value}, as the design has it` : g.ds ? `Replace ${g.component} with the design system's ${g.ds.component}` : `Replace ${g.component} with the design-system component for it, or record why it stays`, patchHint: null, files: [], effort: 3 },
      };
      if (dWin) finding.severity = 'BLOCKER';
    } else {
      const label = g.kind === 'text-style' ? 'Text style' : `${STYLE_TITLE_PROP(props).replace(/^./, (c) => c.toUpperCase())}`;
      const shown = g.category === 'color' ? `${hexOf(g.value)}` : g.value;
      const tok = g.token;
      const dist = g.distance !== null && g.distance !== undefined && g.unit ? `${g.unit === 'ΔE' ? 'ΔE ' : ''}${g.distance}${g.unit === 'px' ? 'px' : ''}` : null;
      const pageDefault = list.some((x) => x.m.pageDefault);
      const lead = pageDefault ? `Page default ${label.toLowerCase()}` : label;
      const near = g.status === 'near';
      const dShown = dWin ? (g.category === 'color' ? hexOf(dWin.value) ?? dWin.value : dWin.value) : null;
      const nearestNote = tok && tok.name !== dWin?.token ? ` · nearest token ${tok.name}${g.category === 'color' ? ` ${hexOf(tok.value) ?? tok.value}` : g.kind === 'text-style' ? '' : ` ${tok.value}`}` : '';
      const usage = g.status === 'usage-unverified';
      const wrong = g.status === 'wrong-token';
      const title = usage
        ? `${lead} ${shown} equals ${tok.name}, but token usage is unverified on ${where}`
        : wrong
        ? `${lead} uses the wrong design token on ${where}: expected ${dWin?.token ?? tok.name}`
        : dWin
        ? `${lead} ${shown}; the design has ${dShown}${dWin.token ? ` (${dWin.token})` : ''} on ${where}${nearestNote}`
        : g.kind === 'text-style'
        ? `${lead} ${shown} matches no text style${tok ? ` (nearest ${tok.name}${g.diffs?.length ? `: ${g.diffs.join(', ')}` : ''})` : ''} on ${where}`
        : near
          ? `${lead} ${shown} is a hand-typed near miss of ${tok.name} (${dist}) on ${where}`
          : `${lead} ${shown} matches no ${CATEGORY_LABEL[g.category] ?? g.category} token${tok ? ` (nearest ${tok.name} ${g.category === 'color' ? hexOf(tok.value) ?? tok.value : tok.value}${dist ? `, ${dist}` : ''})` : ''} on ${where}`;
      // Defined tokens are implementation contracts, including recurring deviations.
      const severity = 'WARNING';
      const cssVar = tok?.vars?.find((v) => v.startsWith('--')) ?? (tok?.name?.startsWith('--') ? tok.name : null);
      const authored = list.map((x) => x.m.authoredVar).find(Boolean) ?? null;
      // One property, or the shorthand its longhands share (padding-top + padding-left → padding).
      const family = (p) => p.replace(/^(padding|margin)-(top|right|bottom|left)$/, '$1').replace(/^border-(top|right|bottom|left)-(width|color)$/, 'border-$2').replace(/^border-(top|bottom)-(left|right)-radius$/, 'border-radius').replace(/^(row|column)-gap$/, 'gap');
      const families = [...new Set(props.map(family))];
      const property = g.kind === 'text-style' ? 'font' : props.length === 1 ? props[0] : families.length === 1 ? families[0] : props.find((p) => p === 'color') ?? props[0];
      finding = {
        title,
        ledger: 'style',
        severity,
        resolution: 'FIX_CODE',
        region,
        element: { selector: byDoc[0].e.path, figmaLayerPath: null, figmaNodeId: null },
        property,
        expected: dWin
          ? { value: dWin.value, token: dWin.token ?? null, source: g.designSource ?? 'prototype' }
          : { value: tok ? tok.value : null, token: tok?.name ?? null, source: 'design-rules' },
        actual: { value: g.value, token: authored, source: { file: null, line: null, snippet: null } },
        delta: usage ? '0 visual difference; token usage not proven' : dWin ? `${shown} in the app, ${dShown} in the design` : dist ? `${dist} from ${tok.name}` : g.diffs?.length ? g.diffs.join(', ') : null,
        tolerance: g.category === 'color' ? `ΔE ${colorDeltaE}` : g.unit === 'px' ? `${g.category === 'letter-spacing' ? Math.min(tolerancePx, 0.25) : tolerancePx}px` : g.kind === 'text-style' ? `${tolerancePx}px per length` : 'exact',
        fix: {
          summary: usage
            ? `Trace ${property} to source and use ${dWin?.token ?? tok.name}; a matching literal is not token compliance`
            : dWin
            ? `Match the design: ${dWin.token ? `use ${dWin.token} (${dShown})` : `use ${dShown}`} instead of ${shown}`
            : tok ? `Use ${tok.name} instead of the hardcoded ${shown}` : `Replace the hardcoded ${shown} with a design-system token`,
          patchHint: dWin
            ? (dWin.token ? dWin.token.startsWith('--') && g.kind !== 'text-style' ? `${property}: var(${dWin.token})` : `apply ${dWin.token}` : 'Identify and apply the intended design-system token; do not copy a literal')
            : cssVar && g.kind !== 'text-style' ? `${property}: var(${cssVar})` : tok ? `apply ${tok.name}` : null,
          files: [],
          effort: 2,
        },
      };
    }
    if (st.screen) finding.screen = st.screen;
    const pinned = evidence.some((ev) => ev.crop);
    const result = {
      key,
      ...finding,
      state: st.id,
      evidence,
      signoff: null,
      knownDrift: null,
      acRef: null,
      ...(pinned ? {} : { unpinnedReason: paths.screenshot ? `Every element of this group lies outside the ${st.id} screenshot (scrolled out of view or below the captured area); recapture the whole page.` : `There is no app screenshot for ${st.id}, so nothing on a capture marks these elements.` }),
      _audit: {
        kind: g.kind === 'component' ? 'component' : g.status === 'usage-unverified' ? 'token-usage' : g.status === 'wrong-token' ? 'wrong-token' : g.kind === 'text-style' ? 'text-style' : g.status === 'near' ? 'near-miss' : 'off-token',
        tokenRequired: g.kind !== 'component',
        usageUnverified: g.status === 'usage-unverified',
        count: n,
        elements: uniquePaths,
        states,
        samples: sampleList,
        ...(g.kind === 'component'
          ? { origin: g.origin, library: g.library, component: g.component, controlKind: g.controlKind, dsEquivalent: g.ds?.component ?? null }
          : { category: g.category, properties: props, nearest: g.token ? { name: g.token.name, value: g.token.value, source: g.token.source?.kind ?? null } : null, distance: g.distance, unit: g.unit }),
        designCheck,
        designValue: dWin ? dWin.value : 'unknown',
        designToken: dWin?.token ?? null,
        designTokenBound: Boolean(dWin?.tokenBound),
        design: { ...tally, source: g.designSource ?? null },
        ...(dWin ? {} : { designHint: g.kind === 'component' ? 'Check the design before filing this component candidate.' : 'Verify the intended semantic token in design and source. Matching the design visually does not waive the token contract.' }),
        knownDriftHint: null,
      },
    };
    const actualStrings = g.kind === 'component' ? [g.component, g.library] : g.category === 'color' ? [hexOf(g.value), g.value] : [g.kind === 'text-style' ? `${round(toPx(primary.e.s?.['font-size']) ?? 0)}px` : g.value];
    const expectedStrings = dWin ? [dWin.value, dWin.token] : g.kind === 'component' ? [g.ds?.component] : [g.token?.name?.replace(/^--/, ''), g.token?.name, g.kind === 'text-style' && g.token?.size !== undefined ? `${round(g.token.size)}px` : g.token?.value];
    result._audit.knownDriftHint = knownDriftHint(drifts, { actual: actualStrings, expected: expectedStrings.filter(Boolean) });
    candidates.push(result);
  }
  candidates.push(...sourceCandidates(rawImports, { catalog, states: [...new Set(results.map((r) => r.state.id))] }));
  // Keys are unique by construction (screen + category + value, or the substitution);
  // a collision (two values folding to one key) gets a deterministic ~2, ~3 suffix.
  const used = new Map();
  for (const c of candidates) {
    const n = (used.get(c.key) ?? 0) + 1;
    used.set(c.key, n);
    if (n > 1) c.key = `${c.key}~${n}`;
  }
  const order = { BLOCKER: 0, WARNING: 1, DS_CANDIDATE: 2 };
  candidates.sort((a, b) => order[a.severity] - order[b.severity] || (a.ledger === b.ledger ? 0 : a.ledger === 'component' ? -1 : 1) || b._audit.count - a._audit.count || a.key.localeCompare(b.key));
  const matchList = [];
  for (const r of results) {
    for (const [name, m] of r.matches) {
      const cur = matchList.find((x) => x.token === name);
      if (cur) {
        cur.verified += m.verified;
        cur.unverified += m.unverified;
      } else matchList.push({ token: name, category: m.token.category, value: m.token.value, source: m.token.source?.kind ?? null, verified: m.verified, unverified: m.unverified });
    }
  }
  matchList.sort((a, b) => b.verified + b.unverified - (a.verified + a.unverified) || a.token.localeCompare(b.token));
  designAlso.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return { groups: { tokens: tokenGroups, components: componentGroups, matches: matchList }, candidates, designAlso };
}

/** Counts audited property/state observations, not pixels or unique source declarations. */
export function tokenComplianceSummary(results) {
  const verified = results.reduce((n, r) => n + [...r.matches.values()].reduce((v, m) => v + m.verified, 0), 0);
  const members = results.flatMap((r) => r.styleMembers);
  const unverified = members.filter((m) => m.status === 'usage-unverified').length;
  const deviations = members.length - unverified;
  return { tokenChecks: verified + members.length, tokenUsageVerified: verified, tokenUsageUnverified: unverified, tokenDeviationChecks: deviations };
}
