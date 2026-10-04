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
// CLI: node scripts/lib/state-discovery.mjs --figma-spec f.json [--ticket t.json]
//        [--config c.json --surface name] [--screen id] --out state-matrix.json
//        [--backfill-out backfill-candidates.json]
import { displayPath, parseCli, readJsonFile, runMain, usageError, writeJson } from './args.mjs';

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
  return n.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || null;
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
  const add = (state, layer, source, order) => {
    if (!state || !layer) return;
    candidates.push({ state, nodeId: layer.id, name: layer.name ?? '', source, depth: layer.depth ?? 0, order });
  };

  const root = layers.find((l) => (l.depth ?? 0) === 0) || null;
  layers.forEach((layer, order) => {
    const depth = layer.depth ?? 0;
    const variants = layer.variantProperties && typeof layer.variantProperties === 'object' ? layer.variantProperties : null;
    if (variants) {
      for (const [key, value] of Object.entries(variants)) {
        if (STATE_KEYS.test(key.trim())) add(normalizeStateName(value), layer, 'variant', order);
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
  for (const c of candidates) {
    const cur = best.get(c.state);
    const better =
      !cur ||
      SOURCE_PRIORITY[c.source] < SOURCE_PRIORITY[cur.source] ||
      (SOURCE_PRIORITY[c.source] === SOURCE_PRIORITY[cur.source] && (c.depth < cur.depth || (c.depth === cur.depth && c.order < cur.order)));
    if (better) best.set(c.state, c);
  }
  return sortStates([...best.keys()]).map((state) => {
    const c = best.get(state);
    return { state, nodeId: c.nodeId, name: c.name, source: c.source };
  });
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
 * (exists in code, no runtime driver).
 */
export function discoverConfigStates(config, surface) {
  const surfaces = config?.surfaces && typeof config.surfaces === 'object' ? config.surfaces : {};
  const s = surface ? surfaces[surface] : Object.values(surfaces)[0];
  const route = s?.route ?? null;
  const out = new Map();
  for (const [key, driver] of Object.entries(s?.states || {})) {
    const state = normalizeStateName(key);
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
 * leave "states" empty; the with-data design must not get lost.
 */
export function designedStates(figmaSpec) {
  if (!figmaSpec || typeof figmaSpec !== 'object') return [];
  const listed = Array.isArray(figmaSpec.states) && figmaSpec.states.length ? figmaSpec.states : discoverFigmaStates(figmaSpec);
  const out = [];
  for (const entry of listed) {
    const state = normalizeStateName(entry?.state);
    if (state && !out.some((o) => o.state === state)) out.push({ ...entry, state });
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

/**
 * State-matrix rows for the designed states (captured: null, findings: []), with
 * the ticket's criteria and the config's drivers attached. See the header comment
 * for the provisional result rules. With `screen`, state ids are "<screen>/<state>"
 * and every row carries `screen`.
 */
export function buildStateMatrix({ figmaSpec = null, ticket = null, config = null, surface = null, screen = null } = {}) {
  const designed = new Map(designedStates(figmaSpec).map((s) => [s.state, s]));
  const specified = new Map(discoverTicketStates(ticket).map((s) => [s.state, s]));
  const implemented = new Map(discoverConfigStates(config, surface).map((s) => [s.state, s]));
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
      designed: { nodeId: d.nodeId, name: d.name ?? '' },
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

  for (const [key, driver] of Object.entries(s?.states || {})) {
    const state = normalizeStateName(key);
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
// CLI
// ---------------------------------------------------------------------------

const HELP = `Build a provisional state matrix from a Figma spec, a ticket and the config.

Usage:
  node scripts/lib/state-discovery.mjs --figma-spec figma-spec.json [--ticket ticket.json]
      [--config design-qa.config.json --surface <name>] [--screen <id>] --out state-matrix.json
      [--backfill-out backfill-candidates.json]

One row per state the design defines (states only in the ticket or only in code
are not rows). Each row gets specified/implemented from the ticket and the config,
and a provisional result:
  designed, not implemented                  MISSING_IN_CODE
  designed + implemented via "source" only   CANNOT_VERIFY (names the missing driver)
  designed + implemented                     CANNOT_VERIFY, pending capture
Capture and compare replace the pending-capture rows with PASS/FAIL. The main
Figma frame counts as the with-data design when figma-spec.json "states" does not
cover it (its own name can map it to another state instead). --screen <id> writes
multi-screen ids ("<id>/<state>") and sets each row's screen.

--backfill-out <file> also writes the design-backfill candidates (step 2, after
parity; never matrix rows): states the config or the ticket has that the design
does not define:
  { "generatedAt", "surface", "candidates": [ { "state", "screen", "label",
    "discoveredBy": "config|ticket", "detail", "driver": DRIVER|null } ] }
Add states you find in source by hand ("discoveredBy": "source") or with
backfill.mjs --add. Merge them into report.json with
  node scripts/backfill.mjs --report <dir>/report.json --candidates <file>
--out or --backfill-out (or both) is required.

Exit codes: 0 ok · 1 error · 2 bad arguments`;

async function main(argv) {
  const { values } = parseCli(argv, {
    'figma-spec': { type: 'string' },
    ticket: { type: 'string' },
    config: { type: 'string' },
    surface: { type: 'string' },
    screen: { type: 'string' },
    out: { type: 'string' },
    'backfill-out': { type: 'string' },
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
  if (config && values.surface && !config.surfaces?.[values.surface]) {
    throw usageError(`surface "${values.surface}" is not in ${values.config} (have: ${Object.keys(config.surfaces || {}).join(', ') || 'none'})`);
  }
  if (config && !values.surface && Object.keys(config.surfaces || {}).length > 1) {
    throw usageError(`the config has several surfaces; pass --surface (one of: ${Object.keys(config.surfaces).join(', ')})`);
  }
  const inputs = { figmaSpec, ticket, config, surface: values.surface ?? null, screen: values.screen ?? null };
  if (values.out) {
    const rows = buildStateMatrix(inputs);
    writeJson(values.out, rows);
    if (!values.quiet) {
      const flag = (v) => (v ? 'yes' : '–');
      console.log('state          specified  implemented  result');
      for (const r of rows) {
        console.log(`${r.state.padEnd(14)} ${flag(r.specified).padEnd(10)} ${(r.implemented?.driver ?? '–').padEnd(12)} ${r.result}`);
      }
      console.log(`Wrote ${displayPath(values.out)} (${rows.length} states)`);
    }
  }
  if (values['backfill-out']) {
    const candidates = discoverUndesigned(inputs);
    const surfaceName = values.surface ?? Object.keys(config?.surfaces ?? {})[0] ?? null;
    writeJson(values['backfill-out'], { generatedAt: new Date().toISOString(), surface: surfaceName, candidates });
    if (!values.quiet) {
      for (const c of candidates) console.log(`undesigned ${c.state.padEnd(14)} ${c.discoveredBy.padEnd(7)} ${c.detail}`);
      console.log(`Wrote ${displayPath(values['backfill-out'])} (${candidates.length} undesigned state(s) — design backfill, step 2, after parity; not in the matrix)`);
    }
  }
  return 0;
}

runMain(import.meta.url, main);
