// Multi-screen discovery: which top-level frames of a fetched Figma page or
// section are separate screens, and which are state variants of one screen
// ("Cart" + "Cart – Empty" = one screen with two states).
import { nameSegments, normalizeStateName, stateFromName } from './state-discovery.mjs';

const SCREEN_TYPES = new Set(['FRAME', 'COMPONENT', 'INSTANCE', 'COMPONENT_SET']);
const GROUPING_TYPES = new Set(['CANVAS', 'SECTION', 'DOCUMENT']);

const phrase = (s) => String(s ?? '').toLowerCase().replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ').trim();

/** kebab-case id: "Checkout / Payment" → "checkout-payment". */
export function screenId(name) {
  return phrase(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'screen';
}

/**
 * Split a frame name into { family, state }: the state segment (Empty, Error,
 * Hover…) is removed and the rest names the screen. No state segment → with-data.
 */
export function screenFamily(name) {
  const segs = nameSegments(name);
  if (segs.length <= 1) {
    const state = stateFromName(name);
    return state ? { family: '', state } : { family: phrase(name), state: 'with-data' };
  }
  // The last segment that is a state label is the state; the others name the screen.
  for (let i = segs.length - 1; i >= 0; i--) {
    const state = stateFromName(segs[i]);
    if (state) return { family: phrase(segs.filter((_, j) => j !== i).join(' ')), state };
  }
  return { family: phrase(segs.join(' ')), state: 'with-data' };
}

function frameOf(node) {
  const box = node?.absoluteBoundingBox ?? {};
  return { width: Math.round(box.width ?? 0), height: Math.round(box.height ?? 0) };
}

/** Candidate screen frames: children of a page/section root, or the root frame plus its page siblings. */
function candidates(figmaSpec) {
  const layers = Array.isArray(figmaSpec?.layers) ? figmaSpec.layers : [];
  const root = layers.find((l) => (l.depth ?? 0) === 0) ?? null;
  const type = figmaSpec?.type ?? root?.type ?? null;
  if (GROUPING_TYPES.has(type)) {
    const out = [];
    // Frames directly under the page/section, and frames inside top-level sections.
    for (const l of layers) {
      if (l.depth === 1 && SCREEN_TYPES.has(l.type)) out.push(l);
      if (l.depth === 2 && SCREEN_TYPES.has(l.type)) {
        const parent = layers.find((p) => p.depth === 1 && l.path?.startsWith(`${p.path}/`));
        if (parent?.type === 'SECTION') out.push(l);
      }
    }
    return out.filter((l) => l.visible !== false);
  }
  if (!root) return [];
  const siblings = (Array.isArray(figmaSpec?.siblings) ? figmaSpec.siblings : []).filter((s) => SCREEN_TYPES.has(s.type));
  return [root, ...siblings];
}

/**
 * Screens of a fetched Figma page/section (or of the page around a fetched frame):
 * [{ id, name, nodeId, frame: { width, height }, states: [{ state, nodeId, name, source }] }].
 * Frames whose names differ only by a state segment form one screen; the frame
 * without a state segment (else the first one) is the screen's main frame.
 */
export function discoverScreens(figmaSpec) {
  const groups = new Map();
  for (const node of candidates(figmaSpec)) {
    const { family, state } = screenFamily(node.name);
    const key = family || phrase(node.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ node, state: normalizeStateName(state) ?? 'with-data' });
  }
  const used = new Set();
  const screens = [];
  for (const [key, members] of groups) {
    const main = members.find((m) => m.state === 'with-data') ?? members[0];
    const states = [];
    for (const m of [main, ...members.filter((x) => x !== main)]) {
      if (states.some((s) => s.state === m.state)) continue;
      states.push({ state: m.state, nodeId: m.node.id, name: m.node.name, source: 'frame-name' });
    }
    let id = screenId(key);
    for (let n = 2; used.has(id); n++) id = `${screenId(key)}-${n}`;
    used.add(id);
    const name = main.state === 'with-data' ? main.node.name : key.replace(/\b\w/g, (c) => c.toUpperCase());
    screens.push({ id, name, nodeId: main.node.id, frame: frameOf(main.node), states });
  }
  return screens;
}
