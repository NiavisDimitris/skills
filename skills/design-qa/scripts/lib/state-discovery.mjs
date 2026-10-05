#!/usr/bin/env node
// State discovery: which states exist in the design (Figma), which the ticket
// specifies and which the app can be driven into (config), merged into the
// state matrix. The design is the source of truth: rows are only the states the
// design defines. States found only in the ticket or only in code (config,
// source branches) are not rows; ticket criteria still annotate designed states.
//
// Results written here are provisional, decided before any capture:
//   designed && !implemented                     → MISSING_IN_CODE
//   designed && implemented via "source" only    → CANNOT_VERIFY (names surfaces.<name>.states.<state>)
//   designed && implemented (runtime driver)     → CANNOT_VERIFY, pending capture
// Capture + compare replaces the "pending capture" rows with PASS or FAIL.
// The main Figma frame is the design of with-data (or of the state its own name
// maps to) whenever figmaSpec.states does not cover that state.
// Multi-screen passes pass `screen`: state ids become "<screen>/<state>".
//
// Undesigned states (the app or the ticket has them, the design does not) are
// never rows. discoverUndesigned() lists them separately as design-backfill
// candidates (step 2, after parity) — read-only, written to backfill-candidates.json.
//
// The design census (lib/screens.mjs) accounts for every top-level frame of the
// fetched node: a page or section spec gives one matrix over all its screens, and
// frames whose mapping is a judgement call are listed as "unmapped" (--strict fails).
//
// CLI: node scripts/lib/state-discovery.mjs --figma-spec f.json [--ticket t.json]
//        [--config c.json --surface name] [--screen id] --out state-matrix.json
//        [--backfill-out backfill-candidates.json] [--frame-map m.json] [--census-out c.json]
//        [--states <dir>/states.json] [--strict]
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CliError, displayPath, oneLine, parseCli, readJsonFile, runMain, usageError, writeJson } from './args.mjs';
import { figmaNodeRefs, normalizeNodeId } from './figma-url.mjs';
import { GROUPING_TYPES, designCensus, frameSpecStates, normalizeFrameMap, screenSpecFrom, withCensusStates } from './screens.mjs';

/** Phrase → normalised state id. Matching is case-insensitive; "-", "_", "/" count as spaces. */
export const SYNONYMS = Object.freeze({
  // with data (the default, populated render)
  'with-data': 'with-data',
  'with data': 'with-data',
  default: 'with-data',
  filled: 'with-data',
  populated: 'with-data',
  data: 'with-data',
  loaded: 'with-data',
  rest: 'with-data',
  idle: 'with-data',
  enabled: 'with-data',
  // empty
  empty: 'empty',
  'empty state': 'empty',
  'no results': 'empty',
  'no result': 'empty',
  'no items': 'empty',
  'no data': 'empty',
  'nothing here': 'empty',
  'zero state': 'empty',
  blank: 'empty',
  // loading
  loading: 'loading',
  skeleton: 'loading',
  spinner: 'loading',
  fetching: 'loading',
  pending: 'loading',
  shimmer: 'loading',
  // error
  error: 'error',
  errors: 'error',
  failure: 'error',
  failed: 'error',
  fail: 'error',
  fails: 'error',
  offline: 'error',
  unavailable: 'error',
  // hover
  hover: 'hover',
  hovered: 'hover',
  mouseover: 'hover',
  'mouse over': 'hover',
  // focus
  focus: 'focus',
  focused: 'focus',
  'focus-visible': 'focus',
  'keyboard focus': 'focus',
  // active (pressed)
  active: 'active',
  pressed: 'active',
  // selected
  selected: 'selected',
  checked: 'selected',
  current: 'selected',
  'active tab': 'selected',
  // disabled
  disabled: 'disabled',
  inactive: 'disabled',
  // disclosure
  expanded: 'expanded',
  open: 'expanded',
  opened: 'expanded',
  collapsed: 'collapsed',
  closed: 'collapsed',
  // success
  success: 'success',
  done: 'success',
  complete: 'success',
  completed: 'success',
});

/** Synonyms too common in prose to trust when scanning free text (ticket ACs, annotations). */
const WEAK_IN_PROSE = new Set([
  'data', 'default', 'rest', 'idle', 'enabled', 'filled', 'blank', 'current', 'open', 'opened', 'closed',
  'done', 'complete', 'completed', 'active', 'inactive', 'fail',
]);

export const CANONICAL_ORDER = Object.freeze([
  'with-data', 'empty', 'loading', 'error', 'hover', 'focus', 'active', 'selected', 'disabled', 'expanded', 'collapsed', 'success',
]);

export const STATE_LABELS = Object.freeze({
  'with-data': 'With data',
  empty: 'Empty',
  loading: 'Loading',
  error: 'Error',
  hover: 'Hover',
  focus: 'Focus',
  active: 'Active (pressed)',
  selected: 'Selected',
  disabled: 'Disabled',
  expanded: 'Expanded',
  collapsed: 'Collapsed',
  success: 'Success',
});

const normalisePhrase = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[-_/:|=,.;!?"'`()[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const LOOKUP = new Map(Object.entries(SYNONYMS).map(([k, v]) => [normalisePhrase(k), v]));
const PHRASES = [...LOOKUP.keys()].sort((a, b) => b.length - a.length);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PHRASE_RES = PHRASES.map((p) => [p, new RegExp(`(^| )${escapeRe(p)}( |$)`)]);

/** Exact label match ("Empty", "Empty state", "State=Hover" segments): id or null. */
export function matchStateLabel(label) {
  const n = normalisePhrase(label);
  if (!n) return null;
  if (LOOKUP.has(n)) return LOOKUP.get(n);
  const m = /^(.*) state$/.exec(n) || /^state (.*)$/.exec(n);
  if (m && LOOKUP.has(m[1])) return LOOKUP.get(m[1]);
  return null;
}

/** Split a layer name into segments on / | – — : ( ) [ ] = , and " - ". */
export function nameSegments(name) {
  return String(name ?? '')
    .split(/\s+-\s+|[/|–—:()[\]=,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** State id for a layer/frame name: the whole name or one of its segments must be a state label. */
export function stateFromName(name) {
  const whole = matchStateLabel(name);
  if (whole) return whole;
  const segs = nameSegments(name);
  for (let i = segs.length - 1; i >= 0; i--) {
    const hit = matchStateLabel(segs[i]);
    if (hit) return hit;
  }
  return null;
}

// Negation: "not empty", "non-empty", "no errors", "without an error", "isn't loading",
// "should not be empty" name the opposite state, so a phrase right after a negator
// (with at most two filler words in between) is not a mention of that state.
const NEGATORS = new Set([
  'not', 'no', 'non', 'without', 'never', 'nor', 'nothing', 't', 'cannot', 'isnt', 'arent', 'wasnt', 'werent',
  'dont', 'doesnt', 'didnt', 'hasnt', 'havent', 'wont', 'cant', 'shouldnt',
]);
const NEGATION_FILLERS = new Set(['a', 'an', 'any', 'the', 'be', 'been', 'being', 'yet', 'more', 'longer', 'show', 'shows', 'display', 'displays', 'have', 'has']);

function isNegated(normalised, index) {
  const before = normalised.slice(0, index).split(' ').filter(Boolean);
  for (let i = before.length - 1, skipped = 0; i >= 0 && skipped <= 2; i--, skipped++) {
    if (NEGATORS.has(before[i])) return true;
    if (!NEGATION_FILLERS.has(before[i])) return false;
  }
  return false;
}

/**
 * First state mentioned in free text (earliest position wins, longer phrases
 * first; "with-data" only when nothing more specific is mentioned). Matches are
 * whole words, and a negated mention ("not empty", "no errors") does not count.
 * strict=true ignores synonyms that are too common in prose.
 */
export function matchStateSynonym(text, { strict = true } = {}) {
  const n = normalisePhrase(text);
  if (!n) return null;
  let best = null;
  for (const [phrase, re] of PHRASE_RES) {
    if (strict && WEAK_IN_PROSE.has(phrase)) continue;
    const global = new RegExp(re.source, 'g');
    let m;
    let index = -1;
    while ((m = global.exec(n))) {
      const at = m.index + m[1].length;
      if (!isNegated(n, at)) {
        index = at;
        break;
      }
      global.lastIndex = at + phrase.length;
    }
    if (index === -1) continue;
    const state = LOOKUP.get(phrase);
    const rank = state === 'with-data' ? 1 : 0;
    if (!best || rank < best.rank || (rank === best.rank && (index < best.index || (index === best.index && phrase.length > best.phrase.length)))) {
      best = { state, index, phrase, rank };
    }
  }
  return best ? best.state : null;
}

/**
 * Normalised state id for any name: the state the whole name (or one of its
 * segments) is a label for; else a state named by a whole-word synonym that is
 * neither negated ("Not empty", "no errors") nor a word too common to trust
 * ("Data table" is not with-data); otherwise a slug of the name.
 */
export function normalizeStateName(name) {
  const n = normalisePhrase(name);
  if (!n) return null;
  if (CANONICAL_ORDER.includes(n.replace(/ /g, '-'))) return n.replace(/ /g, '-');
  const hit = stateFromName(name) ?? matchStateSynonym(name, { strict: true });
  if (hit) return hit;
  return stateId(n);
}

/**
 * The one state-id normaliser: an id (or a label typed as one) → kebab-case. Idempotent and
 * never cut to a synonym inside it ("hover-tile" stays hover-tile). Names are classified by
 * normalizeStateName once; from then on ids only go through this.
 */
export function stateId(value) {
  return normalisePhrase(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || null;
}

/** The state a config or states.json key drives: the id it spells when designed ("hover-tile"), else the state its name maps to ("default" → with-data). */
export function keyState(key, designed = null) {
  const id = stateId(key);
  return designed?.has(id) ? id : normalizeStateName(key);
}

/**
 * The driver keys of one screen: [key, local, driver] for its "<screen>/<state>" keys (the
 * prefix dropped) and for plain keys; another screen's keys (and any "<x>/<y>" key when no
 * screen is given) are left out, as are "$" comments, "screens" and non-object values.
 */
export function screenKeys(states, screen = null) {
  const out = [];
  for (const [key, driver] of Object.entries(states && typeof states === 'object' ? states : {})) {
    if (key.startsWith('$') || key === 'screens' || !driver || typeof driver !== 'object' || Array.isArray(driver)) continue;
    const slash = key.indexOf('/');
    if (slash < 0) out.push([key, key, driver]);
    else if (screen && key.slice(0, slash) === screen) out.push([key, key.slice(slash + 1), driver]);
  }
  return out;
}

/**
 * Exact state id for a name, or null: the whole name, or one of its segments
 * ("Items / Loading"), must be a state label ("loading", "Skeleton", "Empty
 * state"). No partial matches, so "Pending orders" or "Fetching done" is not
 * loading. Capture uses it to decide how to treat a state.
 */
export function exactStateName(name) {
  const n = normalisePhrase(name);
  if (!n) return null;
  if (CANONICAL_ORDER.includes(n.replace(/ /g, '-'))) return n.replace(/ /g, '-');
  return stateFromName(name);
}

export function stateLabel(state) {
  if (STATE_LABELS[state]) return STATE_LABELS[state];
  const s = String(state ?? '').replace(/[-_]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : 'Unnamed state';
}

export function sortStates(states) {
  const pos = (s) => {
    const i = CANONICAL_ORDER.indexOf(s);
    return i === -1 ? CANONICAL_ORDER.length : i;
  };
  return [...states].sort((a, b) => pos(a) - pos(b) || String(a).localeCompare(String(b)));
}

// ---------------------------------------------------------------------------
// Figma
// ---------------------------------------------------------------------------

const SOURCE_PRIORITY = { 'frame-name': 0, variant: 1, annotation: 2, reaction: 3 };
const CONTAINER_TYPES = new Set(['FRAME', 'SECTION', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP']);
const STATE_KEYS = /^(state|status)$/i;

function reactionState(trigger, action, destName) {
  const type = trigger?.type;
  if (type === 'ON_HOVER' || type === 'MOUSE_ENTER') return 'hover';
  if (type === 'ON_PRESS' || type === 'MOUSE_DOWN') return 'active';
  const named = destName ? stateFromName(destName) ?? matchStateSynonym(destName, { strict: false }) : null;
  if (type === 'ON_CLICK' || type === 'ON_TAP') {
    // Clicks usually navigate; only a variant change (or a destination named like a
    // selected state) describes a selected state.
    if (named === 'selected') return 'selected';
    return action?.navigation === 'CHANGE_TO' ? 'selected' : null;
  }
  if (type === 'AFTER_TIMEOUT') return named === 'loading' ? 'loading' : null;
  return null;
}

/**
 * States designed in Figma, one entry per state:
 * [{ state, nodeId, name, source: "variant"|"frame-name"|"reaction"|"annotation" }].
 * Sources: variant properties named State/Status, frames/sections (depth ≤ 2, or
 * sibling frames of the same family) named after a state, prototype reactions and
 * annotations. The main frame is "with-data" unless its own name says otherwise
 * (component sets contribute their variants instead).
 */
export function discoverFigmaStates(figmaSpec) {
  const layers = Array.isArray(figmaSpec?.layers) ? figmaSpec.layers : [];
  const byId = new Map(layers.map((l) => [l.id, l]));
  const candidates = [];
  const add = (state, layer, source, order, raw = null) => {
    if (!state || !layer) return;
    candidates.push({ state, nodeId: layer.id, name: layer.name ?? '', source, depth: layer.depth ?? 0, order, raw });
  };

  const root = layers.find((l) => (l.depth ?? 0) === 0) || null;
  layers.forEach((layer, order) => {
    const depth = layer.depth ?? 0;
    const variants = layer.variantProperties && typeof layer.variantProperties === 'object' ? layer.variantProperties : null;
    if (variants) {
      for (const [key, value] of Object.entries(variants)) {
        // A state word (or one whole segment) is that state; a longer value keeps its own id ("Hover tile").
        if (STATE_KEYS.test(key.trim())) add(exactStateName(value) ?? stateId(value), layer, 'variant', order, stateId(value));
      }
    }
    // Variant names ("State=Hover, Size=M") are handled above, not as frame names.
    if (!variants && depth <= 2 && CONTAINER_TYPES.has(layer.type)) add(stateFromName(layer.name), layer, 'frame-name', order);
    for (const reaction of Array.isArray(layer.reactions) ? layer.reactions : []) {
      const actions = Array.isArray(reaction.actions) ? reaction.actions : reaction.action ? [reaction.action] : [];
      const action = actions[0] || null;
      const dest = action?.destinationId ? byId.get(action.destinationId) : null;
      const state = reactionState(reaction.trigger, action, dest?.name);
      if (state) add(state, dest || layer, 'reaction', order);
    }
    for (const note of Array.isArray(layer.annotations) ? layer.annotations : []) {
      const text = [note?.label, note?.labelMarkdown].filter(Boolean).join(' ');
      add(matchStateSynonym(text), layer, 'annotation', order);
    }
  });

  // Sibling frames next to the main frame ("Items – Empty" beside "Items").
  const family = (name) => normalisePhrase(nameSegments(name)[0] || name);
  const siblings = Array.isArray(figmaSpec?.siblings) ? figmaSpec.siblings : [];
  siblings.forEach((sib, i) => {
    if (!root || !CONTAINER_TYPES.has(sib.type)) return;
    if (family(sib.name) !== family(root.name)) return;
    add(stateFromName(sib.name), { ...sib, depth: 1 }, 'frame-name', layers.length + i);
  });

  if (root && root.type !== 'COMPONENT_SET' && !candidates.some((c) => c.nodeId === root.id)) {
    add('with-data', root, 'frame-name', -1);
  }

  const best = new Map();
  const clashes = []; // two different variant values with one id: both are kept, so discovery stops on them
  for (const c of candidates) {
    const cur = best.get(c.state);
    if (cur && c.source === 'variant' && cur.source === 'variant' && c.raw !== cur.raw) {
      if (!clashes.some((x) => x.raw === c.raw && x.state === c.state)) clashes.push(c);
      continue;
    }
    const better =
      !cur ||
      SOURCE_PRIORITY[c.source] < SOURCE_PRIORITY[cur.source] ||
      (SOURCE_PRIORITY[c.source] === SOURCE_PRIORITY[cur.source] && (c.depth < cur.depth || (c.depth === cur.depth && c.order < cur.order)));
    if (better) best.set(c.state, c);
  }
  return [...sortStates([...best.keys()]).map((state) => best.get(state)), ...clashes].map((c) => ({ state: c.state, nodeId: c.nodeId, name: c.name, source: c.source }));
}

// ---------------------------------------------------------------------------
// Ticket
// ---------------------------------------------------------------------------

/**
 * States the ticket specifies: [{ state, acRef, text }] (first AC per state).
 * The first criterion that names no state is taken as the with-data spec.
 */
export function discoverTicketStates(ticket) {
  if (!ticket) return [];
  let behaviors = Array.isArray(ticket.expectedBehaviors) ? ticket.expectedBehaviors : null;
  if (!behaviors) {
    const acs = Array.isArray(ticket.acceptanceCriteria) ? ticket.acceptanceCriteria : [];
    behaviors = acs.map((text, i) => ({ acRef: `AC-${i + 1}`, text, state: matchStateSynonym(text) }));
  }
  const seen = new Map();
  for (const b of behaviors) {
    const state = b?.state ? normalizeStateName(b.state) : null;
    if (state && !seen.has(state)) seen.set(state, { state, acRef: b.acRef ?? null, text: b.text ?? '' });
  }
  // A criterion that names no state describes the default, populated render.
  const plain = behaviors.find((b) => b && !b.state && b.text);
  if (!seen.has('with-data') && plain) seen.set('with-data', { state: 'with-data', acRef: plain.acRef ?? null, text: plain.text });
  return sortStates([...seen.keys()]).map((s) => seen.get(s));
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Capture applies every key of a driver together (fixture/query in the URL, mock and
// storage before load, the action after it); this order only names the primary one.
// The key that distinguishes a state wins over the shared base data:
// { fixture, action: "hover" } is an action, { fixture, mock } a mock. Keep in sync
// with references/state-matrix.md ("Reachability drivers").
export const DRIVER_ORDER = Object.freeze(['action', 'mock', 'query', 'storage', 'fixture', 'source']);

/** The primary driver kind of a DRIVER object (null for an empty driver = default render). */
export function driverKind(driver) {
  if (!driver || typeof driver !== 'object') return null;
  const kind = DRIVER_ORDER.find((k) => driver[k] !== undefined && driver[k] !== null && driver[k] !== '');
  if (kind) return kind;
  // A viewport-only driver (e.g. a "mobile" state) renders the default data at another size.
  return driver.viewport ? 'fixture' : null;
}

/** One-line description of a DRIVER object. */
export function describeDriver(driver) {
  if (!driver || typeof driver !== 'object') return 'default render';
  const parts = [];
  if (driver.mock) {
    const m = driver.mock;
    const response = m.status !== undefined || m.body !== undefined
      ? ` → ${m.status ?? 200}${m.body !== undefined ? ` ${truncate(typeof m.body === 'string' ? m.body : JSON.stringify(m.body), 40)}` : ''}`
      : '';
    parts.push(`mock ${m.urlPattern}${response}${m.delayMs ? ` (delay ${m.delayMs} ms)` : ''}`);
  }
  if (driver.fixture) parts.push(`fixture ${driver.fixture}`);
  if (driver.query) parts.push(`query ${String(driver.query).startsWith('?') ? driver.query : `?${driver.query}`}`);
  if (driver.storage) {
    const keys = [...Object.keys(driver.storage.local || {}), ...Object.keys(driver.storage.session || {})];
    parts.push(`storage ${keys.join(', ') || '(empty)'}`);
  }
  if (driver.action) parts.push(`${driver.action}${driver.selector ? ` ${driver.selector}` : ''}${driver.keys ? ` [${driver.keys}]` : ''}`);
  if (driver.source) parts.push(`source ${driver.source}`);
  if (driver.viewport) parts.push(`viewport ${driver.viewport.width}×${driver.viewport.height}`);
  return parts.join('; ') || 'default render';
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * States the app can be put into, from config.surfaces[surface].states:
 * [{ state, key, driver: kind, detail }]. with-data is always implemented
 * (the default render of the route) even when the config does not list it.
 * A state with an empty driver other than with-data is treated as "source"
 * (exists in code, no runtime driver). `screen`: that screen's "<screen>/<state>" keys
 * count too (another screen's do not); `passStates`: the pass's states.json drivers, which
 * win over the config's.
 */
export function discoverConfigStates(config, surface, designed = null, { screen = null, passStates = null } = {}) {
  const surfaces = config?.surfaces && typeof config.surfaces === 'object' ? config.surfaces : {};
  const s = surface ? surfaces[surface] : Object.values(surfaces)[0];
  const route = s?.route ?? null;
  const out = new Map();
  // The pass's file first, a screen's own key before a plain one, a key that spells a
  // designed id before one whose name only maps to it.
  const pass = screenKeys(passStates, screen).map((e) => [...e, 0]);
  const cfg = screenKeys(s?.states, screen).map((e) => [...e, 4]);
  const rank = ([key, local, , from]) => from + (key === local ? 2 : 0) + (designed?.has(stateId(local)) ? 0 : 1);
  for (const [key, local, driver] of [...pass, ...cfg].sort((a, b) => rank(a) - rank(b))) {
    const state = keyState(local, designed);
    if (!state || out.has(state)) continue;
    let kind = driverKind(driver);
    let detail = describeDriver(driver);
    if (!kind) {
      if (state === 'with-data') {
        kind = 'fixture';
        detail = `default render of ${route ?? 'the route'}${s?.fixture ? ` (fixture ${s.fixture})` : ''}`;
      } else {
        kind = 'source';
        detail = 'listed in config without a runtime driver';
      }
    }
    out.set(state, { state, key, driver: kind, detail });
  }
  if (!out.has('with-data')) {
    out.set('with-data', {
      state: 'with-data',
      key: null,
      driver: 'fixture',
      detail: `default render of ${route ?? 'the route'}${s?.fixture ? ` (fixture ${s.fixture})` : ''}`,
    });
  }
  return sortStates([...out.keys()]).map((k) => out.get(k));
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

/**
 * Designed states for the matrix: figmaSpec.states when it lists any, otherwise
 * states discovered from figmaSpec.layers. The main frame (figmaSpec.nodeId/name,
 * else the depth-0 layer) designs the state its own name maps to (with-data unless
 * the synonym table says otherwise) when no entry covers that state and the frame
 * is not already assigned to another state. Hand-written specs (MCP mode) often
 * leave "states" empty; the with-data design must not get lost. Ids are kept as
 * listed (stateId only); a second frame with a taken id goes to `collisions` as
 * [kept, other], never merged into the first.
 */
export function designedStates(figmaSpec, collisions = null) {
  if (!figmaSpec || typeof figmaSpec !== 'object') return [];
  const listed = Array.isArray(figmaSpec.states) && figmaSpec.states.length ? figmaSpec.states : discoverFigmaStates(figmaSpec);
  const out = [];
  const ids = new Set(listed.map((e) => stateId(e?.state)));
  for (const entry of listed) {
    let state = stateId(entry?.state);
    if (!state) continue;
    // A label written in place of an id ("Default", "Empty state") names its state, unless that id is listed too.
    const label = state !== entry.state && matchStateLabel(state);
    if (label && !ids.has(label)) state = label;
    const same = out.find((o) => o.state === state);
    if (!same) out.push({ ...entry, state });
    else if (same.nodeId !== entry.nodeId) collisions?.push([same, entry]);
  }
  const root = (Array.isArray(figmaSpec.layers) ? figmaSpec.layers : []).find((l) => (l?.depth ?? 0) === 0) || null;
  const nodeId = figmaSpec.nodeId ?? root?.id ?? null;
  const name = figmaSpec.name ?? root?.name ?? '';
  const type = figmaSpec.type ?? root?.type ?? null;
  if (nodeId && type !== 'COMPONENT_SET' && !out.some((o) => o.nodeId === nodeId)) {
    const state = stateFromName(name) ?? 'with-data';
    if (!out.some((o) => o.state === state)) out.push({ state, nodeId, name, source: 'frame-name' });
  }
  return out;
}

/** A positive integer { width, height }, or null. */
function frameSize(f) {
  const w = Math.round(Number(f?.width));
  const h = Math.round(Number(f?.height));
  return w >= 1 && h >= 1 ? { width: w, height: h } : null;
}

/**
 * The designed frame's full size for a matrix row: the state's own frame (a state frame,
 * an overlay, a breakpoint), else the screen's frame (spec.frame of a per-screen spec),
 * else the main frame's box. validate.mjs uses it to catch a truncated comparison.
 */
function designedFrame(d, figmaSpec) {
  const root = (Array.isArray(figmaSpec?.layers) ? figmaSpec.layers : []).find((l) => (l?.depth ?? 0) === 0);
  return frameSize(d?.frame) ?? frameSize(figmaSpec?.frame) ?? frameSize(root?.absoluteBoundingBox);
}

/**
 * State-matrix rows for the designed states (captured: null, findings: []), with
 * the ticket's criteria and the config's drivers attached. See the header comment
 * for the provisional result rules. With `screen`, state ids are "<screen>/<state>"
 * and every row carries `screen`.
 */
export function buildStateMatrix({ figmaSpec = null, ticket = null, config = null, surface = null, screen = null, passStates = null } = {}) {
  const designed = new Map(designedStates(figmaSpec).map((s) => [s.state, s]));
  const specified = new Map(discoverTicketStates(ticket).map((s) => [s.state, s]));
  const implemented = new Map(discoverConfigStates(config, surface, new Set(designed.keys()), { screen, passStates }).map((s) => [s.state, s]));
  const states = sortStates([...designed.keys()].filter(Boolean));
  const surfaceName = surface ?? Object.keys(config?.surfaces ?? {})[0] ?? '<surface>';
  const hook = (state, key) => `surfaces.${surfaceName}.states.${key ?? state}`;

  return states.map((state) => {
    const d = designed.get(state);
    const sp = specified.get(state);
    const im = implemented.get(state);
    const row = {
      state: screen ? `${screen}/${state}` : state,
      ...(screen ? { screen } : {}),
      label: stateLabel(state),
      designed: { nodeId: d.nodeId, name: d.name ?? '', ...(designedFrame(d, figmaSpec) ? { frame: designedFrame(d, figmaSpec) } : {}) },
      specified: sp ? { acRef: sp.acRef ?? 'AC-?', text: sp.text } : null,
      implemented: im ? { driver: im.driver, detail: im.detail } : null,
      captured: null,
      result: null,
      note: null,
      findings: [],
    };
    const set = (result, note) => {
      row.result = result;
      row.note = note;
    };
    if (!im) {
      set(
        'MISSING_IN_CODE',
        `Designed (${d.name || d.nodeId})${sp ? ` and specified in ${sp.acRef}` : ''} but not implemented: if the code has it, add a driver at ${hook(state)}; otherwise build it.`,
      );
    } else if (im.driver === 'source') {
      set(
        'CANNOT_VERIFY',
        `Implemented in code (${im.detail}) but nothing can drive it at runtime: add a fixture, query, mock, storage or action driver at ${hook(state, im.key)}.`,
      );
    } else {
      set('CANNOT_VERIFY', `Pending capture; compare replaces this with PASS/FAIL.${sp ? '' : ' Not in the ticket.'}`);
    }
    if (d.kind === 'overlay') {
      // A popper, menu or tooltip frame: smaller than the screen, opened by an interaction.
      const size = d.frame ? ` (${d.frame.width}×${d.frame.height})` : '';
      row.note += ` Overlay frame${size} shown over the screen: drive it with an action driver${d.trigger ? ` (${d.trigger})` : ''} and compare it by styles; its design PNG is the overlay's size, not the viewport's.`;
    }
    return row;
  });
}

// ---------------------------------------------------------------------------
// Design backfill candidates (step 2)
// ---------------------------------------------------------------------------

/**
 * States that exist in the app (config) or in the ticket but not in the design:
 * the design-backfill candidates. Never matrix rows. Returns
 * [{ state, screen, label, discoveredBy: "config"|"ticket", detail, driver }]:
 *   config: a configured state the design does not define (driver = the config
 *           DRIVER when it can be driven at runtime, else null);
 *   ticket: a state named in the ticket's expected behaviours / AC that the design
 *           does not define (and the config does not list; otherwise its AC is
 *           appended to the config candidate's detail).
 * The implicit with-data of a ticket (its first plain criterion) is never a
 * candidate. "source" candidates (found in code) are added by the agent. With
 * `screen`, state ids are "<screen>/<state>".
 */
export function discoverUndesigned({ figmaSpec = null, ticket = null, config = null, surface = null, screen = null } = {}) {
  const designed = new Set(designedStates(figmaSpec).map((d) => d.state));
  const surfaces = config?.surfaces && typeof config.surfaces === 'object' ? config.surfaces : {};
  const surfaceName = surface ?? Object.keys(surfaces)[0] ?? null;
  const s = surfaceName ? surfaces[surfaceName] : null;
  const out = new Map();
  const id = (state) => (screen ? `${screen}/${state}` : state);

  for (const [key, local, driver] of screenKeys(s?.states, screen)) {
    const state = keyState(local, designed);
    if (!state || designed.has(state) || out.has(state)) continue;
    const kind = driverKind(driver);
    if (!kind && state === 'with-data') continue; // the default render: never undesigned on its own
    const where = `config surfaces.${surfaceName}.states.${key}`;
    const runtime = kind && kind !== 'source';
    out.set(state, {
      state: id(state),
      screen: screen ?? null,
      label: stateLabel(state),
      discoveredBy: 'config',
      detail: runtime
        ? `${where}: ${describeDriver(driver)}`
        : kind === 'source'
          ? `${where}: source ${driver.source} (no runtime driver)`
          : `${where}: listed without a runtime driver`,
      driver: runtime ? structuredClone(driver) : null,
    });
  }
  for (const t of discoverTicketStates(ticket)) {
    if (t.state === 'with-data' || designed.has(t.state)) continue;
    const ac = `${t.acRef ?? 'AC-?'}: ${t.text}`.trim();
    const existing = out.get(t.state);
    if (existing) {
      existing.detail = `${existing.detail}; ticket ${ac}`;
      continue;
    }
    out.set(t.state, { state: id(t.state), screen: screen ?? null, label: stateLabel(t.state), discoveredBy: 'ticket', detail: `ticket ${ac}`, driver: null });
  }
  return sortStates([...out.keys()]).map((k) => out.get(k));
}

// ---------------------------------------------------------------------------
// Design census checks
// ---------------------------------------------------------------------------

/** True when the spec covers a page, a section, several nodes or a --screens auto fetch: one matrix over its screens. */
export function isMultiScreenSpec(figmaSpec) {
  const root = (Array.isArray(figmaSpec?.layers) ? figmaSpec.layers : []).find((l) => (l?.depth ?? 0) === 0);
  return GROUPING_TYPES.has(figmaSpec?.type ?? root?.type) || Array.isArray(figmaSpec?.screens);
}

function nodeBox(spec, nodeId) {
  const layer = [...(spec?.layers ?? []), ...(spec?.siblings ?? [])].find((l) => l?.id === nodeId);
  const b = layer?.absoluteBoundingBox;
  return b && b.width ? { width: Math.round(b.width), height: Math.round(b.height) } : null;
}

const sizeText = (f) => `${f.width}×${f.height}`;

function configuredSize(value) {
  if (!value || typeof value !== 'object') return null;
  const v = value.frame && typeof value.frame === 'object' ? value.frame : value.viewport && typeof value.viewport === 'object' ? value.viewport : value;
  const w = Number(v.width);
  const h = Number(v.height);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { width: Math.round(w), height: Math.round(h) } : null;
}

/**
 * What the census cannot settle by itself: ticket Figma links the spec does not cover,
 * the config pointing at a frame inside the fetched section, and configured frame sizes
 * that differ from the fetched ones (the fetched size wins).
 * Returns { warnings: [string], notes: [string], ticketLinks: { covered, uncovered, otherFiles, ignored } }.
 * coveredIds: every node id the spec (and its per-screen specs) contains.
 */
export function censusChecks({ figmaSpec, census, ticket = null, config = null, surface = null, coveredIds = new Set(), frameMap = new Map(), multi = false }) {
  const warnings = [];
  const notes = [];
  const fileKey = figmaSpec?.fileKey ?? null;
  const ticketLinks = { covered: [], uncovered: [], otherFiles: [], ignored: [] };
  for (const ref of figmaNodeRefs(ticket?.figmaUrls)) {
    if (!ref.nodeId) continue;
    const item = { nodeId: ref.nodeId, fileKey: ref.fileKey, url: ref.url };
    if (fileKey && ref.fileKey !== fileKey && ref.mainFileKey !== fileKey) ticketLinks.otherFiles.push(item);
    else if (coveredIds.has(ref.nodeId)) ticketLinks.covered.push(item);
    else if (frameMap.get(ref.nodeId)?.ignore) ticketLinks.ignored.push({ ...item, reason: frameMap.get(ref.nodeId).ignore });
    else ticketLinks.uncovered.push(item);
  }
  if (ticketLinks.uncovered.length) {
    warnings.push(
      `the ticket links ${ticketLinks.uncovered.length} other Figma node(s) not covered by this spec: fetch them (or the section that contains them) and run discovery on that spec (` +
        `${ticketLinks.uncovered.map((r) => r.nodeId).join(', ')}); a link that is not part of this design goes in the frame map as { "ignore": "<reason>" }`,
    );
  }
  if (ticketLinks.otherFiles.length) {
    warnings.push(`the ticket also links ${ticketLinks.otherFiles.length} node(s) in another Figma file (${[...new Set(ticketLinks.otherFiles.map((r) => r.fileKey))].join(', ')}): check whether they are part of this design`);
  }

  const surfaces = config?.surfaces && typeof config.surfaces === 'object' ? config.surfaces : {};
  const surfaceName = surface ?? Object.keys(surfaces)[0] ?? null;
  const s = surfaceName ? surfaces[surfaceName] : null;
  const where = (key) => `surfaces.${surfaceName}.${key}`;
  const configNode = normalizeNodeId(s?.figma?.nodeId);
  const rootId = figmaSpec?.nodeId ?? census?.root?.nodeId ?? null;
  if (configNode && rootId && configNode !== rootId) {
    const row = census?.frames.find((f) => f.nodeId === configNode);
    if (row) {
      notes.push(
        `config ${where('figma')} points at frame ${configNode} (${oneLine(row.name)}) inside the fetched ${String(census.root?.type ?? 'node').toLowerCase()} ${rootId}: ` +
          `the wider node wins, so this pass covers all ${census.frames.length} of its frames`,
      );
    } else if (!coveredIds.has(configNode)) {
      warnings.push(`config ${where('figma')}.nodeId is ${configNode} but this spec is node ${rootId}, which does not contain it: check which design this pass compares (a ticket link or an explicit link wins over the config)`);
    }
  }
  // Configured frame sizes: the fetched size wins.
  const mismatch = (key, configured, actual, label) => {
    if (configured && actual && (configured.width !== actual.width || configured.height !== actual.height)) {
      warnings.push(`config ${where(key)} says ${sizeText(configured)} but the fetched frame ${label} is ${sizeText(actual)}: the fetched size wins; capture with --width ${actual.width} --height ${actual.height} and correct the config`);
    }
  };
  if (s?.figma && !multi) mismatch('figma.frame', configuredSize(s.figma), figmaSpec?.frame, `${oneLine(figmaSpec?.name ?? '')} (${rootId})`);
  for (const screen of census?.screens ?? []) {
    const entry = s?.screens?.[screen.id];
    if (entry) mismatch(`screens.${screen.id}.frame`, configuredSize(entry.frame ?? entry.viewport ?? null), screen.frame, `${oneLine(screen.name)} (${screen.nodeId})`);
  }
  if (!multi) {
    const all = designedStates(figmaSpec);
    for (const [key, driver] of Object.entries(s?.states ?? {})) {
      if (!driver?.viewport) continue;
      const state = keyState(key, new Set(all.map((d) => d.state)));
      const designed = all.find((d) => d.state === state);
      if (!designed || designed.kind === 'overlay') continue;
      const actual = designed.frame ?? (designed.nodeId === rootId ? figmaSpec?.frame : nodeBox(figmaSpec, designed.nodeId));
      mismatch(`states.${key}.viewport`, configuredSize(driver.viewport), actual, `of state ${state} (${designed.nodeId})`);
    }
  }
  return { warnings, notes, ticketLinks };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Lines of the matrix table and of the census frame list printed by default (--verbose: all). */
const SHOWN_ROWS = 25;

const HELP = `Build a provisional state matrix from a Figma spec, a ticket and the config,
and account for every designed frame (the design census).

Usage:
  node scripts/lib/state-discovery.mjs --figma-spec figma-spec.json [--ticket ticket.json]
      [--config design-qa.config.json --surface <name>] [--screen <id>] --out state-matrix.json
      [--backfill-out backfill-candidates.json] [--frame-map frame-map.json]
      [--census-out design-census.json] [--states <dir>/states.json] [--strict] [--verbose] [--quiet]

Output: the matrix table and the census frame list show the first ${SHOWN_ROWS} lines each
(--verbose: all; the files always hold everything); unmapped frames and warnings are
always printed in full.

One row per state the design defines (states only in the ticket or only in code
are not rows). Each row gets specified/implemented from the ticket and the config
(and the pass's own drivers, --states, which win over the config's; a key
"<screen>/<state>" counts for that screen only), and a provisional result:
  designed, not implemented                  MISSING_IN_CODE
  designed + implemented via "source" only   CANNOT_VERIFY (names the missing driver)
  designed + implemented                     CANNOT_VERIFY, pending capture
Capture and compare replace the pending-capture rows with PASS/FAIL. The main
Figma frame counts as the with-data design when figma-spec.json "states" does not
cover it (its own name can map it to another state instead). --screen <id> writes
multi-screen ids ("<id>/<state>") and sets each row's screen.

Pages, sections and multi-screen specs: when the spec is a page, a section, several
nodes (figma-mcp-spec.mjs) or a --screens auto fetch, the matrix covers every screen
of it at once, ids "<screen>/<state>" (per-screen specs in screens/<id>/ next to the
spec are used when present). --screen <id> then keeps one screen.

Design census (written to --census-out, default design-census.json next to --out):
every top-level frame of the fetched node with its id, name, size and what it maps to
(a screen, a state, a breakpoint variant "<screen>-<width>" with its own frame size, or
an overlay state with its trigger), plus "unmapped": frames whose mapping is a
judgement call, each with the provisional mapping used in the matrix. Confirm or
change them in a frame map (--frame-map) and re-run:
  { "<nodeId>": { "screen": "<id>", "state": "<id>", "trigger": "hover|click|…",
                  "variantOf": "<screen id>" } | { "ignore": "<reason>" } }
A node id the ticket links that is not part of this design can be ignored the same way.
Also warned: ticket Figma links this spec does not cover, a config frame inside the
fetched section (the wider node wins) and configured sizes that differ from the
fetched frames (the fetched size wins).

--backfill-out <file> also writes the design-backfill candidates (step 2, after
parity; never matrix rows): states the config or the ticket has that the design
does not define:
  { "generatedAt", "surface", "candidates": [ { "state", "screen", "label",
    "discoveredBy": "config|ticket", "detail", "driver": DRIVER|null } ] }
Add states you find in source by hand ("discoveredBy": "source") or with
backfill.mjs --add. Merge them into report.json with
  node scripts/backfill.mjs --report <dir>/report.json --candidates <file>
--out or --backfill-out (or both) is required.

Exit codes: 0 ok · 1 error · 2 bad arguments · 3 two designed frames would share one
state id, or a mapped frame has no row · 4 --strict and a designed frame or a ticket
Figma link is unaccounted for (the files are still written)`;

/** Frame-map file → Map (usage error on a bad entry). */
function readFrameMap(file) {
  if (!file) return new Map();
  try {
    return normalizeFrameMap(readJsonFile(file, 'frame map'));
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw usageError(`--frame-map ${oneLine(file)}: ${oneLine(err.message)}`);
  }
}

/** The per-screen specs of a multi-screen spec: screens/<id>/figma-spec.json next to it, else cut from it. */
function screenSpecs(figmaSpec, census, specFile) {
  return census.screens.map((screen) => {
    const file = specFile ? path.join(path.dirname(path.resolve(specFile)), 'screens', screen.id, 'figma-spec.json') : null;
    if (file && existsSync(file)) return { screen, spec: withCensusStates(readJsonFile(file, `screen spec ${screen.id}`), screen, census), file };
    return { screen, spec: screenSpecFrom(figmaSpec, screen), file: null };
  });
}

async function main(argv) {
  const { values } = parseCli(argv, {
    'figma-spec': { type: 'string' },
    ticket: { type: 'string' },
    config: { type: 'string' },
    surface: { type: 'string' },
    screen: { type: 'string' },
    out: { type: 'string' },
    'backfill-out': { type: 'string' },
    'frame-map': { type: 'string' },
    'census-out': { type: 'string' },
    states: { type: 'string' },
    strict: { type: 'boolean' },
    verbose: { type: 'boolean' },
    quiet: { type: 'boolean' },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (!values['figma-spec']) {
    throw usageError('--figma-spec is required: the rows are the states the design defines (--ticket and --config are optional); see --help');
  }
  if (values.screen !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(values.screen)) {
    throw usageError(`--screen must be a kebab-case id like "cart" (got "${values.screen}")`);
  }
  if (!values.out && !values['backfill-out']) throw usageError('--out <state-matrix.json> is required (and/or --backfill-out <backfill-candidates.json>)');
  const figmaSpec = values['figma-spec'] ? readJsonFile(values['figma-spec'], 'figma spec') : null;
  const ticket = values.ticket ? readJsonFile(values.ticket, 'ticket') : null;
  const config = values.config ? readJsonFile(values.config, 'config') : null;
  const passStates = values.states ? readJsonFile(values.states, 'states file') : null;
  if (config && values.surface && !config.surfaces?.[values.surface]) {
    throw usageError(`surface "${values.surface}" is not in ${values.config} (have: ${Object.keys(config.surfaces || {}).join(', ') || 'none'})`);
  }
  if (config && !values.surface && Object.keys(config.surfaces || {}).length > 1) {
    throw usageError(`the config has several surfaces; pass --surface (one of: ${Object.keys(config.surfaces).join(', ')})`);
  }
  const log = values.quiet ? () => {} : (msg) => console.log(msg);
  // Warnings quote Figma names: always one line.
  const warn = (msg) => console.error(`warning: ${oneLine(msg)}`);
  const frameMap = readFrameMap(values['frame-map']);
  let census;
  try {
    census = designCensus(figmaSpec, { frameMap });
  } catch (err) {
    throw usageError(`--frame-map: ${oneLine(err.message)}`);
  }
  const multi = isMultiScreenSpec(figmaSpec);
  const base = { ticket, config, surface: values.surface ?? null };

  // The specs the rows come from: every screen of a multi-screen spec, else the spec itself
  // with the census states merged in (a frame the census maps is never left out).
  let parts;
  if (multi) {
    parts = screenSpecs(figmaSpec, census, values['figma-spec']);
    if (values.screen) {
      parts = parts.filter((p) => p.screen.id === values.screen);
      if (!parts.length) throw usageError(`--screen ${values.screen}: this spec's screens are ${census.screens.map((x) => x.id).join(', ') || 'none'}`);
    }
    if (!census.screens.length) warn(`no screen frames found under ${oneLine(figmaSpec?.name ?? '')} (${oneLine(figmaSpec?.nodeId ?? '')}): link a page, a section or a frame`);
  } else {
    const { screen: rootScreen, states } = frameSpecStates(figmaSpec, census);
    parts = [{ screen: null, spec: { ...figmaSpec, states }, file: null, censusScreen: rootScreen }];
    for (const other of census.screens.filter((x) => x !== rootScreen)) {
      warn(`the frames of ${oneLine(other.name)} (${other.id}, ${other.frame.width}×${other.frame.height}) form another screen this single-frame matrix does not cover: run discovery on the page or section spec (figma-fetch --screens auto, or figma-mcp-spec on its metadata)`);
    }
  }

  const coveredIds = new Set([figmaSpec?.nodeId, ...(figmaSpec?.nodes ?? [])].filter(Boolean));
  for (const l of [...(figmaSpec?.layers ?? []), ...(figmaSpec?.siblings ?? [])]) if (l?.id) coveredIds.add(l.id);
  for (const p of parts) for (const l of p.spec?.layers ?? []) if (l?.id) coveredIds.add(l.id);
  const checks = censusChecks({ figmaSpec, census, ...base, coveredIds, frameMap, multi });

  // Every designed frame is a row of its own: frames sharing an id, or a census frame without its row, stop the run.
  const collisions = [];
  for (const p of parts) designedStates(p.spec, collisions);
  const rows = parts.flatMap((p) => buildStateMatrix({ figmaSpec: p.spec, ...base, passStates, screen: multi ? p.screen.id : values.screen ?? null }));
  const covered = new Set(parts.map((p) => (p.screen ?? p.censusScreen)?.id));
  const rowKeys = new Set(rows.map((r) => `${r.designed.nodeId} ${r.state.split('/').pop()}`));
  const lost = census.frames.filter((f) => f.mappedTo?.screen && covered.has(f.mappedTo.screen) && !rowKeys.has(`${f.nodeId} ${f.mappedTo.state}`));
  const dropped = [
    ...collisions.map(([a, b]) => `${oneLine(a.nodeId)} "${oneLine(a.name ?? '')}" and ${oneLine(b.nodeId)} "${oneLine(b.name ?? '')}" share the state id "${a.state}"`),
    ...lost.map((f) => `${oneLine(f.nodeId)} "${oneLine(f.name)}" (${f.mappedTo.screen}/${f.mappedTo.state}) has no row`),
  ];

  if (values.out) {
    writeJson(values.out, rows);
    if (!values.quiet) {
      const flag = (v) => (v ? 'yes' : '–');
      const width = Math.max(14, ...rows.map((r) => r.state.length));
      console.log(`${'state'.padEnd(width)} specified  implemented  result`);
      const shownRows = values.verbose ? rows : rows.slice(0, SHOWN_ROWS);
      for (const r of shownRows) {
        console.log(`${oneLine(r.state).padEnd(width)} ${flag(r.specified).padEnd(10)} ${(r.implemented?.driver ?? '–').padEnd(12)} ${r.result}`);
      }
      if (shownRows.length < rows.length) console.log(`… ${rows.length - shownRows.length} more in ${oneLine(displayPath(values.out))}`);
      console.log(`Wrote ${displayPath(values.out)} (${rows.length} states${multi ? ` across ${parts.length} screen(s)` : ''})`);
    }
  }
  if (values['backfill-out']) {
    const candidates = parts.flatMap((p) => discoverUndesigned({ figmaSpec: p.spec, ...base, screen: multi ? p.screen.id : values.screen ?? null }));
    const surfaceName = values.surface ?? Object.keys(config?.surfaces ?? {})[0] ?? null;
    writeJson(values['backfill-out'], { generatedAt: new Date().toISOString(), surface: surfaceName, candidates });
    if (!values.quiet) {
      for (const c of candidates) console.log(`undesigned ${oneLine(c.state).padEnd(14)} ${c.discoveredBy.padEnd(7)} ${oneLine(c.detail)}`);
      console.log(`Wrote ${displayPath(values['backfill-out'])} (${candidates.length} undesigned state(s) — design backfill, step 2, after parity; not in the matrix)`);
    }
  }

  // The census: every top-level frame, what it maps to, and what is still a judgement call.
  const censusFile = values['census-out'] ?? (values.out ? path.join(path.dirname(path.resolve(values.out)), 'design-census.json') : null);
  if (censusFile) {
    writeJson(censusFile, {
      generatedAt: new Date().toISOString(),
      figmaSpec: displayPath(path.resolve(values['figma-spec'])),
      source: figmaSpec?.source ?? 'rest',
      multiScreen: multi,
      ...census,
      ticketLinks: checks.ticketLinks,
      warnings: checks.warnings,
      notes: checks.notes,
    });
  }
  const mapped = census.frames.filter((f) => f.confirmed).length;
  log(
    `Design census: ${census.frames.length} frame(s) under ${oneLine(census.root?.name ?? '')} (${oneLine(census.root?.nodeId ?? '')}): ` +
      `${mapped} mapped, ${census.unmapped.length} unmapped; ${census.screens.length} screen(s)` +
      (census.outside.length ? `; ${census.outside.length} other frame(s) on the page not in this pass` : '') +
      (censusFile ? ` — ${displayPath(censusFile)}` : ''),
  );
  // Unmapped frames are always listed (they need a decision); mapped ones up to the cap.
  let mappedShown = 0;
  const shownFrames = census.frames.filter((f) => values.verbose || !f.confirmed || mappedShown++ < SHOWN_ROWS);
  for (const f of shownFrames) {
    const m = f.mappedTo ?? {};
    const to = m.kind === 'ignored' ? `ignored (${oneLine(m.reason)})` : `${m.kind} ${m.screen}/${m.state}${m.trigger ? ` on ${m.trigger}` : ''}${m.variantOf ? ` (variant of ${m.variantOf})` : ''}`;
    log(`  ${oneLine(f.nodeId)} ${oneLine(f.name)} ${f.frame.width}×${f.frame.height} → ${to}${f.confirmed ? '' : ' [unmapped: provisional]'}`);
  }
  if (shownFrames.length < census.frames.length) {
    log(`  … ${census.frames.length - shownFrames.length} more mapped frame(s)${censusFile ? ` in ${oneLine(displayPath(censusFile))}` : ' (--verbose lists them)'}`);
  }
  for (const n of checks.notes) log(`note: ${oneLine(n)}`);
  for (const u of census.unmapped) {
    const sug = u.suggestion ?? {};
    warn(
      `frame ${u.nodeId} "${u.name}" (${u.frame.width}×${u.frame.height}) is unmapped: ${u.reason} Provisionally ${sug.screen}/${sug.state}; ` +
        `confirm or change it in a frame map ({ "${u.nodeId}": { "screen": "${sug.screen}", "state": "${sug.state}" } }) and re-run with --frame-map`,
    );
  }
  for (const w of checks.warnings) warn(w);
  if (dropped.length) {
    throw new CliError(
      `${dropped.length} designed frame(s) would not get a state row of their own: ${dropped.slice(0, 6).join('; ')}${dropped.length > 6 ? `; … ${dropped.length - 6} more` : ''}. ` +
        'Do: give each frame its own state id (a frame map entry { "<nodeId>": { "screen": "<id>", "state": "<id>" } }, or the spec\'s "states") and re-run',
      3,
    );
  }
  const unaccounted = census.unmapped.length + checks.ticketLinks.uncovered.length;
  if (values.strict && unaccounted) {
    throw new CliError(`--strict: ${census.unmapped.length} unmapped frame(s) and ${checks.ticketLinks.uncovered.length} uncovered ticket Figma link(s); resolve them (see the warnings) and re-run`, 4);
  }
  return 0;
}

runMain(import.meta.url, main);
