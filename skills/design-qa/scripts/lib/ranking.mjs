// Derived rules for a design-qa report: pixel-diff bands, parity, verdict,
// state coverage, the scorecard and the fix-now / debt ranking.
// Pure functions — no IO — so the validator, renderer and tests share one truth.
// Also the derived counts of the design backfill (step 2), which sit beside step 1
// and never change it.
// Direction is design → code only: every open finding is fixed in code (or
// dismissed / signed off), never pushed back to the design.

export const SEVERITIES = Object.freeze(['BLOCKER', 'WARNING', 'PASS', 'CANNOT_VERIFY', 'DS_CANDIDATE']);
export const RESOLUTIONS = Object.freeze(['FIX_CODE', 'INTENTIONAL', 'DATA', 'DISMISSED', 'NONE', 'UNCLASSIFIED']);
export const LEDGERS = Object.freeze(['structure', 'component', 'style', 'state', 'behavior', 'motion']);
export const VERDICTS = Object.freeze(['PASS', 'REVIEW', 'FAIL']);
export const BANDS = Object.freeze(['pass', 'review', 'fail']);

export const SCHEMA_VERSION = '2.0';
export const TRIAGE_SOURCES = Object.freeze(['report-ui', 'chat', 'cli', 'ci-default']);
export const DISMISSAL_SOURCES = Object.freeze(['report-ui', 'chat', 'cli', 'prior-pass']);
/** Design backfill (step 2): what a person decided about an undesigned state. */
export const BACKFILL_DECISIONS = Object.freeze(['pending', 'build', 'not-needed']);
/** Design backfill: how an undesigned state was found. */
export const BACKFILL_DISCOVERED_BY = Object.freeze(['config', 'source', 'ticket', 'capture']);

/** rank.bucket values: fix-now and debt hold FIX_CODE findings; everything else is none. */
export const BUCKETS = Object.freeze(['fix-now', 'debt', 'none']);

/** Resolutions that still need work: they count against parity. */
export const OPEN_RESOLUTIONS = Object.freeze(['FIX_CODE', 'UNCLASSIFIED']);
/** Only FIX_CODE findings are scored: they fill fix-now / debt. */
export const RANKABLE_RESOLUTIONS = Object.freeze(['FIX_CODE']);
export const RANKABLE_SEVERITIES = Object.freeze(['BLOCKER', 'WARNING', 'DS_CANDIDATE']);

export const DEFAULT_TOLERANCES = Object.freeze({ pass: 1, review: 5 });
export const DEFAULT_SEVERITY_WEIGHTS = Object.freeze({ BLOCKER: 3, WARNING: 2, DS_CANDIDATE: 1 });
export const DEFAULT_LEDGER_WEIGHTS = Object.freeze({ structure: 3, component: 3, state: 3, style: 2, behavior: 2, motion: 2 });
export const DEFAULT_TOP_N = 5;
export const DEFAULT_EFFORT = 3;

const RESOLVED = Symbol('design-qa.resolvedOptions');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Normalise ranking/tolerance options. Accepts either
 *   { topN, ranking: { severity, ledger }, tolerances: { pass, review } }
 * or a design-qa config ({ report: { topN, ranking }, tolerances: { pixelDiff: { pass, review } } }),
 * or a mix of both (explicit keys win over config keys).
 */
export function resolveOptions(opts = {}) {
  if (opts && opts[RESOLVED]) return opts;
  const o = isObj(opts) ? opts : {};
  const report = isObj(o.report) ? o.report : {};
  const ranking = isObj(o.ranking) ? o.ranking : isObj(report.ranking) ? report.ranking : {};
  const tolSource = isObj(o.tolerances) ? (isObj(o.tolerances.pixelDiff) ? o.tolerances.pixelDiff : o.tolerances) : {};
  const topN = Number.isInteger(o.topN) ? o.topN : Number.isInteger(report.topN) ? report.topN : DEFAULT_TOP_N;
  const resolved = {
    topN: Math.max(0, topN),
    severityWeights: { ...DEFAULT_SEVERITY_WEIGHTS, ...(isObj(ranking.severity) ? ranking.severity : {}) },
    ledgerWeights: { ...DEFAULT_LEDGER_WEIGHTS, ...(isObj(ranking.ledger) ? ranking.ledger : {}) },
    tolerances: {
      pass: typeof tolSource.pass === 'number' ? tolSource.pass : DEFAULT_TOLERANCES.pass,
      review: typeof tolSource.review === 'number' ? tolSource.review : DEFAULT_TOLERANCES.review,
    },
  };
  Object.defineProperty(resolved, RESOLVED, { value: true });
  return resolved;
}

/**
 * Pixel-diff band: percent < pass → "pass"; percent <= review → "review"; else "fail".
 * 0% (identical images) is always "pass", also with a pass tolerance of 0 (as diff.mjs).
 */
export function band(percent, tolerances = DEFAULT_TOLERANCES) {
  const t = isObj(tolerances) && isObj(tolerances.pixelDiff) ? tolerances.pixelDiff : tolerances || {};
  const pass = typeof t.pass === 'number' ? t.pass : DEFAULT_TOLERANCES.pass;
  const review = typeof t.review === 'number' ? t.review : DEFAULT_TOLERANCES.review;
  if (percent === 0 || percent < pass) return 'pass';
  if (percent <= review) return 'review';
  return 'fail';
}

export function isOpen(finding) {
  return OPEN_RESOLUTIONS.includes(finding?.resolution);
}

/** Dismissed findings (not an issue / removed from this QA): not diffs, left out of parity. */
export function isDismissed(finding) {
  return finding?.resolution === 'DISMISSED';
}

const filled = (v) => typeof v === 'string' && v.trim() !== '';

/** Open style finding whose design names a token the code does not use. */
export function isTokenMismatch(finding) {
  return (
    isOpen(finding) &&
    finding.ledger === 'style' &&
    filled(finding.expected?.token) &&
    (finding.actual?.token ?? null) !== finding.expected.token
  );
}

/** Open component finding: the code renders another component or variant than the design. */
export function isComponentMismatch(finding) {
  return isOpen(finding) && finding.ledger === 'component';
}

/** Open motion finding: a transition / animation is missing or differs from the design. */
export function isMotionMismatch(finding) {
  return isOpen(finding) && finding.ledger === 'motion';
}

/**
 * Open design-system mismatches, each list in id order:
 * { tokens, components, motion } (accepts a report or a findings array).
 */
export function designSystemGroups(report) {
  const findings = Array.isArray(report) ? report : Array.isArray(report?.findings) ? report.findings : [];
  const pick = (test) => findings.filter((f) => f && test(f)).sort((a, b) => compareIds(a.id, b.id));
  return { tokens: pick(isTokenMismatch), components: pick(isComponentMismatch), motion: pick(isMotionMismatch) };
}

export function isRankable(finding) {
  return RANKABLE_RESOLUTIONS.includes(finding?.resolution) && RANKABLE_SEVERITIES.includes(finding?.severity);
}

/** Triageable findings are the rankable ones: each gets a "fix-now" or "debt" decision. */
export function isTriageable(finding) {
  return isRankable(finding);
}

/** findingId → triage item (first one wins; duplicates are a validation error). */
export function triageIndex(report) {
  const index = new Map();
  const items = Array.isArray(report?.triage?.items) ? report.triage.items : [];
  for (const item of items) {
    if (item && typeof item.findingId === 'string' && !index.has(item.findingId)) index.set(item.findingId, item);
  }
  return index;
}

/** Ticketed debt: the person deferred it (decision "debt") and a ticket tracks it. */
export function isTicketedDebt(finding, index) {
  const item = index.get(finding?.id);
  return Boolean(item && item.decision === 'debt' && item.ticket);
}

/**
 * Unexplained findings: open (FIX_CODE, UNCLASSIFIED) and not ticketed
 * debt. Without a triage block this is exactly the open set.
 */
export function unexplainedFindings(report) {
  const index = triageIndex(report);
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  return findings.filter((f) => f && isOpen(f) && !isTicketedDebt(f, index));
}

/** { count: items decided "debt", ticketed: those with a ticket }. */
export function debtSummary(report) {
  const items = Array.isArray(report?.triage?.items) ? report.triage.items : [];
  const debt = items.filter((i) => i && i.decision === 'debt');
  return { count: debt.length, ticketed: debt.filter((i) => i.ticket).length };
}

/**
 * parity = round(100 × (1 − open / max(1, findings − dismissed))). Dismissed
 * findings are not diffs, so they leave the denominator. Clamped to 99 while any
 * finding is open, so 100 always means "nothing left to do".
 */
export function parity(findings = []) {
  const list = Array.isArray(findings) ? findings : [];
  const open = list.filter(isOpen).length;
  const counted = list.filter((f) => !isDismissed(f)).length;
  const value = Math.round(100 * (1 - open / Math.max(1, counted)));
  return open > 0 ? Math.min(value, 99) : value;
}

export function stateCoverage(stateMatrix = []) {
  const rows = Array.isArray(stateMatrix) ? stateMatrix : [];
  const has = (row, key) => isObj(row) && row[key] !== null && row[key] !== undefined;
  return {
    total: rows.length,
    designed: rows.filter((r) => has(r, 'designed')).length,
    specified: rows.filter((r) => has(r, 'specified')).length,
    implemented: rows.filter((r) => has(r, 'implemented')).length,
    verified: rows.filter((r) => r && (r.result === 'PASS' || r.result === 'FAIL')).length,
  };
}

/**
 * The band of one scorecard.pixelDiff entry: the band of its percent, raised from "pass"
 * to "review" when diff.mjs found a structural difference (structuralBand "review": a
 * large area that differs below pixelmatch's threshold). Never raised to "fail".
 */
export function pixelDiffBand(entry, tolerances = DEFAULT_TOLERANCES) {
  const b = band(entry.percent, tolerances);
  return b === 'pass' && entry?.structuralBand === 'review' ? 'review' : b;
}

/** Pixel-diff bands recomputed from each entry's percent and structuralBand (entries without a numeric percent are skipped). */
export function derivedBands(report, opts = {}) {
  const o = resolveOptions(opts);
  const out = {};
  const pixelDiff = isObj(report?.scorecard?.pixelDiff) ? report.scorecard.pixelDiff : {};
  for (const [state, entry] of Object.entries(pixelDiff)) {
    if (isObj(entry) && typeof entry.percent === 'number' && Number.isFinite(entry.percent)) {
      out[state] = pixelDiffBand(entry, o.tolerances);
    }
  }
  return out;
}

/**
 * Verdict plus the human-readable reasons that produced it.
 * FAIL: an open BLOCKER, a MISSING_IN_CODE state, or a pixel diff in the fail band
 * for a state that has an unexplained finding or no findings at all.
 * REVIEW: an unexplained finding (ticketed debt is explained), a CANNOT_VERIFY
 * finding, an open decision, a review band, a fail band whose findings are all
 * explained (fixed, INTENTIONAL, DATA, DISMISSED or ticketed debt), a
 * CANNOT_VERIFY state, or no verified state at all (an empty state matrix, or no
 * row PASS or FAIL: nothing was captured and compared). Otherwise PASS.
 */
export function explainVerdict(report, opts = {}) {
  const o = resolveOptions(opts);
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  const matrix = Array.isArray(report?.stateMatrix) ? report.stateMatrix : [];
  const decisions = Array.isArray(report?.openDecisions) ? report.openDecisions : [];
  const bands = derivedBands(report, o);
  const unexplained = unexplainedFindings(report);
  const unexplainedSet = new Set(unexplained);

  const fail = [];
  const explainedFailBands = [];
  for (const f of findings) {
    if (f && f.severity === 'BLOCKER' && isOpen(f)) fail.push(`${f.id} is an open BLOCKER (${f.resolution})`);
  }
  for (const row of matrix) {
    if (row && row.result === 'MISSING_IN_CODE') fail.push(`state "${row.state}" is MISSING_IN_CODE`);
  }
  for (const [state, b] of Object.entries(bands)) {
    if (b !== 'fail') continue;
    const inState = findings.filter((f) => f && f.state === state);
    if (!inState.length || inState.some((f) => unexplainedSet.has(f))) fail.push(`pixel diff for "${state}" is in the fail band`);
    else explainedFailBands.push(state);
  }
  if (fail.length) return { verdict: 'FAIL', reasons: fail };

  const review = [];
  if (unexplained.length) review.push(`${unexplained.length} unexplained finding(s): ${unexplained.map((f) => f.id).join(', ')}`);
  const cannot = findings.filter((f) => f && f.severity === 'CANNOT_VERIFY');
  if (cannot.length) review.push(`${cannot.length} CANNOT_VERIFY finding(s)`);
  if (decisions.length) review.push(`${decisions.length} open decision(s)`);
  for (const [state, b] of Object.entries(bands)) {
    if (b === 'review') review.push(`pixel diff for "${state}" is in the review band`);
  }
  for (const state of explainedFailBands) {
    review.push(`pixel diff for "${state}" is in the fail band, but every finding there is explained`);
  }
  for (const row of matrix) {
    if (row && row.result === 'CANNOT_VERIFY') review.push(`state "${row.state}" is CANNOT_VERIFY`);
  }
  // Nothing compared is not a pass: an empty pass must not read as full parity.
  const coverage = stateCoverage(matrix);
  if (coverage.total === 0) review.push('no state was verified: the state matrix is empty');
  else if (coverage.verified === 0) review.push(`no state was verified (0 of ${coverage.total} captured and compared)`);
  if (review.length) return { verdict: 'REVIEW', reasons: review };
  return { verdict: 'PASS', reasons: [] };
}

export function deriveVerdict(report, opts = {}) {
  return explainVerdict(report, opts).verdict;
}

/** score = sevW×100 + ledgerW×10 + (6 − effort); null when the finding is not rankable. */
export function scoreFinding(finding, opts = {}) {
  if (!isRankable(finding)) return null;
  const o = resolveOptions(opts);
  const sev = Number(o.severityWeights[finding.severity]) || 0;
  const led = Number(o.ledgerWeights[finding.ledger]) || 0;
  const effort = typeof finding.fix?.effort === 'number' ? finding.fix.effort : DEFAULT_EFFORT;
  return sev * 100 + led * 10 + (6 - effort);
}

function idNumber(id) {
  const m = /(\d+)$/.exec(String(id ?? ''));
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

/** Compare two finding ids: numeric suffix first, then plain string order. */
export function compareIds(a, b) {
  const d = idNumber(a) - idNumber(b);
  if (d !== 0 && Number.isFinite(d)) return d;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

/** Tie-break for equal scores: id ascending (numeric part first). */
export function tieBreak(a, b) {
  return compareIds(a?.id, b?.id);
}

/** Sort order inside a bucket: rank.score desc, then id ascending. */
export function compareRanked(a, b) {
  const s = (b?.rank?.score ?? 0) - (a?.rank?.score ?? 0);
  return s !== 0 ? s : tieBreak(a, b);
}

/** Which list a finding belongs to, independent of topN: "fix-code" (fix-now or debt) or "none". */
export function bucketKind(finding) {
  return isRankable(finding) ? 'fix-code' : 'none';
}

/**
 * Returns a new array (same order as the input) where every finding has `rank`.
 * FIX_CODE findings with severity BLOCKER, WARNING or DS_CANDIDATE are sorted by
 * score (ties: id ascending): the first topN are "fix-now", the rest "debt".
 * Everything else (INTENTIONAL, DATA, DISMISSED, UNCLASSIFIED, PASS,
 * CANNOT_VERIFY) is { score: 0, bucket: "none" }.
 */
export function rankFindings(findings = [], opts = {}) {
  const o = resolveOptions(opts);
  const list = Array.isArray(findings) ? findings : [];
  const scored = list.map((f, index) => ({ f, index, score: scoreFinding(f, o) }));
  const byScore = (a, b) => b.score - a.score || tieBreak(a.f, b.f);
  const ranks = new Map();
  scored
    .filter((s) => s.score !== null)
    .sort(byScore)
    .forEach((s, position) => ranks.set(s.index, { score: s.score, bucket: position < o.topN ? 'fix-now' : 'debt' }));
  return list.map((f, index) => ({ ...f, rank: ranks.get(index) ?? { score: 0, bucket: 'none' } }));
}

/** Findings of one rank bucket in order: score desc, then id ascending. */
export function findingsInBucket(findings = [], bucket) {
  return (Array.isArray(findings) ? findings : [])
    .filter((f) => f && f.rank && f.rank.bucket === bucket)
    .sort((a, b) => compareRanked(a, b));
}

/** { tokens, components, motion }: counts of open design-system mismatches. */
export function designSystemCounts(report) {
  const g = designSystemGroups(report);
  return { tokens: g.tokens.length, components: g.components.length, motion: g.motion.length };
}

/**
 * The scorecard implied by the findings, state matrix, decisions, triage and
 * pixel-diff percents (schemaVersion 2.0): counts, parity, verdict, bands,
 * coverage, unexplained, debt, loopClosed (unexplained == 0 and no open
 * decisions), dismissed and designSystem — plus backfill (step 2) only when the
 * report has a backfill block.
 */
export function computeScorecard(report, opts = {}) {
  const o = resolveOptions(opts);
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  const byResolution = Object.fromEntries(RESOLUTIONS.map((r) => [r, 0]));
  for (const f of findings) {
    if (f && Object.prototype.hasOwnProperty.call(bySeverity, f.severity)) bySeverity[f.severity] += 1;
    if (f && Object.prototype.hasOwnProperty.call(byResolution, f.resolution)) byResolution[f.resolution] += 1;
  }
  const bands = derivedBands(report, o);
  const pixelDiff = {};
  const given = isObj(report?.scorecard?.pixelDiff) ? report.scorecard.pixelDiff : {};
  for (const [state, entry] of Object.entries(given)) {
    const e = isObj(entry) ? entry : {};
    pixelDiff[state] = { ...e, band: bands[state] ?? e.band, image: e.image ?? null };
  }
  const scorecard = {
    parity: parity(findings),
    verdict: deriveVerdict(report, o),
    bySeverity,
    byResolution,
    pixelDiff,
    stateCoverage: stateCoverage(report?.stateMatrix),
  };
  const unexplained = unexplainedFindings(report).length;
  scorecard.unexplained = unexplained;
  scorecard.debt = debtSummary(report);
  scorecard.loopClosed = isLoopClosed(report);
  scorecard.dismissed = findings.filter(isDismissed).length;
  scorecard.designSystem = designSystemCounts(report);
  // Step 2 (design backfill) is reported beside step 1, never inside it: it is added
  // only when the report has a backfill block and changes nothing above.
  if (hasBackfill(report)) scorecard.backfill = backfillSummary(report);
  return scorecard;
}

/** Step 1 is closed: no unexplained finding (open and not ticketed debt) and no open decision. */
export function isLoopClosed(report) {
  const decisions = Array.isArray(report?.openDecisions) ? report.openDecisions.length : 0;
  return unexplainedFindings(report).length === 0 && decisions === 0;
}

// ---------------------------------------------------------------------------
// Design backfill (step 2): undesigned states built back into Figma. Kept apart
// from step 1 — it never changes parity, verdict, unexplained, loopClosed, the
// rank buckets or designSystem.

/** True when the report carries a backfill block (an object, not null). */
export function hasBackfill(report) {
  return isObj(report?.backfill);
}

/** backfill.items (an empty array when there is no backfill block). */
export function backfillItems(report) {
  return hasBackfill(report) && Array.isArray(report.backfill.items) ? report.backfill.items.filter(isObj) : [];
}

/** The recorded override that allows building before step 1 is closed, or null. */
export function backfillOverride(report) {
  const o = hasBackfill(report) && isObj(report.backfill.gate) ? report.backfill.gate.override : null;
  return isObj(o) ? o : null;
}

/**
 * Frames may be built in Figma once production matches the design (step 1's
 * loopClosed, derived from the findings) or when a person recorded an override.
 */
export function isBackfillReady(report) {
  return isLoopClosed(report) || backfillOverride(report) !== null;
}

/** An item that has a Figma frame recorded. */
export function isBackfillBuilt(item) {
  return isObj(item?.figma);
}

/**
 * scorecard.backfill: { candidates, toBuild (decision build, no Figma frame yet),
 * built (Figma frame recorded), notNeeded, pending, ready }; null without a
 * backfill block.
 */
export function backfillSummary(report) {
  if (!hasBackfill(report)) return null;
  const items = backfillItems(report);
  return {
    candidates: items.length,
    toBuild: items.filter((i) => i.decision === 'build' && !isBackfillBuilt(i)).length,
    built: items.filter(isBackfillBuilt).length,
    notNeeded: items.filter((i) => i.decision === 'not-needed').length,
    pending: items.filter((i) => i.decision === 'pending').length,
    ready: isBackfillReady(report),
  };
}
