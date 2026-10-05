#!/usr/bin/env node
// Record a person's dismissals in report.json (not an issue, remove from QA, or
// accept as intentional — always with a written reason) and keep the cumulative
// dismissed log so later passes know about them.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CliError, checkLedgerPaths, displayPath, oneLine, parseCli, readJsonFile, runMain, scriptCommand, shellArg, usageError, withFileLocks, writeJson, writeText } from './lib/args.mjs';
import {
  DISMISS_KINDS,
  applyDismissal,
  applyPriorDismissals,
  normalizeKind,
  parseDismissalsFile,
  renderDismissedMarkdown,
  undoDismissal,
  upsertLogEntries,
} from './lib/dismissals.mjs';
import { assertRunOwnsDir, callerRunId } from './lib/run-lock.mjs';
import { reportSlug } from './lib/triage.mjs';

const HELP = `Dismiss findings with a written reason, undo a dismissal, or re-apply earlier passes' dismissals.

Usage:
  node scripts/dismiss.mjs --report <report.json> --id <ids> --kind <kind> --reason "<why>" [options]
  node scripts/dismiss.mjs --report <report.json> --from <dismissals.json | message.txt> [options]
  node scripts/dismiss.mjs --report <report.json> --undo <ids> [options]
  node scripts/dismiss.mjs --report <report.json> --apply-log [options]

Choose exactly one of:
  --id <ids>             finding id(s) to dismiss, comma-separated (e.g. DQ-004); needs
                         --kind and --reason
  --from <file>          dismissals.json exported by report.html
                         { feature, slug, reportGeneratedAt, decidedBy,
                           items: [ { findingId, kind, reason, by, date } ] }
                         or a text file holding the chat message:
                           /design-qa dismiss <slug>
                           DQ-004 not-an-issue — <reason>
                           DQ-007 remove — <reason>
                           DQ-009 intentional — <reason>
                           by: <name>
  --undo <ids>           restore dismissed / accepted finding(s) to the resolution they had
                         (UNCLASSIFIED or DATA when recorded, else FIX_CODE) and mark their
                         log entries "undone"
  --apply-log            re-apply the log's active dismissals of this feature to open findings
                         with the same fingerprint and unchanged expected/actual values
                         (source prior-pass); matches whose values changed stay open and are
                         listed as notices

Options:
  --kind <kind>          not-an-issue | remove | intentional (with --id)
                           not-an-issue  the difference is not real or does not matter
                           remove        take it out of this QA (duplicate, out of scope)
                           intentional   accepted divergence: INTENTIONAL + signoff
  --reason "<why>"       required, non-empty (with --id)
  --by <name>            who decided (a --from item's own "by" wins; then --by, then the
                         file's decidedBy / "by:" line)
  --source <source>      report-ui | chat | cli (default: cli for --id, report-ui for a
                         dismissals.json, chat for a chat message)
  --log <file>           JSON log (default: dismissed.json next to the feature folder, i.e.
                         qa-reports/dismissed.json for qa-reports/<slug>/report.json)
  --md <file>            Markdown log (default: the --log path with .md)
  --dry-run              print the result without writing anything
  --run <id>             this pass's run id (default: DESIGN_QA_RUN_ID); refused (exit 5)
                         when the report folder's run lock names another run, or is not
                         finished and no id is given (--dry-run needs none)
  --quiet                only print warnings and errors
  -h, --help             show this help

Dismissing sets resolution DISMISSED with { kind, reason, by, date, source, priorRef }
(intentional: INTENTIONAL with signoff { by, date, reason }), rank { score: 0, bucket:
"none" }, and removes the finding from triage.items. Only BLOCKER, WARNING and
DS_CANDIDATE findings can be dismissed. Log entries are upserted by feature +
fingerprint (ledger|state|selector|property) with stable ids DS-0001…. The JSON and
Markdown log paths must differ (the Markdown one ends in .md); report.json and the log
are locked while they are read and rewritten, replaced atomically and never written
through a symlink. The scorecard is not recomputed here: re-render with
  node scripts/render-report.mjs --in <report.json> --recompute --write-back
which also validates the report.

Exit codes: 0 ok · 1 unreadable report or log · 2 bad arguments (missing reason, unknown id…) ·
5 another run owns the report folder`;

const ID_RE = /^DQ-\d{3,}$/;
const CLI_SOURCES = ['report-ui', 'chat', 'cli'];

function parseIds(raw, flag) {
  const ids = String(raw ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((id) => id.toUpperCase());
  if (!ids.length) throw usageError(`--${flag}: give at least one finding id (e.g. DQ-004)`);
  const bad = ids.filter((id) => !ID_RE.test(id));
  if (bad.length) throw usageError(`--${flag}: not finding ids: ${bad.map(oneLine).join(', ')} (expected e.g. DQ-004)`);
  return [...new Set(ids)];
}

function withExtension(file, ext) {
  return file.replace(/\.(json|md)$/i, '') + ext;
}

const quote = (v) => {
  const s = oneLine(v);
  return `"${s.length > 90 ? `${s.slice(0, 87)}…` : s}"`;
};

async function main(argv) {
  const { values } = parseCli(argv, {
    report: { type: 'string' },
    id: { type: 'string' },
    kind: { type: 'string' },
    reason: { type: 'string' },
    from: { type: 'string' },
    undo: { type: 'string' },
    'apply-log': { type: 'boolean' },
    by: { type: 'string' },
    source: { type: 'string' },
    log: { type: 'string' },
    md: { type: 'string' },
    'dry-run': { type: 'boolean' },
    run: { type: 'string' },
    quiet: { type: 'boolean' },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (!values.report) throw usageError('--report <report.json> is required (see --help)');
  const modes = [values.id !== undefined, values.from !== undefined, values.undo !== undefined, Boolean(values['apply-log'])].filter(Boolean).length;
  if (modes !== 1) throw usageError('choose exactly one of --id <ids>, --from <file>, --undo <ids> or --apply-log');
  if (values.source && !CLI_SOURCES.includes(values.source)) {
    throw usageError(`--source must be one of ${CLI_SOURCES.join(', ')} (got "${oneLine(values.source)}")`);
  }
  if (values.id === undefined && (values.kind !== undefined || values.reason !== undefined)) {
    throw usageError('--kind and --reason go with --id (a --from file carries its own)');
  }

  const reportFile = path.resolve(values.report);
  const runId = callerRunId(values.run);
  if (!values['dry-run'] || runId) assertRunOwnsDir(path.dirname(reportFile), { runId });
  const mdFlag = values.md ? path.resolve(values.md) : null;
  const logFile = path.resolve(values.log ?? (mdFlag ? withExtension(mdFlag, '.json') : path.join(path.dirname(path.dirname(reportFile)), 'dismissed.json')));
  const mdFile = mdFlag ?? withExtension(logFile, '.md');
  checkLedgerPaths(logFile, mdFile, 'dismissed log');
  // report.json and the log stay locked from the read to the last write (parallel runs keep every entry).
  return values['dry-run'] ? dismiss(values, { reportFile, logFile, mdFile, runId }) : withFileLocks([reportFile, logFile], () => dismiss(values, { reportFile, logFile, mdFile, runId }));
}

function dismiss(values, { reportFile, logFile, mdFile, runId }) {
  const log = values.quiet ? () => {} : (msg) => console.log(msg);
  const warn = (msg) => console.error(`warning: ${msg}`);
  const show = (file) => oneLine(displayPath(file));
  const report = readJsonFile(reportFile, 'report', 1);
  if (!report || typeof report !== 'object' || !Array.isArray(report.findings)) {
    throw new CliError(`${show(reportFile)} is not a design-qa report (no "findings" array)`, 1);
  }
  if (report.schemaVersion !== '2.0') {
    throw new CliError(`${show(reportFile)}: schemaVersion 2.0 required (got "${oneLine(report.schemaVersion)}"); 1.x reports: re-run the pass`, 1);
  }
  const slug = reportSlug(report);
  const byId = new Map(report.findings.map((f) => [f.id, f]));

  let previousLog = null;
  if (existsSync(logFile)) {
    previousLog = readJsonFile(logFile, 'dismissed log', 1);
    if (!previousLog || !Array.isArray(previousLog.entries)) throw new CliError(`${show(logFile)} is not a dismissed log (no "entries" array)`, 1);
  }

  let next = report;
  const changes = [];

  if (values['apply-log']) {
    const result = applyPriorDismissals(report, previousLog);
    next = result.report;
    log(`Prior dismissals for ${oneLine(slug)} (${oneLine(report.meta?.feature ?? 'unknown feature')}) from ${show(logFile)}:`);
    if (!previousLog) log('  no log yet; nothing to apply');
    for (const a of result.applied) {
      const f = next.findings.find((x) => x.id === a.findingId);
      const reason = a.kind === 'intentional' ? f.signoff?.reason : f.dismissal?.reason;
      log(`  ${oneLine(a.findingId)} ${oneLine(a.kind)} (${oneLine(a.entryId)}) — ${quote(reason)}`);
    }
    for (const c of result.changed) {
      log(
        `  notice: ${oneLine(c.findingId)} matches ${oneLine(c.entryId)} (${oneLine(c.kind)}) but its values changed — ` +
          `expected ${quote(c.was.expectedValue)} → ${quote(c.now.expectedValue)}, actual ${quote(c.was.actualValue)} → ${quote(c.now.actualValue)}; left open`,
      );
    }
    log(`  re-applied ${result.applied.length}, changed ${result.changed.length} (left open)`);
    if (!result.applied.length) {
      if (values['dry-run']) log('[dry run] nothing written');
      return 0;
    }
  } else if (values.undo !== undefined) {
    for (const id of parseIds(values.undo, 'undo')) {
      let restored;
      try {
        ({ report: next, finding: restored } = undoDismissal(next, id));
      } catch (err) {
        throw usageError(oneLine(err.message));
      }
      changes.push({ findingId: id, action: 'undo' });
      log(`Undone ${oneLine(id)}: back to ${oneLine(restored.resolution)}`);
    }
  } else {
    let items;
    let defaultSource;
    if (values.id !== undefined) {
      const kind = normalizeKind(values.kind);
      if (!values.kind) throw usageError(`--kind is required with --id: ${DISMISS_KINDS.join(' | ')}`);
      if (!kind) throw usageError(`--kind must be one of ${DISMISS_KINDS.join(', ')} (got "${oneLine(values.kind)}")`);
      items = parseIds(values.id, 'id').map((findingId) => ({ findingId, kind, reason: (values.reason ?? '').trim(), by: null, date: null }));
      defaultSource = 'cli';
      if (!items[0].reason) {
        throw usageError(`--reason is required: say why ${items.map((i) => i.findingId).join(', ')} ${kind === 'intentional' ? 'is an accepted divergence' : kind === 'remove' ? 'should be removed from this QA' : 'is not an issue'} (e.g. --reason "1px anti-aliasing noise, not a real difference")`);
      }
    } else {
      let parsed;
      const fromFile = path.resolve(values.from);
      let content;
      try {
        content = readFileSync(fromFile, 'utf8');
      } catch (err) {
        throw usageError(`cannot read --from ${oneLine(values.from)}: ${err.code === 'ENOENT' ? 'file not found' : err.message}`);
      }
      try {
        parsed = parseDismissalsFile(content);
      } catch (err) {
        throw usageError(`--from ${oneLine(values.from)}: ${oneLine(err.message)}`);
      }
      if (parsed.slug && parsed.slug !== slug) warn(`dismissals are for "${oneLine(parsed.slug)}" but this report is "${oneLine(slug)}"`);
      if (parsed.reportGeneratedAt && parsed.reportGeneratedAt !== report.meta?.generatedAt) {
        warn(`dismissals were made on the report generated ${oneLine(parsed.reportGeneratedAt)}; this report was generated ${oneLine(report.meta?.generatedAt)}`);
      }
      items = parsed.items.map((item) => ({ ...item, by: item.by ?? values.by ?? parsed.decidedBy ?? null }));
      defaultSource = parsed.format === 'json' ? 'report-ui' : 'chat';
      const blank = items.filter((i) => !i.reason).map((i) => i.findingId);
      if (blank.length) throw usageError(`a reason is required for every dismissal; missing for ${blank.map(oneLine).join(', ')}`);
    }
    const unknown = items.filter((i) => !byId.has(i.findingId)).map((i) => i.findingId);
    if (unknown.length) throw usageError(`unknown finding id(s): ${unknown.map(oneLine).join(', ')}`);
    const source = values.source ?? defaultSource;
    const now = new Date().toISOString();
    for (const item of items) {
      const before = byId.get(item.findingId);
      try {
        ({ report: next } = applyDismissal(next, item.findingId, {
          kind: item.kind,
          reason: item.reason,
          by: item.by ?? values.by ?? null,
          date: item.date ?? now,
          source,
        }));
      } catch (err) {
        throw usageError(oneLine(err.message));
      }
      changes.push({ findingId: item.findingId, action: 'dismiss', source });
      const again = ['DISMISSED', 'INTENTIONAL'].includes(before.resolution) ? ' (updated)' : '';
      log(`${item.kind === 'intentional' ? 'Accepted' : 'Dismissed'} ${oneLine(item.findingId)} ${oneLine(item.kind)}${again} — ${quote(item.reason)}`);
    }
  }

  const { log: nextLog, stats } = upsertLogEntries(previousLog, next, changes);
  if (changes.length) log(`Dismissed log: ${stats.added} added, ${stats.updated} updated, ${stats.undone} undone`);
  if (values['dry-run']) {
    log('[dry run] report.json and the dismissed log not written');
    return 0;
  }
  writeJson(reportFile, next);
  if (changes.length) {
    writeJson(logFile, nextLog);
    writeText(mdFile, renderDismissedMarkdown(nextLog));
    log(`Wrote ${show(reportFile)}, ${show(logFile)} and ${show(mdFile)}`);
  } else {
    log(`Wrote ${show(reportFile)}`);
  }
  log('The next command recomputes the scorecard and validates the report.');
  log(`Next: ${scriptCommand('render-report.mjs')} --in ${shellArg(displayPath(reportFile))} --recompute --write-back${runId ? ` --run ${runId}` : ''}`);
  return 0;
}

runMain(import.meta.url, main);
