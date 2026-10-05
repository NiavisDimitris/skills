#!/usr/bin/env node
// Keep the design-debt log (JSON + Markdown) in step with triaged reports: one
// entry per debt item, keyed by report slug + finding fingerprint (finding ids are
// renumbered every pass); entries whose finding is no longer open in a newer report
// are marked resolved.
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  CliError,
  assertInsideDir,
  checkLedgerPaths,
  displayPath,
  formatIssues,
  oneLine,
  parseCli,
  readJsonFile,
  runMain,
  usageError,
  withFileLocks,
  writeJson,
  writeText,
} from './lib/args.mjs';
import { DISMISSIBLE_SEVERITIES, fingerprint, mdCell } from './lib/dismissals.mjs';
import { DASH, sourceLocation } from './lib/fixplan.mjs';
import { compareIds, isOpen, triageIndex } from './lib/ranking.mjs';
import { resolveReviewConfig } from './lib/review-context.mjs';
import { assertRunOwnsDir, callerRunId } from './lib/run-lock.mjs';
import { validateConfig, validateReport } from './lib/schema-check.mjs';
import { DEBT_OWNER, kebab, reportSlug } from './lib/triage.mjs';

const HELP = `Update the design-debt log from a triaged report.

Usage:
  node scripts/debt-log.mjs --report <report.json> [--log <design-debt.json>] [--md <design-debt.md>]
      [--config design-qa.config.json] [--run <id>] [--quiet]

Options:
  --report <file>   triaged report.json (see triage.mjs)
  --log <file>      JSON log (default: design-debt.json next to the feature folder, i.e.
                    qa-reports/design-debt.json for qa-reports/<slug>/report.json)
  --md <file>       Markdown log (default: the same path with .md; else config
                    report.debtLog)
  --config <file>   design-qa.config.json (report.debtLog: path of the Markdown log,
                    relative to the config file and inside its folder, symlinks
                    followed). Default: the rendered report's config, else the nearest
                    ancestor design-qa.config.json
  --run <id>        your run id (or DESIGN_QA_RUN_ID); needed while the report's run
                    is not finished
  --quiet           only print warnings and errors
  -h, --help        show this help

Every triage item decided "debt" is upserted as { since, slug, parentTicket, findingId,
fingerprint, severity, resolution, owner ("engineering": the code must match the
design), title, where, ticket, status: "open", reportPath }, keyed by slug +
fingerprint (ledger|state|selector|property, as the dismissed log; "#2", "#3"… for
repeats in one report). Finding ids are renumbered every pass, so findingId is only
shown; a ticket stays with its fingerprint. An open entry of the same slug whose
finding is no longer open in this (newer) report becomes status "resolved" with
resolvedAt. An older log's entry without a fingerprint is matched by finding id only
when the title is the same too; otherwise a newer report resolves it with
"unmatched": true (its finding cannot be identified any more). Reports older than an
entry's last update never change it, and re-running with the same report changes
nothing. The JSON and Markdown paths must differ (the Markdown one ends in .md). The
log is locked while it is read and rewritten, and never written through a symlink.
The Markdown log is a table: Status, Since, Feature, Finding, Severity, Owner, Title,
Where, Ticket.

Exit codes: 0 ok · 1 invalid report or log · 2 bad arguments`;

const time = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isNaN(t) ? null : t;
};

/** Where to look: file:line and selector in the code, else the design layer. */
export function whereOf(finding) {
  const figma = finding?.element?.figmaLayerPath || finding?.element?.figmaNodeId || null;
  const code = [sourceLocation(finding), finding?.element?.selector].filter((v) => v && v !== DASH).join(' · ');
  return code || (figma ? `Figma: ${figma}` : DASH);
}

function sortEntries(entries) {
  return [...entries].sort(
    (a, b) =>
      (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) ||
      (time(a.since) ?? 0) - (time(b.since) ?? 0) ||
      String(a.slug).localeCompare(String(b.slug)) ||
      compareIds(a.findingId, b.findingId),
  );
}

/**
 * Each finding's debt key in this report: its fingerprint, with "#2", "#3"… for the
 * second and later findings that share one (counted, in report order, over the
 * findings that can be debt: BLOCKER, WARNING, DS_CANDIDATE). findingId → key.
 */
export function debtKeys(report) {
  const keys = new Map();
  const seen = new Map();
  for (const f of Array.isArray(report?.findings) ? report.findings : []) {
    if (!f || !DISMISSIBLE_SEVERITIES.includes(f.severity)) continue;
    const fp = fingerprint(f);
    const n = (seen.get(fp) ?? 0) + 1;
    seen.set(fp, n);
    if (!keys.has(f.id)) keys.set(f.id, n === 1 ? fp : `${fp}#${n}`);
  }
  return keys;
}

/**
 * Pure update: returns { log, stats: { added, updated, resolved, reopened, skippedOlder } }.
 * reportPath is stored as given (callers pass it relative to the log file). Entries
 * are keyed by slug + fingerprint (debtKeys); see the help text for older entries.
 */
export function updateDebtLog(previous, report, { reportPath = null } = {}) {
  const entries = Array.isArray(previous?.entries) ? previous.entries.map((e) => ({ ...e })) : [];
  const slug = reportSlug(report);
  const generatedAt = report?.meta?.generatedAt ?? null;
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  const byId = new Map(findings.map((f) => [f.id, f]));
  const keys = debtKeys(report);
  const byFp = new Map([...keys].map(([id, fp]) => [fp, byId.get(id)]));
  const index = triageIndex(report);
  const newer = (e) => time(e.updatedAt) === null || time(generatedAt) === null || time(generatedAt) >= time(e.updatedAt);
  const stats = { added: 0, updated: 0, resolved: 0, reopened: 0, skippedOlder: 0 };

  // Entries from before fingerprint keying: adopt the fingerprint of the finding with the
  // same id AND title in this (newer) report; unmatched ones keep a key of their own.
  const key = (s, fp) => `${s}::${fp}`;
  const byKey = new Map();
  entries.forEach((e, i) => {
    if (typeof e.fingerprint !== 'string' && e.slug === slug && newer(e)) {
      const f = byId.get(e.findingId);
      if (f && keys.has(f.id) && f.title === e.title) e.fingerprint = keys.get(f.id);
    }
    const k = typeof e.fingerprint === 'string' ? key(e.slug, e.fingerprint) : `legacy::${i}`;
    if (!byKey.has(k)) byKey.set(k, e);
    else byKey.set(`dup::${i}`, e); // two entries for one key (hand-edited log): keep both
  });
  const touched = new Set();

  for (const [findingId, item] of index) {
    if (item.decision !== 'debt') continue;
    const f = byId.get(findingId);
    if (!f || !keys.has(findingId)) continue;
    const fp = keys.get(findingId);
    const k = key(slug, fp);
    const existing = byKey.get(k);
    if (existing && !newer(existing)) {
      stats.skippedOlder += 1;
      continue;
    }
    const entry = {
      since: existing?.since ?? report.triage?.decidedAt ?? generatedAt,
      slug,
      feature: report.meta?.feature ?? null,
      parentTicket: report.meta?.ticket?.key ?? null,
      findingId,
      fingerprint: fp,
      severity: f.severity,
      resolution: f.resolution,
      owner: DEBT_OWNER,
      title: f.title,
      where: whereOf(f),
      ticket: item.ticket ?? existing?.ticket ?? null,
      status: 'open',
      reportPath,
      updatedAt: generatedAt,
    };
    if (!existing) stats.added += 1;
    else if (existing.status === 'resolved') stats.reopened += 1;
    else if (JSON.stringify({ ...existing, updatedAt: null }) !== JSON.stringify({ ...entry, updatedAt: null })) stats.updated += 1;
    byKey.set(k, entry);
    touched.add(k);
  }

  for (const [k, e] of byKey) {
    if (e.slug !== slug || e.status !== 'open' || touched.has(k)) continue;
    if (!newer(e)) {
      stats.skippedOlder += 1;
      continue;
    }
    if (typeof e.fingerprint !== 'string') {
      // An older entry whose id now names another finding (or none): it cannot be followed.
      byKey.set(k, { ...e, status: 'resolved', resolvedAt: generatedAt, updatedAt: generatedAt, reportPath, unmatched: true });
      stats.resolved += 1;
      continue;
    }
    const f = byFp.get(e.fingerprint);
    if (!f || !isOpen(f)) {
      byKey.set(k, { ...e, status: 'resolved', resolvedAt: generatedAt, updatedAt: generatedAt, reportPath });
      stats.resolved += 1;
    }
  }

  const all = sortEntries([...byKey.values()]);
  const stamps = [previous?.updatedAt, generatedAt].filter((v) => time(v) !== null);
  const updatedAt = stamps.sort((a, b) => time(a) - time(b)).pop() ?? null;
  return { log: { version: 1, updatedAt, entries: all }, stats };
}

const cell = mdCell; // one line, \ and | escaped
const day = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(String(iso ?? '')) ? String(iso).slice(0, 10) : DASH);
const TICKET_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const LINK_URL_RE = /^https?:\/\/[^\s()<>[\]|\\]+$/i;

/** The Ticket cell: [KEY](url) for a plain key and an http(s) URL, else the key as text. */
function ticketCell(ticket) {
  if (!ticket?.key) return DASH;
  const key = String(ticket.key);
  if (TICKET_KEY_RE.test(key) && typeof ticket.url === 'string' && LINK_URL_RE.test(ticket.url)) return `[${key}](${ticket.url})`;
  return cell(key);
}

/** The Markdown log: title, "open n · resolved m", then one table row per entry. */
export function renderDebtLog(log) {
  const entries = Array.isArray(log?.entries) ? log.entries : [];
  const open = entries.filter((e) => e.status === 'open').length;
  const resolved = entries.filter((e) => e.status === 'resolved').length;
  const lines = [
    '# Design debt log',
    '',
    `open ${open} · resolved ${resolved}`,
    '',
    '| Status | Since | Feature | Finding | Severity | Owner | Title | Where | Ticket |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const e of entries) {
    const status = e.status === 'resolved' ? `resolved ${day(e.resolvedAt)}${e.unmatched ? ' (unmatched)' : ''}` : 'open';
    const feature = e.feature && e.slug !== kebab(e.feature) ? `${e.feature} (${e.slug})` : e.feature || e.slug;
    lines.push(
      `| ${status} | ${day(e.since)} | ${cell(feature)} | ${cell(e.findingId)} | ${cell(e.severity)} | ${cell(e.owner)} | ${cell(e.title)} | ${cell(e.where)} | ${ticketCell(e.ticket)} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function withExtension(file, ext) {
  return file.replace(/\.(json|md)$/i, '') + ext;
}

async function main(argv) {
  const { values } = parseCli(argv, {
    report: { type: 'string' },
    log: { type: 'string' },
    md: { type: 'string' },
    config: { type: 'string' },
    run: { type: 'string' },
    quiet: { type: 'boolean' },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const log = values.quiet ? () => {} : (msg) => console.log(msg);
  const warn = (msg) => console.error(`warning: ${msg}`);
  if (!values.report) throw usageError('--report <report.json> is required (see --help)');

  const reportFile = path.resolve(values.report);
  // Only the run that owns the report folder logs its debt (a finished run's report needs no id).
  assertRunOwnsDir(path.dirname(reportFile), { runId: callerRunId(values.run) });
  const report = readJsonFile(reportFile, 'report', 2);
  const check = validateReport(report, { skipScorecard: true, skipRanks: true });
  if (!check.valid) {
    throw new CliError(`${oneLine(displayPath(reportFile))} is not a valid report:\n${formatIssues(check.errors)}`, 1);
  }
  if (!report.triage) warn('this report has no triage block, so there is no debt to log (run triage.mjs first); only resolutions are applied');

  // The same configuration apply-decisions.mjs uses: --config, else the rendered report's, else the nearest ancestor's.
  let configMd = null;
  const configFile = resolveReviewConfig(reportFile, { explicit: values.config, generatedAt: report.meta?.generatedAt });
  if (configFile) {
    const config = readJsonFile(configFile, 'config', 2);
    const cv = validateConfig(config);
    if (!cv.valid) throw usageError(`${values.config ? '--config' : oneLine(displayPath(configFile))} is invalid:\n${formatIssues(cv.errors)}`);
    if (typeof config.report?.debtLog === 'string') configMd = path.resolve(path.dirname(configFile), config.report.debtLog);
  }
  const defaultBase = path.join(path.dirname(path.dirname(reportFile)), 'design-debt');
  const fromConfig = values.md === undefined && values.log === undefined && configMd !== null;
  const mdFile = path.resolve(values.md ?? (values.log ? withExtension(values.log, '.md') : configMd ?? `${defaultBase}.md`));
  const logFile = path.resolve(values.log ?? withExtension(mdFile, '.json'));
  checkLedgerPaths(logFile, mdFile, `debt log${fromConfig ? ' (config report.debtLog)' : ''}`);
  if (fromConfig) {
    // A path from a (possibly committed) config stays inside the config's folder, symlinks
    // followed; --md / --log typed by the user are taken as given.
    for (const file of [mdFile, logFile]) assertInsideDir(path.dirname(configFile), file, 'config report.debtLog');
  }

  const reportPath = path.relative(path.dirname(logFile), reportFile).split(path.sep).join('/');
  const { next, stats } = withFileLocks([logFile], () => {
    let previous = null;
    if (existsSync(logFile)) {
      previous = readJsonFile(logFile, 'debt log', 1);
      if (!previous || !Array.isArray(previous.entries)) throw new CliError(`${oneLine(displayPath(logFile))} is not a design-debt log (no "entries" array)`, 1);
    }
    const { log: updated, stats: counts } = updateDebtLog(previous, report, { reportPath });
    writeJson(logFile, updated);
    writeText(mdFile, renderDebtLog(updated));
    return { next: updated, stats: counts };
  });
  if (stats.skippedOlder) warn(`${stats.skippedOlder} entr${stats.skippedOlder === 1 ? 'y was' : 'ies were'} updated by a newer report and left unchanged`);
  const open = next.entries.filter((e) => e.status === 'open').length;
  log(
    `Debt log for ${oneLine(reportSlug(report))}: ${stats.added} added, ${stats.updated} updated, ${stats.reopened} reopened, ${stats.resolved} resolved — ` +
      `open ${open} · resolved ${next.entries.length - open}`,
  );
  log(`Wrote ${oneLine(displayPath(logFile))} and ${oneLine(displayPath(mdFile))}`);
  return 0;
}

runMain(import.meta.url, main);
