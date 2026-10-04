// Dismissals: a person's written decision that a finding is not an issue, should be
// removed from this QA, or is an accepted (intentional) divergence. Pure functions:
// apply/undo on a report, the cumulative dismissed log (JSON + Markdown) that carries
// the decisions into later passes, and the two import formats (dismissals.json from
// report.html and the multi-line "/design-qa dismiss <slug>" chat message).
import { oneLine } from './args.mjs';
import { isRfc3339DateTime } from './schema-check.mjs';
import { reportSlug } from './triage.mjs';

export const DISMISS_KINDS = Object.freeze(['not-an-issue', 'remove', 'intentional']);
export const DISMISSAL_SOURCES = Object.freeze(['report-ui', 'chat', 'cli', 'prior-pass']);
export const DISMISSIBLE_SEVERITIES = Object.freeze(['BLOCKER', 'WARNING', 'DS_CANDIDATE']);
/** Findings a dismissal applies to on its own: the open ones. */
export const OPEN_RESOLUTIONS = Object.freeze(['FIX_CODE', 'UNCLASSIFIED']);
/**
 * Resolutions an undo can restore besides FIX_CODE (the default): recorded as
 * previousResolution on the dismissal (or sign-off) when the finding had one of them.
 */
export const RESTORABLE_RESOLUTIONS = Object.freeze(['UNCLASSIFIED', 'DATA']);

const KIND_ALIASES = new Map([
  ['not-an-issue', 'not-an-issue'],
  ['not an issue', 'not-an-issue'],
  ['notanissue', 'not-an-issue'],
  ['remove', 'remove'],
  ['remove from qa', 'remove'],
  ['remove-from-qa', 'remove'],
  ['intentional', 'intentional'],
  ['accept as intentional', 'intentional'],
  ['accept-as-intentional', 'intentional'],
]);

const ID_RE = /^DQ-\d{3,}$/;
const DASH = '–';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const orNull = (v) => (text(v) ? text(v) : null);

/** Normalise a kind ("Not an issue", "remove", …) to one of DISMISS_KINDS, else null. */
export function normalizeKind(kind) {
  const k = String(kind ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, ' ');
  return KIND_ALIASES.get(k) ?? KIND_ALIASES.get(k.replace(/ /g, '-')) ?? null;
}

/** An RFC 3339 date-time with a time zone: exactly what the report validator accepts. */
export function isIsoDateTime(value) {
  return isRfc3339DateTime(value);
}

/**
 * Stable identity of a finding across passes (ids are renumbered every pass):
 * ledger | state | selector (else Figma layer path, else region) | property,
 * lower-cased and whitespace-collapsed.
 */
export function fingerprint(finding) {
  const el = isObj(finding?.element) ? finding.element : {};
  const where = el.selector || el.figmaLayerPath || finding?.region || '';
  return [finding?.ledger, finding?.state, where, finding?.property]
    .map((v) => (v === null || v === undefined ? '' : String(v)))
    .join('|')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Why a finding cannot take this kind of dismissal, or null when it can. */
export function dismissBlocker(finding, kind) {
  if (!finding) return 'unknown finding';
  if (!DISMISS_KINDS.includes(kind)) return `kind must be one of ${DISMISS_KINDS.join(', ')}`;
  if (!DISMISSIBLE_SEVERITIES.includes(finding.severity)) {
    return `${oneLine(finding.id)} is ${oneLine(finding.severity)}: only BLOCKER, WARNING and DS_CANDIDATE findings can be dismissed or accepted`;
  }
  return null;
}

function cloneReport(report) {
  return structuredClone(report);
}

function findIndex(report, findingId) {
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  return findings.findIndex((f) => f && f.id === findingId);
}

/**
 * Dismiss one finding. kind "not-an-issue" | "remove" → resolution DISMISSED with
 * `dismissal`; kind "intentional" → resolution INTENTIONAL with `signoff`. Either way
 * rank becomes { score: 0, bucket: "none" } and the finding leaves triage.items.
 * The scorecard is NOT recomputed (render-report --recompute does that).
 * Returns { report, finding, previous } (previous = the finding before); throws Error
 * on an unknown id, a blank reason, a bad kind or a PASS/CANNOT_VERIFY finding.
 */
export function applyDismissal(report, findingId, { kind, reason, by = null, date = new Date().toISOString(), source = 'cli', priorRef = null } = {}) {
  const k = normalizeKind(kind);
  if (!k) throw new Error(`${findingId}: kind must be one of ${DISMISS_KINDS.join(', ')} (got "${kind ?? ''}")`);
  if (!text(reason)) throw new Error(`${findingId}: a reason is required (why is it ${k === 'intentional' ? 'intentional' : k === 'remove' ? 'out of this QA' : 'not an issue'}?)`);
  if (!DISMISSAL_SOURCES.includes(source)) throw new Error(`source must be one of ${DISMISSAL_SOURCES.join(', ')} (got "${source}")`);
  const i = findIndex(report, findingId);
  if (i < 0) throw new Error(`unknown finding id: ${findingId}`);
  const previous = report.findings[i];
  const blocker = dismissBlocker(previous, k);
  if (blocker) throw new Error(blocker);

  const next = cloneReport(report);
  const f = next.findings[i];
  const when = isIsoDateTime(date) ? date : new Date().toISOString();
  // What an undo restores: the resolution before the first dismissal (kept across re-dismissals).
  const before = ['DISMISSED', 'INTENTIONAL'].includes(previous.resolution) ? previousResolutionOf(previous) : previous.resolution;
  const restore = RESTORABLE_RESOLUTIONS.includes(before) ? { previousResolution: before } : {};
  if (k === 'intentional') {
    f.resolution = 'INTENTIONAL';
    f.signoff = { by: orNull(by) ?? 'unknown', date: when, reason: text(reason), ...restore };
    delete f.dismissal;
  } else {
    f.resolution = 'DISMISSED';
    f.dismissal = { kind: k, reason: text(reason), by: orNull(by), date: when, source, priorRef: priorRef ?? null, ...restore };
    f.signoff = null;
  }
  f.rank = { score: 0, bucket: 'none' };
  if (isObj(next.triage) && Array.isArray(next.triage.items)) {
    next.triage.items = next.triage.items.filter((item) => item?.findingId !== findingId);
  }
  return { report: next, finding: f, previous };
}

/** The resolution a dismissed / accepted finding had before (previousResolution), else null. */
export function previousResolutionOf(finding) {
  const record = finding?.resolution === 'DISMISSED' ? finding.dismissal : finding?.resolution === 'INTENTIONAL' ? finding.signoff : null;
  const value = isObj(record) ? record.previousResolution : null;
  return RESTORABLE_RESOLUTIONS.includes(value) ? value : null;
}

/**
 * Undo a dismissal (or an accepted-as-intentional sign-off): resolution back to what
 * it was before (previousResolution: UNCLASSIFIED or DATA; FIX_CODE when unknown),
 * dismissal and signoff removed, rank cleared (null: re-ranked on render). A finding
 * back at FIX_CODE returns to the report's triage block (when there is one) as
 * "fix-now". Returns { report, finding, previous }; throws on an unknown id or a
 * finding that is neither DISMISSED nor INTENTIONAL.
 */
export function undoDismissal(report, findingId) {
  const i = findIndex(report, findingId);
  if (i < 0) throw new Error(`unknown finding id: ${findingId}`);
  const previous = report.findings[i];
  if (!['DISMISSED', 'INTENTIONAL'].includes(previous.resolution)) {
    throw new Error(`${findingId} is ${oneLine(previous.resolution)}, not dismissed or accepted as intentional; nothing to undo`);
  }
  const next = cloneReport(report);
  const f = next.findings[i];
  f.resolution = previousResolutionOf(previous) ?? 'FIX_CODE';
  delete f.dismissal;
  f.signoff = null;
  f.rank = null;
  if (f.resolution === 'FIX_CODE' && isObj(next.triage) && Array.isArray(next.triage.items) && !next.triage.items.some((item) => item?.findingId === findingId)) {
    const order = new Map(next.findings.map((x, j) => [x.id, j]));
    next.triage.items = [...next.triage.items, { findingId, decision: 'fix-now', reason: 'Dismissal undone.', ticket: null }].sort(
      (a, b) => (order.get(a.findingId) ?? 0) - (order.get(b.findingId) ?? 0),
    );
  }
  return { report: next, finding: f, previous };
}

/** The kind a dismissed finding carries: dismissal.kind, "intentional", or null. */
export function dismissalKindOf(finding) {
  if (finding?.resolution === 'DISMISSED') return finding.dismissal?.kind ?? null;
  if (finding?.resolution === 'INTENTIONAL') return 'intentional';
  return null;
}

// ---------------------------------------------------------------------------
// Import formats

function normalizeItem(raw, where) {
  if (!isObj(raw)) throw new Error(`${where}: each item must be an object`);
  const findingId = String(raw.findingId ?? raw.id ?? '').trim().toUpperCase();
  if (!ID_RE.test(findingId)) throw new Error(`${where}: "${raw.findingId ?? raw.id ?? ''}" is not a finding id (expected e.g. DQ-004)`);
  const kind = normalizeKind(raw.kind);
  if (!kind) throw new Error(`${where} (${findingId}): kind must be one of ${DISMISS_KINDS.join(', ')} (got "${raw.kind ?? ''}")`);
  return {
    findingId,
    kind,
    reason: typeof raw.reason === 'string' ? raw.reason.trim() : '',
    by: orNull(raw.by),
    date: isIsoDateTime(raw.date) ? raw.date : null,
  };
}

/**
 * Parse the chat message the report copies for Claude Code:
 *
 *   /design-qa dismiss <slug>
 *   DQ-004 not-an-issue — <reason>
 *   DQ-007 remove — <reason>
 *   DQ-009 intentional — <reason>
 *   by: <name>
 *
 * The separator may be an em/en dash, "-", "--" or ":". Lines that are neither an
 * item, the header nor "by:" continue the previous item's reason. Code fences are
 * ignored. Returns { feature: null, slug, reportGeneratedAt: null, decidedBy, items }.
 */
export function parseChatDismissMessage(message) {
  const lines = String(message ?? '')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('```'));
  let slug = null;
  let decidedBy = null;
  const items = [];
  const kinds = '(not[- ]an[- ]issue|remove(?:[- ]from[- ]qa)?|intentional|accept[- ]as[- ]intentional)';
  const itemRe = new RegExp(`^(DQ-\\d{3,})\\s+${kinds}\\b\\s*(?:—|–|--|-|:)?\\s*(.*)$`, 'i');
  for (const line of lines) {
    const head = line.match(/^\/?design-qa\s+dismiss\b\s*(\S+)?/i);
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
      items.push({ findingId: m[1].toUpperCase(), kind: normalizeKind(m[2]), reason: m[3].trim(), by: null, date: null });
      continue;
    }
    if (/^DQ-\d/i.test(line)) {
      throw new Error(`cannot read "${oneLine(line)}": expected "DQ-004 not-an-issue|remove|intentional — <reason>"`);
    }
    if (items.length) {
      const last = items[items.length - 1];
      last.reason = last.reason ? `${last.reason} ${line}` : line;
      continue;
    }
    throw new Error(`cannot read "${oneLine(line)}": the message starts with "/design-qa dismiss <slug>"`);
  }
  if (!items.length) throw new Error('no dismissals found (expected lines like "DQ-004 not-an-issue — <reason>")');
  return { feature: null, slug, reportGeneratedAt: null, decidedBy, items };
}

/**
 * The chat message for a list of { findingId, kind, reason } (inverse of
 * parseChatDismissMessage). Every value is folded to one line (oneLine), so a reason
 * can never add an item line of its own.
 */
export function formatChatDismissMessage({ slug, items = [], decidedBy = null } = {}) {
  const lines = [`/design-qa dismiss ${oneLine(slug) || 'report'}`];
  for (const item of items) {
    lines.push(`${oneLine(item.findingId)} ${normalizeKind(item.kind) ?? oneLine(item.kind)} — ${oneLine(item.reason)}`);
  }
  if (orNull(decidedBy)) lines.push(`by: ${oneLine(decidedBy)}`);
  return lines.join('\n');
}

/**
 * Parse a --from file: dismissals.json exported by report.html
 * ({ feature, slug, reportGeneratedAt, decidedBy, items: [{ findingId, kind, reason, by, date }] })
 * or a text file holding the chat message. Returns the same shape plus
 * format: "json" | "chat". Items keep a blank reason as "" (the caller rejects it).
 */
export function parseDismissalsFile(content) {
  const raw = String(content ?? '').replace(/^﻿/, '');
  if (raw.trim().startsWith('{')) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new Error(`dismissals.json is not valid JSON: ${err.message}`);
    }
    if (!isObj(data) || !Array.isArray(data.items)) throw new Error('dismissals.json must be an object with an "items" array');
    if (!data.items.length) throw new Error('dismissals.json has no items');
    return {
      format: 'json',
      feature: orNull(data.feature),
      slug: orNull(data.slug),
      reportGeneratedAt: orNull(data.reportGeneratedAt),
      decidedBy: orNull(data.decidedBy),
      items: data.items.map((item, i) => normalizeItem(item, `items[${i}]`)),
    };
  }
  return { format: 'chat', ...parseChatDismissMessage(raw) };
}

// ---------------------------------------------------------------------------
// The dismissed log (qa-reports/dismissed.json + dismissed.md)

const entryKey = (feature, fp) => `${String(feature ?? '').trim().toLowerCase()}::${fp}`;
const entryNumber = (id) => {
  const m = /^DS-(\d+)$/.exec(String(id ?? ''));
  return m ? Number(m[1]) : 0;
};
export const formatEntryId = (n) => `DS-${String(n).padStart(4, '0')}`;

/** The log entry fields that describe a dismissed finding of this report. */
export function logEntryFor(report, finding, { source = null } = {}) {
  const el = isObj(finding?.element) ? finding.element : {};
  const isIntentional = finding?.resolution === 'INTENTIONAL';
  const d = isIntentional ? finding.signoff ?? {} : finding?.dismissal ?? {};
  return {
    feature: report?.meta?.feature ?? null,
    slug: reportSlug(report),
    findingId: finding?.id ?? null,
    title: finding?.title ?? null,
    fingerprint: fingerprint(finding),
    ledger: finding?.ledger ?? null,
    state: finding?.state ?? null,
    selector: el.selector ?? null,
    figmaLayerPath: el.figmaLayerPath ?? null,
    property: finding?.property ?? null,
    expectedValue: finding?.expected?.value ?? null,
    actualValue: finding?.actual?.value ?? null,
    kind: dismissalKindOf(finding),
    reason: d.reason ?? null,
    by: d.by ?? null,
    date: d.date ?? null,
    source: source ?? (isIntentional ? null : d.source ?? null),
  };
}

/**
 * Upsert log entries for findings of `report` (the report AFTER applying):
 * changes = [{ findingId, action: "dismiss" | "undo", source? }]. Keyed by
 * feature + fingerprint: an existing entry keeps its DS-id and is overwritten
 * (status "active"); "undo" marks the matching entry "undone" with undoneAt.
 * New entries get the next DS-0001… id. Returns { log, stats: { added, updated, undone } }.
 */
export function upsertLogEntries(previous, report, changes = [], { now = new Date().toISOString() } = {}) {
  const entries = Array.isArray(previous?.entries) ? previous.entries.map((e) => ({ ...e })) : [];
  const byKey = new Map(entries.map((e) => [entryKey(e.feature, e.fingerprint), e]));
  let max = entries.reduce((m, e) => Math.max(m, entryNumber(e.id)), 0);
  const findings = new Map((Array.isArray(report?.findings) ? report.findings : []).map((f) => [f.id, f]));
  const stats = { added: 0, updated: 0, undone: 0 };

  for (const change of changes) {
    const f = findings.get(change.findingId);
    if (!f) continue;
    const fields = logEntryFor(report, f, { source: change.source ?? null });
    const key = entryKey(fields.feature, fields.fingerprint);
    const existing = byKey.get(key);
    if (change.action === 'undo') {
      if (existing && existing.status !== 'undone') {
        existing.status = 'undone';
        existing.undoneAt = now;
        stats.undone += 1;
      }
      continue;
    }
    if (existing) {
      Object.assign(existing, fields, { status: 'active' });
      delete existing.undoneAt;
      stats.updated += 1;
    } else {
      max += 1;
      const entry = { id: formatEntryId(max), ...fields, status: 'active' };
      entries.push(entry);
      byKey.set(key, entry);
      stats.added += 1;
    }
  }
  entries.sort((a, b) => entryNumber(a.id) - entryNumber(b.id));
  return { log: { version: 1, updatedAt: changes.length ? now : previous?.updatedAt ?? null, entries }, stats };
}

/**
 * Re-apply earlier passes' dismissals: every active entry of this report's feature
 * whose fingerprint matches an open finding (FIX_CODE / UNCLASSIFIED) and whose
 * expectedValue / actualValue still equal the finding's expected.value / actual.value
 * dismisses it again (source "prior-pass", priorRef = entry id; kind, reason and by
 * from the entry). Matches whose values changed stay open and are listed in `changed`.
 * Returns { report, applied: [{ findingId, entryId, kind }], changed: [{ findingId,
 * entryId, kind, was: { expectedValue, actualValue }, now: { expectedValue, actualValue } }] }.
 */
export function applyPriorDismissals(report, log) {
  const feature = String(report?.meta?.feature ?? '').trim().toLowerCase();
  const active = (Array.isArray(log?.entries) ? log.entries : []).filter(
    (e) => e && e.status === 'active' && String(e.feature ?? '').trim().toLowerCase() === feature,
  );
  const byFp = new Map();
  for (const e of active) if (!byFp.has(e.fingerprint)) byFp.set(e.fingerprint, e);
  let next = report;
  const applied = [];
  const changed = [];
  for (const f of Array.isArray(report?.findings) ? report.findings : []) {
    if (!f || !OPEN_RESOLUTIONS.includes(f.resolution) || !DISMISSIBLE_SEVERITIES.includes(f.severity)) continue;
    const e = byFp.get(fingerprint(f));
    if (!e) continue;
    const nowValues = { expectedValue: f.expected?.value ?? null, actualValue: f.actual?.value ?? null };
    const wasValues = { expectedValue: e.expectedValue ?? null, actualValue: e.actualValue ?? null };
    if (nowValues.expectedValue !== wasValues.expectedValue || nowValues.actualValue !== wasValues.actualValue) {
      changed.push({ findingId: f.id, entryId: e.id, kind: e.kind, was: wasValues, now: nowValues });
      continue;
    }
    ({ report: next } = applyDismissal(next, f.id, {
      kind: e.kind,
      reason: e.reason,
      by: e.by,
      date: e.date,
      source: 'prior-pass',
      priorRef: e.id,
    }));
    applied.push({ findingId: f.id, entryId: e.id, kind: e.kind });
  }
  return { report: next, applied, changed };
}

/**
 * A Markdown table cell: one line (every line break, including a lone \r, and control
 * character folded), backslashes and pipes escaped so a value can neither end the
 * row nor shift the columns.
 */
export const mdCell = (v) => oneLine(v ?? DASH).replace(/[\\|]/g, '\\$&') || DASH;
/** Heading text: one line, a leading #, >, list marker or fence run escaped. */
export const mdHeading = (v) => oneLine(v).replace(/^([#>+=*-]|`{3,}|~{3,})/, '\\$1');
const cell = mdCell;
const day = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(String(iso ?? '')) ? String(iso).slice(0, 10) : DASH);

/** dismissed.md: title, "active n · undone m", then one table per feature. */
export function renderDismissedMarkdown(log) {
  const entries = Array.isArray(log?.entries) ? log.entries : [];
  const active = entries.filter((e) => e.status === 'active').length;
  const lines = [
    '# Dismissed findings',
    '',
    'Findings a person marked not an issue, removed from QA, or accepted as intentional. Later passes re-apply active entries whose finding and values are unchanged (dismiss.mjs --apply-log).',
    '',
    `active ${active} · undone ${entries.length - active}`,
  ];
  const groups = new Map();
  for (const e of entries) {
    const name = e.feature || e.slug || 'Unknown feature';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(e);
  }
  for (const [name, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const slug = list.find((e) => e.slug)?.slug;
    lines.push('', `## ${mdHeading(name)}${slug && slug !== name ? ` (${oneLine(slug)})` : ''}`, '');
    lines.push('| ID | Finding | Kind | Reason | By | Date | Status |', '|---|---|---|---|---|---|---|');
    for (const e of list) {
      const finding = [e.findingId, e.title].filter(Boolean).join(' — ');
      const status = e.status === 'undone' ? `undone ${day(e.undoneAt)}`.trim() : 'active';
      lines.push(`| ${cell(e.id)} | ${cell(finding)} | ${cell(e.kind)} | ${cell(e.reason)} | ${cell(e.by)} | ${day(e.date)} | ${status} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}
