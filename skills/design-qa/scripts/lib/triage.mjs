// Triage: the person's "fix-now" / "debt" decision for every triageable finding
// (FIX_CODE or SYNC_FIGMA with severity BLOCKER, WARNING or DS_CANDIDATE), so every
// diff is either fixed now or tracked as debt with a ticket.
import {
  compareRanked,
  computeScorecard,
  findingsInBucket,
  isTriageable,
  rankFindings,
  resolveOptions,
  triageIndex,
} from './ranking.mjs';

export function kebab(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The report's slug: its ticket key, else the kebab-cased feature name. */
export function reportSlug(report) {
  return report?.meta?.ticket?.key || kebab(report?.meta?.feature) || 'report';
}

/** Who fixes a finding: design for SYNC_FIGMA, engineering otherwise. */
export function ownerOf(finding) {
  return finding?.resolution === 'SYNC_FIGMA' ? 'design' : 'engineering';
}

/** The findings with ranks (ranked with rankFindings when any rank is missing). */
export function withRanks(findings, opts = {}) {
  const list = Array.isArray(findings) ? findings : [];
  return list.every((f) => f && f.rank) ? list : rankFindings(list, opts);
}

/** Recommended fix-now ids: the fix-now bucket, then the sync-figma bucket, in rank order. */
export function recommendedFixIds(report, opts = {}) {
  const ranked = withRanks(report?.findings, opts);
  return [...findingsInBucket(ranked, 'fix-now'), ...findingsInBucket(ranked, 'sync-figma')].map((f) => f.id);
}

/** "/design-qa triage <slug> --fix DQ-001,DQ-002" ("--fix none" when nothing is fixed now). */
export function triageCommand(report, fixIds = []) {
  const ids = (Array.isArray(fixIds) ? fixIds : []).filter(Boolean);
  return `/design-qa triage ${reportSlug(report)} --fix ${ids.length ? ids.join(',') : 'none'}`;
}

/**
 * Split the triageable findings by decision, each list in rank order:
 * { triaged, fixNow (FIX_CODE), syncFigma (SYNC_FIGMA), debt (both) }.
 * Without a triage block the rank buckets are the recommendation.
 */
export function triageLists(report, opts = {}) {
  const findings = withRanks(report?.findings, opts);
  if (!report?.triage || !Array.isArray(report.triage.items)) {
    return {
      triaged: false,
      fixNow: findingsInBucket(findings, 'fix-now'),
      syncFigma: findingsInBucket(findings, 'sync-figma'),
      debt: findingsInBucket(findings, 'debt'),
    };
  }
  const index = triageIndex(report);
  const sorted = findings.filter((f) => f && isTriageable(f) && index.has(f.id)).sort(compareRanked);
  const decided = (f, decision) => index.get(f.id).decision === decision;
  return {
    triaged: true,
    fixNow: sorted.filter((f) => decided(f, 'fix-now') && f.resolution === 'FIX_CODE'),
    syncFigma: sorted.filter((f) => decided(f, 'fix-now') && f.resolution === 'SYNC_FIGMA'),
    debt: sorted.filter((f) => decided(f, 'debt')),
  };
}

/**
 * Build a triage block: listed ids → "fix-now", every other triageable finding →
 * "debt". Blockers are always fix-now (with a warning when not listed). Tickets,
 * and reasons whose decision did not change, carry over from the previous triage.
 * Returns { triage, warnings }.
 */
export function buildTriage(report, { fixIds = [], decidedBy = null, decidedAt = new Date().toISOString(), source = 'cli' } = {}) {
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  const previous = triageIndex(report);
  const fix = new Set(fixIds);
  const warnings = [];
  const items = findings.filter((f) => f && isTriageable(f)).map((f) => {
    let decision = fix.has(f.id) ? 'fix-now' : 'debt';
    let reason = null;
    if (decision === 'debt' && f.severity === 'BLOCKER') {
      decision = 'fix-now';
      reason = 'Blockers cannot be deferred.';
      warnings.push(`${f.id} is a BLOCKER: blockers cannot be deferred; kept in fix now`);
    }
    const before = previous.get(f.id);
    if (before && before.decision === decision && reason === null) reason = before.reason ?? null;
    const ticket = before?.ticket ?? null;
    if (ticket && decision === 'fix-now') warnings.push(`${f.id} moves to fix now but ${ticket.key} still tracks it as debt; close or re-scope that ticket`);
    return { findingId: f.id, decision, reason, ticket };
  });
  return { triage: { decidedBy, decidedAt, source, items }, warnings };
}

const KEY_ORDER = ['$schema', 'schemaVersion', 'meta', 'scorecard', 'triage', 'stateMatrix', 'findings', 'ledgers', 'openDecisions', 'fixLoop', 'evidence'];

function orderKeys(obj) {
  const out = {};
  for (const k of KEY_ORDER) if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  for (const k of Object.keys(obj)) if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = obj[k];
  return out;
}

/** The report with a triage block applied: schemaVersion 1.1, ranks filled, scorecard recomputed. */
export function applyTriage(report, triage, opts = {}) {
  const o = resolveOptions(opts);
  const next = orderKeys({ ...report, schemaVersion: '1.1', findings: withRanks(report.findings, o), triage });
  next.scorecard = computeScorecard(next, o);
  return next;
}
