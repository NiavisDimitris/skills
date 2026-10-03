#!/usr/bin/env node
// Render report.json into the self-contained interactive HTML report (and,
// optionally, the Markdown fix plan). See --help.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
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
});
const MAX_EMBED_BYTES = 15 * 1024 * 1024;
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
                       Paths resolve relative to the report.json directory; missing files
                       are skipped with a warning.
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
The context element gets { "reportPath": "<--in relative to the working directory>" }
when the --in file is inside the working directory, else {} (never an absolute path:
the HTML is shared). The page names that path in the message it copies for an agent;
review.mjs adds { live, token } to it when it serves the page.

Exit codes: 0 rendered · 1 invalid report, template or IO error · 2 bad arguments`;

/** JSON safe to embed inside <script type="application/json">. */
export function serializeForScript(value) {
  return JSON.stringify(value)
    .replace(/<\//g, '<\\/')
    .replace(/<!--/g, '\\u003c!--')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Every image path the report references (deduplicated, in report order). */
export function collectImagePaths(report) {
  const out = [];
  const add = (p) => {
    if (typeof p === 'string' && p && IMAGE_TYPES[path.extname(p).toLowerCase()] && !out.includes(p)) out.push(p);
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

/** { "<path as written in the report>": "data:<mime>;base64,…" } for images that exist. */
export function buildAssets(report, baseDir, { warn = () => {} } = {}) {
  const assets = {};
  for (const ref of collectImagePaths(report)) {
    const file = path.resolve(baseDir, ref);
    if (!existsSync(file)) {
      warn(`image not found, not embedded: ${ref}`);
      continue;
    }
    const size = statSync(file).size;
    if (size > MAX_EMBED_BYTES) {
      warn(`image larger than 15 MB, not embedded: ${ref}`);
      continue;
    }
    const mime = IMAGE_TYPES[path.extname(file).toLowerCase()];
    assets[ref] = `data:${mime};base64,${readFileSync(file).toString('base64')}`;
  }
  return assets;
}

/**
 * The page context for the design-qa-context element: { reportPath } with the report
 * file relative to cwd (forward slashes) when it is inside cwd, else {}. Never an
 * absolute path: report.html is shared.
 */
export function reportContext(reportFile, cwd = process.cwd()) {
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const rel = path.relative(real(cwd), real(path.resolve(cwd, reportFile)));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return {};
  return { reportPath: rel.split(path.sep).join('/') };
}

/**
 * Inject data, assets, the page context and title into the template (throws when the
 * data or assets placeholder is missing; the context and title placeholders are optional).
 */
export function fillTemplate(template, report, assets = {}, context = {}) {
  for (const key of ['data', 'assets']) {
    if (!template.includes(PLACEHOLDERS[key])) {
      throw new CliError(`template is missing the ${PLACEHOLDERS[key]} placeholder (see --help for the template contract)`, 1);
    }
  }
  const title = escapeHtml(`Design QA — ${report?.meta?.feature ?? 'report'}`);
  const data = serializeForScript(report);
  const assetJson = serializeForScript(assets);
  const contextJson = serializeForScript(context && typeof context === 'object' ? context : {});
  // Function replacers: the payload must never be interpreted as a $-pattern. The
  // context goes in first: the data and assets JSON may legitimately contain its
  // placeholder text (e.g. a finding title), which must never be rewritten.
  return template
    .replace(PLACEHOLDERS.context, () => contextJson)
    .replace(PLACEHOLDERS.data, () => data)
    .replace(PLACEHOLDERS.assets, () => assetJson)
    .split(PLACEHOLDERS.title)
    .join(title);
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
  const context = reportContext(inFile);
  if (values.config) {
    const configFile = path.resolve(values.config);
    context.configPath = path.relative(process.cwd(), configFile).split(path.sep).join('/');
    context.configFromReport = path.relative(path.dirname(inFile), configFile).split(path.sep).join('/');
    context.reportGeneratedAt = report.meta.generatedAt;
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
