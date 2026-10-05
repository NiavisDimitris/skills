// Local handoff context. Keep paths relative in shared HTML; resolve configuration
// from the report location so the receiving agent need not use the renderer's cwd.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const RAW_TEXT_RE = /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title)\b([^>]*)>([\s\S]*?)(<\/\1\s*>|$)/gi;

/**
 * The real <script id="<id>"> element of a page: elements are scanned in document
 * order and the bodies of scripts, styles and comments are skipped, so the literal
 * text `<script id='design-qa-context'>` inside another element's JSON (a report
 * string) never matches. Returns { index, length, open, body, close } or null.
 */
export function findScriptElement(html, id) {
  const idRe = new RegExp(`\\bid\\s*=\\s*(["'])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`, 'i');
  RAW_TEXT_RE.lastIndex = 0;
  for (let m; (m = RAW_TEXT_RE.exec(html)); ) {
    if (m[1]?.toLowerCase() !== 'script' || !idRe.test(m[2]) || !m[4]) continue;
    const open = m[0].slice(0, m[0].length - m[3].length - m[4].length);
    return { index: m.index, length: m[0].length, open, body: m[3], close: m[4] };
  }
  return null;
}

const BODY_SCAN_RE = /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|<body\b[^>]*>/gi;

/**
 * The real <body …> start tag of a page (comments and the bodies of scripts, styles,
 * textareas and titles are skipped, so "<body>" written inside them never matches):
 * { index, end } or null.
 */
export function findBodyOpen(html) {
  BODY_SCAN_RE.lastIndex = 0;
  for (let m; (m = BODY_SCAN_RE.exec(html)); ) {
    if (!m[1] && /^<body\b/i.test(m[0])) return { index: m.index, end: m.index + m[0].length };
  }
  return null;
}

// Equal strings, or two parseable date-times naming the same instant.
const sameInstant = (a, b) => a === b || (typeof a === 'string' && typeof b === 'string' && !Number.isNaN(Date.parse(a)) && Date.parse(a) === Date.parse(b));

/**
 * Does report.html still show report.json? Compared on every request by review.mjs:
 *   reason "regenerated": report.json's meta.generatedAt differs from the report embedded
 *     in report.html (a new pass or a re-generated report that was not re-rendered;
 *     finding ids may point at other findings, so Send is refused);
 *   reason "modified": report.json's content differs from the report embedded in
 *     report.html AND report.json was written more than slackMs after the HTML. Both
 *     are needed: render-report.mjs --write-back saves the very report it embedded just
 *     after the HTML (seconds later on a loaded machine), and without --write-back the
 *     page holds the recomputed report while report.json is older. A page without an
 *     embedded report is judged by modification time alone.
 * Returns { stale, reason, reportGeneratedAt, htmlGeneratedAt, reportModifiedAt,
 * htmlModifiedAt }; a file that cannot be read is never called stale. `html` saves a
 * second read when the caller has the page already.
 */
export function reportFreshness(reportFile, htmlFile, { html, slackMs = 2000 } = {}) {
  const out = { stale: false, reason: null, reportGeneratedAt: null, htmlGeneratedAt: null, reportModifiedAt: null, htmlModifiedAt: null };
  let reportStat;
  let htmlStat;
  try {
    reportStat = statSync(reportFile);
    htmlStat = statSync(htmlFile);
    out.reportModifiedAt = reportStat.mtime.toISOString();
    out.htmlModifiedAt = htmlStat.mtime.toISOString();
  } catch {
    return out;
  }
  let onDisk;
  let embedded;
  try {
    onDisk = JSON.parse(readFileSync(reportFile, 'utf8').replace(/^\uFEFF/, ''));
    out.reportGeneratedAt = onDisk?.meta?.generatedAt ?? null;
  } catch {
    // Unreadable report.json: Send reports it.
  }
  try {
    const element = findScriptElement(html ?? readFileSync(htmlFile, 'utf8'), 'design-qa-data');
    embedded = element ? JSON.parse(element.body) : undefined;
    out.htmlGeneratedAt = embedded?.meta?.generatedAt ?? null;
  } catch {
    // An unfilled or foreign page: judged by modification time only.
  }
  if (typeof out.reportGeneratedAt === 'string' && typeof out.htmlGeneratedAt === 'string' && !sameInstant(out.reportGeneratedAt, out.htmlGeneratedAt)) {
    return { ...out, stale: true, reason: 'regenerated' };
  }
  // The same report (written back by the render that embedded it) is never stale, however late it was written.
  const sameContent = onDisk !== undefined && embedded !== undefined && JSON.stringify(onDisk) === JSON.stringify(embedded);
  if (!sameContent && reportStat.mtimeMs > htmlStat.mtimeMs + slackMs) return { ...out, stale: true, reason: 'modified' };
  return out;
}

export function readReviewContext(file) {
  if (!existsSync(file)) return {};
  const element = findScriptElement(readFileSync(file, 'utf8'), 'design-qa-context');
  try {
    const value = JSON.parse(element?.body ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function resolveReviewConfig(reportFile, { explicit, htmlFile, generatedAt } = {}) {
  if (explicit) return path.resolve(explicit);
  const dir = path.dirname(path.resolve(reportFile));
  const context = readReviewContext(htmlFile ?? path.join(dir, 'report.html'));
  if (context.reportGeneratedAt === generatedAt && typeof context.configFromReport === 'string' && context.configFromReport) {
    return path.resolve(dir, context.configFromReport);
  }
  for (let current = dir; ; current = path.dirname(current)) {
    const file = path.join(current, 'design-qa.config.json');
    if (existsSync(file)) return file;
    if (path.dirname(current) === current) return null;
  }
}

/** Shell quoting for printed commands: the one implementation lives in args.mjs. */
export { shellArg } from './args.mjs';
