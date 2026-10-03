#!/usr/bin/env node
// Apply a reviewer's decisions from report.html (one decisions document: fix now /
// debt, dismissals with a reason, design-backfill decisions, ticket authorisation) to
// report.json in one go, keep the dismissed and debt logs, and print exactly what the
// agent does next. Works with any coding agent: plain Node, exit codes and stdout.
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, displayPath, parseCli, readJsonFile, runMain, usageError, writeText } from './lib/args.mjs';
import { resolveReviewConfig, shellArg } from './lib/review-context.mjs';
import { DecisionsError, applyDecisions, parseDecisions, summaryLine } from './lib/decisions.mjs';
import { renderDismissedMarkdown, upsertLogEntries } from './lib/dismissals.mjs';
import { DASH, sourceLocation } from './lib/fixplan.mjs';
import { backfillItems, resolveOptions } from './lib/ranking.mjs';
import { validateConfig, validateReport } from './lib/schema-check.mjs';
import { reportSlug, triageLists } from './lib/triage.mjs';
import { renderDebtLog, updateDebtLog } from './debt-log.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PENDING = 'decisions.json';
const APPLIED = 'decisions.applied.json';

const HELP = `Apply the reviewer's decisions from report.html to report.json in one go.

Usage:
  node scripts/apply-decisions.mjs --report <dir>/report.json [--from <file> | --from -] [options]

Input (--from):
  <file>                 the decisions document (decisions.json, written by review.mjs when the
                         reviewer clicks Send), or a text file holding the whole message from
                         "Copy for your agent" (the JSON inside its \`\`\`design-qa-decisions fence
                         is read; everything else is ignored)
  -                      read the document or the message from stdin
  (omitted)              <dir>/decisions.json when it exists; otherwise "No pending decisions"

Options:
  --allow-stale          apply although the decisions were made on an earlier report
                         (reportGeneratedAt differs from meta.generatedAt). Finding ids are
                         renumbered on every pass, so only when you know they still match
  --by <name>            who decided (default: the document's decidedBy)
  --log <file>           dismissed log JSON (default: dismissed.json next to the feature folder,
                         i.e. qa-reports/dismissed.json for qa-reports/<slug>/report.json)
  --md <file>            dismissed log Markdown (default: the --log path with .md)
  --config <file>        design-qa.config.json: tolerances.pixelDiff, report.topN and
                         report.ranking for the recomputed scorecard; report.debtLog for the
                         debt log's Markdown path. Default: the rendered report's config,
                         else the nearest ancestor design-qa.config.json
  --dry-run              print the result without writing anything
  --quiet                only print warnings and errors
  -h, --help             show this help

The decisions document (schemas/decisions.schema.json):
  { "kind": "design-qa-decisions", "version": 1, "slug", "feature", "reportGeneratedAt",
    "decidedBy", "decidedAt", "tickets": true|false,
    "triage": { "fixNow": [ids], "debt": [ids] },
    "dismissals": [ { "findingId", "kind": "not-an-issue"|"remove"|"intentional", "reason", "by", "date" } ],
    "backfill": [ { "id", "decision": "build"|"not-needed", "reason", "by", "date" } ] }

Applied in this order: dismissals (as dismiss.mjs does), the triage (as triage.mjs
--selection does, source report-ui; blockers listed as debt stay fix now, with a
warning; triage.ticketsAuthorized records "tickets"), the backfill decisions (as
backfill.mjs --from does). The scorecard is recomputed and the result validated before
report.json is written. New dismissals are upserted into the dismissed log; the debt
log (design-debt.json / .md next to the feature folder, as debt-log.mjs) follows the
triage. Re-applying the same decisions reconciles missing outputs without duplicating entries.
Existing output files are replaced atomically. After all outputs are saved,
<dir>/decisions.json is renamed to decisions.applied.json, so a second run reports
"No pending decisions".

Exit codes: 0 applied, nothing new, or nothing pending · 1 invalid report, write
failure, or the result does not validate · 2 bad arguments, unreadable or stale
decisions, slug mismatch, unknown ids`;

function withExtension(file, ext) {
  return file.replace(/\.(json|md)$/i, '') + ext;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const scriptPath = (name) => displayPath(path.join(HERE, name));

async function main(argv) {
  const { values } = parseCli(argv, {
    report: { type: 'string' },
    from: { type: 'string' },
    'allow-stale': { type: 'boolean' },
    by: { type: 'string' },
    log: { type: 'string' },
    md: { type: 'string' },
    config: { type: 'string' },
    'dry-run': { type: 'boolean' },
    quiet: { type: 'boolean' },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const quiet = Boolean(values.quiet);
  const log = quiet ? () => {} : (msg) => console.log(msg);
  if (!values.report) throw usageError('--report <dir>/report.json is required (see --help)');

  const reportFile = path.resolve(values.report);
  const reportDir = path.dirname(reportFile);
  const pendingFile = path.join(reportDir, PENDING);
  const appliedFile = path.join(reportDir, APPLIED);

  // Read the decisions.
  let content;
  let fromFile = null;
  let fromLabel;
  if (values.from === '-') {
    content = await readStdin();
    fromLabel = 'stdin';
  } else {
    if (values.from === undefined) {
      if (!existsSync(pendingFile)) {
        const applied = existsSync(appliedFile) ? ` (the last ones were applied: ${displayPath(appliedFile)})` : '';
        log(`No pending decisions: ${displayPath(pendingFile)} does not exist${applied}.`);
        log(`Next: ask the reviewer to open report.html (node ${scriptPath('review.mjs')} --report ${displayPath(reportFile)}) and click Send, or paste the "Copy for your agent" message and run this with --from <that file>`);
        return 0;
      }
      fromFile = pendingFile;
    } else {
      fromFile = path.resolve(values.from);
    }
    fromLabel = displayPath(fromFile);
    try {
      content = readFileSync(fromFile, 'utf8');
    } catch (err) {
      throw usageError(`cannot read --from ${fromLabel}: ${err.code === 'ENOENT' ? 'file not found' : err.message}`);
    }
  }
  let doc;
  try {
    doc = parseDecisions(content);
  } catch (err) {
    if (err instanceof DecisionsError) throw usageError(`${fromLabel}: ${err.message}`);
    throw err;
  }
  if (values.by !== undefined) doc = { ...doc, decidedBy: values.by.trim() || null };

  // Read and check the report and the config.
  const report = readJsonFile(reportFile, 'report', 1);
  if (!report || typeof report !== 'object' || !Array.isArray(report.findings)) {
    throw new CliError(`${displayPath(reportFile)} is not a design-qa report (no "findings" array)`, 1);
  }
  let config = {};
  const configFile = resolveReviewConfig(reportFile, { explicit: values.config, generatedAt: report.meta?.generatedAt });
  if (configFile) {
    config = readJsonFile(configFile, 'config', 2);
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

  // Apply.
  let result;
  try {
    result = applyDecisions(report, doc, { allowStale: Boolean(values['allow-stale']), options });
  } catch (err) {
    if (err instanceof DecisionsError) {
      const hint = err.code === 'stale' ? ' (Or pass --allow-stale if you are sure the ids still point at the same findings.)' : '';
      throw usageError(`${fromLabel}: ${err.message}${hint}`);
    }
    throw err;
  }
  const { report: next, changes, warnings } = result;
  const after = validateReport(next, { options });
  if (!after.valid) {
    throw new CliError(`the report with these decisions applied does not validate:\n${after.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`, 1);
  }

  // What the agent reads.
  const lists = triageLists(next, options);
  const where = (f) => (sourceLocation(f) === DASH ? '' : ` — ${sourceLocation(f)}`);
  const slug = reportSlug(next);
  log(`Review decisions for ${next.meta?.feature ?? slug} (${slug}): ${summaryLine(doc)}`);
  log(`Decided by ${doc.decidedBy ?? 'the reviewer'} on ${doc.decidedAt.slice(0, 10)} (from ${fromLabel})`);
  log(lists.triaged ? `Fix now (${lists.fixNow.length}), in this order:` : `Fix now (${lists.fixNow.length}), the recommendation (no triage recorded yet):`);
  for (const f of lists.fixNow) log(`  ${f.id} [${f.severity}] ${f.title}${where(f)}`);
  if (!lists.fixNow.length) log('  none');
  log(`Fix later, tracked as debt (${lists.debt.length}):`);
  for (const f of lists.debt) log(`  ${f.id} [${f.severity}] ${f.title}`);
  if (!lists.debt.length) log('  none');
  if (doc.dismissals.length) log(`Dismissed (${doc.dismissals.length}): ${doc.dismissals.map((x) => `${x.findingId} ${x.kind}`).join(', ')}`);
  if (doc.backfill.length) log(`Design backfill (${doc.backfill.length}): ${doc.backfill.map((b) => `${b.id} ${b.decision}`).join(', ')}`);
  log(doc.tickets ? 'Tickets: authorised by the reviewer' : 'Tickets: not authorised (create none; list the debt in your reply)');
  for (const w of warnings) {
    if (quiet) console.error(`warning: ${w}`);
    else log(`Warning: ${w}`);
  }

  const markApplied = () => {
    if (fromFile && path.resolve(fromFile) === pendingFile) {
      renameSync(pendingFile, appliedFile);
      log(`Marked as applied: ${displayPath(appliedFile)}`);
    }
  };

  if (values['dry-run']) {
    log(changes.length ? `[dry run] ${changes.length} change(s); nothing written` : '[dry run] nothing new; nothing written');
    return 0;
  }

  // Reconcile every output, even when a previous attempt already saved the report.
  // Build all outputs before writing so an unreadable log cannot partially apply a review.
  const outputs = [];
  const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;
  if (changes.length) outputs.push([reportFile, jsonText(next)]);

  const dismissChanges = doc.dismissals.map((c) => ({ findingId: c.findingId, action: 'dismiss', source: 'report-ui' }));
  if (dismissChanges.length) {
    const mdFlag = values.md ? path.resolve(values.md) : null;
    const logFile = path.resolve(values.log ?? (mdFlag ? withExtension(mdFlag, '.json') : path.join(path.dirname(reportDir), 'dismissed.json')));
    const mdFile = mdFlag ?? withExtension(logFile, '.md');
    let previous = null;
    if (existsSync(logFile)) {
      previous = readJsonFile(logFile, 'dismissed log', 1);
      if (!previous || !Array.isArray(previous.entries)) throw new CliError(`${displayPath(logFile)} is not a dismissed log (no "entries" array)`, 1);
    }
    const { log: nextLog } = upsertLogEntries(previous, next, dismissChanges, { now: doc.decidedAt });
    outputs.push([logFile, jsonText(nextLog)], [mdFile, renderDismissedMarkdown(nextLog)]);
  }

  if (next.triage) {
    const configMd = configFile && typeof config.report?.debtLog === 'string' ? path.resolve(path.dirname(configFile), config.report.debtLog) : null;
    const debtMd = configMd ?? path.join(path.dirname(reportDir), 'design-debt.md');
    const debtJson = withExtension(debtMd, '.json');
    let previous = null;
    if (existsSync(debtJson)) {
      previous = readJsonFile(debtJson, 'debt log', 1);
      if (!previous || !Array.isArray(previous.entries)) throw new CliError(`${displayPath(debtJson)} is not a design-debt log (no "entries" array)`, 1);
    }
    const relReport = path.relative(path.dirname(debtJson), reportFile).split(path.sep).join('/');
    const { log: debtLog } = updateDebtLog(previous, next, { reportPath: relReport });
    outputs.push([debtJson, jsonText(debtLog)], [debtMd, renderDebtLog(debtLog)]);
  }
  const written = [];
  for (const [file, content] of outputs) {
    if (existsSync(file) && readFileSync(file, 'utf8') === content) continue;
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      writeText(tmp, content);
      renameSync(tmp, file);
    } finally {
      rmSync(tmp, { force: true });
    }
    written.push(displayPath(file));
  }
  if (!changes.length) log('Nothing new: report.json already records these decisions (not rewritten).');
  if (written.length) log(`Wrote ${written.join(', ')}`);
  markApplied();

  // Next steps.
  const rel = displayPath(reportFile);
  const inDir = (name) => displayPath(path.join(reportDir, name));
  const render = [
    `node ${scriptPath('render-report.mjs')} --in ${rel} --out ${inDir('report.html')} --fixplan ${inDir('report-fixplan.md')}`,
    backfillItems(next).length ? `--backfill-plan ${inDir('report-backfill.md')}` : null,
    configFile ? `--config ${shellArg(displayPath(configFile))}` : null,
    '--embed-images --recompute --write-back',
  ]
    .filter(Boolean)
    .join(' ');
  log(`Next: ${render}`);
  const untracked = (next.triage?.items ?? []).filter((i) => i.decision === 'debt' && !i.ticket).length;
  if (doc.tickets && untracked) {
    log(
      `Next: create one ticket per debt item (${untracked}): node ${scriptPath('jira-fetch.mjs')} --tickets-from ${rel} (preview), then the same with --write ` +
        `(or the tracker's MCP); then node ${scriptPath('debt-log.mjs')} --report ${rel}${configFile ? ` --config ${shellArg(displayPath(configFile))}` : ''} records the ticket keys`,
    );
  } else if (!doc.tickets && untracked) {
    log(`Next: ${untracked} debt item(s) have no ticket; the reviewer did not authorise tickets, so create none and list them in your reply`);
  }
  if (lists.fixNow.length) log(`Next: fix the fix-now set (${lists.fixNow.map((f) => f.id).join(', ')}) in that order, per references/fix-loop.md`);
  else log('Next: nothing to fix now');
  return 0;
}

runMain(import.meta.url, main);
