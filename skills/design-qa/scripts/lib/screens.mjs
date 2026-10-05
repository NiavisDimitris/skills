// Multi-screen discovery and the design census: which top-level frames of a
// fetched Figma page or section are separate screens, which are states of one
// screen ("Cart" + "Cart – Empty" = one screen with two states), which are
// narrower breakpoint variants and which are small overlays (a popper, a menu)
// shown on top of a screen. Every top-level frame ends up somewhere: mapped, or
// listed as "unmapped" with a provisional mapping the agent confirms in a frame
// map. A frame never vanishes.
import { figmaMotionSpecs } from './figma-motion.mjs';
import { figmaDesignUrl } from './figma-url.mjs';
import { discoverFigmaStates, nameSegments, sortStates, stateFromName, stateId } from './state-discovery.mjs';

const SCREEN_TYPES = new Set(['FRAME', 'COMPONENT', 'INSTANCE', 'COMPONENT_SET']);
/** Node types whose child frames are screens. NODE_SET: several nodes fetched together (figma-mcp-spec). */
export const GROUPING_TYPES = new Set(['CANVAS', 'SECTION', 'DOCUMENT', 'NODE_SET']);

// Overlay frames: smaller than the screen and named like a floating surface.
const OVERLAY_WORDS = /(^| )(popper|popover|tooltip|tool tip|menu|dropdown|drop down|flyout|hover card|context menu|overlay|toast|snackbar|listbox|autocomplete)( |$)/;
const HOVER_WORDS = /(^| )(hover|hovered|tooltip|tool tip|hover card|mouse over|mouseover)( |$)/;
const CLICK_WORDS = /(^| )(menu|dropdown|drop down|popover|context menu|listbox|autocomplete|select|open|opened|expanded|click|clicked)( |$)/;
// Breakpoint markers in a frame name: "Orders 600", "Orders – 600px", "Orders mobile".
const BREAKPOINT_TOKEN = /(^| )(?:@?\d{3,4}(?: ?px| ?w)?|mobile|tablet|desktop|phone|breakpoint)(?= |$)/g;
const OVERLAY_RATIO = 0.6;
const FRAME_MAP_ID = /^[a-z0-9][a-z0-9-]*$/;

const phrase = (s) => String(s ?? '').toLowerCase().replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ').trim();
const slug = (s) => phrase(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/** kebab-case id: "Checkout / Payment" → "checkout-payment". */
export function screenId(name) {
  return slug(name) || 'screen';
}

/** { family, state, segment }: segment is the raw label that named the state ('' for with-data). */
function splitName(name) {
  const segs = nameSegments(name);
  if (segs.length <= 1) {
    const state = stateFromName(name);
    return state ? { family: '', state, segment: String(name ?? '').trim() } : { family: phrase(name), state: 'with-data', segment: '' };
  }
  // The last segment that is a state label is the state; the others name the screen.
  for (let i = segs.length - 1; i >= 0; i--) {
    const state = stateFromName(segs[i]);
    if (state) return { family: phrase(segs.filter((_, j) => j !== i).join(' ')), state, segment: segs[i] };
  }
  return { family: phrase(segs.join(' ')), state: 'with-data', segment: '' };
}

/**
 * Split a frame name into { family, state }: the state segment (Empty, Error,
 * Hover…) is removed and the rest names the screen. No state segment → with-data.
 */
export function screenFamily(name) {
  const { family, state } = splitName(name);
  return { family, state };
}

/** The family without breakpoint markers ("orders 600" → "orders"). */
function baseFamily(family) {
  return family.replace(BREAKPOINT_TOKEN, ' ').replace(/\s+/g, ' ').trim();
}

function boxOf(node) {
  const b = node?.absoluteBoundingBox ?? {};
  return { x: Number(b.x) || 0, y: Number(b.y) || 0, width: Math.round(Number(b.width) || 0), height: Math.round(Number(b.height) || 0) };
}

const sizeOf = (box) => ({ width: box.width, height: box.height });
const sameWidth = (a, b) => Math.abs(a - b) <= 1;

/**
 * The frames to account for, grouped by the container they sit in.
 *  - A page, section or node set: the frames directly under it and directly under
 *    every section nested in it (sections inside sections too).
 *  - A frame: the frame itself and its siblings on the page. With
 *    siblingsAsScreens every sibling frame is a candidate screen (figma-fetch
 *    --screens auto on a frame link); otherwise only siblings of the frame's own
 *    family are (the rest of the page is "outside" this pass).
 */
function containersOf(spec, { siblingsAsScreens }) {
  const layers = Array.isArray(spec?.layers) ? spec.layers : [];
  const root = layers.find((l) => (l?.depth ?? 0) === 0) ?? null;
  const type = spec?.type ?? root?.type ?? null;
  const containers = [];
  const others = [];
  const outside = [];
  if (!root) return { root, type, containers, others, outside };
  if (GROUPING_TYPES.has(type)) {
    const parent = new Map();
    const index = new Map();
    const stack = [];
    layers.forEach((l, i) => {
      const d = l.depth ?? 0;
      stack.length = d;
      parent.set(l, stack[d - 1] ?? null);
      stack[d] = l;
      index.set(l, i);
    });
    const containerMemo = new Map([[root, true]]);
    const isContainer = (l) => {
      if (!l) return false;
      if (containerMemo.has(l)) return containerMemo.get(l);
      const yes = l.type === 'SECTION' && isContainer(parent.get(l));
      containerMemo.set(l, yes);
      return yes;
    };
    const byNode = new Map();
    const containerFor = (node) => {
      if (!byNode.has(node)) {
        // The root is a container too; it names the screen only when it is a section.
        const c = { node: node === root && type !== 'SECTION' ? null : node, root: node === root, frames: [] };
        byNode.set(node, c);
        containers.push(c);
      }
      return byNode.get(node);
    };
    containerFor(root);
    for (const l of layers) {
      if (l === root) continue;
      const p = parent.get(l);
      if (!isContainer(p)) continue;
      if (l.type === 'SECTION') {
        containerFor(l);
        continue;
      }
      if (SCREEN_TYPES.has(l.type)) containerFor(p).frames.push({ node: l, index: index.get(l) });
      else others.push({ nodeId: l.id, name: l.name ?? '', type: l.type ?? null, section: p === root ? null : p.name ?? null });
    }
    return { root, type, containers: containers.filter((c) => c.frames.length), others, outside };
  }
  const siblings = (Array.isArray(spec?.siblings) ? spec.siblings : []).filter((s) => s && SCREEN_TYPES.has(s.type));
  const rootFamily = phrase(nameSegments(root.name)[0] || root.name);
  const frames = [{ node: root, index: 0 }];
  siblings.forEach((s, i) => {
    const sameFamily = phrase(nameSegments(s.name)[0] || s.name) === rootFamily;
    if (siblingsAsScreens || sameFamily) frames.push({ node: s, index: i + 1 });
    else outside.push({ nodeId: s.id, name: s.name ?? '', type: s.type ?? null, frame: sizeOf(boxOf(s)) });
  });
  containers.push({ node: null, root: true, frameRoot: true, frames });
  return { root, type, containers, others, outside };
}

/**
 * Validate a frame map: { "<nodeId>": { screen, state?, trigger?, variantOf? } | { ignore: "<reason>" } }.
 * Also accepts { frames: { … } }. Returns a Map nodeId → decision; throws Error on bad entries.
 */
export function normalizeFrameMap(frameMap) {
  const out = new Map();
  if (!frameMap) return out;
  const entries = frameMap.frames && typeof frameMap.frames === 'object' ? frameMap.frames : frameMap;
  if (typeof entries !== 'object' || Array.isArray(entries)) throw new Error('a frame map is an object: { "<nodeId>": { "screen": "<id>", "state": "<id>" } | { "ignore": "<reason>" } }');
  for (const [nodeId, d] of Object.entries(entries)) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error(`frame map ${nodeId}: expected an object`);
    if ('ignore' in d) {
      if (typeof d.ignore !== 'string' || !d.ignore.trim()) throw new Error(`frame map ${nodeId}: "ignore" needs a written reason`);
      out.set(nodeId, { ignore: d.ignore.trim() });
      continue;
    }
    if (typeof d.screen !== 'string' || !FRAME_MAP_ID.test(d.screen)) throw new Error(`frame map ${nodeId}: "screen" must be a kebab-case id like "orders"`);
    if (d.state !== undefined && (typeof d.state !== 'string' || !FRAME_MAP_ID.test(d.state))) throw new Error(`frame map ${nodeId}: "state" must be a kebab-case id like "side-panel"`);
    if (d.variantOf !== undefined && (typeof d.variantOf !== 'string' || !FRAME_MAP_ID.test(d.variantOf))) throw new Error(`frame map ${nodeId}: "variantOf" must be a screen id`);
    if (d.trigger !== undefined && d.trigger !== null && !['hover', 'click', 'focus', 'press', 'keyboard'].includes(d.trigger)) {
      throw new Error(`frame map ${nodeId}: "trigger" must be hover, click, focus, press or keyboard`);
    }
    out.set(nodeId, { screen: d.screen, state: stateId(d.state) ?? 'with-data', trigger: d.trigger ?? null, variantOf: d.variantOf ?? null });
  }
  return out;
}

function overlayTrigger(name) {
  const p = phrase(name);
  if (HOVER_WORDS.test(p)) return 'hover';
  if (CLICK_WORDS.test(p)) return 'click';
  return null;
}

/** The words of `name` left after removing a screen's family words: "Orders – Hover popper" − "orders" → "hover popper". */
function remainderAfter(name, family) {
  const words = phrase(name).split(' ').filter(Boolean);
  const fam = new Set(family.split(' ').filter(Boolean));
  return words.filter((w) => !fam.has(w)).join(' ');
}

/**
 * The design census of a fetched Figma node: every top-level frame with what it
 * maps to, the screens (with their states) that result, and the frames whose
 * mapping is a judgement call ("unmapped", each with a provisional suggestion).
 *
 * options:
 *   frameMap   decisions that override the automatic mapping (normalizeFrameMap input)
 *   siblings   "auto" (default: sibling frames are screens when spec.screens is set),
 *              "screens" or "family"
 *
 * Returns { root, frames[], screens[], unmapped[], others[], outside[] }:
 *   frames[]   { nodeId, name, type, section, frame, hidden, mappedTo, by, confirmed }
 *              mappedTo: { kind: screen|state|breakpoint|overlay|ignored, screen, state,
 *              trigger, variantOf, reason }
 *   screens[]  { id, name, nodeId, frame, variantOf, states: [{ state, nodeId, name,
 *              source, frame, kind, trigger }] }
 *   unmapped[] { nodeId, name, section, frame, reason, suggestion } (also in frames[]
 *              with confirmed: false and the suggestion as mappedTo)
 */
export function designCensus(spec, { frameMap = null, siblings = 'auto' } = {}) {
  const siblingsAsScreens = siblings === 'screens' || (siblings === 'auto' && Array.isArray(spec?.screens));
  const { root, type, containers, others, outside } = containersOf(spec, { siblingsAsScreens });
  const decisions = frameMap instanceof Map ? frameMap : normalizeFrameMap(frameMap);
  const rows = [];
  const screens = new Map();
  const usedIds = new Set();

  const entries = [];
  for (const c of containers) {
    for (const { node, index } of c.frames) {
      const e = { node, index, container: c, box: boxOf(node), ...splitName(node.name) };
      e.base = baseFamily(e.family);
      e.row = {
        nodeId: node.id,
        name: node.name ?? '',
        type: node.type ?? null,
        section: c.node && c.node.type === 'SECTION' ? c.node.name ?? null : null,
        frame: sizeOf(e.box),
        hidden: node.visible === false,
        mappedTo: null,
        by: null,
        confirmed: true,
      };
      rows.push(e.row);
      entries.push(e);
    }
  }
  entries.sort((a, b) => a.index - b.index || 0);

  const map = (e, mappedTo, by, { confirmed = true, reason = null } = {}) => {
    e.row.mappedTo = mappedTo;
    e.row.by = by;
    e.row.confirmed = confirmed;
    if (!confirmed) e.row.reason = reason;
  };
  const newScreen = (base, { name, node, box, variantOf = null }) => {
    let id = base || 'screen';
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);
    const screen = { id, name, nodeId: node.id, frame: sizeOf(box), variantOf, states: [], box, family: null };
    screens.set(id, screen);
    return screen;
  };
  /** Add a state to a screen; a taken id falls back to the frame's own label, then to a numbered id (unconfirmed). */
  const addState = (screen, state, e, { kind = 'state', trigger = null, by = 'name', confirmed = true, reason = null } = {}) => {
    let id = stateId(state) ?? 'state';
    let ok = confirmed;
    let why = reason;
    if (screen.states.some((s) => s.state === id)) {
      const own = stateId(e.segment || remainderAfter(e.node.name, screen.family ?? ''));
      if (own && own !== id && !screen.states.some((s) => s.state === own)) {
        id = own;
      } else {
        let n = 2;
        const taken = id;
        while (screen.states.some((s) => s.state === `${taken}-${n}`)) n++;
        id = `${taken}-${n}`;
        ok = false;
        why = why ?? `another frame of screen "${screen.id}" is already its ${taken} state: a duplicate, an alternative or a different state?`;
      }
    }
    screen.states.push({ state: id, nodeId: e.node.id, name: e.node.name ?? '', source: 'frame-name', frame: sizeOf(e.box), kind, trigger });
    map(e, { kind, screen: screen.id, state: id, trigger, variantOf: screen.variantOf }, by, { confirmed: ok, reason: why });
    return id;
  };

  // 1. Hidden frames and frame-map decisions are settled first.
  const auto = [];
  const decided = [];
  for (const e of entries) {
    const d = decisions.get(e.node.id);
    if (d?.ignore) map(e, { kind: 'ignored', reason: d.ignore }, 'frame-map');
    else if (d) decided.push({ e, d });
    else if (e.row.hidden) map(e, { kind: 'ignored', reason: 'hidden in Figma' }, 'hidden');
    else auto.push(e);
  }

  // 2. Each container's main frame: named like its section, else the top-left
  //    with-data frame at the most common width, else the largest frame.
  for (const c of containers) {
    const own = auto.filter((e) => e.container === c);
    if (!own.length) continue;
    if (c.frameRoot) {
      c.main = own.find((e) => e.node === root) ?? own[0];
    } else {
      const sectionFamily = c.node ? baseFamily(splitName(c.node.name).family) : '';
      const widths = new Map();
      for (const e of own) widths.set(e.box.width, (widths.get(e.box.width) ?? 0) + 1);
      const mode = [...widths].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
      const topLeft = (list) => [...list].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)[0];
      c.main =
        (sectionFamily && own.find((e) => e.state === 'with-data' && (e.base === sectionFamily || e.family === sectionFamily))) ||
        topLeft(own.filter((e) => e.state === 'with-data' && e.box.width === mode)) ||
        [...own].sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0];
    }
    const ref = c.main.box;
    for (const e of own) {
      if (e === c.main) continue;
      const small = e.box.width <= ref.width * OVERLAY_RATIO && e.box.height <= ref.height * OVERLAY_RATIO;
      const named = OVERLAY_WORDS.test(phrase(e.node.name)) && e.box.width * e.box.height < 0.5 * ref.width * ref.height;
      e.overlay = small || named;
    }
  }

  // 3. Families: frames named "<Screen>" and "<Screen> – <State>" are one group.
  const groups = new Map();
  const loose = []; // overlays and frames named only after a state ("Loading")
  for (const e of auto) {
    if (e.overlay || !e.family) {
      loose.push(e);
      continue;
    }
    if (!groups.has(e.family)) groups.set(e.family, { family: e.family, base: e.base, members: [] });
    groups.get(e.family).members.push(e);
  }
  for (const g of groups.values()) {
    g.main = g.members.find((m) => m.state === 'with-data') ?? g.members[0];
    g.hasContainerMain = g.members.some((m) => m.container.main === m);
  }

  // 4. Breakpoint variants between families: "Orders mobile" (390 wide) beside "Orders" (1440).
  const byBase = new Map();
  for (const g of groups.values()) {
    if (!byBase.has(g.base)) byBase.set(g.base, []);
    byBase.get(g.base).push(g);
  }
  for (const list of byBase.values()) {
    if (list.length < 2) continue;
    const primary = list.find((g) => g.family === g.base) ?? list.find((g) => g.hasContainerMain) ?? [...list].sort((a, b) => b.main.box.width - a.main.box.width)[0];
    for (const g of list) if (g !== primary && !sameWidth(g.main.box.width, primary.main.box.width)) g.variantOf = primary;
  }

  // 5. "<Screen> – <Something>" where <Screen> is another family: a state of that screen.
  const families = [...groups.values()].filter((g) => !g.variantOf);
  for (const g of families) {
    let best = null;
    for (const h of families) {
      if (h === g || h.prefixOf || !g.family.startsWith(`${h.family} `)) continue;
      if (!best || h.family.length > best.family.length) best = h;
    }
    if (best && sameWidth(g.main.box.width, best.main.box.width)) {
      // Confident when the screen's name is a whole leading segment ("Orders – Side panel").
      const segs = nameSegments(g.main.node.name).map(phrase);
      let acc = '';
      let boundary = false;
      for (const s of segs) {
        acc = acc ? `${acc} ${s}` : s;
        if (acc === best.family) boundary = true;
      }
      g.prefixOf = best;
      g.prefixConfident = boundary;
    }
  }

  // 6. Screens, in layer order: one per family, its frames at another width split
  //    off as breakpoint variants ("<id>-<width>").
  const screenOf = new Map(); // group → screen
  const ordered = [...groups.values()].sort((a, b) => a.main.index - b.main.index);
  const sectionSingleton = (g) => {
    const c = g.main.container;
    return c.node?.type === 'SECTION' && g.members.length === 1 && g.main.state === 'with-data' && c.main && c.main !== g.main && !c.main.overlay;
  };
  const pendingSingletons = [];
  for (const g of ordered) {
    if (g.variantOf || g.prefixOf) continue;
    if (sectionSingleton(g)) {
      pendingSingletons.push(g);
      continue;
    }
    ownScreen(g);
  }
  // Families that are another screen's breakpoint variant.
  for (const g of ordered) {
    if (!g.variantOf) continue;
    const primary = screenOf.get(g.variantOf) ?? screenOf.get(g.variantOf.prefixOf);
    if (primary) splitVariants(primary, g.members);
    else ownScreen(g);
  }
  // "<Screen> – <Something>": custom states of that screen.
  for (const g of ordered) {
    if (!g.prefixOf) continue;
    const screen = screenOf.get(g.prefixOf);
    if (!screen) {
      ownScreen(g);
      continue;
    }
    const label = stateId(remainderAfter(g.family, g.prefixOf.family)) ?? 'variant';
    for (const m of g.members) {
      const state = m.state === 'with-data' ? label : `${label}-${m.state}`;
      addState(screen, state, m, {
        by: 'name',
        confirmed: g.prefixConfident,
        reason: g.prefixConfident ? null : `named like screen "${screen.id}" plus "${remainderAfter(g.family, g.prefixOf.family)}": a state of that screen or a screen of its own?`,
      });
    }
  }

  /** A family that is a screen of its own; its frames at another width become breakpoint variants. */
  function ownScreen(g) {
    const name = g.main.state === 'with-data' ? g.main.node.name ?? '' : titleCase(g.family);
    const screen = newScreen(screenId(g.family), { name, node: g.main.node, box: g.main.box });
    screen.family = g.family;
    screenOf.set(g, screen);
    const wide = [];
    for (const m of [g.main, ...g.members.filter((x) => x !== g.main)]) {
      if (!sameWidth(m.box.width, g.main.box.width)) wide.push(m);
      else addState(screen, m.state, m, { by: 'name' });
    }
    if (wide.length) splitVariants(screen, wide);
    return screen;
  }

  function splitVariants(primary, members) {
    const byWidth = new Map();
    for (const m of members) {
      if (!byWidth.has(m.box.width)) byWidth.set(m.box.width, []);
      byWidth.get(m.box.width).push(m);
    }
    for (const [width, list] of byWidth) {
      let variant = [...screens.values()].find((s) => s.variantOf === primary.id && s.frame.width === width);
      if (!variant) {
        const main = list.find((m) => m.state === 'with-data') ?? list[0];
        variant = newScreen(`${primary.id}-${width}`, { name: main.node.name ?? `${primary.name} ${width}`, node: main.node, box: main.box, variantOf: primary.id });
        variant.family = primary.family;
      }
      for (const m of list) addState(variant, m.state, m, { kind: 'breakpoint', by: 'size' });
    }
  }

  // 7. The screen a container belongs to: the one its main frame maps to (a container
  //    whose frames are all named after states gets a screen named after the section).
  const containerScreen = (c) => {
    if (!c.main) return null;
    const mapped = c.main.row.mappedTo;
    if (mapped?.screen) return screens.get(mapped.screen) ?? null;
    if (c.main.overlay || c.main.family) return null;
    const label = c.node?.name ?? spec?.name ?? root?.name ?? 'Screen';
    const screen = newScreen(screenId(baseFamily(splitName(label).family) || label), { name: label, node: c.main.node, box: c.main.box });
    screen.family = phrase(label);
    addState(screen, c.main.state, c.main, { by: 'section' });
    return screen;
  };
  const screensIn = (c) => {
    const ids = new Set();
    for (const e of entries) if (e.container === c && e.row.mappedTo?.screen && !screens.get(e.row.mappedTo.screen)?.variantOf) ids.add(e.row.mappedTo.screen);
    return ids;
  };
  const nearestScreen = (e) => {
    let best = null;
    for (const s of screens.values()) {
      if (s.variantOf) continue;
      const dx = Math.max(0, s.box.x - (e.box.x + e.box.width), e.box.x - (s.box.x + s.box.width));
      const dy = Math.max(0, s.box.y - (e.box.y + e.box.height), e.box.y - (s.box.y + s.box.height));
      const dist = Math.hypot(dx, dy) + (e.container.main?.row.mappedTo?.screen === s.id ? -1e-6 : 0);
      if (!best || dist < best.dist) best = { s, dist };
    }
    return best?.s ?? null;
  };

  // 8. Frames in a section with a name of their own, beside the section's main screen:
  //    a state of that screen or a screen of its own? Provisionally a state; confirm.
  for (const g of pendingSingletons) {
    const m = g.main;
    const screen = containerScreen(m.container);
    if (!screen) {
      const s = newScreen(screenId(g.family), { name: m.node.name ?? '', node: m.node, box: m.box });
      s.family = g.family;
      addState(s, 'with-data', m, { by: 'name' });
      continue;
    }
    const label = stateId(remainderAfter(g.family, screen.family ?? '')) ?? stateId(g.family) ?? 'variant';
    addState(screen, label, m, {
      by: 'section',
      confirmed: false,
      reason: `a frame in section "${m.container.node?.name ?? ''}" with a name of its own: a state of screen "${screen.id}" (provisional) or a separate screen?`,
    });
  }

  // 9. Overlays and frames named only after a state ("Loading", "Empty").
  for (const e of loose.sort((a, b) => a.index - b.index)) {
    const c = e.container;
    let screen = null;
    let confident = false;
    if (e.overlay) {
      // The screen named in the overlay's own name wins ("Orders – Row menu").
      for (const s of screens.values()) {
        if (s.variantOf || !s.family) continue;
        if (phrase(e.node.name).startsWith(`${s.family} `) && (!screen || s.family.length > screen.family.length)) screen = s;
      }
      confident = Boolean(screen);
    }
    if (!screen) {
      const own = screensIn(c);
      screen = containerScreen(c);
      confident = Boolean(screen) && own.size <= 1;
      if (!screen) screen = nearestScreen(e);
    }
    if (!screen) {
      // Nothing to attach to: the frame is a screen of its own.
      const s = newScreen(screenId(e.family || e.node.name), { name: e.node.name ?? '', node: e.node, box: e.box });
      s.family = e.family || phrase(e.node.name);
      addState(s, e.state, e, { by: 'name' });
      continue;
    }
    if (e.overlay) {
      const label = stateId(remainderAfter(e.node.name, screen.family ?? '')) ?? 'overlay';
      addState(screen, label, e, {
        kind: 'overlay',
        trigger: overlayTrigger(e.node.name),
        by: 'overlay',
        confirmed: confident,
        reason: confident ? null : `a small frame (${e.box.width}×${e.box.height}) shown over a screen: which screen, and what opens it?`,
      });
    } else {
      addState(screen, e.state, e, {
        by: 'name',
        confirmed: confident,
        reason: confident ? null : `named only after a state ("${e.node.name ?? ''}"): a state of which screen?`,
      });
    }
  }

  // 10. Frame-map decisions.
  for (const { e, d } of decided) {
    let screen = screens.get(d.screen);
    if (!screen) {
      screen = newScreen(d.screen, { name: e.node.name ?? d.screen, node: e.node, box: e.box, variantOf: d.variantOf });
      screen.family = e.family;
    }
    if (screen.states.some((s) => s.state === d.state)) throw new Error(`frame map ${e.node.id}: screen "${d.screen}" already has a "${d.state}" state`);
    const kind = d.trigger || e.overlay ? 'overlay' : screen.variantOf ? 'breakpoint' : 'state';
    screen.states.push({ state: d.state, nodeId: e.node.id, name: e.node.name ?? '', source: 'frame-name', frame: sizeOf(e.box), kind, trigger: d.trigger ?? null });
    map(e, { kind, screen: screen.id, state: d.state, trigger: d.trigger ?? null, variantOf: screen.variantOf }, 'frame-map');
  }

  // A frame that is the main frame of its screen reads "screen", the rest "state".
  for (const e of entries) {
    const m = e.row.mappedTo;
    if (m?.screen && screens.get(m.screen)?.nodeId === e.node.id && m.kind === 'state') m.kind = 'screen';
  }

  // Each breakpoint variant right after the screen it varies.
  const all = [...screens.values()];
  const orderedScreens = [];
  for (const s of all.filter((x) => !x.variantOf || !screens.has(x.variantOf))) {
    orderedScreens.push(s);
    orderedScreens.push(...all.filter((x) => x.variantOf === s.id));
  }
  const outScreens = orderedScreens.map((s) => ({
    id: s.id,
    name: s.name,
    nodeId: s.nodeId,
    frame: s.frame,
    ...(s.variantOf ? { variantOf: s.variantOf } : {}),
    states: s.states,
  }));
  return {
    root: root ? { nodeId: spec?.nodeId ?? root.id, name: spec?.name ?? root.name ?? '', type, frame: spec?.frame ?? sizeOf(boxOf(root)) } : null,
    frames: rows,
    screens: outScreens,
    unmapped: rows
      .filter((r) => !r.confirmed)
      .map((r) => ({ nodeId: r.nodeId, name: r.name, section: r.section, frame: r.frame, reason: r.reason, suggestion: r.mappedTo })),
    others,
    outside,
  };
}

/**
 * Screens of a fetched Figma page/section (or of the page around a fetched frame):
 * [{ id, name, nodeId, frame: { width, height }, variantOf?, states: [{ state, nodeId, name, source, frame, kind, trigger }] }].
 * Frames whose names differ only by a state segment form one screen; frames at another
 * width are breakpoint variants ("<id>-<width>"); small overlays are states. See designCensus.
 */
export function discoverScreens(figmaSpec, { frameMap = null } = {}) {
  return designCensus(figmaSpec, { frameMap, siblings: 'screens' }).screens;
}

/**
 * The states of one screen's spec: the census states first (they name every frame of
 * the screen), then what state discovery finds inside the frame (variants, reactions,
 * annotations) for ids the census does not have. A census frame keeps the census id
 * only: another id for it is dropped (an annotation on the main frame excepted).
 */
export function mergeScreenStates(discovered, censusStates) {
  const out = (censusStates ?? []).map((s) => ({ ...s }));
  const owned = new Set(out.map((s) => s.nodeId));
  const ids = new Set(out.map((s) => s.state));
  for (const s of discovered ?? []) {
    if (ids.has(s.state)) continue;
    if (owned.has(s.nodeId) && !(s.source === 'annotation' && s.nodeId === out[0].nodeId)) continue;
    out.push(s);
  }
  return out;
}

/** A single-frame spec's states with the census ids for its frame and the state frames beside it: { screen, states }. */
export function frameSpecStates(spec, census) {
  const screen = census.screens.find((x) => x.nodeId === spec?.nodeId) ?? census.screens[0] ?? null;
  const listed = Array.isArray(spec?.states) && spec.states.length ? spec.states : discoverFigmaStates(spec);
  if (!screen) return { screen, states: listed };
  const states = mergeScreenStates(listed, screen.states);
  const rank = new Map(sortStates(states.map((s) => s.state)).map((id, i) => [id, i]));
  return { screen, states: states.sort((a, b) => rank.get(a.state) - rank.get(b.state)) };
}

/** A per-screen spec (a file written earlier) with the census owning the top-level frames; the file adds what is inside the frame. */
export function withCensusStates(spec, screen, census) {
  const owned = new Set(census.frames.map((f) => f.nodeId));
  return { ...spec, states: mergeScreenStates((spec.states ?? []).filter((st) => !owned.has(st.nodeId)), screen.states) };
}

/**
 * A figma-spec.json for one screen, cut out of a page/section spec (the screen frame's
 * subtree, re-rooted), with the census states. Used when the per-screen spec is built
 * from data already fetched (MCP metadata, or a page spec in state discovery).
 */
export function screenSpecFrom(rootSpec, screen) {
  const layers = Array.isArray(rootSpec?.layers) ? rootSpec.layers : [];
  const start = layers.findIndex((l) => l.id === screen.nodeId);
  let sub = [];
  if (start !== -1) {
    const base = layers[start].depth ?? 0;
    const prefix = String(layers[start].path ?? '').slice(0, -String(layers[start].name ?? '').length).replace(/\/$/, '');
    for (let i = start; i < layers.length; i++) {
      if (i > start && (layers[i].depth ?? 0) <= base) break;
      const l = layers[i];
      const p = String(l.path ?? '');
      sub.push({ ...l, depth: (l.depth ?? 0) - base, path: prefix && p.startsWith(`${prefix}/`) ? p.slice(prefix.length + 1) : p });
    }
  } else {
    const sib = (rootSpec?.siblings ?? []).find((s) => s.id === screen.nodeId);
    sub = [{ id: screen.nodeId, name: sib?.name ?? screen.name, type: sib?.type ?? 'FRAME', path: sib?.name ?? screen.name, depth: 0, absoluteBoundingBox: sib?.absoluteBoundingBox ?? { x: 0, y: 0, ...screen.frame } }];
  }
  const known = new Map([...layers, ...(rootSpec?.siblings ?? [])].map((l) => [l.id, l]));
  const siblings = screen.states
    .filter((s) => s.nodeId !== screen.nodeId)
    .map((s) => ({ id: s.nodeId, name: s.name, type: known.get(s.nodeId)?.type ?? 'FRAME', absoluteBoundingBox: known.get(s.nodeId)?.absoluteBoundingBox ?? null }));
  const spec = {
    fileKey: rootSpec?.fileKey ?? null,
    nodeId: screen.nodeId,
    url: rootSpec?.fileKey ? figmaDesignUrl(rootSpec.fileKey, screen.nodeId) : null,
    fileName: rootSpec?.fileName ?? null,
    lastModified: rootSpec?.lastModified ?? null,
    version: rootSpec?.version ?? null,
    name: sub[0]?.name ?? screen.name,
    type: sub[0]?.type ?? 'FRAME',
    frame: screen.frame,
    layers: sub,
    components: rootSpec?.components ?? {},
    componentSets: rootSpec?.componentSets ?? {},
    styles: rootSpec?.styles ?? {},
    variables: rootSpec?.variables ?? null,
    siblings,
    states: [],
    motion: [],
    exports: [],
    fetchedAt: rootSpec?.fetchedAt ?? null,
    degradations: [],
  };
  for (const key of ['source', 'unavailable', 'variableDefs', 'codeConnect']) if (rootSpec?.[key] !== undefined) spec[key] = rootSpec[key];
  spec.states = mergeScreenStates(discoverFigmaStates(spec), screen.states);
  spec.motion = figmaMotionSpecs(spec);
  spec.screen = { id: screen.id, name: screen.name, ...(screen.variantOf ? { variantOf: screen.variantOf } : {}) };
  return spec;
}
