#!/usr/bin/env node
// Render report.json into the self-contained interactive HTML report (and,
// optionally, the Markdown fix plan). See --help.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, displayPath, parseCli, readJsonFile, runMain, toNumber, usageError, writeJson, writeText } from './lib/args.mjs';
import { renderFixplan } from './lib/fixplan.mjs';
import { computeScorecard, rankFindings, resolveOptions } from './lib/ranking.mjs';
import { validateConfig, validateReport } from './lib/schema-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TEMPLATE = path.resolve(HERE, '../templates/report.html');
export const PLACEHOLDERS = Object.freeze({
  data: '/*__DESIGN_QA_DATA__*/',
  assets: '/*__DESIGN_QA_ASSETS__*/',
  title: '__DESIGN_QA_TITLE__',
});
const MAX_EMBED_BYTES = 15 * 1024 * 1024;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
const IMAGE_EVIDENCE = new Set(['screenshot', 'figma', 'diff']);

const HELP = `Render a design-qa report.json into the interactive HTML report.

Usage:
  node scripts/render-report.mjs --in <report.json> [--out <report.html>] [options]

Options:
  --in <file>          report.json to render (required)
  --out <file>         HTML to write (default: report.html next to --in)
  --template <file>    HTML template (default: ../templates/report.html next to this script)
  --embed-images       inline every referenced image as a data: URI so the HTML is
                       self-contained (scorecard.pixelDiff[*].image, stateMatrix[*].captured.*,
                       findings[*].evidence[*].path of screenshot/figma/diff evidence,
                       evidence.states[*].figma|app|diff). Paths resolve relative to the
                       report.json directory; missing files are skipped with a warning.
  --fixplan <file>     also write the Markdown fix plan (fix now / debt / missing states /
                       cannot verify) with a paste-ready prompt for a coding agent
  --recompute          rewrite the derived values from the rules instead of failing when the
                       stored ones disagree: every finding's rank and the scorecard
                       (severity/resolution counts, parity, verdict, pixel-diff bands,
                       state coverage)
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
ledger×10 + (6 − effort) for BLOCKER/WARNING/DS_CANDIDATE findings; FIX_CODE ones
by score → the top N are "fix-now", the rest "debt" (the engineer's lists);
SYNC_FIGMA ones → "sync-figma" (the designer's list); everything else "none".
Without --recompute the stored scorecard must equal the derived one.

Template contract: the template must contain
  <script id="design-qa-data" type="application/json">${PLACEHOLDERS.data}</script>
  <script id="design-qa-assets" type="application/json">${PLACEHOLDERS.assets}</script>
  <title>${PLACEHOLDERS.title}</title>

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
    add(row?.captured?.figma);
    add(row?.captured?.app);
    add(row?.captured?.diff);
  }
  for (const f of report?.findings || []) {
    for (const e of f?.evidence || []) if (IMAGE_EVIDENCE.has(e?.type)) add(e.path);
  }
  for (const s of Object.values(report?.evidence?.states || {})) {
    add(s?.figma);
    add(s?.app);
    add(s?.diff);
  }
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

/** Inject data, assets and title into the template (throws when a placeholder is missing). */
export function fillTemplate(template, report, assets = {}) {
  for (const key of ['data', 'assets']) {
    if (!template.includes(PLACEHOLDERS[key])) {
      throw new CliError(`template is missing the ${PLACEHOLDERS[key]} placeholder (see --help for the template contract)`, 1);
    }
  }
  const title = escapeHtml(`Design QA — ${report?.meta?.feature ?? 'report'}`);
  const data = serializeForScript(report);
  const assetJson = serializeForScript(assets);
  // Function replacers: the payload must never be interpreted as a $-pattern.
  return template
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

  const embed = values['embed-images'] ?? config?.report?.embedImages === true;
  const assets = embed ? buildAssets(report, path.dirname(inFile), { warn }) : {};
  const html = fillTemplate(template, report, assets);

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
  if (values['write-back']) {
    writeJson(inFile, report);
    log(`Updated ${displayPath(inFile)}`);
  }
  return 0;
}

runMain(import.meta.url, main);
