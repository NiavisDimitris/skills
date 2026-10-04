#!/usr/bin/env node
// Record the person's triage in report.json: the listed findings are fixed now,
// every other triageable finding becomes debt (to be ticketed and logged), so every
// diff is either fixed or tracked.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CliError, displayPath, formatIssues, oneLine, parseCli, readJsonFile, runMain, usageError, writeJson } from './lib/args.mjs';
import { TRIAGE_SOURCES, isTriageable, resolveOptions } from './lib/ranking.mjs';
import { isRfc3339DateTime, validateConfig, validateReport } from './lib/schema-check.mjs';
import { shellArg } from './lib/review-context.mjs';
import { applyTriage, buildTriage, recommendedFixIds, reportSlug, sameInstant, triageLists } from './lib/triage.mjs';

const HELP = `Record which findings get fixed now; everything else becomes debt.

Usage:
  node scripts/triage.mjs --report <report.json> --fix <ids> [options]
  node scripts/triage.mjs --report <report.json> --selection <selection.json> [options]
  node scripts/triage.mjs --report <report.json> --default [options]

Choose exactly one of:
  --fix <ids>              comma-separated finding ids to fix now (e.g. DQ-001,DQ-003);
                           "none" fixes nothing now (an empty value is an error, so an
                           unset variable never turns every finding into debt)
  --selection <file>       selection.json exported by report.html:
                           { feature, slug, reportGeneratedAt, fixNow: [ids], debt: [ids],
                             decidedBy, decidedAt }
  --default                the recommendation: the fix-now rank bucket and every blocker are
                           fixed now, the rest of the debt bucket becomes debt (use in CI)

Options:
  --allow-stale            with --selection: apply although it was made on an earlier report
                           (reportGeneratedAt differs from meta.generatedAt). Finding ids are
                           renumbered on every pass, so only when you know they still match
  --by <name>              who decided (default: the selection's decidedBy, else none)
  --source <source>        report-ui | chat | cli | ci-default (default: report-ui for
                           --selection, ci-default for --default, cli for --fix)
  --config <file>          design-qa.config.json: tolerances.pixelDiff, report.topN and
                           report.ranking for the recomputed scorecard and ranks
  --dry-run                print the result without writing report.json
  --quiet                  only print warnings and errors
  -h, --help               show this help

Triageable findings are FIX_CODE findings with severity BLOCKER, WARNING or
DS_CANDIDATE (DISMISSED and INTENTIONAL findings never are). Listed ids become
"fix-now", every other triageable finding "debt". A BLOCKER can never be debt: unlisted
blockers stay fix-now (with a warning). Tickets already recorded for a finding are
kept. report.json (schemaVersion 2.0) is rewritten in place with the triage block and
a recomputed scorecard (unexplained, debt, loopClosed), then validated. Next: ticket the debt with
jira-fetch.mjs --tickets-from <report.json>, log it with debt-log.mjs, and re-render.

Exit codes: 0 ok · 1 invalid report (including not JSON) or write failure · 2 bad arguments,
report not found, or a stale selection`;

const ID_RE = /^DQ-\d{3,}$/;

function parseIds(text) {
  const raw = String(text ?? '').trim();
  if (raw.toLowerCase() === 'none') return [];
  const ids = raw.split(/[\s,]+/).filter(Boolean).map((id) => id.toUpperCase());
  if (!ids.length) {
    throw usageError(`--fix needs finding ids (e.g. DQ-001,DQ-004) or "none" to fix nothing now; got ${JSON.stringify(String(text ?? ''))} (an unset variable?)`);
  }
  const bad = ids.filter((id) => !ID_RE.test(id));
  if (bad.length) throw usageError(`--fix: not finding ids: ${bad.map(oneLine).join(', ')} (expected e.g. DQ-001,DQ-004)`);
  return [...new Set(ids)];
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
    'allow-stale': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    quiet: { type: 'boolean' },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const log = values.quiet ? () => {} : (msg) => console.log(msg);
  // Every report, selection or flag value in a warning is folded to one line.
  const warn = (msg) => console.error(`warning: ${oneLine(msg)}`);

  if (!values.report) throw usageError('--report <report.json> is required (see --help)');
  const modes = [values.fix !== undefined, Boolean(values.selection), Boolean(values.default)].filter(Boolean).length;
  if (modes !== 1) throw usageError('choose exactly one of --fix <ids>, --selection <selection.json> or --default');
  if (values['allow-stale'] && !values.selection) throw usageError('--allow-stale goes with --selection');
  if (values.source && !TRIAGE_SOURCES.includes(values.source)) {
    throw usageError(`--source must be one of ${TRIAGE_SOURCES.join(', ')} (got "${oneLine(values.source)}")`);
  }

  const reportFile = path.resolve(values.report);
  // A wrong path is a bad argument (2); a file that is not JSON is an invalid report (1).
  if (!existsSync(reportFile)) throw usageError(`cannot read report ${oneLine(reportFile)}: file not found`);
  const report = readJsonFile(reportFile, 'report', 1);
  let config = {};
  if (values.config) {
    config = readJsonFile(path.resolve(values.config), 'config', 2);
    const cv = validateConfig(config);
    if (!cv.valid) throw usageError(`--config is invalid:\n${formatIssues(cv.errors)}`);
  }
  const options = resolveOptions(config);

  const before = validateReport(report, { options, skipScorecard: true, skipRanks: true, skipTriage: true });
  if (!before.valid) {
    throw new CliError(
      `${oneLine(displayPath(reportFile))} is not a valid report; fix it first:\n${formatIssues(before.errors)}`,
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
    if (selection.reportGeneratedAt && !sameInstant(selection.reportGeneratedAt, report.meta.generatedAt)) {
      // As apply-decisions.mjs: ids are renumbered on every pass, so a stale selection is refused.
      const msg =
        `the selection was made on the report generated ${oneLine(selection.reportGeneratedAt)}, but report.json was generated ${oneLine(report.meta.generatedAt)}. ` +
        'Finding ids are renumbered on every pass, so they may point at different findings';
      if (!values['allow-stale']) {
        throw usageError(
          `${msg}. Reopen the current report.html, choose again and export a new selection. (Or pass --allow-stale if you are sure the ids still point at the same findings.)`,
        );
      }
      warn(`${msg}; applied anyway (--allow-stale)`);
    }
    fixIds = [...new Set(selection.fixNow.map((id) => String(id).toUpperCase()))];
    const debtIds = new Set((Array.isArray(selection.debt) ? selection.debt : []).map((id) => String(id).toUpperCase()));
    const both = fixIds.filter((id) => debtIds.has(id));
    if (both.length) throw usageError(`selection lists ${both.map(oneLine).join(', ')} as both fix now and debt`);
    const unlisted = findings.filter((f) => isTriageable(f) && !fixIds.includes(f.id) && !debtIds.has(f.id)).map((f) => f.id);
    if (unlisted.length) warn(`not in the selection, recorded as debt: ${unlisted.join(', ')}`);
    decidedBy = values.by ?? selection.decidedBy ?? null;
    // Only a date-time the validator accepts is kept; anything else is replaced by now.
    if (isRfc3339DateTime(selection.decidedAt)) decidedAt = selection.decidedAt;
    source ??= 'report-ui';
  } else {
    fixIds = recommendedFixIds(report, options);
    source ??= 'ci-default';
  }

  const unknown = fixIds.filter((id) => !byId.has(id));
  if (unknown.length) throw usageError(`unknown finding id(s): ${unknown.map(oneLine).join(', ')}`);
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
    throw new CliError(`the triaged report does not validate:\n${formatIssues(after.errors)}`, 1);
  }

  const lists = triageLists(next, options);
  const ids = (list) => list.map((f) => oneLine(f.id)).join(', ') || 'none';
  const debtItems = triage.items.filter((i) => i.decision === 'debt');
  const needTickets = debtItems.filter((i) => !i.ticket).length;
  const sc = next.scorecard;
  // Report and selection values (feature, slug, decidedBy) are folded to one line: none can start a line of its own.
  log(`Triage for ${oneLine(slug)} (${oneLine(report.meta.feature)}) — source ${oneLine(source)}${decidedBy ? `, decided by ${oneLine(decidedBy)}` : ''}, ${oneLine(decidedAt.slice(0, 10))}`);
  log(`  Fix now (${lists.fixNow.length}): ${ids(lists.fixNow)}`);
  log(`  Debt (${lists.debt.length}): ${ids(lists.debt)} — ${debtItems.length - needTickets} ticketed, ${needTickets} need a ticket`);
  log(`  Verdict ${oneLine(sc.verdict)} · parity ${oneLine(sc.parity)}% · unexplained ${oneLine(sc.unexplained)} · loop ${sc.loopClosed ? 'closed' : 'open'}`);
  if (values['dry-run']) {
    log('[dry run] report.json not written');
    return 0;
  }
  writeJson(reportFile, next);
  log(`Wrote ${oneLine(displayPath(reportFile))}`);
  if (needTickets) log(`Next: node scripts/jira-fetch.mjs --tickets-from ${shellArg(displayPath(reportFile))} (dry run first), then debt-log.mjs and render-report.mjs`);
  return 0;
}

runMain(import.meta.url, main);
