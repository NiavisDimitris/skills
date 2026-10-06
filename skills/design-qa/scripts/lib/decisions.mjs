// Review decisions: ONE document that carries everything a reviewer decided in
// report.html (fix now / debt, dismissals with a reason, design-backfill decisions,
// annotations the reviewer added on a capture, and whether tickets may be created) to
// any coding agent. Pure functions: parse the document (bare JSON, or the whole "Copy
// for your agent" message with the JSON in a ```design-qa-decisions fence), validate
// it, summarise it, apply it to a report by composing the existing triage / dismissal /
// backfill / annotation functions, and write the plain-language message. report.html mirrors decisionsMessage() character for
// character, so keep its output stable and deterministic. Every name, title or value
// that comes from the report or the document is folded to one line (oneLine) before
// it is printed, so data can never forge a line (a "Next:" command, a second fence).
import { ANNOTATIONS_MAX, AnnotationError, annotationIdentity, mergeAnnotations, normalizeAnnotation } from './annotations.mjs';
import { oneLine } from './args.mjs';
import { decideItems, DECIDE_CHOICES } from './backfill.mjs';
import { DISMISS_KINDS, applyDismissal, normalizeKind } from './dismissals.mjs';
import { agentPrompt } from './fixplan.mjs';
import { backfillItems, computeScorecard, hasBackfill, isTriageable, resolveOptions } from './ranking.mjs';
import { isRfc3339DateTime } from './schema-check.mjs';
import { applyTriage, buildTriage, reportSlug, withRanks } from './triage.mjs';
import { shellArg } from './review-context.mjs';

export const DECISIONS_KIND = 'design-qa-decisions';
export const DECISIONS_VERSION = 1;
/** Info string of the fence that holds the document inside the pasted message. */
export const DECISIONS_FENCE = 'design-qa-decisions';

const FINDING_ID_RE = /^DQ-\d{3,}$/;
const BACKFILL_ID_RE = /^BF-\d{3,}$/;
const TOP_KEYS = ['kind', 'version', 'slug', 'feature', 'reportGeneratedAt', 'decidedBy', 'decidedAt', 'tickets', 'triage', 'dismissals', 'backfill', 'annotations'];
const ALLOWED_TOP = new Set([...TOP_KEYS, '$schema']);
const DISMISSAL_KEYS = new Set(['findingId', 'kind', 'reason', 'by', 'date']);
const BACKFILL_KEYS = new Set(['id', 'decision', 'reason', 'by', 'date']);
const TRIAGE_KEYS = new Set(['fixNow', 'debt']);

/**
 * Why a decisions document cannot be used. code: "invalid" (shape), "version" (a newer
 * format), "slug" / "stale" (made on another report), "unknown-id", "apply" (the report
 * refuses a decision, e.g. a PASS finding dismissed).
 */
export class DecisionsError extends Error {
  constructor(message, code = 'invalid') {
    super(oneLine(message)); // messages quote document and report values: one line, always
    this.name = 'DecisionsError';
    this.code = code;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const invalid = (message) => new DecisionsError(message, 'invalid');
const nameOrNull = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const show = (v) => JSON.stringify(v === undefined ? null : v);

// Every date is an RFC 3339 date-time with an explicit zone (Z or ±hh:mm), the validator's
// own rule (isRfc3339DateTime): a zone-less time would be read in the local zone, so two
// machines could disagree on the instant.
const isDateTime = (v) => isRfc3339DateTime(v);

function unknownKeys(obj, allowed, where) {
  const extra = Object.keys(obj).filter((k) => !allowed.has(k));
  if (extra.length) throw invalid(`${where} has unknown key${extra.length === 1 ? '' : 's'}: ${extra.map((k) => show(k)).join(', ')}`);
}

function optionalName(value, where) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalid(`${where} must be a string or null (got ${typeof value})`);
  return nameOrNull(value);
}

function optionalDate(value, where) {
  if (value === undefined || value === null) return null;
  if (!isDateTime(value)) throw invalid(`${where} must be an ISO date-time with a time zone, like "2026-10-03T10:00:00.000Z" (got ${show(value)})`);
  return value;
}

function idList(value, where) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(`${where} must be an array of finding ids`);
  const seen = new Set();
  value.forEach((id, i) => {
    if (typeof id !== 'string' || !FINDING_ID_RE.test(id)) {
      throw invalid(`${where}[${i}] is ${show(id)}, not a finding id (expected e.g. "DQ-004")`);
    }
    if (seen.has(id)) throw invalid(`${where} lists ${id} twice`);
    seen.add(id);
  });
  return [...value];
}

/**
 * Validate a decisions object and return it in canonical form (fixed key order;
 * dismissals and backfill always arrays; triage only when given; annotations only when
 * there are any, so a document without them is exactly what it was before annotations
 * existed; names trimmed, null when blank; reasons verbatim). Idempotent:
 * normalizeDecisions(normalizeDecisions(x)) deep-equals normalizeDecisions(x). Throws
 * DecisionsError (code "invalid" or "version").
 */
export function normalizeDecisions(data) {
  if (!isObj(data)) throw invalid('the decisions document must be a JSON object');
  if (data.kind !== DECISIONS_KIND) throw invalid(`"kind" must be "${DECISIONS_KIND}" (got ${show(data.kind ?? null)})`);
  if (typeof data.version === 'number' && Number.isInteger(data.version) && data.version > DECISIONS_VERSION) {
    throw new DecisionsError(
      `this decisions document is version ${data.version}, a newer format than this design-qa skill reads (version ${DECISIONS_VERSION}); update the design-qa skill`,
      'version',
    );
  }
  if (data.version !== DECISIONS_VERSION) throw invalid(`"version" must be ${DECISIONS_VERSION} (got ${show(data.version ?? null)})`);
  unknownKeys(data, ALLOWED_TOP, 'the decisions document');

  if (typeof data.slug !== 'string' || !data.slug.trim()) throw invalid('"slug" is required: the report folder name, e.g. "ACME-482"');
  if (data.feature !== undefined && data.feature !== null && typeof data.feature !== 'string') throw invalid('"feature" must be a string or null');
  if (!isDateTime(data.reportGeneratedAt)) {
    throw invalid(`"reportGeneratedAt" must be the report's meta.generatedAt, an ISO date-time with a time zone (got ${show(data.reportGeneratedAt ?? null)})`);
  }
  if (!isDateTime(data.decidedAt)) throw invalid(`"decidedAt" must be an ISO date-time with a time zone, like "2026-10-03T10:00:00.000Z" (got ${show(data.decidedAt ?? null)})`);
  if (data.tickets !== undefined && typeof data.tickets !== 'boolean') throw invalid(`"tickets" must be true or false (got ${show(data.tickets)})`);
  const decidedBy = optionalName(data.decidedBy, '"decidedBy"');

  let triage;
  if (data.triage !== undefined && data.triage !== null) {
    if (!isObj(data.triage)) throw invalid('"triage" must be an object { fixNow: [ids], debt: [ids] }');
    unknownKeys(data.triage, TRIAGE_KEYS, '"triage"');
    const fixNow = idList(data.triage.fixNow, 'triage.fixNow');
    const debt = idList(data.triage.debt, 'triage.debt');
    const both = fixNow.filter((id) => debt.includes(id));
    if (both.length) throw invalid(`triage lists ${both.join(', ')} as both fix now and debt`);
    triage = { fixNow, debt };
  }

  if (data.dismissals !== undefined && !Array.isArray(data.dismissals)) throw invalid('"dismissals" must be an array');
  const dismissed = new Set();
  const dismissals = (data.dismissals ?? []).map((raw, i) => {
    const where = `dismissals[${i}]`;
    if (!isObj(raw)) throw invalid(`${where} must be an object { findingId, kind, reason, by, date }`);
    unknownKeys(raw, DISMISSAL_KEYS, where);
    if (typeof raw.findingId !== 'string' || !FINDING_ID_RE.test(raw.findingId)) {
      throw invalid(`${where}.findingId is ${show(raw.findingId ?? null)}, not a finding id (expected e.g. "DQ-007")`);
    }
    const id = raw.findingId;
    if (dismissed.has(id)) throw invalid(`dismissals list ${id} twice`);
    dismissed.add(id);
    // Aliases ("Not an issue") are read; the canonical enum value is what is kept and written.
    const kind = normalizeKind(raw.kind);
    if (!kind || !DISMISS_KINDS.includes(kind)) throw invalid(`${where} (${id}): "kind" must be one of ${DISMISS_KINDS.join(', ')} (got ${show(raw.kind ?? null)})`);
    if (typeof raw.reason !== 'string' || !raw.reason.trim()) throw invalid(`${where} (${id}): a non-empty "reason" is required for every dismissal`);
    return { findingId: id, kind, reason: raw.reason, by: optionalName(raw.by, `${where}.by`), date: optionalDate(raw.date, `${where}.date`) };
  });
  if (triage) {
    const overlap = [...triage.fixNow, ...triage.debt].filter((id) => dismissed.has(id));
    if (overlap.length) throw invalid(`${overlap.join(', ')} ${overlap.length === 1 ? 'is' : 'are'} dismissed in this document and must not also be in triage`);
  }

  if (data.backfill !== undefined && !Array.isArray(data.backfill)) throw invalid('"backfill" must be an array');
  const seenBf = new Set();
  const backfill = (data.backfill ?? []).map((raw, i) => {
    const where = `backfill[${i}]`;
    if (!isObj(raw)) throw invalid(`${where} must be an object { id, decision, reason, by, date }`);
    unknownKeys(raw, BACKFILL_KEYS, where);
    if (typeof raw.id !== 'string' || !BACKFILL_ID_RE.test(raw.id)) {
      throw invalid(`${where}.id is ${show(raw.id ?? null)}, not a backfill id (expected e.g. "BF-001")`);
    }
    if (seenBf.has(raw.id)) throw invalid(`backfill lists ${raw.id} twice`);
    seenBf.add(raw.id);
    if (!DECIDE_CHOICES.includes(raw.decision)) {
      throw invalid(`${where} (${raw.id}): "decision" must be one of ${DECIDE_CHOICES.join(', ')} (got ${show(raw.decision ?? null)})`);
    }
    if (raw.reason !== undefined && raw.reason !== null && typeof raw.reason !== 'string') throw invalid(`${where} (${raw.id}): "reason" must be a string or null`);
    const reason = typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason : null;
    if (raw.decision === 'not-needed' && !reason) throw invalid(`${where} (${raw.id}): a non-empty "reason" is required for not-needed`);
    return { id: raw.id, decision: raw.decision, reason, by: optionalName(raw.by, `${where}.by`), date: optionalDate(raw.date, `${where}.date`) };
  });

  // Annotations: issues the reviewer marked on a capture (scripts/lib/annotations.mjs), in the given order.
  if (data.annotations !== undefined && !Array.isArray(data.annotations)) throw invalid('"annotations" must be an array');
  const rawAnnotations = data.annotations ?? [];
  if (rawAnnotations.length > ANNOTATIONS_MAX) throw invalid(`"annotations" lists ${rawAnnotations.length}; at most ${ANNOTATIONS_MAX} in one document`);
  const seenAnnotations = new Map();
  const annotations = rawAnnotations.map((raw, i) => {
    let a;
    try {
      a = normalizeAnnotation(raw, `annotations[${i}]`);
    } catch (err) {
      if (err instanceof AnnotationError) throw invalid(err.message);
      throw err;
    }
    const key = annotationIdentity(a);
    if (seenAnnotations.has(key)) {
      throw invalid(`annotations lists the same annotation twice: annotations[${seenAnnotations.get(key)}] and annotations[${i}] (same state, side, box and note)`);
    }
    seenAnnotations.set(key, i);
    return a;
  });

  const doc = {
    kind: DECISIONS_KIND,
    version: DECISIONS_VERSION,
    slug: data.slug,
    feature: data.feature ?? null,
    reportGeneratedAt: data.reportGeneratedAt,
    decidedBy,
    decidedAt: data.decidedAt,
    tickets: data.tickets ?? false,
  };
  if (triage) doc.triage = triage;
  doc.dismissals = dismissals;
  doc.backfill = backfill;
  if (annotations.length) doc.annotations = annotations;
  return doc;
}

// ---------------------------------------------------------------------------
// Reading the pasted message

// Only an opener in column 0 counts: the message indents every line it quotes (snippet
// lines by two spaces), so a quoted "```design-qa-decisions" is never taken for one.
const FENCE_OPEN_RE = new RegExp(`^(\`{3,}|~{3,})\\s*${DECISIONS_FENCE}\\s*$`, 'i');
const ANY_FENCE_RE = /^\s*(`{3,}|~{3,})[^`]*$/;

function stripQuoting(lines) {
  let out = lines;
  // A message pasted as a blockquote ("> " on every line), possibly nested.
  for (let i = 0; i < 5; i++) {
    const filled = out.filter((l) => l.trim());
    if (!filled.length || !filled.every((l) => /^\s*>/.test(l))) break;
    out = out.map((l) => l.replace(/^\s*>\s?/, ''));
  }
  // A message pasted indented as a whole: remove the indentation every line shares, so
  // its own lines are back in column 0 and the lines it quotes stay indented.
  const filled = out.filter((l) => l.trim());
  let common = filled.length ? /^[ \t]*/.exec(filled[0])[0] : '';
  for (const l of filled) {
    while (common && !l.startsWith(common)) common = common.slice(0, -1);
  }
  return common ? out.map((l) => (l.startsWith(common) ? l.slice(common.length) : l.trimStart())) : out;
}

/**
 * The JSON text of the document: the bare JSON, or the one ```design-qa-decisions
 * fence. A message with two or more such fences is refused: text quoted from the
 * report could otherwise smuggle a forged document in ahead of the real one.
 */
export function extractDecisionsJson(text) {
  const raw = String(text ?? '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n');
  if (/^[{[]/.test(raw.trim())) return raw.trim();
  const lines = stripQuoting(raw.split('\n'));
  const opens = lines.filter((l) => FENCE_OPEN_RE.test(l)).length;
  if (opens > 1) {
    throw invalid(
      `the message has ${opens} \`\`\`${DECISIONS_FENCE} blocks; exactly one is allowed. Copy the message again from report.html (or apply the decisions.json document)`,
    );
  }
  const start = lines.findIndex((l) => FENCE_OPEN_RE.test(l));
  if (start >= 0) {
    const open = FENCE_OPEN_RE.exec(lines[start])[1];
    const end = lines.findIndex((l, i) => {
      if (i <= start) return false;
      const m = /^\s*(`{3,}|~{3,})\s*$/.exec(l);
      return Boolean(m && m[1][0] === open[0] && m[1].length >= open.length);
    });
    if (end < 0) throw invalid(`the \`\`\`${DECISIONS_FENCE} block is not closed: copy the whole message again`);
    return lines.slice(start + 1, end).join('\n').trim();
  }
  // No decisions fence: maybe the bare document inside quotes or an outer fence.
  let body = lines.join('\n').trim().replace(/^["“”']+|["“”']+$/g, '').trim();
  const bodyLines = body.split('\n');
  if (bodyLines.length > 1 && ANY_FENCE_RE.test(bodyLines[0]) && ANY_FENCE_RE.test(bodyLines[bodyLines.length - 1])) {
    body = bodyLines.slice(1, -1).join('\n').trim();
  }
  if (body.startsWith('{')) return body;
  throw invalid(
    `no \`\`\`${DECISIONS_FENCE} block found: paste the whole message from "Copy for your agent" in report.html, or the decisions.json document`,
  );
}

/**
 * Parse a decisions document: the bare JSON (text starting with "{") or the whole
 * pasted message (its one ```design-qa-decisions fence; everything outside it is
 * ignored; a second fence is an error). Tolerates CRLF, surrounding whitespace, a blockquoted or fenced message.
 * Returns the normalized document; throws DecisionsError with the field and the reason.
 */
export function parseDecisions(text) {
  const json = extractDecisionsJson(text);
  let data;
  try {
    data = JSON.parse(json);
  } catch (err) {
    const curly = /[“”‘’]/.test(json) ? ' It contains curly quotes (“ ”): an editor or chat app changed them; copy the message again from report.html.' : '';
    throw invalid(`the decisions document is not valid JSON: ${err.message}.${curly}`);
  }
  return normalizeDecisions(data);
}

// ---------------------------------------------------------------------------
// Summary

/** Counts: { fixNow, debt, dismissed, backfillBuild, backfillNotNeeded, annotations, tickets }. */
export function summarizeDecisions(doc) {
  const backfill = Array.isArray(doc?.backfill) ? doc.backfill : [];
  return {
    fixNow: Array.isArray(doc?.triage?.fixNow) ? doc.triage.fixNow.length : 0,
    debt: Array.isArray(doc?.triage?.debt) ? doc.triage.debt.length : 0,
    dismissed: Array.isArray(doc?.dismissals) ? doc.dismissals.length : 0,
    backfillBuild: backfill.filter((b) => b?.decision === 'build').length,
    backfillNotNeeded: backfill.filter((b) => b?.decision === 'not-needed').length,
    annotations: Array.isArray(doc?.annotations) ? doc.annotations.length : 0,
    tickets: doc?.tickets === true,
  };
}

/**
 * "fix now 5 · later 3 · dismissed 2 · backfill 1 · annotations 2 · tickets: yes" (the
 * backfill and annotations parts only when there are any). report.html mirrors it.
 */
export function summaryLine(doc) {
  const s = summarizeDecisions(doc);
  const backfill = s.backfillBuild + s.backfillNotNeeded;
  const parts = [`fix now ${s.fixNow}`, `later ${s.debt}`, `dismissed ${s.dismissed}`];
  if (backfill) parts.push(`backfill ${backfill}`);
  if (s.annotations) parts.push(`annotations ${s.annotations}`);
  parts.push(`tickets: ${s.tickets ? 'yes' : 'no'}`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Checking against a report and applying

// Equal strings, or two zoned date-times naming the same instant (zone-less ones are never reinterpreted).
const sameInstant = (a, b) => a === b || (isDateTime(a) && isDateTime(b) && Date.parse(a) === Date.parse(b));

/**
 * Is `doc` for this report? Returns { warnings }; throws DecisionsError "slug" when the
 * slug differs and "stale" when reportGeneratedAt differs from meta.generatedAt (finding
 * ids are renumbered on every pass) unless allowStale, which turns it into a warning.
 */
export function checkDecisionsTarget(report, doc, { allowStale = false } = {}) {
  const slug = reportSlug(report);
  const warnings = [];
  if (doc.slug !== slug) {
    throw new DecisionsError(`these decisions are for ${show(doc.slug)} but this report is ${show(slug)}: apply them to qa-reports/${doc.slug}/report.json`, 'slug');
  }
  const generatedAt = report?.meta?.generatedAt ?? null;
  if (!sameInstant(doc.reportGeneratedAt, generatedAt)) {
    const msg =
      `these decisions were made on the report generated ${oneLine(doc.reportGeneratedAt)}, but report.json was generated ${oneLine(generatedAt)}. ` +
      'Finding ids are renumbered on every pass, so they may point at different findings';
    if (!allowStale) {
      throw new DecisionsError(`${msg}. Reopen the current report.html, review again and send the new decisions.`, 'stale');
    }
    warnings.push(oneLine(`${msg}; applied anyway (--allow-stale)`));
  }
  return { warnings };
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function triageComparable(triage) {
  if (!isObj(triage)) return null;
  return {
    decidedBy: triage.decidedBy ?? null,
    decidedAt: triage.decidedAt ?? null,
    source: triage.source ?? null,
    ticketsAuthorized: triage.ticketsAuthorized ?? null,
    items: (Array.isArray(triage.items) ? triage.items : []).map((i) => ({
      findingId: i?.findingId,
      decision: i?.decision,
      reason: i?.reason ?? null,
      ticket: i?.ticket ?? null,
    })),
  };
}

/**
 * Apply a (normalized) decisions document to a report. Pure: no file I/O, the input is
 * not mutated. Order: dismissals (applyDismissal, source "report-ui"), then triage
 * (buildTriage / applyTriage, source "report-ui", with triage.ticketsAuthorized = doc.tickets),
 * then backfill (decideItems); the scorecard is recomputed when any of them changed the
 * report. Then the annotations: each must name a state of the report with an image on
 * its side; they are merged into the recorded ones (mergeAnnotations: never twice, next
 * id after the highest) and never change report.json (they become findings when the
 * report is rebuilt). Missing by / date fall back to doc.decidedBy / doc.decidedAt, so
 * the result is deterministic and re-applying the same document changes nothing (changes: []).
 * opts: { now (fallback date when the doc has no decidedAt), allowStale, options
 * (ranking options / design-qa config), annotations (the records already in
 * <report dir>/annotations.json) }.
 * Returns { report, changes, warnings, annotations (every record after the merge) }; changes are
 *   { type: "dismissal", findingId, kind, updated }
 *   { type: "triage", fixNow: [ids], debt: [ids] }   (the recorded split, rank order of the report)
 *   { type: "backfill", id, decision, previous }
 *   { type: "annotation", id, state, severity, decision }   (one per newly recorded annotation)
 * Throws DecisionsError: "slug" / "stale" (see checkDecisionsTarget), "unknown-id",
 * "apply" (e.g. a PASS finding dismissed, a backfill item already built, an annotation
 * on a side of a state that has no image).
 */
export function applyDecisions(report, doc, { now = new Date().toISOString(), allowStale = false, options = {}, annotations = [] } = {}) {
  if (!isObj(report) || !Array.isArray(report.findings)) throw new DecisionsError('not a design-qa report (no "findings" array)', 'apply');
  const d = normalizeDecisions(doc);
  const o = resolveOptions(options);
  const { warnings } = checkDecisionsTarget(report, d, { allowStale });
  const decidedAt = d.decidedAt ?? now;
  const byId = new Map(report.findings.map((f) => [f?.id, f]));

  const triageIds = d.triage ? [...d.triage.fixNow, ...d.triage.debt] : [];
  const unknown = [...new Set([...d.dismissals.map((x) => x.findingId), ...triageIds])].filter((id) => !byId.has(id));
  if (unknown.length) {
    throw new DecisionsError(
      `unknown finding id${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')}: not in this report.json. Reopen the current report.html and decide again`,
      'unknown-id',
    );
  }
  if (d.backfill.length) {
    const known = new Set(backfillItems(report).map((i) => i.id));
    const missing = d.backfill.map((b) => b.id).filter((id) => !known.has(id));
    if (missing.length) {
      const have = hasBackfill(report) ? [...known].join(', ') || 'none' : 'the report has no backfill block';
      throw new DecisionsError(`unknown backfill id${missing.length === 1 ? '' : 's'} ${missing.join(', ')} (have: ${have})`, 'unknown-id');
    }
  }
  const docAnnotations = d.annotations ?? [];
  if (docAnnotations.length) {
    const rows = new Map((Array.isArray(report.stateMatrix) ? report.stateMatrix : []).filter((r) => typeof r?.state === 'string').map((r) => [r.state, r]));
    docAnnotations.forEach((a, i) => {
      const row = rows.get(a.state);
      if (!row) {
        throw new DecisionsError(`annotations[${i}] names state ${show(a.state)}, not a state of this report (have: ${[...rows.keys()].join(', ') || 'none'})`, 'unknown-id');
      }
      const image = a.side === 'app' ? row.captured?.app : row.captured?.design;
      if (typeof image !== 'string' || !image) {
        const what = a.side === 'app' ? 'no app capture' : 'no design image';
        throw new DecisionsError(`annotations[${i}] is on the ${a.side} image of ${show(a.state)}, but this report has ${what} for that state`, 'apply');
      }
    });
  }

  let next = report;
  const changes = [];

  // 1. Dismissals.
  for (const item of d.dismissals) {
    const before = next.findings.find((f) => f.id === item.findingId);
    const wasInTriage = Array.isArray(next.triage?.items) && next.triage.items.some((i) => i?.findingId === item.findingId);
    let result;
    try {
      result = applyDismissal(next, item.findingId, {
        kind: item.kind,
        reason: item.reason,
        by: item.by ?? d.decidedBy,
        date: item.date ?? decidedAt,
        source: 'report-ui',
      });
    } catch (err) {
      throw new DecisionsError(err.message, 'apply');
    }
    if (sameJson(before, result.finding) && !wasInTriage) continue;
    next = result.report;
    changes.push({ type: 'dismissal', findingId: item.findingId, kind: item.kind, updated: ['DISMISSED', 'INTENTIONAL'].includes(before.resolution) });
  }

  // 2. Triage.
  if (d.triage) {
    const current = new Map(next.findings.map((f) => [f.id, f]));
    const listed = new Set(triageIds);
    const fixIds = [];
    for (const id of d.triage.fixNow) {
      const f = current.get(id);
      if (isTriageable(f)) fixIds.push(id);
      else warnings.push(`${id} is ${oneLine(f.severity)} / ${oneLine(f.resolution)} in report.json, not triageable; its fix-now decision is ignored`);
    }
    for (const id of d.triage.debt) {
      const f = current.get(id);
      if (!isTriageable(f)) warnings.push(`${id} is ${oneLine(f.severity)} / ${oneLine(f.resolution)} in report.json, not triageable; its debt decision is ignored`);
    }
    const unlisted = next.findings.filter((f) => isTriageable(f) && !listed.has(f.id)).map((f) => f.id);
    if (unlisted.length) warnings.push(`not in the decisions, recorded as debt: ${unlisted.join(', ')}`);
    const built = buildTriage(next, { fixIds, decidedBy: d.decidedBy, decidedAt, source: 'report-ui' });
    warnings.push(...built.warnings.map(oneLine));
    const triage = { ...built.triage, ticketsAuthorized: d.tickets };
    if (!sameJson(triageComparable(next.triage), triageComparable(triage))) {
      next = applyTriage(next, triage, o);
      const decision = new Map(triage.items.map((i) => [i.findingId, i.decision]));
      const ranked = withRanks(next.findings, o).filter((f) => decision.has(f.id));
      changes.push({
        type: 'triage',
        fixNow: ranked.filter((f) => decision.get(f.id) === 'fix-now').map((f) => f.id),
        debt: ranked.filter((f) => decision.get(f.id) === 'debt').map((f) => f.id),
      });
    }
  }

  // 3. Design backfill.
  for (const b of d.backfill) {
    const before = backfillItems(next).find((i) => i.id === b.id);
    let result;
    try {
      result = decideItems(next, [{ id: b.id, decision: b.decision, reason: b.reason ?? '', by: b.by ?? d.decidedBy, date: b.date ?? decidedAt }], { now: decidedAt });
    } catch (err) {
      throw new DecisionsError(err.message, 'apply');
    }
    const after = backfillItems(result.report).find((i) => i.id === b.id);
    if (sameJson(before, after)) continue;
    next = result.report;
    changes.push({ type: 'backfill', id: b.id, decision: b.decision, previous: before.decision });
  }

  if (changes.length) {
    next = { ...next, findings: withRanks(next.findings, o) };
    next.scorecard = computeScorecard(next, o);
  }

  // 4. Annotations: recorded beside the report (annotations.json), never in it.
  let merged;
  try {
    merged = mergeAnnotations(annotations, docAnnotations, { by: d.decidedBy, date: decidedAt });
  } catch (err) {
    if (err instanceof AnnotationError) throw new DecisionsError(err.message, 'apply');
    throw err;
  }
  for (const a of merged.added) changes.push({ type: 'annotation', id: a.id, state: a.state, severity: a.severity, decision: a.decision });
  if (docAnnotations.length && !d.triage && !isObj(next.triage)) {
    warnings.push('no triage is recorded yet, so the fix now / later choice on the annotations applies only once one is; until then the rebuilt report uses the recommended split');
  }
  return { report: next, changes, warnings, annotations: merged.annotations };
}

// ---------------------------------------------------------------------------
// The plain-language message ("Copy for your agent")

/**
 * A finding with every string folded to one line (oneLine), except the source
 * snippet, which agentPrompt prints as indented lines of its own.
 */
function foldedFinding(value, key = '') {
  if (typeof value === 'string') return key === 'snippet' ? value : oneLine(value);
  if (Array.isArray(value)) return value.map((v) => foldedFinding(v));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, foldedFinding(v, k)]));
  return value;
}

/**
 * The message report.html copies for any coding agent: what to do, the document in a
 * ```design-qa-decisions fence, then the fix-now prompts (agentPrompt), the fix-later,
 * dismissed, backfill and annotation lists. Deterministic: everything comes from the (normalized)
 * document and the report's findings. reportPath defaults to qa-reports/<slug>/report.json.
 * Lines are joined with "\n"; there is no trailing newline. Feature, slug, names,
 * report path and every finding string (but the snippet) are folded with oneLine, so
 * nothing quoted can open a line of its own (a forged fence or instruction).
 */
export function decisionsMessage(report, doc, { reportPath, configPath } = {}) {
  const d = normalizeDecisions(doc);
  const file = reportPath || `qa-reports/${d.slug}/report.json`;
  const feature = oneLine(d.feature ?? report?.meta?.feature ?? d.slug);
  const findings = new Map((Array.isArray(report?.findings) ? report.findings : []).map((f) => [f?.id, f]));
  const finding = (id) => foldedFinding(findings.get(id) ?? { id, title: '(not in this report)' });
  const fixNow = d.triage ? d.triage.fixNow : [];
  const debt = d.triage ? d.triage.debt : [];
  const annotations = d.annotations ?? [];

  const lines = [
    `Apply my design QA review for ${feature} (${oneLine(d.slug)}).`,
    '',
    `Report: ${oneLine(file)}`,
    `Decided by ${oneLine(d.decidedBy ?? 'the reviewer')}: ${summaryLine(d)}`,
    '',
    'What to do:',
    '1. Use the design-qa skill, section "Apply review decisions". Save this whole message to a file and run its script:',
    `   node scripts/apply-decisions.mjs --report ${shellArg(file)} --from <that file>${configPath ? ` --config ${shellArg(configPath)}` : ''}`,
    `   (the script path is relative to the design-qa skill folder). No design-qa skill available? Skip step 1 and do steps ${annotations.length ? '2 to 4' : '2 and 3'} from the text below.`,
    `2. Fix the "Fix now" findings below, in the order given. Do not change data or copy beyond what each item says. Run the project's tests after each item.`,
    '3. Do not fix the "Fix later" items; they are tracked as debt. Leave dismissed items alone.',
    ...(annotations.length
      ? ['4. "Annotations added in the review" lists issues the reviewer found that the QA missed: check each one in the app, then fix it now or later as marked.']
      : []),
    '',
    `\`\`\`${DECISIONS_FENCE}`,
    JSON.stringify(d, null, 2),
    '```',
    '',
    `Fix now (${fixNow.length})`,
    '',
    fixNow.length ? fixNow.map((id) => agentPrompt(finding(id))).join('\n\n') : 'None.',
    '',
    `Fix later (${debt.length})`,
    ...(debt.length ? debt.map((id) => `- ${id} [${finding(id).severity ?? '–'}] ${finding(id).title}`) : ['None.']),
  ];
  if (d.dismissals.length) {
    lines.push('', `Dismissed (${d.dismissals.length})`);
    for (const x of d.dismissals) lines.push(`- ${x.findingId} ${x.kind} — ${oneLine(x.reason)}`);
  }
  if (d.backfill.length) {
    lines.push('', `Design backfill (${d.backfill.length})`);
    for (const b of d.backfill) lines.push(b.decision === 'not-needed' ? `- ${b.id} not-needed — ${oneLine(b.reason)}` : `- ${b.id} build`);
  }
  if (annotations.length) {
    lines.push('', `Annotations added in the review (${annotations.length})`);
    for (const a of annotations) {
      const { x, y, w, h } = a.box;
      lines.push(`- [${a.severity}] ${oneLine(a.state)} (${a.side} ${x},${y} ${w}×${h}) ${a.decision === 'fix-now' ? 'fix now' : 'fix later'} — ${oneLine(a.note)}`);
    }
  }
  return lines.join('\n');
}
