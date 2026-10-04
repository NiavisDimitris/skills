#!/usr/bin/env node
// Render report.json into the self-contained interactive HTML report (and,
// optionally, the Markdown fix plan). See --help.
import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, displayPath, parseCli, readJsonFile, runMain, toNumber, usageError, writeJson, writeText } from './lib/args.mjs';
import { renderFixplan } from './lib/fixplan.mjs';
import { renderBackfillPlan } from './lib/backfill-plan.mjs';
import { computeScorecard, rankFindings, resolveOptions } from './lib/ranking.mjs';
import { validateConfig, validateReport } from './lib/schema-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TEMPLATE = path.resolve(HERE, '../templates/report.html');
export const PLACEHOLDERS = Object.freeze({
  data: '/*__DESIGN_QA_DATA__*/',
  assets: '/*__DESIGN_QA_ASSETS__*/',
  context: '/*__DESIGN_QA_CONTEXT__*/',
  title: '__DESIGN_QA_TITLE__',
  scriptSrc: '__DESIGN_QA_SCRIPT_SRC__',
});
// Every placeholder, matched in one pass (the comment-wrapped ones first): text inserted for one placeholder is
// never scanned again, so report text that quotes a placeholder stays as it is.
const PLACEHOLDER_SPLIT_RE = /(\/\*__DESIGN_QA_(?:DATA|ASSETS|CONTEXT)__\*\/|__DESIGN_QA_(?:TITLE|SCRIPT_SRC)__)/;
const MAX_EMBED_BYTES = 15 * 1024 * 1024;
/** Total size of the images --embed-images inlines (override: DESIGN_QA_EMBED_BUDGET_BYTES). */
export const DEFAULT_EMBED_BUDGET_BYTES = 100 * 1024 * 1024;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
const IMAGE_EVIDENCE = new Set(['screenshot', 'design', 'figma', 'diff', 'motion']);

const HELP = `Render a design-qa report.json into the interactive HTML report.

Usage:
  node scripts/render-report.mjs --in <report.json> [--out <report.html>] [options]

Options:
  --in <file>          report.json to render (required)
  --out <file>         HTML to write (default: report.html next to --in)
  --template <file>    HTML template (default: ../templates/report.html next to this script)
  --embed-images       inline every referenced image as a data: URI so the HTML is
                       self-contained (scorecard.pixelDiff[*].image, stateMatrix[*].captured.
                       design|app|diff, findings[*].evidence[*].path of screenshot/design/
                       figma/diff/motion evidence with an image extension,
                       evidence.states[*].design|app|diff, backfill.items[*].captured.app).
                       Paths resolve relative to the report.json directory and must stay
                       inside it (symlinks included); only regular files whose bytes match
                       the extension (PNG, JPEG, GIF, WebP, SVG) are embedded, at most 15 MB
                       each and 100 MB in all (DESIGN_QA_EMBED_BUDGET_BYTES). Anything else
                       (missing, outside, a URL, over budget) is skipped with a warning and
                       stays a relative path. The page never loads a URL image.
  --fixplan <file>     also write the Markdown fix plan: Source, Triage and Dismissed lines,
                       Fix now (+ paste block for a coding agent), Design-system mismatches
                       (Tokens, Components, Motion), Debt — tickets, Missing states / needs
                       decision, Dismissed, Cannot verify. With a triage block the person's
                       decisions fill Fix now and Debt; otherwise the recommendation does
                       (the fix-now bucket plus every blocker). When the report has design-
                       backfill items, the plan ends with one pointer line to report-backfill.md
  --backfill-plan <file>
                       also write the design-backfill plan (step 2, report-backfill.md) when
                       the report's backfill block has items: status line (production
                       matches the design yes/no, counts; "Blocked until step 1 is closed"
                       when not ready), Build in Figma (+ paste block for a design agent),
                       Built, Not needed, Pending decision. Not written without items
  --recompute          rewrite the derived values from the rules instead of failing when the
                       stored ones disagree: every finding's rank and the scorecard
                       (severity/resolution counts, parity, verdict, pixel-diff bands,
                       state coverage, unexplained, debt, loopClosed, dismissed,
                       designSystem, and backfill when the report has a backfill block)
  --write-back         save the rendered report (ranks filled, scorecard recomputed with
                       --recompute) back to the --in file
  --config <file>      design-qa.config.json: tolerances.pixelDiff, report.topN,
                       report.ranking and report.embedImages
  --top-n <n>          number of "fix now" findings (default: config report.topN or 5);
                       re-ranks every finding
  --quiet              print errors only
  -h, --help           show this help

Before rendering, the report is validated (same rules as validate.mjs) and the
command fails on any error. When any finding has "rank": null (or with --top-n /
--recompute) every finding is ranked with the derived rules: score = severity×100 +
ledger×10 + (6 − effort) for FIX_CODE findings with severity BLOCKER, WARNING or
DS_CANDIDATE; by score the top N are "fix-now", the rest "debt"; everything else
(INTENTIONAL, DATA, DISMISSED, UNCLASSIFIED, PASS, CANNOT_VERIFY) is "none".
Without --recompute the stored scorecard must equal the derived one.

Template contract: the template must contain
  <script id="design-qa-data" type="application/json">${PLACEHOLDERS.data}</script>
  <script id="design-qa-assets" type="application/json">${PLACEHOLDERS.assets}</script>
and should contain (a warning, not an error, when missing)
  <script id="design-qa-context" type="application/json">${PLACEHOLDERS.context}</script>
  <title>${PLACEHOLDERS.title}</title>
and may contain, in a Content-Security-Policy <meta> outside any script,
  script-src ${PLACEHOLDERS.scriptSrc}
which becomes the sha256 source of every inline script of the rendered page.
The context element gets { "reportPath": "<--in relative to the working directory>" }
when the --in file is inside the working directory, else {} (never an absolute path:
the HTML is shared). The page names that path in the message it copies for an agent;
review.mjs adds { live, token } to it when it serves the page.

Exit codes: 0 rendered · 1 invalid report, template or IO error · 2 bad arguments`;

const SCRIPT_ESCAPES = { '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029', __DESIGN_QA_: '\\u005f_DESIGN_QA_' };
/**
 * JSON safe to embed inside <script type="application/json">: every "<", ">" and "&" as a
 * \u escape (no "</script", no "<!--"), U+2028/2029 escaped, and "__DESIGN_QA_" written as
 * "\u005f_DESIGN_QA_" so no placeholder text survives in the data. JSON.parse gives back
 * exactly the same value.
 */
export function serializeForScript(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]|__DESIGN_QA_/g, (c) => SCRIPT_ESCAPES[c]);
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Why the page cannot show an image reference, or null for a plain relative path: a URL
 * (a scheme, "//host", "\\host"), an absolute path, or control characters / leading spaces.
 * The template's imgSrc() applies the same rule.
 */
export function imageRefProblem(ref) {
  if (typeof ref !== 'string' || !ref) return 'not a path';
  if (/^(?:[a-z][a-z0-9+.-]*:)?[\\/]{2}/i.test(ref) || /^(?:https?|ftp|data|blob|file):/i.test(ref)) return 'a URL (the report never loads remote images)';
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || /^[\\/]/.test(ref)) return 'an absolute path or a URL (image paths are relative to the report folder)';
  if (/^\s|[\u0000-\u001f\u007f-\u009f]/.test(ref)) return 'not a plain relative path (control characters or leading spaces)';
  return null;
}

/** A path for a warning: JSON-quoted when it holds control characters, so it stays one printed line. */
const shown = (ref) => (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(ref) ? JSON.stringify(ref) : ref);

/** Every string the report gives as an image (deduplicated, in report order), whatever its extension. */
export function collectImageRefs(report) {
  const out = [];
  const add = (p) => {
    if (typeof p === 'string' && p && !out.includes(p)) out.push(p);
  };
  for (const entry of Object.values(report?.scorecard?.pixelDiff || {})) add(entry?.image);
  for (const row of report?.stateMatrix || []) {
    add(row?.captured?.design);
    add(row?.captured?.app);
    add(row?.captured?.diff);
  }
  for (const f of report?.findings || []) {
    for (const e of f?.evidence || []) if (IMAGE_EVIDENCE.has(e?.type)) add(e.path);
  }
  for (const s of Object.values(report?.evidence?.states || {})) {
    add(s?.design);
    add(s?.app);
    add(s?.diff);
  }
  for (const item of Array.isArray(report?.backfill?.items) ? report.backfill.items : []) add(item?.captured?.app);
  return out;
}

/** Every image path the report references with an image extension (deduplicated, in report order). */
export function collectImagePaths(report) {
  return collectImageRefs(report).filter((p) => IMAGE_TYPES[path.extname(p).toLowerCase()]);
}

/** DESIGN_QA_EMBED_BUDGET_BYTES (a whole number of bytes) or the 100 MB default. */
export function embedBudget(env = process.env) {
  const raw = env?.DESIGN_QA_EMBED_BUDGET_BYTES;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_EMBED_BUDGET_BYTES;
  const n = Number(String(raw).trim());
  return Number.isSafeInteger(n) && n >= 0 ? n : DEFAULT_EMBED_BUDGET_BYTES;
}

const isInside = (dir, file) => {
  const rel = path.relative(dir, file);
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

// The first bytes of each type (SVG: an <svg> root, after an optional XML declaration, comments or a doctype).
const SVG_HEAD_RE = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:(?:<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)\s*)*<svg[\s>/]/i;
const MAGIC = {
  'image/png': (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6)),
  'image/webp': (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  'image/svg+xml': (b) => SVG_HEAD_RE.test(b.toString('utf8', 0, Math.min(b.length, 4096)).replace(/^\uFEFF/, '')),
};

/**
 * The bytes of a regular file, or null. Opened without following a final symlink and
 * without blocking (a FIFO swapped in after the stat never hangs the render); the open
 * descriptor must still be a regular file no larger than maxBytes.
 */
function readRegularFile(file, maxBytes) {
  let fd;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (!n) break;
      off += n;
    }
    return buf.subarray(0, off);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * { "<path as written in the report>": "data:<mime>;base64,…" } for the images that can be
 * embedded: a relative path that resolves (symlinks included) inside the report folder, a
 * regular file (stat before open: a FIFO or a device is never opened) of at most 15 MB
 * whose first bytes match its extension, while the total stays within the budget. Every
 * other reference is skipped with a warning and stays a relative path in the page.
 */
export function buildAssets(report, baseDir, { warn = () => {}, budget = embedBudget() } = {}) {
  const assets = {};
  let realBase;
  try {
    realBase = realpathSync(baseDir);
  } catch {
    warn(`report folder not found, no image embedded: ${shown(String(baseDir))}`);
    return assets;
  }
  let used = 0;
  for (const ref of collectImageRefs(report)) {
    const problem = imageRefProblem(ref);
    if (problem) {
      warn(`image not embedded and not shown: ${shown(ref)} is ${problem}`);
      continue;
    }
    const mime = IMAGE_TYPES[path.extname(ref).toLowerCase()];
    if (!mime) continue; // not an image type (JSON evidence and the like)
    const file = path.resolve(baseDir, ref);
    if (!isInside(path.resolve(baseDir), file)) {
      warn(`image outside the report folder, not embedded: ${shown(ref)}`);
      continue;
    }
    let real;
    let st;
    try {
      real = realpathSync(file);
      st = statSync(real);
    } catch {
      warn(`image not found, not embedded: ${shown(ref)}`);
      continue;
    }
    if (!isInside(realBase, real)) {
      warn(`image links to a file outside the report folder, not embedded: ${shown(ref)}`);
      continue;
    }
    if (!st.isFile()) {
      warn(`image is not a regular file, not embedded: ${shown(ref)}`);
      continue;
    }
    if (st.size > MAX_EMBED_BYTES) {
      warn(`image larger than 15 MB, not embedded: ${shown(ref)}`);
      continue;
    }
    if (used + st.size > budget) {
      warn(`embedded images would exceed ${formatBytes(budget)} in all, not embedded (the page shows it from its relative path): ${shown(ref)}`);
      continue;
    }
    const bytes = readRegularFile(real, Math.min(MAX_EMBED_BYTES, budget - used));
    if (!bytes) {
      warn(`image cannot be read as a regular file, not embedded: ${shown(ref)}`);
      continue;
    }
    if (!MAGIC[mime](bytes)) {
      warn(`image content is not ${mime} as its extension says, not embedded: ${shown(ref)}`);
      continue;
    }
    used += bytes.length;
    assets[ref] = `data:${mime};base64,${bytes.toString('base64')}`;
  }
  return assets;
}

function formatBytes(n) {
  return n >= 1024 * 1024 ? `${Math.round((n / (1024 * 1024)) * 10) / 10} MB` : `${n} bytes`;
}

/**
 * The page context for the design-qa-context element: { reportPath } with the report
 * file relative to cwd (forward slashes) when it is inside cwd, else {}. Never an
 * absolute path: report.html is shared.
 */
export function reportContext(reportFile, cwd = process.cwd()) {
  const rel = pathInside(reportFile, cwd);
  return rel ? { reportPath: rel } : {};
}

const realOrResolved = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** `file` relative to cwd with forward slashes when it is inside cwd (real paths), else null. */
export function pathInside(file, cwd = process.cwd()) {
  const rel = path.relative(realOrResolved(cwd), realOrResolved(path.resolve(cwd, file)));
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/** The inline scripts' CSP sources ('sha256-…', in page order), "'none'" without any. */
export function inlineScriptSources(html) {
  const out = [];
  for (const m of String(html).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1];
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const t = type ? (type[1] ?? type[2] ?? type[3]).trim().toLowerCase() : '';
    if (t && !['module', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript'].includes(t)) continue; // data blocks never run
    // The HTML parser turns CRLF and CR into LF before the browser hashes the text.
    const source = `'sha256-${createHash('sha256').update(m[2].replace(/\r\n?/g, '\n'), 'utf8').digest('base64')}'`;
    if (!out.includes(source)) out.push(source);
  }
  return out.length ? out.join(' ') : "'none'";
}

/**
 * Inject data, assets, the page context, title and script hashes into the template (throws
 * when the data or assets placeholder is missing; the others are optional). One pass over
 * the template: text inserted for a placeholder is never scanned again, so a report string
 * that quotes a placeholder ("__DESIGN_QA_TITLE__" in a finding title) is left as it is.
 * The script-src placeholder becomes the sha256 of every inline script of the result.
 */
export function fillTemplate(template, report, assets = {}, context = {}) {
  for (const key of ['data', 'assets']) {
    if (!template.includes(PLACEHOLDERS[key])) {
      throw new CliError(`template is missing the ${PLACEHOLDERS[key]} placeholder (see --help for the template contract)`, 1);
    }
  }
  const values = {
    [PLACEHOLDERS.data]: serializeForScript(report),
    [PLACEHOLDERS.assets]: serializeForScript(assets),
    [PLACEHOLDERS.context]: serializeForScript(context && typeof context === 'object' ? context : {}),
    [PLACEHOLDERS.title]: escapeHtml(`Design QA — ${report?.meta?.feature ?? 'report'}`),
  };
  const parts = template.split(PLACEHOLDER_SPLIT_RE); // the placeholders sit at the odd indexes
  const scriptSrc = [];
  for (let i = 1; i < parts.length; i += 2) {
    if (parts[i] === PLACEHOLDERS.scriptSrc) {
      scriptSrc.push(i);
      parts[i] = '';
    } else {
      parts[i] = values[parts[i]];
    }
  }
  if (scriptSrc.length) {
    const sources = inlineScriptSources(parts.join('')); // the placeholder sits outside every script
    for (const i of scriptSrc) parts[i] = sources;
  }
  return parts.join('');
}

/**
 * Validate, rank and (optionally) re-score a report. Returns { report, errors, warnings }.
 * Ranks are recomputed for every finding when any rank is null, with rerank (--top-n)
 * or with recompute; recompute also rewrites the scorecard.
 * opts: { options (ranking/tolerances), recompute, rerank }
 */
export function prepareReport(input, { options = {}, recompute = false, rerank = false } = {}) {
  const o = resolveOptions(options);
  const inputFindings = Array.isArray(input?.findings) ? input.findings : [];
  const needsRank = rerank || recompute || inputFindings.some((f) => !f || f.rank === null || f.rank === undefined);
  // --recompute derives the scorecard, so a report written without one (or with a partial one) is fine.
  if (recompute && input && typeof input === 'object') input = { ...input, scorecard: computeScorecard(input, o) };
  const first = validateReport(input, { options: o, skipScorecard: recompute, skipRanks: needsRank });
  if (!first.valid) return { report: input, errors: first.errors, warnings: first.warnings };
  let report = input;
  if (needsRank) report = { ...report, findings: rankFindings(report.findings, o) };
  if (recompute) report = { ...report, scorecard: computeScorecard(report, o) };
  const final = validateReport(report, { options: o });
  return { report, errors: final.errors, warnings: [...first.warnings, ...final.warnings].filter(uniqueIssue()) };
}

function uniqueIssue() {
  const seen = new Set();
  return (e) => {
    const k = `${e.path}\u0000${e.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };
}

async function main(argv) {
  const { values } = parseCli(argv, {
    in: { type: 'string' },
    out: { type: 'string' },
    template: { type: 'string' },
    'embed-images': { type: 'boolean' },
    fixplan: { type: 'string' },
    'backfill-plan': { type: 'string' },
    recompute: { type: 'boolean' },
    'write-back': { type: 'boolean' },
    config: { type: 'string' },
    'top-n': { type: 'string' },
    quiet: { type: 'boolean' },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (!values.in) throw usageError('--in <report.json> is required (see --help)');
  const log = values.quiet ? () => {} : (msg) => console.log(msg);
  const warn = values.quiet ? () => {} : (msg) => console.error(`warning: ${msg}`);

  const inFile = path.resolve(values.in);
  const input = readJsonFile(inFile, 'report', 2);

  let config = {};
  if (values.config) {
    config = readJsonFile(path.resolve(values.config), 'config', 2);
    const cv = validateConfig(config);
    if (!cv.valid) {
      throw usageError(`--config is invalid:\n${cv.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
    }
  }
  const topN = toNumber(values['top-n'], 'top-n', { min: 0, integer: true });
  const options = resolveOptions({ ...config, ...(topN !== undefined ? { topN } : {}) });

  const { report, errors, warnings } = prepareReport(input, {
    options,
    recompute: Boolean(values.recompute),
    rerank: topN !== undefined,
  });
  for (const w of warnings) warn(`${w.path}: ${w.message}`);
  if (errors.length) {
    const derivedDrift = errors.some((e) => e.path.startsWith('scorecard') || /^findings\[\d+\]\.rank/.test(e.path));
    const hint = derivedDrift && !values.recompute
      ? '\nThe scorecard or ranks disagree with the derived rules; fix the report or pass --recompute.'
      : '';
    throw new CliError(
      `${displayPath(inFile)} is not a valid report (${errors.length} error${errors.length === 1 ? '' : 's'}):\n${errors
        .map((e) => `  ${e.path}: ${e.message}`)
        .join('\n')}${hint}`,
      1,
    );
  }

  const templateFile = path.resolve(values.template || DEFAULT_TEMPLATE);
  let template;
  try {
    template = readFileSync(templateFile, 'utf8');
  } catch (err) {
    throw new CliError(`cannot read template ${displayPath(templateFile)}: ${err.code === 'ENOENT' ? 'file not found' : err.message}`, 1);
  }
  if (!template.includes(PLACEHOLDERS.title)) warn(`template has no ${PLACEHOLDERS.title} placeholder; the page title is left as is`);
  if (!template.includes(PLACEHOLDERS.context)) warn(`template has no ${PLACEHOLDERS.context} placeholder; the page gets no report path`);

  const embed = values['embed-images'] ?? config?.report?.embedImages === true;
  const assets = embed ? buildAssets(report, path.dirname(inFile), { warn }) : {};
  if (!embed) {
    for (const ref of collectImageRefs(report)) {
      const problem = imageRefProblem(ref);
      if (problem) warn(`image not shown: ${shown(ref)} is ${problem}`);
    }
  }
  const context = reportContext(inFile);
  if (values.config) {
    // Shared HTML: only paths inside the working directory, like reportPath (never ../../ out of it).
    const configFile = path.resolve(values.config);
    const configPath = pathInside(configFile);
    if (configPath) context.configPath = configPath;
    if (configPath && context.reportPath) {
      // Real paths on both sides (as for reportPath): a symlinked temp or home folder never turns into ../../… hops.
      context.configFromReport = path.relative(path.dirname(realOrResolved(inFile)), realOrResolved(configFile)).split(path.sep).join('/');
      context.reportGeneratedAt = report.meta.generatedAt;
    }
    if (!configPath) warn('--config is outside the working directory: its path is not written into the shared report.html');
  }
  const html = fillTemplate(template, report, assets, context);

  const outFile = path.resolve(values.out || path.join(path.dirname(inFile), 'report.html'));
  writeText(outFile, html);
  const sc = report.scorecard;
  log(
    `Rendered ${displayPath(outFile)} — ${sc.verdict} · parity ${sc.parity}% · ${report.findings.length} finding(s)` +
      (embed ? ` · ${Object.keys(assets).length} image(s) embedded` : ''),
  );

  if (values.fixplan) {
    const planFile = path.resolve(values.fixplan);
    writeText(planFile, renderFixplan(report, options));
    log(`Wrote fix plan ${displayPath(planFile)}`);
  }
  if (values['backfill-plan']) {
    const planFile = path.resolve(values['backfill-plan']);
    const plan = renderBackfillPlan(report);
    if (plan) {
      writeText(planFile, plan);
      log(`Wrote design-backfill plan ${displayPath(planFile)}`);
    } else {
      log(`No design-backfill items; ${displayPath(planFile)} not written`);
    }
  }
  if (values['write-back']) {
    writeJson(inFile, report);
    log(`Updated ${displayPath(inFile)}`);
  }
  return 0;
}

runMain(import.meta.url, main);
