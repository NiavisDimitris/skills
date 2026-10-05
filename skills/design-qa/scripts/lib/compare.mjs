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

// ---------------------------------------------------------------------------
// Colours: every CSS Color 4 syntax Chrome can return as a computed value (hex, rgb(),
// hsl(), hwb(), lab(), lch(), oklab(), oklch(), color(<space> …), named), converted to
// CIELAB (D50, as CSS lab()) and compared with CIEDE2000. Matrices: CSS Color 4.
// ---------------------------------------------------------------------------

/** Default colour tolerance: ΔE (CIEDE2000), as tolerances.colorDeltaE. */
export const DEFAULT_COLOR_DELTA_E = 1.5;
/** Allowed alpha difference between two colours (0–1). */
export const ALPHA_TOLERANCE = 0.01;

const mul = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const SRGB_TO_XYZ = [
  [0.41239079926595934, 0.357584339383878, 0.1804807884018343],
  [0.21263900587151027, 0.715168678767756, 0.07219231536073371],
  [0.01933081871559182, 0.11919477979462598, 0.9505321522496607],
];
const XYZ_TO_SRGB = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
];
const P3_TO_XYZ = [
  [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
  [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
  [0, 0.04511338185890264, 1.043944368900976],
];
const A98_TO_XYZ = [
  [0.5766690429101305, 0.1855582379065463, 0.1882286462349947],
  [0.29734497525053605, 0.6273635662554661, 0.0752914584939978],
  [0.02703136138641234, 0.07068885253582723, 0.9913375368376388],
];
const REC2020_TO_XYZ = [
  [0.6369580483012914, 0.14461690358620832, 0.1688809751641721],
  [0.2627002120112671, 0.6779980715188708, 0.05930171646986196],
  [0, 0.028072693049087428, 1.060985057710791],
];
const PROPHOTO_TO_XYZ_D50 = [
  [0.7977604896723027, 0.13518583717574031, 0.0313493495815248],
  [0.2880711282292934, 0.7118432178101014, 0.00008565396060525902],
  [0, 0, 0.8251046025104601],
];
const D65_TO_D50 = [
  [1.0479298208405488, 0.022946793341019088, -0.05019222954313557],
  [0.029627815688159344, 0.990434484573249, -0.01707382502938514],
  [-0.009243058152591178, 0.015055144896577895, 0.7518742899580008],
];
const D50_TO_D65 = [
  [0.9554734527042182, -0.023098536874261423, 0.0632593086610217],
  [-0.028369706963208136, 1.0099954580058226, 0.021041398966943008],
  [0.012314001688319899, -0.020507696433477912, 1.3303659366080753],
];
const LMS_TO_XYZ = [
  [1.2268798758459243, -0.5578149944602171, 0.2813910456659647],
  [-0.0405757452148008, 1.112286803280317, -0.0717110580655164],
  [-0.0763729366746601, -0.4214933324022432, 1.5869240198367816],
];
const D50_WHITE = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];
const LAB_E = 216 / 24389;
const LAB_K = 24389 / 27;

const signed = (f) => (v) => Math.sign(v) * f(Math.abs(v));
const srgbToLinear = signed((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
const linearToSrgb = signed((v) => (v > 0.0031308 ? 1.055 * v ** (1 / 2.4) - 0.055 : 12.92 * v));
const a98ToLinear = signed((v) => v ** (563 / 256));
const prophotoToLinear = signed((v) => (v <= 16 / 512 ? v / 16 : v ** 1.8));
const rec2020ToLinear = signed((v) => {
  const a = 1.09929682680944;
  const b = 0.018053968510807;
  return v < b * 4.5 ? v / 4.5 : ((v + a - 1) / a) ** (1 / 0.45);
});

function xyzD50ToLab(xyz) {
  const f = (t) => (t > LAB_E ? Math.cbrt(t) : (LAB_K * t + 16) / 116);
  const [fx, fy, fz] = xyz.map((v, i) => f(v / D50_WHITE[i]));
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function labToXyzD50([L, a, b]) {
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const inv = (f) => (f ** 3 > LAB_E ? f ** 3 : (116 * f - 16) / LAB_K);
  return [inv(fx), L > LAB_K * LAB_E ? fy ** 3 : L / LAB_K, inv(fz)].map((v, i) => v * D50_WHITE[i]);
}
const fromXyzD65 = (xyz) => ({ srgb: mul(XYZ_TO_SRGB, xyz).map(linearToSrgb), lab: xyzD50ToLab(mul(D65_TO_D50, xyz)) });
const fromXyzD50 = (xyz) => ({ srgb: mul(XYZ_TO_SRGB, mul(D50_TO_D65, xyz)).map(linearToSrgb), lab: xyzD50ToLab(xyz) });
const fromSrgb = (rgb) => ({ srgb: rgb, lab: xyzD50ToLab(mul(D65_TO_D50, mul(SRGB_TO_XYZ, rgb.map(srgbToLinear)))) });
const fromLab = (lab) => ({ srgb: fromXyzD50(labToXyzD50(lab)).srgb, lab });
const polar = (l, c, h) => [l, c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)];
function fromOklab([L, a, b]) {
  const lms = [L + 0.3963377773761749 * a + 0.2158037573099136 * b, L - 0.1055613458156586 * a - 0.0638541728258133 * b, L - 0.0894841775298119 * a - 1.2914855480194092 * b];
  return fromXyzD65(mul(LMS_TO_XYZ, lms.map((v) => v ** 3)));
}
function hslToSrgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}
function hwbToSrgb(h, w, b) {
  if (w + b >= 1) return [w / (w + b), w / (w + b), w / (w + b)];
  return hslToSrgb(h, 1, 0.5).map((c) => c * (1 - w - b) + w);
}

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/;
const num = (s) => (NUMBER_RE.test(s) ? Number(s) : NaN);
/** A colour component: "none" → 0, "50%" → 0.5 × percentRef, else the number. */
function component(token, percentRef) {
  if (token === 'none') return 0;
  return token.endsWith('%') ? (num(token.slice(0, -1)) / 100) * percentRef : num(token);
}
/** A hue in degrees (deg, rad, grad, turn or a bare number), 0–360. */
function hue(token) {
  if (token === 'none') return 0;
  const m = /^(.*?)(deg|rad|grad|turn)?$/.exec(token);
  const n = num(m[1]);
  const deg = m[2] === 'rad' ? (n * 180) / Math.PI : m[2] === 'grad' ? n * 0.9 : m[2] === 'turn' ? n * 360 : n;
  return ((deg % 360) + 360) % 360;
}
const alphaOf = (token) => (token === undefined ? 1 : clamp(component(token, 1), 0, 1));

const RGB_SPACES = {
  srgb: (c) => fromSrgb(c),
  'srgb-linear': (c) => fromXyzD65(mul(SRGB_TO_XYZ, c)),
  'display-p3': (c) => fromXyzD65(mul(P3_TO_XYZ, c.map(srgbToLinear))),
  'a98-rgb': (c) => fromXyzD65(mul(A98_TO_XYZ, c.map(a98ToLinear))),
  'prophoto-rgb': (c) => fromXyzD50(mul(PROPHOTO_TO_XYZ_D50, c.map(prophotoToLinear))),
  rec2020: (c) => fromXyzD65(mul(REC2020_TO_XYZ, c.map(rec2020ToLinear))),
  xyz: (c) => fromXyzD65(c),
  'xyz-d65': (c) => fromXyzD65(c),
  'xyz-d50': (c) => fromXyzD50(c),
};

/** A colour function's components → { srgb: [0–1 floats, unclamped], lab } or null. */
function colorFunction(fn, args) {
  const [x, y, z] = args;
  switch (fn) {
    case 'rgb':
    case 'rgba': {
      const c = args.map((t) => clamp(component(t, 255), 0, 255));
      return c.every(Number.isFinite) ? { ...fromSrgb(c.map((v) => v / 255)), legacy: c } : null;
    }
    case 'hsl':
    case 'hsla':
    case 'hwb': {
      // Saturation, lightness, whiteness and blackness: "50%" or a bare 0–100 number.
      const pct = (t) => clamp(t === 'none' ? 0 : component(t.endsWith('%') ? t : `${t}%`, 1), 0, 1);
      const [h, s, l] = [hue(x), pct(y), pct(z)];
      if (![h, s, l].every(Number.isFinite)) return null;
      return fromSrgb(fn === 'hwb' ? hwbToSrgb(h, s, l) : hslToSrgb(h, s, l));
    }
    case 'lab': {
      const lab = [clamp(component(x, 100), 0, 100), component(y, 125), component(z, 125)];
      return lab.every(Number.isFinite) ? fromLab(lab) : null;
    }
    case 'lch': {
      const lch = [clamp(component(x, 100), 0, 100), Math.max(0, component(y, 150)), hue(z)];
      return lch.every(Number.isFinite) ? fromLab(polar(...lch)) : null;
    }
    case 'oklab': {
      const lab = [clamp(component(x, 1), 0, 1), component(y, 0.4), component(z, 0.4)];
      return lab.every(Number.isFinite) ? fromOklab(lab) : null;
    }
    case 'oklch': {
      const lch = [clamp(component(x, 1), 0, 1), Math.max(0, component(y, 0.4)), hue(z)];
      return lch.every(Number.isFinite) ? fromOklab(polar(...lch)) : null;
    }
    default:
      return null;
  }
}

/**
 * Any CSS colour → { rgba: [r, g, b, a] (0–255 integers clamped to sRGB, alpha 0–1),
 * lab: [L, a, b] (CIELAB D50, unclamped: a display-p3 red keeps its wider chroma),
 * alpha, inGamut } or null.
 */
export function parseColorDetailed(value) {
  const s = String(value ?? '').trim().toLowerCase();
  let parsed = null;
  let alpha = 1;
  if (NAMED_COLORS[s]) {
    const [r, g, b, a] = NAMED_COLORS[s];
    parsed = { ...fromSrgb([r / 255, g / 255, b / 255]), legacy: [r, g, b] };
    alpha = a;
  } else if (/^#[0-9a-f]{3,8}$/.test(s)) {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    parsed = { ...fromSrgb([n(0) / 255, n(2) / 255, n(4) / 255]), legacy: [n(0), n(2), n(4)] };
    alpha = h.length === 8 ? n(6) / 255 : 1;
  } else {
    const m = /^([a-z0-9-]+)\(\s*([^()]*?)\s*\)$/.exec(s);
    if (!m) return null;
    const [, fn, body] = m;
    const [main, alphaPart, ...rest] = body.split('/');
    if (rest.length || (alphaPart !== undefined && !alphaPart.trim())) return null;
    let args = main.trim().split(/[\s,]+/).filter(Boolean);
    let alphaToken = alphaPart?.trim();
    if (alphaToken === undefined && /^(rgba?|hsla?)$/.test(fn) && args.length === 4) alphaToken = args.pop();
    if (fn === 'color') {
      const space = RGB_SPACES[args[0]];
      args = args.slice(1);
      if (!space || args.length !== 3) return null;
      const c = args.map((t) => component(t, 1));
      parsed = c.every(Number.isFinite) ? space(c) : null;
    } else {
      parsed = args.length === 3 ? colorFunction(fn, args) : null;
    }
    alpha = alphaOf(alphaToken);
    if (!Number.isFinite(alpha)) return null;
  }
  if (!parsed || !parsed.lab.every(Number.isFinite)) return null;
  const eps = 0.5 / 255;
  const inGamut = parsed.legacy !== undefined || parsed.srgb.every((c) => c >= -eps && c <= 1 + eps);
  const rgb = parsed.legacy ?? parsed.srgb.map((c) => c * 255);
  return {
    rgba: [...rgb.map((c) => clamp(Math.round(c), 0, 255)), clamp(round(alpha, 3), 0, 1)],
    lab: parsed.lab,
    alpha: clamp(alpha, 0, 1),
    inGamut,
  };
}

/** Any CSS colour → [r, g, b, a] (0–255, clamped to sRGB; alpha 0–1) or null. */
export function parseColor(value) {
  return parseColorDetailed(value)?.rgba ?? null;
}

/** Canonical "rgba(r,g,b,a)" for any colour syntax (clamped to sRGB); null when not a colour. */
export function canonicalColor(value) {
  const c = parseColor(value);
  return c ? `rgba(${c[0]},${c[1]},${c[2]},${c[3]})` : null;
}

/** CIEDE2000 colour difference of two CIELAB colours [L, a, b]. */
export function deltaE2000([L1, a1, b1], [L2, a2, b2]) {
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;
  const p7 = (c) => Math.sqrt(c ** 7 / (c ** 7 + 25 ** 7));
  const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - p7(cBar));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1 = Math.hypot(a1p, b1);
  const c2 = Math.hypot(a2p, b2);
  const h = (b, a) => (b === 0 && a === 0 ? 0 : (deg(Math.atan2(b, a)) + 360) % 360);
  const h1 = h(b1, a1p);
  const h2 = h(b2, a2p);
  let dh = 0;
  if (c1 * c2 !== 0) dh = Math.abs(h2 - h1) <= 180 ? h2 - h1 : h2 - h1 > 180 ? h2 - h1 - 360 : h2 - h1 + 360;
  const dL = L2 - L1;
  const dC = c2 - c1;
  const dH = 2 * Math.sqrt(c1 * c2) * Math.sin(rad(dh / 2));
  const lBar = (L1 + L2) / 2;
  const cpBar = (c1 + c2) / 2;
  let hBar = h1 + h2;
  if (c1 * c2 !== 0) hBar = Math.abs(h1 - h2) <= 180 ? (h1 + h2) / 2 : h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2;
  const t = 1 - 0.17 * Math.cos(rad(hBar - 30)) + 0.24 * Math.cos(rad(2 * hBar)) + 0.32 * Math.cos(rad(3 * hBar + 6)) - 0.2 * Math.cos(rad(4 * hBar - 63));
  const dTheta = 30 * Math.exp(-(((hBar - 275) / 25) ** 2));
  const rT = -Math.sin(rad(2 * dTheta)) * 2 * p7(cpBar);
  const sL = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sC = 1 + 0.045 * cpBar;
  const sH = 1 + 0.015 * cpBar * t;
  return Math.sqrt((dL / sL) ** 2 + (dC / sC) ** 2 + (dH / sH) ** 2 + rT * (dC / sC) * (dH / sH));
}

/**
 * Difference of two CSS colours: { deltaE (CIEDE2000), alpha (absolute difference) },
 * or null when either is not a colour. Two fully transparent colours are equal (ΔE 0)
 * whatever their RGB.
 */
export function colorDifference(x, y) {
  const cx = parseColorDetailed(x);
  const cy = parseColorDetailed(y);
  if (!cx || !cy) return null;
  const transparent = cx.alpha < 0.0005 && cy.alpha < 0.0005;
  return { deltaE: transparent ? 0 : deltaE2000(cx.lab, cy.lab), alpha: Math.abs(cx.alpha - cy.alpha) };
}

/** Whether two colours match: ΔE ≤ maxDeltaE and alpha within ALPHA_TOLERANCE; null when either is not a colour. */
export function colorsMatch(x, y, maxDeltaE = DEFAULT_COLOR_DELTA_E) {
  const diff = colorDifference(x, y);
  if (!diff) return null;
  return diff.deltaE <= maxDeltaE + 1e-9 && diff.alpha <= ALPHA_TOLERANCE + 1e-9;
}

const COLOR_RE = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|\b(?:transparent|black|white)\b/gi;
const WEIGHTS = { normal: '400', bold: '700' };

/**
 * Canonical form of a computed value: colours → rgba() (only colours inside the sRGB
 * gamut: a wider display-p3 or oklch colour keeps its own syntax so it is never clipped
 * onto another), seconds → ms, quotes and spacing removed. { canonicalColors: false }
 * keeps every colour as written (lower-cased) for a ΔE comparison at full precision.
 */
export function normalizeValue(property, value, { canonicalColors = true } = {}) {
  if (value === null || value === undefined) return '';
  let s = String(value).trim().toLowerCase();
  if (property === 'font-weight' && WEIGHTS[s]) return WEIGHTS[s];
  if (/timing-function$|^easing$/.test(property ?? '')) return splitCssList(s).map((e) => normalizeEasing(e)).join(',');
  if (canonicalColors) {
    s = s.replace(COLOR_RE, (m) => {
      const c = parseColorDetailed(m);
      return c?.inGamut ? `rgba(${c.rgba.join(',')})` : m;
    });
  }
  s = s.replace(/(^|[\s,(])(-?\d*\.?\d+)s\b/g, (_, pre, n) => `${pre}${round(Number(n) * 1000, 2)}ms`);
  s = s.replace(/["']/g, '').replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ');
  return s;
}

const NUM_RE = /^(-?\d*\.?\d+)(px|ms|%|deg|em|rem)?$/;

/**
 * Top-level tokens of a normalised value: words, numbers, "," and "/" separators, and
 * whole function calls with balanced parentheses ("oklch(0.5 0.2 270 / 0.4)",
 * "linear-gradient(…)").
 */
export function splitTokens(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === ',' || ch === '/') {
      out.push(ch);
      i += 1;
      continue;
    }
    let j = i;
    while (j < s.length && !/[\s,/()]/.test(s[j])) j += 1;
    if (s[j] === '(') {
      let depth = 0;
      for (; j < s.length; j += 1) {
        if (s[j] === '(') depth += 1;
        else if (s[j] === ')' && --depth === 0) break;
      }
      j = Math.min(j + 1, s.length);
    } else if (j === i) {
      j = i + 1; // a stray ")"
    }
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

const singleNumber = (s) => {
  const m = NUM_RE.exec(s);
  return m ? { n: Number(m[1]), unit: m[2] ?? '' } : null;
};

function tokensMatch(x, y, tol) {
  if (x === y) return true;
  const colors = colorsMatch(x, y, tol.colorDeltaE);
  if (colors !== null) return colors;
  const nx = singleNumber(x);
  const ny = singleNumber(y);
  if (nx && ny && nx.unit === ny.unit) {
    const t = nx.unit === 'px' ? tol.tolerancePx : nx.unit === 'ms' ? tol.toleranceMs : 0.001;
    return Math.abs(nx.n - ny.n) <= t;
  }
  // The same function on both sides (a gradient, a transform): compare its arguments.
  const fx = /^([a-z-]*)\((.*)\)$/s.exec(x);
  const fy = /^([a-z-]*)\((.*)\)$/s.exec(y);
  if (fx && fy && fx[1] === fy[1]) return listsMatch(splitTokens(fx[2]), splitTokens(fy[2]), tol);
  return false;
}
const listsMatch = (xs, ys, tol) => xs.length === ys.length && xs.every((x, i) => tokensMatch(x, ys[i], tol));

/**
 * Compare two computed values: { result: "PASS"|"FAIL", delta, deltaE? }.
 * px within tolerancePx, ms within toleranceMs, other numbers within 0.001. Colours (any
 * CSS syntax, also inside shadows, borders, outlines and gradients) match when their
 * CIEDE2000 ΔE ≤ colorDeltaE and alpha is within 0.01; two fully transparent colours
 * match whatever their RGB.
 * delta: app − design for single numeric values (number), else null. deltaE (2 decimals)
 * only when both values are a single colour.
 */
export function compareValues(property, design, app, { tolerancePx = 1, toleranceMs = 1, colorDeltaE = DEFAULT_COLOR_DELTA_E } = {}) {
  const d = normalizeValue(property, design);
  const a = normalizeValue(property, app);
  const sd = singleNumber(d);
  const sa = singleNumber(a);
  const delta = sd && sa && sd.unit === sa.unit ? round(sa.n - sd.n, 3) : null;
  const color = colorDifference(design, app);
  const out = (result) => (color ? { result, delta, deltaE: round(color.deltaE, 2) } : { result, delta });
  if (d === a) return out('PASS');
  const raw = (v) => splitTokens(normalizeValue(property, v, { canonicalColors: false }));
  return out(listsMatch(raw(design), raw(app), { tolerancePx, toleranceMs, colorDeltaE }) ? 'PASS' : 'FAIL');
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

const validBox = (r) => r && typeof r === 'object' && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(r[k]));

/** A getAnimations() entry as a motion spec. */
export function motionFromRuntime(entry) {
  const base = {
    durationMs: typeof entry.durationMs === 'number' ? round(entry.durationMs, 2) : null,
    easing: normalizeEasing(entry.easing),
    delayMs: typeof entry.delayMs === 'number' ? round(entry.delayMs, 2) : 0,
    source: 'runtime',
    target: entry.target ?? null,
    // The element's recorded path and box (captures since 0.2.2), to pin a finding on it.
    at: typeof entry.selector === 'string' && entry.selector ? { selector: entry.selector, rect: validBox(entry.rect) ? entry.rect : null } : null,
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
  // A running animation on an element that was not grabbed: where it runs (app side first).
  const at = observed?.at ?? expected?.at ?? null;
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
      ...(at ? { target: { side: observed?.at ? 'app' : 'design', ...at } } : {}),
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

/**
 * Pair design and app samples of one element class: same text first, then the remaining
 * samples of both sides in order (the texts may be data). counts: { dCount, aCount }, the
 * number of elements each side's selector matched (the capture's `count`). When a side
 * matched more elements than it sampled (the grab limit), a leftover on the other side
 * may be one of the unsampled elements: it is notSampled (CANNOT_VERIFY), not missing or
 * extra. → { pairs: [{ d, a, dIndex, aIndex, notSampled }], extra: [{ a, aIndex, notSampled }] }.
 */
export function pairSamples(dSamples = [], aSamples = [], { dCount = null, aCount = null } = {}) {
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
    pairs.push({ d, a: aSamples[j], dIndex: i, aIndex: j, notSampled: false });
  });
  const leftA = aSamples.map((_, j) => j).filter((j) => !usedA.has(j));
  const truncated = (count, samples) => typeof count === 'number' && count > samples.length;
  dSamples.forEach((d, i) => {
    if (pairedD.has(i)) return;
    if (!leftA.length) {
      pairs.push({ d, a: null, dIndex: i, aIndex: null, notSampled: truncated(aCount, aSamples) });
      return;
    }
    const j = leftA.shift();
    usedA.add(j);
    pairs.push({ d, a: aSamples[j], dIndex: i, aIndex: j, notSampled: false });
  });
  pairs.sort((x, y) => x.dIndex - y.dIndex);
  const extra = aSamples.map((a, j) => (usedA.has(j) ? null : { a, aIndex: j, notSampled: truncated(dCount, dSamples) })).filter(Boolean);
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
 * colorDeltaE, durationToleranceMs }.
 * → { style, tokens, components, motion, structure }.
 */
export function compareState(input) {
  const { state, design, app, tokenMap = {}, tokenCategories = null, catalog = null, tolerancePx = 1, colorDeltaE = DEFAULT_COLOR_DELTA_E, durationToleranceMs = 20 } = input;
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
    const { pairs, extra } = pairSamples(dEntry.samples, aEntry.samples, { dCount: dEntry.count, aCount: aEntry.count });
    const sampledNote = (entry, side) => `not sampled in the ${side}: its selector matched ${entry.count} elements and only the first ${entry.samples.length} were captured (raise the grab limit to compare it)`;
    for (const { d, a, dIndex, aIndex, notSampled } of pairs) {
      const selector = a?.__el?.selector ?? d?.__el?.selector ?? dEntry.selector;
      // The design's text names the element across states (the app's may be data).
      const text = d.__el?.text ?? null;
      grabbedSelectors.design.add(motionSample(design, cls, dIndex)?.__selector);
      if (a) grabbedSelectors.app.add(motionSample(app, cls, aIndex)?.__selector);
      const dVisible = d.__visible !== false;
      const aVisible = a ? a.__visible !== false : false;
      if (notSampled) {
        // The app has more elements than it sampled: this one is probably among them.
        if (dVisible) out.structure.push({ state, source: 'computed', elementClass: cls, index: dIndex, selector, text, design: 'present', app: 'not sampled', result: 'CANNOT_VERIFY', note: sampledNote(aEntry, 'app') });
        continue;
      }
      if (dVisible && !aVisible) {
        out.structure.push({ state, source: 'computed', elementClass: cls, index: dIndex, selector, text: d.__el?.text ?? null, design: 'present', app: a ? 'hidden' : 'missing', result: 'FAIL', note: a ? 'hidden in app' : 'missing in app' });
      } else if (!dVisible && aVisible) {
        out.structure.push({ state, source: 'computed', elementClass: cls, index: dIndex, selector, text: a.__el?.text ?? null, design: 'hidden', app: 'present', result: 'FAIL', note: 'extra in app: visible in the app, hidden in the design' });
      }
      if (dVisible && aVisible) {
        for (const prop of propsOf(d)) {
          if (!(prop in a)) continue;
          if (d[prop] === '' && a[prop] === '') continue;
          const { result, delta, deltaE } = compareValues(prop, d[prop], a[prop], { tolerancePx, toleranceMs: 1, colorDeltaE });
          out.style.push({ state, elementClass: cls, index: dIndex, selector, text, property: prop, design: d[prop], app: a[prop], delta, ...(deltaE === undefined ? {} : { deltaE }), result });
          // A colour within ΔE but not identical is still traced: a near-miss value that no
          // token produces is a hand-typed colour (a hardcoded token row, the style row passes).
          const nearMiss = result === 'PASS' && deltaE > 0;
          if (result !== 'FAIL' && !nearMiss) continue;
          // __vars are root tokens whose value equals the computed value, so they get the
          // same category filter: a value is never traced to a token of another kind.
          const dCtx = { tokens: dTokens, categories: tokenCategories };
          const aCtx = { tokens: aTokens, categories: tokenCategories };
          const expectedToken = pickToken(d.__vars?.[prop], prop, dCtx) ?? tokenForValue(dTokens, prop, d[prop], dCtx);
          if (!expectedToken) continue;
          const actualToken = pickToken(a.__vars?.[prop], prop, aCtx) ?? tokenForValue(aTokens, prop, a[prop], aCtx);
          if (nearMiss && actualToken) continue;
          out.tokens.push({
            state, elementClass: cls, index: dIndex, selector, text, property: prop,
            expectedToken, expectedValue: d[prop], actualToken: actualToken ?? null, actualValue: a[prop], result: 'FAIL',
            note: actualToken
              ? `uses ${actualToken} instead of ${expectedToken}`
              : `hardcoded value: no token resolves to ${a[prop]}${nearMiss ? ` (within ΔE ${deltaE} of the design)` : ''}; use ${expectedToken}`,
          });
        }
        const di = componentIdentity(d.__el, catalog);
        if (di) {
          const ai = componentIdentity(a.__el, catalog);
          const ok = ai && ai.component === di.component && (di.variant === null || ai.variant === di.variant);
          out.components.push({ state, elementClass: cls, index: dIndex, selector, text, design: di, app: ai, result: ok ? 'PASS' : 'FAIL' });
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
    for (const { a, aIndex, notSampled } of extra) {
      if (a.__visible === false) continue;
      const row = { state, source: 'computed', elementClass: cls, index: aIndex, selector: a.__el?.selector ?? aEntry.selector, text: a.__el?.text ?? null };
      // The design has more elements than it sampled: this one may be among them.
      if (notSampled) out.structure.push({ ...row, design: 'not sampled', app: 'present', result: 'CANNOT_VERIFY', note: sampledNote(dEntry, 'design') });
      else out.structure.push({ ...row, design: 'missing', app: 'present', result: 'FAIL', note: 'extra in app' });
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

// The same element = same element class, index, selector and (design) text: the empty
// state's heading at index 0 is not the with-data heading at index 0.
const elementKey = (r) => [r.elementClass, r.index, r.selector ?? null, r.text ?? null];
const REPEAT_KEYS = {
  style: (r) => [...elementKey(r), r.property, r.design, r.app],
  tokens: (r) => [...elementKey(r), r.property, r.expectedValue, r.actualValue],
  components: (r) => [...elementKey(r), JSON.stringify(r.design), JSON.stringify(r.app)],
  structure: (r) => [r.source, ...elementKey(r), r.role ?? null, r.name ?? null, r.design, r.app],
};

/**
 * Drop FAIL rows that repeat an earlier state's row with the same element (element
 * class, index, selector and text), property and values (a padding drift seen in
 * with-data shows again in hover): one difference, one row. State-specific differences
 * keep their rows. Returns { dropped } and mutates states.
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
    style: { pass: count(all('style'), (r) => r.result === 'PASS'), fail: count(all('style'), (r) => r.result === 'FAIL'), cannotVerify: count(all('style'), (r) => r.result === 'CANNOT_VERIFY') },
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
      fail: count(all('structure'), (r) => r.result === 'FAIL'),
      missingInApp: count(all('structure'), (r) => r.result === 'FAIL' && (r.app === 'missing' || r.app === 'hidden')),
      extraInApp: count(all('structure'), (r) => r.result === 'FAIL' && (r.design === 'missing' || r.design === 'hidden')),
      cannotVerify: count(all('structure'), (r) => r.result === 'CANNOT_VERIFY'),
    },
  };
}
