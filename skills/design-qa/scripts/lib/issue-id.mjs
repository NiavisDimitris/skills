// Stable identity and category of a finding across runs, for the run result log
// and the metrics built on it. Finding ids (DQ-001…) are renumbered every pass;
// issue_id is not: it hashes where the finding is and what kind it is, using the
// same normalisation as the dismissals fingerprint. Zero dependencies.
import { createHash } from 'node:crypto';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const norm = (v) => (v === null || v === undefined ? '' : String(v)).toLowerCase().replace(/\s+/g, ' ').trim();

/** Findings that count as issues: real divergences a person could act on. */
export const ISSUE_SEVERITIES = Object.freeze(['BLOCKER', 'WARNING', 'DS_CANDIDATE']);
export const OPEN_RESOLUTIONS = Object.freeze(['FIX_CODE', 'UNCLASSIFIED']);
export const DISMISSED_RESOLUTIONS = Object.freeze(['DISMISSED', 'INTENTIONAL']);

export const CATEGORIES = Object.freeze([
  'spacing',
  'color',
  'typography',
  'sizing',
  'shape',
  'component',
  'missing-state',
  'motion',
  'structure',
  'copy',
  'behavior',
  'other',
]);

/** The screen a finding or state row belongs to: its screen, else the "<screen>/" prefix of its state, else "default". */
export function screenOf(item) {
  if (item?.screen) return String(item.screen);
  const state = item?.state ? String(item.state) : '';
  const slash = state.indexOf('/');
  return slash > 0 ? state.slice(0, slash) : 'default';
}

/**
 * Where the finding is: the Figma node id when there is one (it does not change
 * between passes), else the selector, else the Figma layer path, else the region.
 */
export function elementOf(finding) {
  const el = isObj(finding?.element) ? finding.element : {};
  if (el.figmaNodeId) return `figma:${el.figmaNodeId}`;
  return el.selector || el.figmaLayerPath || finding?.region || '';
}

/** Fine-grained issue type: "<ledger>:<property>", e.g. "style:padding". */
export function issueTypeOf(finding) {
  return `${norm(finding?.ledger) || 'unknown'}:${norm(finding?.property) || '-'}`;
}

/**
 * issue_id = "iss_" + 16 hex of sha256(screen | state | element | type), each part
 * lower-cased and whitespace-collapsed. State is part of it: the same element failing
 * in two states is two defects, and fixing one does not fix the other.
 */
export function issueId({ screen, state, element, type }) {
  const key = [screen, state, element, type].map(norm).join('|');
  return `iss_${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

export function findingIssueId(finding) {
  return issueId({ screen: screenOf(finding), state: finding?.state, element: elementOf(finding), type: issueTypeOf(finding) });
}

const STYLE_CATEGORIES = [
  ['spacing', /^(padding|margin|gap|row-gap|column-gap|inset|top|right|bottom|left)(-|$)/],
  ['color', /(^|-)(color|background|fill|stroke|opacity)(-|$)/],
  ['typography', /^(font|line-height|letter-spacing|text-transform|text-decoration|text-align|white-space|word-spacing)(-|$)/],
  ['shape', /^(border|outline|box-shadow|shadow|elevation|radius)(-|$)|radius/],
  ['sizing', /^(width|height|min-|max-|aspect-ratio|size)/],
];

/** Coarse category for totals and metrics. Unknown combinations are "other". */
export function categoryOf(finding) {
  const ledger = norm(finding?.ledger);
  const prop = norm(finding?.property);
  switch (ledger) {
    case 'style':
      for (const [cat, re] of STYLE_CATEGORIES) if (re.test(prop)) return cat;
      if (finding?.expected?.token || finding?.actual?.token) return 'color';
      return 'other';
    case 'component':
      return 'component';
    case 'motion':
      return 'motion';
    case 'state':
      return prop === 'presence' || prop === 'missing' ? 'missing-state' : 'behavior';
    case 'behavior':
      return 'behavior';
    case 'structure':
      return /^(text|label|copy|placeholder|casing|microcopy)/.test(prop) ? 'copy' : 'structure';
    default:
      return 'other';
  }
}

/**
 * What a finding that is not an issue says about it: pass (verified match),
 * unverified (CANNOT_VERIFY) or reclassified (DATA, NONE, anything else).
 */
export function nonIssueOutcomeOf(finding) {
  if (finding?.severity === 'PASS') return 'pass';
  if (finding?.severity === 'CANNOT_VERIFY') return 'unverified';
  return 'reclassified';
}

/** open | dismissed | null (not an issue: PASS, CANNOT_VERIFY, DATA, NONE). */
export function issueStatusOf(finding) {
  if (!ISSUE_SEVERITIES.includes(finding?.severity)) return null;
  if (OPEN_RESOLUTIONS.includes(finding?.resolution)) return 'open';
  if (DISMISSED_RESOLUTIONS.includes(finding?.resolution)) return 'dismissed';
  return null;
}
