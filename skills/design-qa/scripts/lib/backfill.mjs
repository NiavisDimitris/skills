// Design backfill (step 2 of 2): states the app has but the design does not, built
// back into Figma with the design-system library once production matches the
// design. Pure functions on report.json's optional `backfill` block: merge
// discovered candidates, attach app-only captures, record decisions (build /
// not-needed with a reason), the gate override, built frames, and the two import
// formats (backfill.json from report.html and the "/design-qa backfill <slug>" chat
// message). Nothing here touches step 1 (stateMatrix, findings, parity, triage).
import { parseFigmaUrl, normalizeNodeId } from './figma-url.mjs';
import {
  BACKFILL_DECISIONS,
  BACKFILL_DISCOVERED_BY,
  backfillItems,
  backfillOverride,
  backfillSummary,
  band,
  hasBackfill,
  isBackfillBuilt,
  isBackfillReady,
  isLoopClosed,
  unexplainedFindings,
} from './ranking.mjs';
import { isRfc3339DateTime } from './schema-check.mjs';
import { stateLabel } from './state-discovery.mjs';
import { reportSlug } from './triage.mjs';

export { BACKFILL_DECISIONS, BACKFILL_DISCOVERED_BY, backfillSummary, isBackfillReady };

/** Decisions a person records (the chat message and backfill.json carry these two). */
export const DECIDE_CHOICES = Object.freeze(['build', 'not-needed']);

const ID_RE = /^BF-\d{3,}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const orNull = (v) => (text(v) ? text(v) : null);
const posixJoin = (a, b) => (a ? `${a.replace(/\/+$/, '')}/${String(b).replace(/^\.\//, '')}` : String(b));

/** Raised by recordBuilt when frames may not be built yet (the CLI exits 1). */
export class BackfillGateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackfillGateError';
  }
}

/** A date-time the validator accepts (RFC 3339); anything else falls back to "now" where it is recorded. */
export function isIsoDateTime(value) {
  return isRfc3339DateTime(value);
}

/** "BF-001" for 1 (three digits at least). */
export const formatBackfillId = (n) => `BF-${String(n).padStart(3, '0')}`;
const idNumber = (id) => {
  const m = /^BF-(\d+)$/.exec(String(id ?? ''));
  return m ? Number(m[1]) : 0;
};

/** An empty backfill block. */
export function emptyBackfill() {
  return { gate: { override: null }, items: [] };
}

/** "cart/empty" → "empty"; "empty" → "empty". */
export function stripScreen(state) {
  const s = String(state ?? '');
  return s.includes('/') ? s.slice(s.indexOf('/') + 1) : s;
}

/** Normalise a decision ("Build in Figma", "not needed", …) to a BACKFILL_DECISIONS value, else null. */
export function normalizeDecision(decision) {
  const d = String(decision ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  if (d === 'build' || d === 'build-in-figma') return 'build';
  if (d === 'not-needed' || d === 'notneeded' || d === 'not-need') return 'not-needed';
  if (d === 'pending' || d === 'undo') return 'pending';
  return null;
}

/** The meta.screens name of a screen id (else the id itself, else null). */
export function screenName(report, screen) {
  if (!screen) return null;
  const s = (Array.isArray(report?.meta?.screens) ? report.meta.screens : []).find((x) => x && x.id === screen);
  return s?.name || screen;
}

/**
 * The name of the frame to build, in the file's convention "<Screen> – <State>":
 * the screen's name, else the anchor frame's family ("Orders – With data" → "Orders"),
 * else the feature.
 */
export function frameName(item, report) {
  const family = (name) => String(name ?? '').split(/\s+[–—-]\s+|\s*\/\s*/)[0].trim();
  const base = screenName(report, item?.screen) || family(item?.anchor?.name) || report?.meta?.feature || 'Screen';
  return `${base} – ${item?.label || stateLabel(stripScreen(item?.state))}`;
}

function cloneWithBackfill(report) {
  const next = structuredClone(report);
  if (!isObj(next.backfill)) next.backfill = emptyBackfill();
  if (!isObj(next.backfill.gate)) next.backfill.gate = { override: null };
  if (!Array.isArray(next.backfill.items)) next.backfill.items = [];
  return next;
}

function findItem(report, id) {
  const items = backfillItems(report);
  const item = items.find((i) => i.id === id);
  if (!item) {
    const known = items.map((i) => i.id).join(', ') || 'none';
    throw new Error(`unknown backfill id: ${id} (have: ${known})`);
  }
  return item;
}

// ---------------------------------------------------------------------------
// Candidates

/**
 * One candidate as stored: { state, screen, label, discoveredBy, detail, driver }.
 * A screen prefixes the state ("cart/bulk-selected"); a prefixed state without a
 * screen takes the prefix as its screen. discoveredBy defaults to "source".
 * Throws on a missing state or an unknown discoveredBy.
 */
export function normalizeCandidate(raw, where = 'candidate') {
  if (!isObj(raw)) throw new Error(`${where}: each candidate must be an object`);
  let state = text(raw.state);
  if (!state) throw new Error(`${where}: "state" is required`);
  let screen = orNull(raw.screen);
  if (screen && !state.startsWith(`${screen}/`)) state = `${screen}/${stripScreen(state)}`;
  if (!screen && state.includes('/')) screen = state.slice(0, state.indexOf('/'));
  const discoveredBy = text(raw.discoveredBy) || 'source';
  if (!BACKFILL_DISCOVERED_BY.includes(discoveredBy)) {
    throw new Error(`${where} (${state}): discoveredBy must be one of ${BACKFILL_DISCOVERED_BY.join(', ')} (got "${raw.discoveredBy}")`);
  }
  if (raw.driver !== undefined && raw.driver !== null && !isObj(raw.driver)) throw new Error(`${where} (${state}): driver must be an object or null`);
  return {
    state,
    screen,
    label: text(raw.label) || stateLabel(stripScreen(state)),
    discoveredBy,
    detail: orNull(raw.detail),
    driver: isObj(raw.driver) ? structuredClone(raw.driver) : null,
  };
}

/** Candidates from backfill-candidates.json ({ candidates: [...] }) or a bare array. */
export function parseCandidatesFile(data) {
  const list = Array.isArray(data) ? data : isObj(data) && Array.isArray(data.candidates) ? data.candidates : null;
  if (!list) throw new Error('expected backfill-candidates.json: { "generatedAt", "surface", "candidates": [ … ] }');
  return list.map((c, i) => normalizeCandidate(c, `candidates[${i}]`));
}

/** A new item for a candidate: pending, nothing captured, decided or built yet. */
export function newItem(id, candidate) {
  return {
    id,
    state: candidate.state,
    screen: candidate.screen ?? null,
    label: candidate.label,
    discoveredBy: candidate.discoveredBy,
    detail: candidate.detail ?? null,
    driver: candidate.driver ?? null,
    captured: null,
    anchor: null,
    components: [],
    tokens: [],
    decision: 'pending',
    decidedBy: null,
    decidedAt: null,
    reason: null,
    figma: null,
    dsGaps: [],
  };
}

/**
 * Upsert candidates into report.backfill.items by screen + state (creating the
 * block when missing). Existing items keep their id, label, capture, anchor,
 * components, tokens, decision and Figma frame; discoveredBy, detail and driver are
 * refreshed (a null detail/driver never overwrites a known one). States the design
 * defines (stateMatrix rows, compared without letter case, as items are) are skipped.
 * Returns { report, added, updated, skipped: [{ state, why }] } (ids). Throws on an
 * invalid candidate.
 */
export function mergeCandidates(report, candidates = []) {
  const next = cloneWithBackfill(report);
  const items = next.backfill.items;
  const designedStates = (Array.isArray(next.stateMatrix) ? next.stateMatrix : []).map((r) => r?.state).filter((s) => typeof s === 'string' && s);
  const designed = new Map(designedStates.map((s) => [s.toLowerCase(), s]));
  const key = (screen, state) => `${screen ?? ''}::${String(state).toLowerCase()}`;
  const byKey = new Map(items.map((i) => [key(i.screen ?? null, i.state), i]));
  let max = items.reduce((m, i) => Math.max(m, idNumber(i.id)), 0);
  const added = [];
  const updated = [];
  const skipped = [];
  candidates.forEach((raw, i) => {
    const c = normalizeCandidate(raw, `candidates[${i}]`);
    const row = designed.get(c.state.toLowerCase());
    if (row !== undefined) {
      const why = row === c.state ? 'the design defines it (a stateMatrix row)' : `the design defines it as "${row}" (a stateMatrix row; the ids differ only by letter case)`;
      skipped.push({ state: c.state, why });
      return;
    }
    const existing = byKey.get(key(c.screen, c.state));
    if (existing) {
      existing.discoveredBy = c.discoveredBy;
      if (c.detail !== null) existing.detail = c.detail;
      if (c.driver !== null) existing.driver = c.driver;
      if (!updated.includes(existing.id)) updated.push(existing.id);
      return;
    }
    max += 1;
    const item = newItem(formatBackfillId(max), c);
    items.push(item);
    byKey.set(key(c.screen, c.state), item);
    added.push(item.id);
  });
  return { report: next, added, updated, skipped };
}

/**
 * Attach app-only evidence from a capture.json written by
 * capture.mjs --out <dir>/evidence/backfill. `prefix` is the capture folder relative
 * to report.json (e.g. "evidence/backfill"); the manifest's paths are relative to it.
 * A capture state matches an item whose state equals it, else the one item whose state
 * without the screen prefix equals it; `screen` restricts matching to that screen's
 * items. Throws when an unprefixed name is an item on more than one screen and no
 * `screen` is given (a capture of one screen would be attached to another). Returns
 * { report, attached: [{ id, state }], failed: [{ id, state, reason }], unmatched: [capture state] }.
 */
export function attachCaptures(report, capture, { prefix = '', screen = null } = {}) {
  if (!isObj(capture) || !isObj(capture.states)) throw new Error('not a capture.json (no "states" object)');
  const next = cloneWithBackfill(report);
  const items = next.backfill.items.filter((i) => !screen || i.screen === screen);
  const attached = [];
  const failed = [];
  const unmatched = [];
  const rel = (p) => (typeof p === 'string' && p ? (p.startsWith('/') ? p : posixJoin(prefix, p)) : null);
  for (const [key, entry] of Object.entries(capture.states)) {
    const k = String(key).toLowerCase();
    let item = items.find((i) => String(i.state).toLowerCase() === k);
    if (!item) {
      const candidates = items.filter((i) => stripScreen(i.state).toLowerCase() === k);
      if (candidates.length > 1) {
        const which = candidates.map((i) => `${i.id} ${i.state}`).join(', ');
        throw new Error(`capture state "${key}" matches more than one backfill item (${which}): pass --screen <id> for the screen this capture is of`);
      }
      item = candidates[0];
    }
    if (!item) {
      unmatched.push(key);
      continue;
    }
    if (!isObj(entry) || !entry.screenshot) {
      const reason = (Array.isArray(entry?.degradations) && entry.degradations[0]?.reason) || entry?.error || 'no screenshot';
      failed.push({ id: item.id, state: item.state, reason: String(reason) });
      continue;
    }
    item.captured = { app: rel(entry.screenshot), computed: rel(entry.computed), dom: rel(entry.dom), motion: rel(entry.motion) };
    if (!item.driver && isObj(entry.driver) && Object.keys(entry.driver).length) item.driver = structuredClone(entry.driver);
    attached.push({ id: item.id, state: item.state });
  }
  return { report: next, attached, failed, unmatched };
}

// ---------------------------------------------------------------------------
// Decisions, gate and built frames

/**
 * Record decisions: [{ id, decision: "build"|"not-needed"|"pending", reason, by, date }].
 * not-needed needs a reason; an item already built in Figma cannot become
 * not-needed or pending. Returns { report, changes: [{ id, decision, previous }] };
 * throws Error on an unknown id, a bad decision or a missing reason.
 */
export function decideItems(report, decisions = [], { now = new Date().toISOString() } = {}) {
  if (!hasBackfill(report)) throw new Error('the report has no backfill block yet: merge candidates first (--candidates or --add)');
  const next = cloneWithBackfill(report);
  const changes = [];
  for (const d of decisions) {
    const decision = normalizeDecision(d?.decision);
    if (!decision) throw new Error(`${d?.id}: decision must be one of ${BACKFILL_DECISIONS.join(', ')} (got "${d?.decision ?? ''}")`);
    const item = findItem(next, d.id);
    const reason = text(d.reason);
    if (decision === 'not-needed' && !reason) throw new Error(`${item.id}: a reason is required for not-needed (why does "${item.label}" need no design frame?)`);
    if (isBackfillBuilt(item) && decision !== 'build') {
      throw new Error(`${item.id} is already built in Figma (${item.figma.url}); it cannot become ${decision}`);
    }
    const previous = item.decision;
    item.decision = decision;
    item.reason = reason || (decision === 'build' && previous === 'build' ? item.reason ?? null : null);
    item.decidedBy = decision === 'pending' ? null : orNull(d.by);
    item.decidedAt = decision === 'pending' ? null : isIsoDateTime(d.date) ? d.date : now;
    changes.push({ id: item.id, decision, previous });
  }
  return { report: next, changes };
}

/** Allow building before step 1 is closed: backfill.gate.override = { by, date, reason }. */
export function setOverride(report, { reason, by = null, date = new Date().toISOString() } = {}) {
  if (!text(reason)) throw new Error('an override needs a reason (why build frames before production matches the design?)');
  const next = cloneWithBackfill(report);
  next.backfill.gate.override = { by: orNull(by), date: isIsoDateTime(date) ? date : new Date().toISOString(), reason: text(reason) };
  return { report: next, override: next.backfill.gate.override };
}

/** Number of open step-1 items: unexplained findings plus open decisions. */
export function openStepOneCount(report) {
  const decisions = Array.isArray(report?.openDecisions) ? report.openDecisions.length : 0;
  return unexplainedFindings(report).length + decisions;
}

/** Why frames may not be built yet, or null when they may. */
export function gateBlocker(report) {
  if (isBackfillReady(report)) return null;
  const n = openStepOneCount(report);
  return `production does not match the design yet (${n} open in step 1: unexplained findings or open decisions). Finish step 1 first (fix or dismiss them, then re-render), or record an override: --override --reason "<why>"`;
}

/**
 * Record a frame built in Figma: figma = { nodeId, url, name, builtAt, roundTrip }.
 * Refuses (BackfillGateError) unless the backfill is ready (loopClosed or an
 * override). A pending item becomes "build"; a not-needed item is an error. The
 * node id comes from `nodeId` or the link's node-id; `roundTrip` is the pixel-diff
 * percent of the 1x export against the app capture (band from `tolerances`).
 */
export function recordBuilt(
  report,
  id,
  { figmaUrl, nodeId = null, name = null, roundTrip = null, builtAt = new Date().toISOString(), by = null, tolerances } = {},
) {
  const blocker = gateBlocker(report);
  if (blocker) throw new BackfillGateError(`cannot record ${id}: ${blocker}`);
  const parsed = parseFigmaUrl(figmaUrl);
  if (!parsed) throw new Error(`${id}: --figma-url must be a Figma link (figma.com/design/…?node-id=…), got "${figmaUrl ?? ''}"`);
  const node = nodeId !== null && nodeId !== undefined ? normalizeNodeId(nodeId) : parsed.nodeId;
  if (nodeId !== null && nodeId !== undefined && !node) throw new Error(`${id}: --node-id must be a Figma node id like 1:23 (got "${nodeId}")`);
  if (!node) throw new Error(`${id}: the Figma link has no node-id; pass --node-id <id> of the new frame`);
  if (roundTrip !== null && roundTrip !== undefined && !(typeof roundTrip === 'number' && roundTrip >= 0 && roundTrip <= 100)) {
    throw new Error(`${id}: the round-trip diff must be a percent between 0 and 100 (got ${roundTrip})`);
  }
  const next = cloneWithBackfill(report);
  const item = findItem(next, id);
  if (item.decision === 'not-needed') throw new Error(`${id} is decided not-needed ("${item.reason}"); decide it "build" first`);
  if (item.decision !== 'build') {
    item.decision = 'build';
    item.decidedBy = orNull(by);
    item.decidedAt = isIsoDateTime(builtAt) ? builtAt : new Date().toISOString();
  }
  item.figma = {
    nodeId: node,
    url: String(figmaUrl).trim(),
    name: orNull(name) ?? frameName(item, next),
    builtAt: isIsoDateTime(builtAt) ? builtAt : new Date().toISOString(),
    roundTrip: typeof roundTrip === 'number' ? { percent: roundTrip, band: band(roundTrip, tolerances) } : null,
  };
  return { report: next, item };
}

// ---------------------------------------------------------------------------
// Import formats

/**
 * Parse the chat message the report copies for Claude Code:
 *
 *   /design-qa backfill <slug>
 *   BF-001 build
 *   BF-002 build
 *   BF-003 not-needed — <reason>
 *   by: <name>
 *
 * The separator may be an em/en dash, "-", "--" or ":"; a build line may carry a
 * note. Lines that are neither an item, the header nor "by:" continue the previous
 * item's reason. Code fences are ignored. Returns { feature: null, slug,
 * reportGeneratedAt: null, decidedBy, items: [{ id, decision, reason, by, date }] }.
 */
export function parseBackfillMessage(message) {
  const lines = String(message ?? '')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('```'));
  let slug = null;
  let decidedBy = null;
  const items = [];
  const itemRe = /^(BF-\d{3,})\s+(build(?:[- ]in[- ]figma)?|not[- ]needed)\b\s*(?:—|–|--|-|:)?\s*(.*)$/i;
  for (const line of lines) {
    const head = line.match(/^\/?design-qa\s+backfill\b\s*(\S+)?/i);
    if (head) {
      slug = head[1] ?? null;
      continue;
    }
    const by = line.match(/^by\s*:\s*(.*)$/i);
    if (by) {
      decidedBy = orNull(by[1]);
      continue;
    }
    const m = line.match(itemRe);
    if (m) {
      items.push({ id: m[1].toUpperCase(), decision: normalizeDecision(m[2]), reason: m[3].trim(), by: null, date: null });
      continue;
    }
    if (/^BF-\d/i.test(line)) throw new Error(`cannot read "${line}": expected "BF-001 build" or "BF-003 not-needed — <reason>"`);
    if (items.length) {
      const last = items[items.length - 1];
      last.reason = last.reason ? `${last.reason} ${line}` : line;
      continue;
    }
    throw new Error(`cannot read "${line}": the message starts with "/design-qa backfill <slug>"`);
  }
  if (!items.length) throw new Error('no backfill decisions found (expected lines like "BF-001 build" or "BF-003 not-needed — <reason>")');
  return { feature: null, slug, reportGeneratedAt: null, decidedBy, items };
}

/** The chat message for [{ id, decision, reason }] (inverse of parseBackfillMessage). */
export function formatBackfillMessage({ slug, items = [], decidedBy = null } = {}) {
  const lines = [`/design-qa backfill ${slug || 'report'}`];
  for (const item of items) {
    const decision = normalizeDecision(item.decision) ?? item.decision;
    const reason = String(item.reason ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
    lines.push(reason ? `${item.id} ${decision} — ${reason}` : `${item.id} ${decision}`);
  }
  if (orNull(decidedBy)) lines.push(`by: ${text(decidedBy)}`);
  return lines.join('\n');
}

function normalizeFileItem(raw, where) {
  if (!isObj(raw)) throw new Error(`${where}: each item must be an object`);
  const id = String(raw.id ?? raw.itemId ?? '').trim().toUpperCase();
  if (!ID_RE.test(id)) throw new Error(`${where}: "${raw.id ?? raw.itemId ?? ''}" is not a backfill id (expected e.g. BF-001)`);
  const decision = normalizeDecision(raw.decision);
  if (!decision || decision === 'pending') throw new Error(`${where} (${id}): decision must be one of ${DECIDE_CHOICES.join(', ')} (got "${raw.decision ?? ''}")`);
  return { id, decision, reason: typeof raw.reason === 'string' ? raw.reason.trim() : '', by: orNull(raw.by), date: isIsoDateTime(raw.date) ? raw.date : null };
}

/**
 * Parse a --from file: backfill.json exported by report.html
 * ({ feature, slug, reportGeneratedAt, decidedBy, items: [{ id, decision, reason, by, date }] })
 * or a text file holding the chat message. Returns the same shape plus
 * format: "json" | "chat". A blank reason stays "" (the caller rejects it for not-needed).
 */
export function parseBackfillFile(content) {
  const raw = String(content ?? '').replace(/^﻿/, '');
  if (raw.trim().startsWith('{')) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new Error(`backfill.json is not valid JSON: ${err.message}`);
    }
    if (!isObj(data) || !Array.isArray(data.items)) throw new Error('backfill.json must be an object with an "items" array');
    if (!data.items.length) throw new Error('backfill.json has no items');
    return {
      format: 'json',
      feature: orNull(data.feature),
      slug: orNull(data.slug),
      reportGeneratedAt: orNull(data.reportGeneratedAt),
      decidedBy: orNull(data.decidedBy),
      items: data.items.map((item, i) => normalizeFileItem(item, `items[${i}]`)),
    };
  }
  return { format: 'chat', ...parseBackfillMessage(raw) };
}

// ---------------------------------------------------------------------------
// Summary

/**
 * Everything a reply or a plan needs about the gate: { ready, loopClosed, open,
 * override } (open = unexplained findings + open decisions of step 1).
 */
export function gateStatus(report) {
  return { ready: isBackfillReady(report), loopClosed: isLoopClosed(report), open: openStepOneCount(report), override: backfillOverride(report) };
}

/** The message slug ("/design-qa backfill <slug>"). */
export function backfillSlug(report) {
  return reportSlug(report);
}
