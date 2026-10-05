#!/usr/bin/env node
// Apply a reviewer's decisions from report.html (one decisions document: fix now /
// debt, dismissals with a reason, design-backfill decisions, ticket authorisation) to
// report.json in one go, keep the dismissed and debt logs, and print exactly what the
// agent does next. Works with any coding agent: plain Node, exit codes and stdout.
import { existsSync, linkSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { CliError, assertInsideDir, checkLedgerPaths, displayPath, formatIssues, oneLine, parseCli, readJsonFile, runMain, scriptCommand, shellArg, usageError, withFileLocks, writeText } from './lib/args.mjs';
import { resolveReviewConfig } from './lib/review-context.mjs';
import { assertRunOwnsDir, callerRunId } from './lib/run-lock.mjs';
import { DecisionsError, applyDecisions, parseDecisions, summaryLine } from './lib/decisions.mjs';
import { renderDismissedMarkdown, upsertLogEntries } from './lib/dismissals.mjs';
import { DASH, sourceLocation } from './lib/fixplan.mjs';
import { backfillItems, resolveOptions } from './lib/ranking.mjs';
import { validateConfig, validateReport } from './lib/schema-check.mjs';
import { reportSlug, triageLists } from './lib/triage.mjs';
import { renderDebtLog, updateDebtLog } from './debt-log.mjs';

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
                         debt log's Markdown path (relative to the config file and inside
                         its folder, symlinks followed). Default: the rendered report's
                         config, else the nearest ancestor design-qa.config.json
  --dry-run              print the result without writing anything
  --run <id>             this pass's run id (default: DESIGN_QA_RUN_ID); refused (exit 5)
                         when the report folder's run lock names another run
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
Existing output files are replaced atomically, never through a symlink; report.json
and both logs are locked (<file>.lock) from the read to the last write, so parallel
runs keep every entry. <dir>/decisions.json is claimed first (renamed to
decisions.<id>.processing.json, put back when the run fails); after all outputs are
saved it becomes decisions.applied.json, so a second run reports "No pending decisions".
A log's JSON and Markdown paths must differ (the Markdown one ends in .md).

Exit codes: 0 applied, nothing new, or nothing pending · 1 invalid report, write
failure, or the result does not validate · 2 bad arguments, unreadable or stale
decisions, slug mismatch, unknown ids · 5 another run owns the report folder`;

function withExtension(file, ext) {
  return file.replace(/\.(json|md)$/i, '') + ext;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const scriptPath = (name) => scriptCommand(name).slice('node '.length);
const PROCESSING_RE = /^decisions\.[0-9a-f-]+\.processing\.json$/;

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
    run: { type: 'string' },
    quiet: { type: 'boolean' },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const quiet = Boolean(values.quiet);
  const dryRun = Boolean(values['dry-run']);
  const log = quiet ? () => {} : (msg) => console.log(msg);
  if (!values.report) throw usageError('--report <dir>/report.json is required (see --help)');

  const reportFile = path.resolve(values.report);
  const reportDir = path.dirname(reportFile);
  // Before the pending decisions are claimed (renamed): another run's folder is left as it is (a dry run writes nothing).
  const runId = callerRunId(values.run);
  if (!dryRun || runId) assertRunOwnsDir(reportDir, { runId });
  const pendingFile = path.join(reportDir, PENDING);
  const appliedFile = path.join(reportDir, APPLIED);
  const show = (file) => oneLine(displayPath(file));

  // Read the decisions. The pending file is claimed first (renamed), so two runs never
  // apply one document twice and a document saved meanwhile is never marked applied.
  let content;
  let fromFile = null;
  let fromLabel;
  let claimed = null;
  if (values.from === '-') {
    content = await readStdin();
    fromLabel = 'stdin';
  } else {
    if (values.from === undefined) {
      if (!existsSync(pendingFile)) {
        const applied = existsSync(appliedFile) ? ` (the last ones were applied: ${show(appliedFile)})` : '';
        log(`No pending decisions: ${show(pendingFile)} does not exist${applied}.`);
        for (const name of readdirSafe(reportDir).filter((n) => PROCESSING_RE.test(n))) {
          log(`An interrupted run left ${show(path.join(reportDir, name))}: rename it to ${PENDING} to apply it again.`);
        }
        log('Do: Ask the reviewer to click Send in the review (the next command opens it), or to paste the "Copy for your agent" message: save it and run this with --from <that file>.');
        log(`Next: node ${scriptPath('review.mjs')} --report ${shellArg(displayPath(reportFile))}${runId ? ` --run ${runId}` : ''}`);
        return 0;
      }
      fromFile = pendingFile;
    } else {
      fromFile = path.resolve(values.from);
    }
    fromLabel = show(fromFile);
    if (fromFile === pendingFile && !dryRun) {
      claimed = path.join(reportDir, `decisions.${randomUUID()}.processing.json`);
      try {
        renameSync(pendingFile, claimed);
      } catch (err) {
        if (err.code !== 'ENOENT') throw new CliError(`cannot claim ${fromLabel}: ${err.message}`, 1);
        if (values.from !== undefined) throw usageError(`cannot read --from ${fromLabel}: file not found`);
        log(`No pending decisions: ${fromLabel} was taken by another apply-decisions run.`);
        return 0;
      }
    }
    try {
      content = readFileSync(claimed ?? fromFile, 'utf8');
    } catch (err) {
      restoreClaim(claimed, pendingFile);
      throw usageError(`cannot read --from ${fromLabel}: ${err.code === 'ENOENT' ? 'file not found' : err.message}`);
    }
  }
  try {
    const done = applyAll({ values, quiet, dryRun, log, show, reportFile, reportDir, content, fromLabel });
    if (claimed) {
      // The applied record is the canonical document (kinds as enum values), as received.
      writeText(appliedFile, `${JSON.stringify(done.received, null, 2)}\n`);
      rmSync(claimed, { force: true });
      claimed = null;
      log(`Marked as applied: ${show(appliedFile)}`);
    }
    if (done.next) printNext(done, { log, show, reportFile, reportDir, runId });
    return 0;
  } catch (err) {
    restoreClaim(claimed, pendingFile);
    throw err;
  }
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Put a claimed decisions file back as decisions.json (never over one written meanwhile). */
function restoreClaim(claimed, pendingFile) {
  if (!claimed || !existsSync(claimed)) return;
  try {
    linkSync(claimed, pendingFile);
    rmSync(claimed, { force: true });
  } catch (err) {
    if (err.code === 'EEXIST') {
      console.error(`warning: a new ${oneLine(displayPath(pendingFile))} was saved meanwhile; the decisions this run read are kept in ${oneLine(displayPath(claimed))}`);
    } else {
      try {
        renameSync(claimed, pendingFile);
      } catch {
        console.error(`warning: the decisions this run read are kept in ${oneLine(displayPath(claimed))}; rename it to decisions.json to retry`);
      }
    }
  }
}

/** Parse, apply and (unless --dry-run) write everything, under the ledger locks. */
function applyAll({ values, quiet, dryRun, log, show, reportFile, reportDir, content, fromLabel }) {
  let received;
  try {
    received = parseDecisions(content);
  } catch (err) {
    if (err instanceof DecisionsError) throw usageError(`${fromLabel}: ${err.message}`);
    throw err;
  }
  const doc = values.by !== undefined ? { ...received, decidedBy: values.by.trim() || null } : received;

  // The config (before the report is locked: it only needs meta.generatedAt to find it).
  const peek = readJsonFile(reportFile, 'report', 1);
  let config = {};
  const configFile = resolveReviewConfig(reportFile, { explicit: values.config, generatedAt: peek?.meta?.generatedAt });
  if (configFile) {
    config = readJsonFile(configFile, 'config', 2);
    const cv = validateConfig(config);
    if (!cv.valid) throw usageError(`--config is invalid:\n${formatIssues(cv.errors)}`);
  }
  const options = resolveOptions(config);

  // Where the logs go; refuse a JSON / Markdown pair that would overwrite each other.
  const mdFlag = values.md ? path.resolve(values.md) : null;
  const logFile = path.resolve(values.log ?? (mdFlag ? withExtension(mdFlag, '.json') : path.join(path.dirname(reportDir), 'dismissed.json')));
  const mdFile = mdFlag ?? withExtension(logFile, '.md');
  checkLedgerPaths(logFile, mdFile, 'dismissed log');
  const configMd = configFile && typeof config.report?.debtLog === 'string' ? path.resolve(path.dirname(configFile), config.report.debtLog) : null;
  const debtMd = configMd ?? path.join(path.dirname(reportDir), 'design-debt.md');
  const debtJson = withExtension(debtMd, '.json');
  checkLedgerPaths(debtJson, debtMd, `debt log${configMd ? ' (config report.debtLog)' : ''}`);
  if (configMd) {
    // A path from a (possibly committed) config stays inside the config's folder, symlinks followed.
    for (const file of [debtMd, debtJson]) assertInsideDir(path.dirname(configFile), file, 'config report.debtLog');
  }

  const work = () => {
    const report = readJsonFile(reportFile, 'report', 1);
    if (!report || typeof report !== 'object' || !Array.isArray(report.findings)) {
      throw new CliError(`${show(reportFile)} is not a design-qa report (no "findings" array)`, 1);
    }
    const before = validateReport(report, { options, skipScorecard: true, skipRanks: true, skipTriage: true });
    if (!before.valid) throw new CliError(`${show(reportFile)} is not a valid report; fix it first:\n${formatIssues(before.errors)}`, 1);

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
    if (!after.valid) throw new CliError(`the report with these decisions applied does not validate:\n${formatIssues(after.errors)}`, 1);

    // What the agent reads: every report or document value folded to one line.
    const lists = triageLists(next, options);
    const where = (f) => (sourceLocation(f) === DASH ? '' : ` — ${oneLine(sourceLocation(f))}`);
    const slug = reportSlug(next);
    log(`Review decisions for ${oneLine(next.meta?.feature ?? slug)} (${oneLine(slug)}): ${summaryLine(doc)}`);
    log(`Decided by ${oneLine(doc.decidedBy ?? 'the reviewer')} on ${doc.decidedAt.slice(0, 10)} (from ${fromLabel})`);
    log(lists.triaged ? `Fix now (${lists.fixNow.length}), in this order:` : `Fix now (${lists.fixNow.length}), the recommendation (no triage recorded yet):`);
    for (const f of lists.fixNow) log(`  ${f.id} [${oneLine(f.severity)}] ${oneLine(f.title)}${where(f)}`);
    if (!lists.fixNow.length) log('  none');
    log(`Fix later, tracked as debt (${lists.debt.length}):`);
    for (const f of lists.debt) log(`  ${f.id} [${oneLine(f.severity)}] ${oneLine(f.title)}`);
    if (!lists.debt.length) log('  none');
    if (doc.dismissals.length) log(`Dismissed (${doc.dismissals.length}): ${doc.dismissals.map((x) => `${x.findingId} ${x.kind}`).join(', ')}`);
    if (doc.backfill.length) log(`Design backfill (${doc.backfill.length}): ${doc.backfill.map((b) => `${b.id} ${b.decision}`).join(', ')}`);
    log(doc.tickets ? 'Tickets: authorised by the reviewer' : 'Tickets: not authorised (create none; list the debt in your reply)');
    for (const w of warnings) {
      if (quiet) console.error(`warning: ${oneLine(w)}`);
      else log(`Warning: ${oneLine(w)}`);
    }

    if (dryRun) {
      log(changes.length ? `[dry run] ${changes.length} change(s); nothing written` : '[dry run] nothing new; nothing written');
      return { received, next: null };
    }

    // Reconcile every output, even when a previous attempt already saved the report.
    // Build all outputs before writing so an unreadable log cannot partially apply a review.
    const outputs = [];
    const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;
    if (changes.length) outputs.push([reportFile, jsonText(next)]);

    const dismissChanges = doc.dismissals.map((c) => ({ findingId: c.findingId, action: 'dismiss', source: 'report-ui' }));
    if (dismissChanges.length) {
      let previous = null;
      if (existsSync(logFile)) {
        previous = readJsonFile(logFile, 'dismissed log', 1);
        if (!previous || !Array.isArray(previous.entries)) throw new CliError(`${show(logFile)} is not a dismissed log (no "entries" array)`, 1);
      }
      const { log: nextLog } = upsertLogEntries(previous, next, dismissChanges, { now: doc.decidedAt });
      outputs.push([logFile, jsonText(nextLog)], [mdFile, renderDismissedMarkdown(nextLog)]);
    }

    if (next.triage) {
      let previous = null;
      if (existsSync(debtJson)) {
        previous = readJsonFile(debtJson, 'debt log', 1);
        if (!previous || !Array.isArray(previous.entries)) throw new CliError(`${show(debtJson)} is not a design-debt log (no "entries" array)`, 1);
      }
      const relReport = path.relative(path.dirname(debtJson), reportFile).split(path.sep).join('/');
      const { log: debtLog } = updateDebtLog(previous, next, { reportPath: relReport });
      outputs.push([debtJson, jsonText(debtLog)], [debtMd, renderDebtLog(debtLog)]);
    }
    const written = [];
    for (const [file, text] of outputs) {
      let same = false;
      try {
        same = readFileSync(file, 'utf8') === text;
      } catch {
        // missing (or not a file: writeText says so)
      }
      if (same) continue;
      writeText(file, text); // atomic; refuses a symlink or a directory
      written.push(show(file));
    }
    if (!changes.length) log('Nothing new: report.json already records these decisions (not rewritten).');
    if (written.length) log(`Wrote ${written.join(', ')}`);
    return { received, next, lists, doc, configFile };
  };
  return dryRun ? work() : withFileLocks([reportFile, doc.dismissals.length ? logFile : null, debtJson], work);
}

/** The printed next steps: every path shell-quoted, so each command stays one line. */
function printNext({ next, lists, doc, configFile }, { log, reportFile, reportDir, runId }) {
  const rel = shellArg(displayPath(reportFile));
  const inDir = (name) => shellArg(displayPath(path.join(reportDir, name)));
  const config = configFile ? ` --config ${shellArg(displayPath(configFile))}` : '';
  const runArg = runId ? ` --run ${runId}` : '';
  const render = [
    `node ${scriptPath('render-report.mjs')} --in ${rel} --out ${inDir('report.html')} --fixplan ${inDir('report-fixplan.md')}`,
    backfillItems(next).length ? `--backfill-plan ${inDir('report-backfill.md')}` : null,
    configFile ? config.trim() : null,
    '--embed-images --recompute --write-back',
    runId ? `--run ${runId}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  // What comes after the render: Do: lines; the one Next: is the render itself.
  const untracked = (next.triage?.items ?? []).filter((i) => i.decision === 'debt' && !i.ticket).length;
  if (doc.tickets && untracked) {
    log(
      `Do: After the next command, create one ticket per debt item (${untracked}): node ${scriptPath('jira-fetch.mjs')} --tickets-from ${rel}${runArg} (preview), then the same with --write ` +
        `(or the tracker's MCP); then node ${scriptPath('debt-log.mjs')} --report ${rel}${config}${runArg} records the ticket keys.`,
    );
  } else if (!doc.tickets && untracked) {
    log(`Do: ${untracked} debt item(s) have no ticket; the reviewer did not authorise tickets, so create none and list them in your reply.`);
  }
  if (lists.fixNow.length) log(`Do: After the next command, fix the fix-now set (${lists.fixNow.map((f) => oneLine(f.id)).join(', ')}) in that order, per references/fix-loop.md.`);
  else log('Do: Nothing to fix now.');
  log(`Next: ${render}`);
}

runMain(import.meta.url, main);
