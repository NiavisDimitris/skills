// Motion specs: Figma prototype transitions mapped to CSS-comparable values,
// plus the duration / easing normalisation and matching shared with compare.mjs.
// Pure: no IO.

/** Named CSS easings and Figma easing presets as cubic-bezier control points. */
const CSS_EASINGS = Object.freeze({
  ease: [0.25, 0.1, 0.25, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
});
const FIGMA_EASINGS = Object.freeze({
  LINEAR: [0, 0, 1, 1],
  EASE_IN: [0.42, 0, 1, 1],
  EASE_OUT: [0, 0, 0.58, 1],
  EASE_IN_AND_OUT: [0.42, 0, 0.58, 1],
  EASE_IN_BACK: [0.3, -0.05, 0.7, -0.5],
  EASE_OUT_BACK: [0.45, 1.45, 0.8, 1],
  EASE_IN_AND_OUT_BACK: [0.7, -0.4, 0.4, 1.4],
});
/** Figma spring presets (mass, stiffness, damping). */
const FIGMA_SPRINGS = Object.freeze({
  GENTLE: { mass: 1, stiffness: 100, damping: 15 },
  QUICK: { mass: 1, stiffness: 300, damping: 20 },
  BOUNCY: { mass: 1, stiffness: 600, damping: 15 },
  SLOW: { mass: 1, stiffness: 80, damping: 20 },
});

/** Figma trigger type → ledgers.motion trigger. */
export const TRIGGERS = Object.freeze({
  ON_HOVER: 'hover',
  MOUSE_ENTER: 'hover',
  MOUSE_LEAVE: 'hover',
  ON_PRESS: 'press',
  MOUSE_DOWN: 'press',
  MOUSE_UP: 'press',
  ON_CLICK: 'click',
  ON_TAP: 'click',
  AFTER_TIMEOUT: 'timeout',
  ON_DRAG: 'other',
  ON_KEY_DOWN: 'other',
  ON_MEDIA_HIT: 'other',
  ON_MEDIA_END: 'other',
});

/** Figma transition type → the CSS property it usually animates (a hint, not a requirement). */
const PROPERTY_HINT = Object.freeze({
  DISSOLVE: 'opacity',
  MOVE_IN: 'transform',
  MOVE_OUT: 'transform',
  PUSH: 'transform',
  SLIDE_IN: 'transform',
  SLIDE_OUT: 'transform',
});

const round = (n, d = 3) => Number(Number(n).toFixed(d));
const fmt = (pts) => `cubic-bezier(${pts.map((p) => round(p)).join(',')})`;

/** Split a CSS list on top-level commas: "a, cubic-bezier(0,0,1,1), b" → 3 items. */
export function splitCssList(value) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(value ?? '')) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** "0.2s" | "200ms" | 200 → 200 (ms); null when not a duration. */
export function parseDurationMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? round(value, 2) : null;
  const m = /^\s*(-?\d*\.?\d+(?:e[-+]?\d+)?)\s*(ms|s)\s*$/i.exec(String(value ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  return round(m[2].toLowerCase() === 's' ? n * 1000 : n, 2);
}

/**
 * Canonical easing: "linear", "cubic-bezier(x1,y1,x2,y2)" (named CSS easings and
 * Figma presets expanded), "steps(n,start|end)", or the compacted input.
 */
export function normalizeEasing(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const s = raw.toLowerCase().replace(/\s+/g, ' ');
  if (s === 'linear') return 'linear';
  if (CSS_EASINGS[s]) return fmt(CSS_EASINGS[s]);
  if (FIGMA_EASINGS[raw.toUpperCase()]) {
    const pts = FIGMA_EASINGS[raw.toUpperCase()];
    return pts.join(',') === '0,0,1,1' ? 'linear' : fmt(pts);
  }
  if (s === 'step-start') return 'steps(1,start)';
  if (s === 'step-end') return 'steps(1,end)';
  const cb = /^cubic-bezier\(\s*([^)]*)\)$/.exec(s);
  if (cb) {
    const pts = cb[1].split(',').map((p) => Number(p.trim()));
    if (pts.length === 4 && pts.every(Number.isFinite)) return pts.join(',') === '0,0,1,1' ? 'linear' : fmt(pts);
  }
  const st = /^steps\(\s*(\d+)\s*(?:,\s*([a-z-]+)\s*)?\)$/.exec(s);
  if (st) {
    const pos = { 'jump-start': 'start', start: 'start', 'jump-end': 'end', end: 'end' }[st[2] ?? 'end'] ?? st[2];
    return `steps(${st[1]},${pos})`;
  }
  return s.replace(/\s*([(),])\s*/g, '$1');
}

function bezierPoints(easing) {
  const n = normalizeEasing(easing);
  if (n === 'linear') return [0, 0, 1, 1];
  const m = /^cubic-bezier\(([^)]*)\)$/.exec(n ?? '');
  return m ? m[1].split(',').map(Number) : null;
}

/** Same easing after normalisation (control points within tolerance). */
export function easingEqual(a, b, tolerance = 0.02) {
  const pa = bezierPoints(a);
  const pb = bezierPoints(b);
  if (pa && pb) return pa.every((v, i) => Math.abs(v - pb[i]) <= tolerance);
  return normalizeEasing(a) === normalizeEasing(b);
}

/** Damped-spring approximation as a cubic-bezier: overshoot from the damping ratio. */
export function springToCubicBezier({ mass = 1, stiffness = 100, damping = 15 } = {}) {
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const overshoot = zeta < 1 ? Math.exp((-zeta * Math.PI) / Math.sqrt(1 - zeta * zeta)) : 0;
  const y = round(1 + 1.78 * overshoot, 2);
  const omega = Math.sqrt(stiffness / mass);
  const settleS = zeta < 1 ? 4 / (zeta * omega) : 4 / (omega * (zeta - Math.sqrt(zeta * zeta - 1)));
  return { easing: fmt([0.3, y, 0.6, y]), dampingRatio: round(zeta, 3), settleMs: Math.round(settleS * 1000) };
}

/**
 * Figma easing object { type, easingFunctionCubicBezier?, easingFunctionSpring? }
 * → { easing (CSS), figmaEasing, approximate, detail }.
 */
export function figmaEasingToCss(easing) {
  const type = String(easing?.type ?? '').toUpperCase();
  if (!type) return { easing: null, figmaEasing: null, approximate: false, detail: null };
  if (type === 'CUSTOM_CUBIC_BEZIER' || type === 'CUSTOM_BEZIER') {
    const f = easing.easingFunctionCubicBezier ?? {};
    const pts = [f.x1, f.y1, f.x2, f.y2].map(Number);
    if (pts.every(Number.isFinite)) return { easing: normalizeEasing(fmt(pts)), figmaEasing: type, approximate: false, detail: null };
    return { easing: null, figmaEasing: type, approximate: true, detail: 'custom cubic-bezier without control points' };
  }
  if (FIGMA_EASINGS[type]) return { easing: normalizeEasing(type), figmaEasing: type, approximate: false, detail: null };
  const springKey = type.replace(/_SPRING$/, '');
  if (FIGMA_SPRINGS[springKey] || type.includes('SPRING')) {
    const params = FIGMA_SPRINGS[springKey] ?? easing.easingFunctionSpring ?? {};
    const s = springToCubicBezier(params);
    return {
      easing: s.easing,
      figmaEasing: type,
      approximate: true,
      settleMs: s.settleMs,
      detail: `spring ${type.toLowerCase()} (mass ${params.mass ?? 1}, stiffness ${params.stiffness ?? '?'}, damping ${params.damping ?? '?'}; damping ratio ${s.dampingRatio}) approximated as ${s.easing}`,
    };
  }
  return { easing: null, figmaEasing: type, approximate: true, detail: `unknown Figma easing ${type}` };
}

/** Figma durations are seconds in reactions; values above 20 are taken as milliseconds. */
function durationToMs(duration) {
  const n = Number(duration);
  if (!Number.isFinite(n)) return null;
  return Math.round(n > 20 ? n : n * 1000);
}

const kebab = (s) => String(s).toLowerCase().replace(/_/g, '-');

/**
 * Motion the Figma prototype specifies, from layers[].reactions[].actions[].transition:
 * [{ nodeId, nodeName, layerPath, trigger, figmaTrigger, destinationId, destinationName,
 *    navigation, type, direction, durationMs, easing, figmaEasing, delayMs, property,
 *    approximate, detail, source: "figma-reaction" }].
 * A null transition is an instant change: type "instant", durationMs 0.
 */
export function figmaMotionSpecs(figmaSpec) {
  const layers = Array.isArray(figmaSpec?.layers) ? figmaSpec.layers : [];
  const byId = new Map(layers.map((l) => [l.id, l]));
  const out = [];
  for (const layer of layers) {
    for (const reaction of Array.isArray(layer.reactions) ? layer.reactions : []) {
      const actions = Array.isArray(reaction.actions) ? reaction.actions : reaction.action ? [reaction.action] : [];
      const figmaTrigger = String(reaction.trigger?.type ?? '').toUpperCase() || null;
      const trigger = TRIGGERS[figmaTrigger] ?? 'other';
      const triggerDelay = Number(reaction.trigger?.timeout ?? reaction.trigger?.delay);
      for (const action of actions) {
        if (!action || (action.type !== 'NODE' && !action.transition && !action.destinationId)) continue;
        const t = action.transition ?? null;
        const e = t ? figmaEasingToCss(t.easing) : { easing: null, figmaEasing: null, approximate: false, detail: null };
        const type = t?.type ? kebab(t.type) : 'instant';
        let durationMs = t ? durationToMs(t.duration) : 0;
        let approximate = e.approximate;
        const details = [];
        if (e.detail) details.push(e.detail);
        if (t && durationMs === null && e.settleMs) {
          durationMs = e.settleMs;
          approximate = true;
          details.push(`duration estimated from the spring (${e.settleMs} ms)`);
        }
        if (t?.direction) details.push(`direction ${String(t.direction).toLowerCase()}`);
        if (t?.matchLayers) details.push('match layers');
        const dest = action.destinationId ? byId.get(action.destinationId) : null;
        out.push({
          nodeId: layer.id ?? null,
          nodeName: layer.name ?? null,
          layerPath: layer.path ?? null,
          trigger,
          figmaTrigger,
          destinationId: action.destinationId ?? null,
          destinationName: dest?.name ?? null,
          navigation: action.navigation ?? null,
          type,
          direction: t?.direction ? String(t.direction).toLowerCase() : null,
          durationMs,
          easing: e.easing,
          figmaEasing: e.figmaEasing,
          delayMs: Number.isFinite(triggerDelay) ? durationToMs(triggerDelay) : null,
          property: t?.type ? PROPERTY_HINT[String(t.type).toUpperCase()] ?? null : null,
          approximate,
          detail: details.length ? details.join('; ') : null,
          source: 'figma-reaction',
        });
      }
    }
  }
  return out;
}

const familyOf = (p) => {
  const parts = String(p).split('-');
  return { first: parts[0], last: parts[parts.length - 1] };
};

/** Can an observed motion satisfy an expected one (property-wise)? */
export function propertyCompatible(expected, observed) {
  if (!observed) return false;
  const ep = expected?.property ?? null;
  if (expected?.type === 'animation' || ep === 'animation') return observed.type === 'animation';
  if (!ep || ep === 'all') return true;
  if (observed.type === 'animation') return false;
  const op = observed.property ?? 'all';
  if (op === 'all' || op === ep) return true;
  if (ep.startsWith(`${op}-`) || op.startsWith(`${ep}-`)) return true;
  const a = familyOf(ep);
  const b = familyOf(op);
  return a.first === b.first && a.last === b.last;
}

function sameIterations(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return true;
  return String(a) === String(b);
}

/**
 * Match one expected motion against what was observed:
 * { result: "PASS"|"FAIL", observed: <best match>|null, reasons: [..] }.
 * Nothing compatible observed → FAIL, observed null ("missing motion").
 */
export function motionMatches(expected, observedList, { durationToleranceMs = 20 } = {}) {
  const candidates = (Array.isArray(observedList) ? observedList : []).filter((o) => propertyCompatible(expected, o));
  if (!candidates.length) {
    const what = expected?.type === 'animation' ? 'animation' : expected?.property ? `transition on ${expected.property}` : 'motion';
    return { result: 'FAIL', observed: null, reasons: [`missing motion: the app has no ${what}`] };
  }
  const scored = candidates.map((o) => {
    const reasons = [];
    const ed = expected.durationMs;
    if (ed !== null && ed !== undefined && o.durationMs !== null && o.durationMs !== undefined && Math.abs(o.durationMs - ed) > durationToleranceMs) {
      reasons.push(`duration ${o.durationMs}ms, expected ${ed}ms`);
    }
    if (expected.easing && o.easing && !easingEqual(expected.easing, o.easing)) {
      reasons.push(`easing ${normalizeEasing(o.easing)}, expected ${normalizeEasing(expected.easing)}`);
    }
    const dd = expected.delayMs;
    if (dd !== null && dd !== undefined && o.delayMs !== null && o.delayMs !== undefined && Math.abs(o.delayMs - dd) > durationToleranceMs) {
      reasons.push(`delay ${o.delayMs}ms, expected ${dd}ms`);
    }
    if (!sameIterations(expected.iterations, o.iterations)) reasons.push(`iterations ${o.iterations}, expected ${expected.iterations}`);
    const exact = o.property && expected.property && o.property === expected.property ? 0 : 1;
    const gap = Math.abs((o.durationMs ?? 0) - (ed ?? 0));
    return { o, reasons, rank: [reasons.length, exact, gap] };
  });
  scored.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2]);
  const best = scored[0];
  return { result: best.reasons.length ? 'FAIL' : 'PASS', observed: best.o, reasons: best.reasons };
}

/** "200ms ease-out on opacity" — the text used in motion findings' expected/actual values. */
export function describeMotion(m) {
  if (!m) return 'none';
  if (m.type === 'none') return 'none';
  const parts = [];
  if (m.durationMs !== null && m.durationMs !== undefined) parts.push(`${m.durationMs}ms`);
  if (m.easing) parts.push(m.easing);
  if (m.delayMs) parts.push(`delay ${m.delayMs}ms`);
  if (m.type === 'animation') {
    parts.push(m.name ? `animation ${m.name}` : 'animation');
    if (m.iterations !== null && m.iterations !== undefined && String(m.iterations) !== '1') parts.push(`× ${m.iterations}`);
  } else if (m.property) parts.push(`on ${m.property}`);
  else if (m.type) parts.push(m.type);
  return parts.join(' ') || m.type || 'motion';
}
