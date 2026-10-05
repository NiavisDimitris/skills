// Derived rules for a design-qa report: pixel-diff bands, match, verdict,
// state coverage, the scorecard and the fix-now / debt ranking.
// Pure functions — no IO — so the validator, renderer and tests share one truth.
// Also the derived counts of the design backfill (step 2), which sit beside step 1
// and never change it.
// Direction is design → code only: every open finding is fixed in code (or
// dismissed / signed off), never pushed back to the design.

export const SEVERITIES = Object.freeze(['BLOCKER', 'WARNING', 'PASS', 'CANNOT_VERIFY', 'DS_CANDIDATE']);
export const RESOLUTIONS = Object.freeze(['FIX_CODE', 'INTENTIONAL', 'DATA', 'DISMISSED', 'NONE', 'UNCLASSIFIED']);
export const LEDGERS = Object.freeze(['structure', 'component', 'style', 'state', 'behavior', 'motion']);
/** INCOMPLETE: nothing was captured and compared, so the pass has no result (see explainVerdict). */
export const VERDICTS = Object.freeze(['PASS', 'REVIEW', 'FAIL', 'INCOMPLETE']);
/** The last reason of an INCOMPLETE verdict: what to do next. */
export const INCOMPLETE_NEXT = 'nothing was captured and compared: fix the capture (sign-in, URL, state drivers) and run the pass again; this is not a result';
/** Evidence types that come from the app capture (the rest are the design side). */
export const APP_EVIDENCE_TYPES = Object.freeze(['screenshot', 'computed', 'dom', 'motion', 'diff']);
/** An unpinnedReason or dataReason must be at least this long (trimmed): a sentence, not a flag. */
export const UNPINNED_REASON_MIN = 20;
export const DATA_REASON_MIN = 20;
/** A pin's crop covers at least this many pixels (an 8×8 area): a 1×1 crop is not a pin, a 1 px divider 64+ px long is. */
export const MIN_PIN_AREA = 64;
/** Severities that are divergences: they count as settled or open and can explain a fail band. */
export const DIVERGENT_SEVERITIES = Object.freeze(['BLOCKER', 'WARNING', 'DS_CANDIDATE']);
const IMAGE_PATH = /\.(?:png|jpe?g|webp|gif|svg)$/i;
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

/** Resolutions that still need work. */
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

/**
 * A sign-off that came through findings.json (signoff.enteredBy "agent", set by the
 * build): nobody confirmed it. The review and a known drift's "Signed off" line write none.
 */
export function isAgentSignoff(finding) {
  return isObj(finding?.signoff) && finding.signoff.enteredBy === 'agent';
}

/** Open: FIX_CODE or UNCLASSIFIED, or INTENTIONAL / DATA settled only by a sign-off the agent entered. */
export function isOpen(finding) {
  return OPEN_RESOLUTIONS.includes(finding?.resolution) || (['INTENTIONAL', 'DATA'].includes(finding?.resolution) && isAgentSignoff(finding));
}

/** Dismissed findings (not an issue / removed from this QA): not diffs, left out of the settled count. */
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

/** A divergence (BLOCKER, WARNING or DS_CANDIDATE), not a verified match or an evidence gap. */
export function isDivergent(finding) {
  return DIVERGENT_SEVERITIES.includes(finding?.severity);
}

/**
 * How a state row was compared with the design. With captured.comparison (written by
 * build-report.mjs): a pixel diff against a design image (comparison.pixelDiff); compare
 * rows or a worklist alone are not a comparison. Without it (a report from an earlier
 * version): a scorecard.pixelDiff entry for the state, a motion or behaviour ledger row of
 * the state, or a finding of the state with computed, diff or motion evidence. Returns
 * "pixel diff", … or null (captured, not compared).
 */
export function comparisonOf(row, report) {
  if (!isObj(row)) return null;
  const c = isObj(row.captured) && isObj(row.captured.comparison) ? row.captured.comparison : null;
  if (c) return c.pixelDiff === true ? 'pixel diff' : null;
  const state = row.state;
  if (isObj(report?.scorecard?.pixelDiff) && isObj(report.scorecard.pixelDiff[state])) return 'pixel diff';
  const ledgers = isObj(report?.ledgers) ? report.ledgers : {};
  for (const name of ['motion', 'behavior']) {
    if (Array.isArray(ledgers[name]) && ledgers[name].some((r) => isObj(r) && r.state === state)) return `${name} ledger rows`;
  }
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  const grabbed = findings.some((f) => isObj(f) && f.state === state && Array.isArray(f.evidence)
    && f.evidence.some((e) => isObj(e) && ['computed', 'diff', 'motion'].includes(e.type)));
  return grabbed ? 'computed values' : null;
}

/** A PASS or FAIL row that was actually compared (comparisonOf). Without a report, every PASS or FAIL row counts. */
export function isVerifiedRow(row, report = null) {
  if (!isObj(row) || !(row.result === 'PASS' || row.result === 'FAIL')) return false;
  return report ? comparisonOf(row, report) !== null : true;
}

/**
 * The size of a state's app image: stateMatrix[].captured.page.image, else
 * scorecard.pixelDiff.<state>.appWidth / appHeight, else the viewport × dpr when the
 * capture was not full-page. Each of width / height may be null (unknown), with where it came from.
 */
export function appImageSize(report, state) {
  const matrix = Array.isArray(report?.stateMatrix) ? report.stateMatrix : [];
  const row = matrix.find((r) => isObj(r) && r.state === state);
  const page = isObj(row?.captured?.page) ? row.captured.page : null;
  const img = isObj(page?.image) && Number.isInteger(page.image.width) && Number.isInteger(page.image.height) ? page.image : null;
  const i = matrix.indexOf(row);
  if (img) {
    const from = `stateMatrix[${i}].captured.page.image`;
    return { width: img.width, height: img.height, from, widthFrom: from, heightFrom: from };
  }
  const e = isObj(report?.scorecard?.pixelDiff) && isObj(report.scorecard.pixelDiff[state]) ? report.scorecard.pixelDiff[state] : {};
  const pd = (k) => `scorecard.pixelDiff${/^[A-Za-z_$][\w$]*$/.test(state) ? `.${state}` : `[${JSON.stringify(state)}]`}.${k}`;
  const app = report?.meta?.app;
  const dpr = typeof app?.dpr === 'number' && app.dpr > 0 ? app.dpr : 1;
  const vw = Number.isInteger(app?.viewport?.width) ? Math.round(app.viewport.width * dpr) : null;
  const vh = Number.isInteger(app?.viewport?.height) ? Math.round(app.viewport.height * dpr) : null;
  const width = Number.isInteger(e.appWidth) ? e.appWidth : vw;
  const widthFrom = Number.isInteger(e.appWidth) ? pd('appWidth') : vw === null ? null : 'meta.app.viewport × meta.app.dpr';
  let height = Number.isInteger(e.appHeight) ? e.appHeight : null;
  let heightFrom = height === null ? null : pd('appHeight');
  if (height === null && page && page.fullPage === false && vh !== null) {
    height = vh;
    heightFrom = 'meta.app.viewport × meta.app.dpr (not full-page)';
  }
  return { width, height, from: widthFrom, widthFrom, heightFrom };
}

/** The app capture of a row is smaller than its page (× dpr) in either dimension: { image, page } or null. */
export function captureShortfall(report, row) {
  const page = isObj(row?.captured?.page) ? row.captured.page : null;
  if (!page || !Number.isInteger(page.width) || !Number.isInteger(page.height)) return null;
  const img = appImageSize(report, row.state);
  if (img.width === null || img.height === null) return null;
  const dpr = typeof report?.meta?.app?.dpr === 'number' && report.meta.app.dpr > 0 ? report.meta.app.dpr : 1;
  const pw = Math.round(page.width * dpr);
  const ph = Math.round(page.height * dpr);
  if (img.height >= ph - 1 && img.width >= pw - 1) return null;
  // A deliberate first-screen capture (an overlay, a modal): whole when its image covers the design frame.
  if (page.viewportOnly === true) {
    const matrix = Array.isArray(report?.stateMatrix) ? report.stateMatrix : [];
    const frame = isObj(row.designed?.frame) ? row.designed.frame : null;
    const screen = Array.isArray(report?.meta?.screens) ? report.meta.screens.find((x) => isObj(x) && x.id === row.screen) : null;
    const f = frame ?? (isObj(screen?.frame) ? screen.frame : null) ?? (isObj(report?.meta?.source?.frame) ? report.meta.source.frame : null);
    if (matrix.includes(row) && f && Number.isInteger(f.width) && Number.isInteger(f.height) && img.width >= f.width - 1 && img.height >= f.height - 1) return null;
  }
  return { image: { width: img.width, height: img.height }, page: { width: pw, height: ph } };
}

/** The meta.degradations step that declares a state captured only in part: "capture-coverage:<state>". */
export const coverageStep = (state) => `capture-coverage:${state}`;

/** A verified row captured only in part: captured.page.partial, or an app image smaller than the page. */
export function isPartialRow(row, report) {
  if (!isObj(row)) return false;
  if (row.captured?.page?.partial === true) return true;
  return captureShortfall(report, row) !== null;
}

/** A row with a result: MISSING_IN_CODE, or a PASS / FAIL row that was compared. */
const hasResult = (r, report) => isObj(r) && (r.result === 'MISSING_IN_CODE' || isVerifiedRow(r, report));

/**
 * Designed states (rows with "designed") and how many of them have a result (hasResult):
 * { designed, withResult }.
 */
export function designedResults(report) {
  const designed = (Array.isArray(report?.stateMatrix) ? report.stateMatrix : []).filter((r) => isObj(r) && r.designed !== null && r.designed !== undefined);
  return { designed: designed.length, withResult: designed.filter((r) => hasResult(r, report)).length };
}

/**
 * The pass is incomplete when nothing was captured and compared: the state matrix is
 * empty, or no row is MISSING_IN_CODE or a compared PASS / FAIL row (every row
 * CANNOT_VERIFY or NOT_SPECIFIED, or PASS / FAIL without a comparison: the capture
 * landed on a sign-in page, no driver worked, nothing was diffed, …). Also when fewer
 * than half of the designed states have a result: a match over the few compared ones
 * is not the screen's result.
 */
export function isIncomplete(report) {
  const matrix = Array.isArray(report?.stateMatrix) ? report.stateMatrix : [];
  if (!matrix.some((r) => hasResult(r, report))) return true;
  const d = designedResults(report);
  return d.withResult * 2 < d.designed;
}

/** The next step of an INCOMPLETE pass that compared some states, fewer than half of the designed ones. */
export const INCOMPLETE_PART_NEXT = 'capture and compare the other designed states (their drivers, sign-in or URL), or mark a state the app lacks MISSING_IN_CODE, then build again; this is not a result';

const SEVERITY_ORDER = ['BLOCKER', 'WARNING', 'DS_CANDIDATE'];

/**
 * Divergences the agent resolved as DATA (no person's signoff), in id order:
 * { findings, highest } (highest severity, or null when there are none).
 */
export function agentDataFindings(report) {
  return byAgent(report, (f) => f.resolution === 'DATA' && (!isObj(f.signoff) || isAgentSignoff(f)));
}

/** Divergences settled by a sign-off the agent entered (isAgentSignoff): { findings, highest }. */
export function agentSignoffFindings(report) {
  return byAgent(report, (f) => ['INTENTIONAL', 'DATA'].includes(f.resolution) && isAgentSignoff(f));
}

function byAgent(report, test) {
  const list = (Array.isArray(report?.findings) ? report.findings : []).filter((f) => isObj(f) && isDivergent(f) && test(f)).sort((a, b) => compareIds(a.id, b.id));
  return { findings: list, highest: SEVERITY_ORDER.find((s) => list.some((f) => f.severity === s)) ?? null };
}

/** "100%" or "not measured" (null match). */
export function formatParity(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value}%` : 'not measured';
}

/** "2 of 9 states verified" (", 1 only in part" when any verified state was captured in part). */
export function coverageText(coverage) {
  const c = isObj(coverage) ? coverage : {};
  const n = (v) => (Number.isInteger(v) ? v : '–');
  const part = Number.isInteger(c.partial) && c.partial > 0 ? `, ${c.partial} only in part` : '';
  return `${n(c.verified)} of ${n(c.total)} state${c.total === 1 ? '' : 's'} verified${part}`;
}

/**
 * The one-line headline of a scorecard: "FAIL · match 86% · 0 of 18 findings settled ·
 * 8 of 9 states verified". Match says how much of the compared pages matches the design
 * ("(n without a pin)" after it when open findings have no pin), findings settled how far
 * the fix loop has got, and coverage how many states it all
 * rests on. Every printed summary (render-report.mjs, the fix plan, pass.mjs, CI) uses it.
 */
export function scorecardHeadline(scorecard) {
  const sc = isObj(scorecard) ? scorecard : {};
  const cov = isObj(sc.stateCoverage) ? sc.stateCoverage : {};
  const st = isObj(sc.settled) ? sc.settled : null;
  const unpinned = Number.isInteger(sc.unpinned) && sc.unpinned > 0 ? ` (${sc.unpinned} without a pin)` : '';
  const match = `match ${formatParity(sc.match === undefined ? null : sc.match)}${unpinned}`;
  const settled = st && Number.isInteger(st.count) && Number.isInteger(st.total) ? ` · ${st.count} of ${st.total} finding${st.total === 1 ? '' : 's'} settled` : '';
  return `${sc.verdict ?? '–'} · ${match}${settled} · ${coverageText(cov)}`;
}

/**
 * scorecard.settled: { count, total } — total = BLOCKER, WARNING and DS_CANDIDATE
 * findings that are not dismissed, count = those of them that are not open (fixed,
 * INTENTIONAL, DATA, ticketed or not).
 */
export function settledCounts(findings = []) {
  const list = (Array.isArray(findings) ? findings : []).filter((f) => isDivergent(f) && !isDismissed(f));
  return { count: list.filter((f) => !isOpen(f)).length, total: list.length };
}

/** An open divergence: FIX_CODE or UNCLASSIFIED with severity BLOCKER, WARNING or DS_CANDIDATE. */
export const isOpenDivergence = (f) => isOpen(f) && isDivergent(f);
const share = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * How much of a state's page differs from the design and how much of that is accounted for,
 * in percent of the page (report.differences and scorecard.pixelDiff).
 * differing: the larger of the worklist's and the pixel diff's share. A worklist region
 * (regions) is settled when every finding naming it is a settled divergence
 * (INTENTIONAL, DATA, DISMISSED, fixed), or when a rejection a computed hint supports names
 * it (supported: true, build-report.mjs); explained also takes ticketed debt. Regions not on
 * the worklist that nothing names (unlisted) stay open. null when nothing was measured.
 * → { differing, settled, explained, open, openRegions, unlisted: { count, percent }, unsupported: { percent, reasons } }
 */
export function stateDifference(report, row) {
  const c = isObj(report?.differences?.[row?.state]) ? report.differences[row.state] : {};
  const pd = report?.scorecard?.pixelDiff?.[row?.state];
  const measured = [share(c.differing), share(isObj(pd) ? pd.percent : null)].filter((v) => v !== null);
  if (!measured.length) return null;
  const byId = new Map((Array.isArray(report?.findings) ? report.findings : []).filter(isObj).map((f) => [f.id, f]));
  const index = triageIndex(report);
  const by = (e, ok) => (Array.isArray(e.findings) && e.findings.length
    ? e.findings.every((id) => byId.has(id) && isDivergent(byId.get(id)) && ok(byId.get(id)))
    : e.supported === true);
  const out = { differing: Math.max(...measured), settled: 0, explained: 0, openRegions: 0, unsupported: { percent: 0, reasons: [] } };
  for (const e of Array.isArray(c.regions) ? c.regions.filter(isObj) : []) {
    const p = share(e.percent) ?? 0;
    if (by(e, (f) => !isOpen(f))) out.settled += p;
    else out.openRegions += 1;
    if (filled(e.rejected) && e.supported === false && !(Array.isArray(e.findings) && e.findings.length)) {
      out.unsupported.percent = Math.round((out.unsupported.percent + p) * 100) / 100;
      if (!out.unsupported.reasons.includes(e.rejected)) out.unsupported.reasons.push(e.rejected);
    }
    if (by(e, (f) => !isOpen(f) || isTicketedDebt(f, index))) out.explained += p;
  }
  out.unlisted = isObj(c.unlisted) && Number.isInteger(c.unlisted.count) ? { count: c.unlisted.count, percent: share(c.unlisted.percent) ?? 0 } : { count: 0, percent: 0 };
  out.openRegions += out.unlisted.count;
  out.open = Math.max(0, out.differing - out.settled);
  return out;
}

/**
 * scorecard.matchByState: for each compared state (a verified PASS / FAIL row) and each
 * MISSING_IN_CODE state, how much of the designed page the app matches, in percent: 100
 * minus the open share of stateDifference (what differs and nothing settles). 0 for a
 * MISSING_IN_CODE state and for a state captured identical to another (captured.sameAs)
 * with an open state finding. Rounded, then held at 99 while an open region or divergence is
 * in the state and at 1 while some of it matches. CANNOT_VERIFY, NOT_SPECIFIED, uncompared
 * rows and rows without a measured difference are left out.
 */
export function matchByState(report) {
  const matrix = Array.isArray(report?.stateMatrix) ? report.stateMatrix.filter(isObj) : [];
  const open = (Array.isArray(report?.findings) ? report.findings.filter(isObj) : []).filter(isOpenDivergence);
  const out = {};
  for (const row of matrix) {
    if (row.result === 'MISSING_IN_CODE' || (isVerifiedRow(row, report) && filled(row.captured?.sameAs) && open.some((f) => f.ledger === 'state' && f.state === row.state))) {
      out[row.state] = 0;
      continue;
    }
    const d = isVerifiedRow(row, report) ? stateDifference(report, row) : null;
    if (!d) continue;
    const here = open.some((f) => f.state === row.state || (Array.isArray(f.evidence) && f.evidence.some((e) => isObj(e) && e.state === row.state)));
    out[row.state] = boundedPercent(100 - d.open, here || d.openRegions > 0);
  }
  return out;
}

/** Round a percent; at most 99 while something is open, at least 1 unless it is exactly 0. */
function boundedPercent(value, anyOpen) {
  let v = Math.round(value);
  if (anyOpen) v = Math.min(v, 99);
  if (v === 0 && value > 0) v = 1;
  return Math.max(0, Math.min(100, v));
}

/**
 * scorecard.match: the mean of matchByState, null when no state was verified (nothing
 * compared: "not measured"). Held at 99 while any open divergence exists in the report
 * (pinned or not, in any state), at 1 while some state matches in part.
 */
export function scorecardMatch(report, byState = matchByState(report)) {
  if (stateCoverage(report?.stateMatrix, report).verified === 0) return null;
  const values = Object.values(byState);
  if (!values.length) return null;
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  return boundedPercent(values.reduce((a, b) => a + b, 0) / values.length, findings.some((f) => isObj(f) && isOpenDivergence(f)));
}

/**
 * Why an evidence entry is not a pin, or null when it is one: it needs a state (a
 * stateMatrix row when `states` is given), a crop on an image file (not a JSON path) and a
 * crop area of at least MIN_PIN_AREA pixels.
 */
export function pinProblem(e, states = null) {
  if (!isObj(e) || !isObj(e.crop)) return 'no crop';
  if (!filled(e.state)) return 'a crop but no state';
  if (states && !states.has(e.state)) return `state "${e.state}" is not a stateMatrix row`;
  if (typeof e.path !== 'string' || !IMAGE_PATH.test(e.path)) return `the crop is on ${typeof e.path === 'string' ? `"${e.path}"` : 'no file'}, not on an image (put it on the screenshot or design image)`;
  const { w, h } = e.crop;
  if (!(typeof w === 'number' && typeof h === 'number' && w * h >= MIN_PIN_AREA)) return `the crop is ${w}×${h}: smaller than ${MIN_PIN_AREA} px² (an 8×8 area) is not a pin`;
  return null;
}

/** The set of stateMatrix state ids, or null for a report without a matrix. */
export function matrixStates(report) {
  const matrix = Array.isArray(report?.stateMatrix) ? report.stateMatrix : null;
  return matrix && matrix.length ? new Set(matrix.filter((r) => isObj(r) && typeof r.state === 'string').map((r) => r.state)) : null;
}

/** The finding has a pin: an evidence entry that passes pinProblem. */
export function hasPin(finding, states = null) {
  const ev = Array.isArray(finding?.evidence) ? finding.evidence : [];
  return ev.some((e) => pinProblem(e, states) === null);
}

/** Open FIX_CODE findings without a pin (each one must carry an unpinnedReason or be exempt; validate.mjs). */
export function unpinnedFindings(report) {
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  const states = matrixStates(report);
  return findings.filter((f) => f && f.resolution === 'FIX_CODE' && !hasPin(f, states));
}

/**
 * Rejected worklist share per state: the summed percentOfPage of the worklist rejections
 * of each state (capped at 100, one decimal), and the reasons. Map state → { share, reasons }.
 */
export function rejectedShares(report) {
  const out = new Map();
  for (const r of Array.isArray(report?.rejections) ? report.rejections : []) {
    if (!isObj(r) || r.kind !== 'worklist' || !filled(r.state) || typeof r.percentOfPage !== 'number') continue;
    const e = out.get(r.state) || { share: 0, reasons: [] };
    e.share = Math.min(100, Math.round((e.share + r.percentOfPage) * 10) / 10);
    if (filled(r.reason) && !e.reasons.includes(r.reason)) e.reasons.push(r.reason);
    out.set(r.state, e);
  }
  return out;
}

/**
 * scorecard.rejected, only when the report has a rejections array: counts per kind and
 * pageShare = the largest rejected worklist share of any one state's page (percent).
 */
export function rejectedSummary(report) {
  if (!Array.isArray(report?.rejections)) return null;
  const list = report.rejections.filter(isObj);
  const count = (k) => list.filter((r) => r.kind === k).length;
  const shares = [...rejectedShares(report).values()].map((e) => e.share);
  return { worklist: count('worklist'), audit: count('audit'), compare: count('compare'), pageShare: shares.length ? Math.max(...shares) : 0 };
}

/**
 * The report with every PASS / FAIL row that has an app capture re-derived from its
 * findings (FAIL when any finding listed on the row or observed in its state is open, else
 * PASS) and the state ledger synced: what build-report.mjs's finish() does, so a dismissal
 * or sign-off applied after the build moves the row too. Other rows are left alone.
 */
export function deriveStateResults(report) {
  if (!isObj(report) || !Array.isArray(report.stateMatrix)) return report;
  const findings = Array.isArray(report.findings) ? report.findings.filter(isObj) : [];
  const byId = new Map(findings.map((f) => [f.id, f]));
  const results = new Map();
  const stateMatrix = report.stateMatrix.map((row) => {
    if (!isObj(row) || !(row.result === 'PASS' || row.result === 'FAIL') || !row.captured?.app) return row;
    const listed = Array.isArray(row.findings) ? row.findings.map((id) => byId.get(id)).filter(Boolean) : [];
    const open = [...listed, ...findings.filter((f) => f.state === row.state)].some(isOpen);
    const gap = (report.meta?.degradations ?? []).some(d => d.step === `value-comparison:${row.state}`);
    const result = open ? 'FAIL' : gap ? 'CANNOT_VERIFY' : 'PASS';
    results.set(row.state, result);
    return result === row.result ? row : { ...row, result };
  });
  const ledgers = isObj(report.ledgers) && Array.isArray(report.ledgers.state)
    ? { ...report.ledgers, state: report.ledgers.state.map((r) => (isObj(r) && results.has(r.state) && r.result !== results.get(r.state) ? { ...r, result: results.get(r.state) } : r)) }
    : report.ledgers;
  return { ...report, stateMatrix, ledgers };
}

/**
 * "local" for localhost, 127.x.x.x, [::1], *.localhost and file: URLs; "remote" for any
 * other URL (a deployed build: preview, staging, production); null when it is not a URL.
 */
export function targetKind(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  if (u.protocol === 'file:') return 'local';
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host)) return 'local';
  return 'remote';
}

/** The app under test is a deployed build (meta.app.url is not a local host). */
export function isRemoteTarget(report) {
  return targetKind(report?.meta?.app?.url) === 'remote';
}

/** A design-system audit was recorded (meta.tools.dsAudit "script" or "manual"). */
export function dsAuditRan(report) {
  const t = report?.meta?.tools?.dsAudit;
  return t === 'script' || t === 'manual';
}

/**
 * Counts of the state matrix. verified: PASS or FAIL rows that were compared (with the
 * report: comparisonOf; without it every PASS / FAIL row). With the report also partial:
 * verified rows captured only in part (isPartialRow).
 */
export function stateCoverage(stateMatrix = [], report = null) {
  const rows = Array.isArray(stateMatrix) ? stateMatrix : [];
  const has = (row, key) => isObj(row) && row[key] !== null && row[key] !== undefined;
  const verified = rows.filter((r) => isVerifiedRow(r, report));
  const out = {
    total: rows.length,
    designed: rows.filter((r) => has(r, 'designed')).length,
    specified: rows.filter((r) => has(r, 'specified')).length,
    implemented: rows.filter((r) => has(r, 'implemented')).length,
    verified: verified.length,
  };
  if (report) out.partial = verified.filter((r) => isPartialRow(r, report)).length;
  return out;
}

/**
 * The band of one scorecard.pixelDiff entry: the band of its percent, raised from "pass"
 * to "review" when diff.mjs found a structural difference (structuralBand "review": a
 * large area that differs below pixelmatch's threshold) or a part only one image has
 * (paddedRegions with unmasked pixels: not compared). Never raised to "fail".
 */
export function pixelDiffBand(entry, tolerances = DEFAULT_TOLERANCES) {
  const b = band(entry.percent, tolerances);
  return b === 'pass' && (entry?.structuralBand === 'review' || sizeDifferences(entry).length) ? 'review' : b;
}

/**
 * The size differences of a pixel-diff entry from its paddedRegions with unmasked pixels
 * ("the app page is 200 px taller than the design"). Older diff output, without
 * paddedRegions, counted the padded band in percent instead.
 */
export function sizeDifferences(entry) {
  const word = (axis, side) => (axis === 'height' ? (side === 'app' ? 'shorter' : 'taller') : side === 'app' ? 'narrower' : 'wider');
  return (Array.isArray(entry?.paddedRegions) ? entry.paddedRegions : [])
    .filter((r) => isObj(r) && r.pixels > 0 && isObj(r.sizeDiff))
    .map((r) => `the app page is ${r.sizeDiff.px} px ${word(r.sizeDiff.axis, r.side)} than the design`);
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
 * Verdict plus the human-readable reasons that produced it, first match wins.
 * INCOMPLETE: nothing was captured and compared (an empty state matrix, or no row
 * PASS, FAIL or MISSING_IN_CODE; the last reason is INCOMPLETE_NEXT). Findings of such a
 * pass are not grounded in a comparison, so it is neither a pass nor a failure. Also
 * INCOMPLETE instead of REVIEW or PASS when fewer than half of the designed states have a
 * result (INCOMPLETE_PART_NEXT); a FAIL stays FAIL.
 * Divergences the agent resolved as DATA, and those settled by a sign-off the agent
 * entered (open until a person confirms them; FAIL when one is a BLOCKER), are named
 * first in the reasons of any other verdict and make it at least REVIEW.
 * FAIL: an open BLOCKER, a MISSING_IN_CODE state, or a pixel diff in the fail band
 * for a state that has an unexplained finding or no findings at all.
 * REVIEW: an unexplained finding (ticketed debt is explained), a CANNOT_VERIFY
 * finding, an open decision, a review band, a fail band whose findings are all
 * explained (fixed, INTENTIONAL, DATA, DISMISSED or ticketed debt), or a
 * CANNOT_VERIFY state. Otherwise PASS.
 */
export function explainVerdict(report, opts = {}) {
  const o = resolveOptions(opts);
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  const matrix = Array.isArray(report?.stateMatrix) ? report.stateMatrix : [];
  const decisions = Array.isArray(report?.openDecisions) ? report.openDecisions : [];
  const rows = matrix.filter(isObj);
  if (!rows.some((r) => hasResult(r, report))) {
    const count = (result) => rows.filter((r) => r.result === result).length;
    const parts = ['CANNOT_VERIFY', 'NOT_SPECIFIED'].filter((k) => count(k)).map((k) => `${count(k)} ${k}`);
    const what = rows.length
      ? `no state was verified (0 of ${rows.length} captured and compared${parts.length ? `: ${parts.join(', ')}` : ''})`
      : 'no state was verified: the state matrix is empty';
    const valueGaps = (report.meta?.degradations ?? []).filter(d => d.step?.startsWith('value-comparison:'));
    const next = valueGaps.length ? 'resolve the missing Figma/code values and counterparts, rerun evidence and inspect every side-by-side tile; this is not a complete result' : INCOMPLETE_NEXT;
    return { verdict: 'INCOMPLETE', reasons: [what, next] };
  }
  const bands = derivedBands(report, o);
  const unexplained = unexplainedFindings(report);
  const failBands = failBandStates(report, o);

  // Sign-offs the agent wrote itself: open until a person confirms them in the review; named first.
  const signed = agentSignoffFindings(report);
  const signedReason = signed.findings.length ? `${signed.findings.length} finding(s) settled by a sign-off the agent entered, highest severity ${signed.highest} (${signed.findings.map((f) => f.id).join(', ')}): they stay open until a person confirms them in the review` : null;
  const fail = [];
  for (const f of findings) {
    if (f && f.severity === 'BLOCKER' && isOpen(f) && !isAgentSignoff(f)) fail.push(`${f.id} is an open BLOCKER (${f.resolution})`);
  }
  for (const row of matrix) {
    if (row && row.result === 'MISSING_IN_CODE') fail.push(`state "${row.state}" is MISSING_IN_CODE`);
  }
  for (const { state, left } of failBands.unexplainedLeft) {
    fail.push(`pixel diff for "${state}" is in the fail band: ${left}% of the page differs with no settled finding, ticketed debt or supported rejection naming it (or an unexplained finding is in it)`);
  }
  // DATA decided by the agent alone is its word: a person checks it, whatever the verdict.
  const data = agentDataFindings(report);
  const dataReason = data.findings.length ? `${data.findings.length} finding(s) resolved as DATA by the agent, highest severity ${data.highest} (${data.findings.map((f) => f.id).join(', ')}): a person checks them` : null;
  if (fail.length || signed.highest === 'BLOCKER') return { verdict: 'FAIL', reasons: [...(signedReason ? [signedReason] : []), ...fail, ...(dataReason ? [dataReason] : [])] };
  // Fewer than half of the designed states have a result: not a REVIEW or a PASS of the screen.
  if (isIncomplete(report)) {
    const d = designedResults(report);
    const notYet = rows.filter((r) => r.designed && !hasResult(r, report)).map((r) => `${r.state} ${r.result}`);
    const what = `only ${d.withResult} of ${d.designed} designed states have a result (compared, or MISSING_IN_CODE): fewer than half; not compared: ${notYet.join(', ')}`;
    return { verdict: 'INCOMPLETE', reasons: [what, ...(signedReason ? [signedReason] : []), ...(dataReason ? [dataReason] : []), INCOMPLETE_PART_NEXT] };
  }

  const review = [signedReason, dataReason].filter(Boolean);
  if (unexplained.length) review.push(`${unexplained.length} unexplained finding(s): ${unexplained.map((f) => f.id).join(', ')}`);
  const cannot = findings.filter((f) => f && f.severity === 'CANNOT_VERIFY');
  if (cannot.length) review.push(`${cannot.length} CANNOT_VERIFY finding(s)`);
  if (decisions.length) review.push(`${decisions.length} open decision(s)`);
  const pixelDiff = isObj(report?.scorecard?.pixelDiff) ? report.scorecard.pixelDiff : {};
  for (const [state, b] of Object.entries(bands)) {
    const sizes = sizeDifferences(pixelDiff[state]);
    // A size difference is its own reason: the part only one image has is not compared, so not in match.
    if (sizes.length) review.push(`"${state}": ${sizes.join(' and ')}; that part is not compared: check it against the design`);
    if (b === 'review' && (band(pixelDiff[state].percent, o.tolerances) !== 'pass' || pixelDiff[state].structuralBand === 'review')) review.push(`pixel diff for "${state}" is in the review band`);
  }
  for (const state of failBands.explained) {
    review.push(`pixel diff for "${state}" is in the fail band, but every finding there is explained`);
  }
  for (const row of matrix) {
    if (row && row.result === 'CANNOT_VERIFY') review.push(`state "${row.state}" is CANNOT_VERIFY`);
  }
  // A state compared only on part of its page is not a full result.
  for (const row of matrix) {
    if (!isVerifiedRow(row, report) || !isPartialRow(row, report)) continue;
    const why = (Array.isArray(report.meta?.degradations) ? report.meta.degradations : []).filter((d) => isObj(d) && d.step === coverageStep(row.state) && filled(d.reason)).map((d) => d.reason);
    review.push(`"${row.state}" was captured only in part${why.length ? `: ${why.join('; ')}` : ''}`);
  }
  // What the agent decided not to report must not hide a large part of a page.
  for (const [state, e] of rejectedShares(report)) {
    if (e.share > o.tolerances.review) {
      review.push(`${e.share}% of "${state}" was rejected by the agent as ${e.reasons.join('/') || 'not a finding'}: check the rejected regions`);
    }
  }
  review.push(...unlistedReasons(report));
  // A rejection with nothing computed behind its reason is the agent's word only: a person checks it.
  for (const row of matrix.filter((r) => isVerifiedRow(r, report))) {
    const u = stateDifference(report, row)?.unsupported;
    if (u?.percent) review.push(`${u.percent}% of "${row.state}" was rejected as ${u.reasons.join('/')} with no computed hint behind it: it still counts as different; check those regions`);
  }
  if (review.length) return { verdict: 'REVIEW', reasons: review };
  return { verdict: 'PASS', reasons: [] };
}

/**
 * One REVIEW reason per compared state with differences beyond the worklist's caps that
 * nothing names: never decided, so not a match. Each names the share and the command to list them.
 */
export function unlistedReasons(report) {
  const rows = (Array.isArray(report?.stateMatrix) ? report.stateMatrix : []).filter((r) => isVerifiedRow(r, report)).map((r) => ({ r, d: stateDifference(report, r) })).filter((x) => x.d);
  const sizes = rows.map(({ r, d }) => (Array.isArray(report.differences?.[r.state]?.regions) ? report.differences[r.state].regions.length : 0) + d.unlisted.count);
  const run = filled(report?.meta?.runId) ? ` --run ${report.meta.runId}` : '';
  const cmd = `worklist.mjs --dir <report folder> --max-per-state ${Math.max(0, ...sizes)} --max-total ${sizes.reduce((a, b) => a + b, 0)}${run}`;
  return rows.filter(({ d }) => d.unlisted.count).map(({ r, d }) => `"${r.state}": ${d.unlisted.count} difference(s), ${d.unlisted.percent}% of the page, were not on the worklist and nobody decided them: list them with ${cmd}, then file or reject each`);
}

/**
 * States whose pixel diff is in the fail band, split into explained and unexplained. Explained:
 * no BLOCKER, WARNING or DS_CANDIDATE finding of the state is unexplained, and at most the
 * review tolerance of its page differs beyond what settled findings, ticketed debt and
 * supported rejections name (stateDifference). unexplainedLeft: { state, left } per unexplained state.
 */
export function failBandStates(report, opts = {}) {
  const o = resolveOptions(opts);
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  const matrix = Array.isArray(report?.stateMatrix) ? report.stateMatrix.filter(isObj) : [];
  const unexplainedSet = new Set(unexplainedFindings(report));
  const out = { explained: [], unexplained: [], unexplainedLeft: [] };
  for (const [state, b] of Object.entries(derivedBands(report, o))) {
    if (b !== 'fail') continue;
    const d = stateDifference(report, matrix.find((r) => r.state === state) ?? { state });
    const left = Math.round(Math.max(0, d.differing - d.explained) * 100) / 100;
    if (left > o.tolerances.review || findings.some((f) => f && f.state === state && isDivergent(f) && unexplainedSet.has(f))) {
      out.unexplained.push(state);
      out.unexplainedLeft.push({ state, left });
    } else out.explained.push(state);
  }
  return out;
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

/**
 * Why the token and the component check did not run, each null when it ran: meta.notChecked
 * (build-report.mjs), else "no design-system audit was run" for both when none ran.
 */
export function designSystemNotChecked(report) {
  const n = isObj(report?.meta?.notChecked) ? report.meta.notChecked : {};
  const none = dsAuditRan(report) ? null : 'no design-system audit was run';
  return { tokens: filled(n.tokens) ? n.tokens : none, components: filled(n.components) ? n.components : none };
}

/** { tokens, components, motion }: counts of open design-system mismatches; null for a check that did not run and found nothing. */
export function designSystemCounts(report) {
  const g = designSystemGroups(report);
  const off = designSystemNotChecked(report);
  const count = (k) => (off[k] && !g[k].length ? null : g[k].length);
  return { tokens: count('tokens'), components: count('components'), motion: g.motion.length };
}

/**
 * The scorecard implied by the findings, state matrix, decisions, triage and
 * pixel-diff percents (schemaVersion 2.0): counts, match (null when no state was
 * measured), verdict, bands, coverage, unexplained, debt, loopClosed (unexplained == 0,
 * no open decisions and not INCOMPLETE), dismissed, designSystem and unpinned (open
 * FIX_CODE findings without a pin) — plus backfill (step 2) only when the report has a
 * backfill block. Every other key of a pixelDiff entry (structuralPercent,
 * designHeight, appHeight, padded, …) is kept as it is.
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
    verdict: deriveVerdict(report, o),
    bySeverity,
    byResolution,
    pixelDiff,
    stateCoverage: stateCoverage(report?.stateMatrix, report),
  };
  const byState = matchByState(report);
  scorecard.match = scorecardMatch(report, byState);
  scorecard.matchByState = scorecard.match === null ? {} : byState;
  scorecard.settled = settledCounts(findings);
  const unexplained = unexplainedFindings(report).length;
  scorecard.unexplained = unexplained;
  scorecard.debt = debtSummary(report);
  scorecard.loopClosed = isLoopClosed(report, o);
  scorecard.dismissed = findings.filter(isDismissed).length;
  scorecard.designSystem = designSystemCounts(report);
  scorecard.unpinned = unpinnedFindings(report).length;
  const rejected = rejectedSummary(report);
  if (rejected) scorecard.rejected = rejected;
  // Step 2 (design backfill) is reported beside step 1, never inside it: it is added
  // only when the report has a backfill block and changes nothing above.
  if (hasBackfill(report)) scorecard.backfill = backfillSummary(report);
  return scorecard;
}

/**
 * Step 1 is closed: no unexplained finding (open and not ticketed debt), no open
 * decision, no fail band left unexplained (failBandStates), and the pass is not
 * INCOMPLETE (a pass that compared nothing is never closed).
 */
export function isLoopClosed(report, opts = {}) {
  const decisions = Array.isArray(report?.openDecisions) ? report.openDecisions.length : 0;
  return unexplainedFindings(report).length === 0 && decisions === 0 && !isIncomplete(report) && failBandStates(report, opts).unexplained.length === 0;
}

// ---------------------------------------------------------------------------
// Design backfill (step 2): undesigned states built back into Figma. Kept apart
// from step 1 — it never changes match, verdict, unexplained, loopClosed, the
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
