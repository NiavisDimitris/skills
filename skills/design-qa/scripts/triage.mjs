#!/usr/bin/env node
// Record the person's triage in report.json: the listed findings are fixed now,
// every other triageable finding becomes debt (to be ticketed and logged), so every
// diff is either fixed or tracked.
import path from 'node:path';
import { CliError, displayPath, parseCli, readJsonFile, runMain, usageError, writeJson } from './lib/args.mjs';
import { TRIAGE_SOURCES, isTriageable, resolveOptions } from './lib/ranking.mjs';
import { validateConfig, validateReport } from './lib/schema-check.mjs';
import { applyTriage, buildTriage, ownerOf, recommendedFixIds, reportSlug, triageLists } from './lib/triage.mjs';

const HELP = `Record which findings get fixed now; everything else becomes debt.

Usage:
  node scripts/triage.mjs --report <report.json> --fix <ids> [options]
  node scripts/triage.mjs --report <report.json> --selection <selection.json> [options]
  node scripts/triage.mjs --report <report.json> --default [options]

Choose exactly one of:
  --fix <ids>              comma-separated finding ids to fix now (e.g. DQ-001,DQ-003);
                           "none" fixes nothing now
  --selection <file>       selection.json exported by report.html:
                           { feature, slug, reportGeneratedAt, fixNow: [ids], debt: [ids],
                             decidedBy, decidedAt }
  --default                the recommendation: the fix-now and sync-figma rank buckets are
                           fixed now, the debt bucket becomes debt (use in CI)

Options:
  --by <name>              who decided (default: the selection's decidedBy, else none)
  --source <source>        report-ui | chat | cli | ci-default (default: report-ui for
                           --selection, ci-default for --default, cli for --fix)
  --config <file>          design-qa.config.json: tolerances.pixelDiff, report.topN and
                           report.ranking for the recomputed scorecard and ranks
  --dry-run                print the result without writing report.json
  --quiet                  only print warnings and errors
  -h, --help               show this help

Triageable findings are FIX_CODE and SYNC_FIGMA findings with severity BLOCKER, WARNING
or DS_CANDIDATE. Listed ids become "fix-now", every other triageable finding "debt".
A BLOCKER can never be debt: unlisted blockers stay fix-now (with a warning). Tickets
already recorded for a finding are kept. report.json is rewritten in place with the
triage block, schemaVersion 1.1 and a recomputed scorecard (unexplained, debt,
loopClosed), then validated. Next: ticket the debt with
jira-fetch.mjs --tickets-from <report.json>, log it with debt-log.mjs, and re-render.

Exit codes: 0 ok · 1 invalid report or write failure · 2 bad arguments`;

const ID_RE = /^DQ-\d{3,}$/;

function parseIds(text) {
  const raw = String(text ?? '').trim();
  if (!raw || raw.toLowerCase() === 'none') return [];
  const ids = raw.split(/[\s,]+/).filter(Boolean).map((id) => id.toUpperCase());
  const bad = ids.filter((id) => !ID_RE.test(id));
  if (bad.length) throw usageError(`--fix: not finding ids: ${bad.join(', ')} (expected e.g. DQ-001,DQ-004)`);
  return [...new Set(ids)];
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

async function main(argv) {
  const { values } = parseCli(argv, {
    report: { type: 'string' },
    fix: { type: 'string' },
    selection: { type: 'string' },
    default: { type: 'boolean' },
    by: { type: 'string' },
    source: { type: 'string' },
    config: { type: 'string' },
    'dry-run': { type: 'boolean' },
    quiet: { type: 'boolean' },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const log = values.quiet ? () => {} : (msg) => console.log(msg);
  const warn = (msg) => console.error(`warning: ${msg}`);

  if (!values.report) throw usageError('--report <report.json> is required (see --help)');
  const modes = [values.fix !== undefined, Boolean(values.selection), Boolean(values.default)].filter(Boolean).length;
  if (modes !== 1) throw usageError('choose exactly one of --fix <ids>, --selection <selection.json> or --default');
  if (values.source && !TRIAGE_SOURCES.includes(values.source)) {
    throw usageError(`--source must be one of ${TRIAGE_SOURCES.join(', ')} (got "${values.source}")`);
  }

  const reportFile = path.resolve(values.report);
  const report = readJsonFile(reportFile, 'report', 2);
  let config = {};
  if (values.config) {
    config = readJsonFile(path.resolve(values.config), 'config', 2);
    const cv = validateConfig(config);
    if (!cv.valid) throw usageError(`--config is invalid:\n${cv.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
  }
  const options = resolveOptions(config);

  const before = validateReport(report, { options, skipScorecard: true, skipRanks: true, skipTriage: true });
  if (!before.valid) {
    throw new CliError(
      `${displayPath(reportFile)} is not a valid report; fix it first:\n${before.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`,
      1,
    );
  }
  const findings = report.findings;
  const byId = new Map(findings.map((f) => [f.id, f]));
  const slug = reportSlug(report);

  let fixIds;
  let decidedBy = values.by ?? null;
  let decidedAt = new Date().toISOString();
  let source = values.source;
  if (values.fix !== undefined) {
    fixIds = parseIds(values.fix);
    source ??= 'cli';
  } else if (values.selection) {
    const selection = readJsonFile(path.resolve(values.selection), 'selection', 2);
    if (!selection || typeof selection !== 'object' || !Array.isArray(selection.fixNow)) {
      throw usageError('selection.json must be an object with a "fixNow" array of finding ids');
    }
    if (selection.slug && selection.slug !== slug) warn(`selection is for "${selection.slug}" but this report is "${slug}"`);
    if (selection.reportGeneratedAt && selection.reportGeneratedAt !== report.meta.generatedAt) {
      warn(`selection was made on the report generated ${selection.reportGeneratedAt}; this report was generated ${report.meta.generatedAt}`);
    }
    fixIds = [...new Set(selection.fixNow.map((id) => String(id).toUpperCase()))];
    const debtIds = new Set((Array.isArray(selection.debt) ? selection.debt : []).map((id) => String(id).toUpperCase()));
    const both = fixIds.filter((id) => debtIds.has(id));
    if (both.length) throw usageError(`selection lists ${both.join(', ')} as both fix now and debt`);
    const unlisted = findings.filter((f) => isTriageable(f) && !fixIds.includes(f.id) && !debtIds.has(f.id)).map((f) => f.id);
    if (unlisted.length) warn(`not in the selection, recorded as debt: ${unlisted.join(', ')}`);
    decidedBy = values.by ?? selection.decidedBy ?? null;
    if (isIsoDate(selection.decidedAt)) decidedAt = selection.decidedAt;
    source ??= 'report-ui';
  } else {
    fixIds = recommendedFixIds(report, options);
    source ??= 'ci-default';
  }

  const unknown = fixIds.filter((id) => !byId.has(id));
  if (unknown.length) throw usageError(`unknown finding id(s): ${unknown.join(', ')}`);
  for (const id of fixIds) {
    const f = byId.get(id);
    if (!isTriageable(f)) warn(`${id} is not triageable (${f.severity} / ${f.resolution}); ignored`);
  }

  const { triage, warnings } = buildTriage(report, {
    fixIds: fixIds.filter((id) => isTriageable(byId.get(id))),
    decidedBy,
    decidedAt,
    source,
  });
  warnings.forEach(warn);
  const next = applyTriage(report, triage, options);
  const after = validateReport(next, { options });
  if (!after.valid) {
    throw new CliError(`the triaged report does not validate:\n${after.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`, 1);
  }

  const lists = triageLists(next, options);
  const ids = (list) => list.map((f) => f.id).join(', ') || 'none';
  const debtItems = triage.items.filter((i) => i.decision === 'debt');
  const needTickets = debtItems.filter((i) => !i.ticket).length;
  const sc = next.scorecard;
  log(`Triage for ${slug} (${report.meta.feature}) — source ${source}${decidedBy ? `, decided by ${decidedBy}` : ''}, ${decidedAt.slice(0, 10)}`);
  log(`  Fix now (${lists.fixNow.length}): ${ids(lists.fixNow)}`);
  log(`  Sync to Figma (${lists.syncFigma.length}): ${ids(lists.syncFigma)}`);
  log(`  Debt (${lists.debt.length}): ${lists.debt.map((f) => `${f.id} [${ownerOf(f)}]`).join(', ') || 'none'} — ${debtItems.length - needTickets} ticketed, ${needTickets} need a ticket`);
  log(`  Verdict ${sc.verdict} · parity ${sc.parity}% · unexplained ${sc.unexplained} · loop ${sc.loopClosed ? 'closed' : 'open'}`);
  if (values['dry-run']) {
    log('[dry run] report.json not written');
    return 0;
  }
  writeJson(reportFile, next);
  log(`Wrote ${displayPath(reportFile)} (schemaVersion 1.1)`);
  if (needTickets) log(`Next: node scripts/jira-fetch.mjs --tickets-from ${displayPath(reportFile)} (dry run first), then debt-log.mjs and render-report.mjs`);
  return 0;
}

runMain(import.meta.url, main);
