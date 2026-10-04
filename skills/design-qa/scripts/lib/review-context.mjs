// Local handoff context. Keep paths relative in shared HTML; resolve configuration
// from the report location so the receiving agent need not use the renderer's cwd.
import { existsSync, readFileSync } from 'node:fs';
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

// Control characters and line breaks: printed raw they would split a "Next:" line.
const HAS_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const CONTROL_RE = new RegExp(HAS_CONTROL.source, 'g');
const ansiEscape = (c) => {
  const code = c.charCodeAt(0);
  return code < 0x100 ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
};

/**
 * Quote one shell word for a printed command. Plain words stay bare; anything else
 * is single-quoted; a value with a line break or another control character uses
 * $'…' quoting (bash, zsh) so the printed command always stays on one line.
 */
export const shellArg = (value) => {
  const s = String(value);
  if (/^[A-Za-z0-9_./:@=-]+$/.test(s)) return s;
  if (HAS_CONTROL.test(s)) {
    return `$'${s.replace(/[\\']/g, '\\$&').replace(CONTROL_RE, ansiEscape)}'`;
  }
  return "'" + s.replace(/'/g, "'\\''") + "'";
};
