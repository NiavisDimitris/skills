#!/usr/bin/env node
// Keep the design-debt log (JSON + Markdown) in step with triaged reports: one
// entry per debt item, keyed by report slug + finding id; entries whose finding is
// no longer open in a newer report are marked resolved.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CliError, displayPath, parseCli, readJsonFile, runMain, usageError, writeJson, writeText } from './lib/args.mjs';
import { DASH, sourceLocation } from './lib/fixplan.mjs';
import { compareIds, isOpen, triageIndex } from './lib/ranking.mjs';
import { validateConfig, validateReport } from './lib/schema-check.mjs';
import { kebab, ownerOf, reportSlug } from './lib/triage.mjs';

const HELP = `Update the design-debt log from a triaged report.

Usage:
  node scripts/debt-log.mjs --report <report.json> [--log <design-debt.json>] [--md <design-debt.md>]
      [--config design-qa.config.json] [--quiet]

Options:
  --report <file>   triaged report.json (see triage.mjs)
  --log <file>      JSON log (default: design-debt.json next to the feature folder, i.e.
                    qa-reports/design-debt.json for qa-reports/<slug>/report.json)
  --md <file>       Markdown log (default: the same path with .md; config report.debtLog
                    when --config is given)
  --config <file>   design-qa.config.json (report.debtLog: path of the Markdown log,
                    relative to the config file)
  --quiet           only print warnings and errors
  -h, --help        show this help

Every triage item decided "debt" is upserted as { since, slug, parentTicket, findingId,
severity, resolution, owner, title, where, ticket, status: "open", reportPath }, keyed
by slug + findingId. An open entry of the same slug whose finding is no longer open
in this (newer) report becomes status "resolved" with resolvedAt. Reports older than
an entry's last update never change it, and re-running with the same report changes
nothing. The Markdown log is a table: Status, Since, Feature, Finding, Severity, Owner,
Title, Where, Ticket.

Exit codes: 0 ok · 1 invalid report or log · 2 bad arguments`;

const time = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isNaN(t) ? null : t;
};

/** Where to look: the Figma layer for design debt, file:line and selector for code debt. */
export function whereOf(finding) {
  const figma = finding?.element?.figmaLayerPath || finding?.element?.figmaNodeId || null;
  const code = [sourceLocation(finding), finding?.element?.selector].filter((v) => v && v !== DASH).join(' · ');
  if (ownerOf(finding) === 'design') return figma ? `Figma: ${figma}` : code || DASH;
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
 * Pure update: returns { log, stats: { added, updated, resolved, reopened, skippedOlder } }.
 * reportPath is stored as given (callers pass it relative to the log file).
 */
export function updateDebtLog(previous, report, { reportPath = null } = {}) {
  const entries = Array.isArray(previous?.entries) ? previous.entries.map((e) => ({ ...e })) : [];
  const slug = reportSlug(report);
  const generatedAt = report?.meta?.generatedAt ?? null;
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  const byId = new Map(findings.map((f) => [f.id, f]));
  const index = triageIndex(report);
  const key = (s, id) => `${s}::${id}`;
  const byKey = new Map(entries.map((e) => [key(e.slug, e.findingId), e]));
  const newer = (e) => time(e.updatedAt) === null || time(generatedAt) === null || time(generatedAt) >= time(e.updatedAt);
  const stats = { added: 0, updated: 0, resolved: 0, reopened: 0, skippedOlder: 0 };
  const touched = new Set();

  for (const [findingId, item] of index) {
    if (item.decision !== 'debt') continue;
    const f = byId.get(findingId);
    if (!f) continue;
    const k = key(slug, findingId);
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
      severity: f.severity,
      resolution: f.resolution,
      owner: ownerOf(f),
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
    const f = byId.get(e.findingId);
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

const cell = (v) => String(v ?? DASH).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|') || DASH;
const day = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(String(iso ?? '')) ? String(iso).slice(0, 10) : DASH);

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
    const status = e.status === 'resolved' ? `resolved ${day(e.resolvedAt)}` : 'open';
    const feature = e.feature && e.slug !== kebab(e.feature) ? `${e.feature} (${e.slug})` : e.feature || e.slug;
    const ticket = e.ticket?.key ? (e.ticket.url ? `[${e.ticket.key}](${e.ticket.url})` : e.ticket.key) : DASH;
    lines.push(
      `| ${status} | ${day(e.since)} | ${cell(feature)} | ${cell(e.findingId)} | ${cell(e.severity)} | ${cell(e.owner)} | ${cell(e.title)} | ${cell(e.where)} | ${cell(ticket)} |`,
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
  const report = readJsonFile(reportFile, 'report', 2);
  const check = validateReport(report, { skipScorecard: true, skipRanks: true });
  if (!check.valid) {
    throw new CliError(`${displayPath(reportFile)} is not a valid report:\n${check.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`, 1);
  }
  if (!report.triage) warn('this report has no triage block, so there is no debt to log (run triage.mjs first); only resolutions are applied');

  let configMd = null;
  if (values.config) {
    const configFile = path.resolve(values.config);
    const config = readJsonFile(configFile, 'config', 2);
    const cv = validateConfig(config);
    if (!cv.valid) throw usageError(`--config is invalid:\n${cv.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
    if (typeof config.report?.debtLog === 'string') configMd = path.resolve(path.dirname(configFile), config.report.debtLog);
  }
  const defaultBase = path.join(path.dirname(path.dirname(reportFile)), 'design-debt');
  const mdFile = path.resolve(values.md ?? (values.log ? withExtension(values.log, '.md') : configMd ?? `${defaultBase}.md`));
  const logFile = path.resolve(values.log ?? withExtension(mdFile, '.json'));

  let previous = null;
  if (existsSync(logFile)) {
    previous = readJsonFile(logFile, 'debt log', 1);
    if (!previous || !Array.isArray(previous.entries)) throw new CliError(`${displayPath(logFile)} is not a design-debt log (no "entries" array)`, 1);
  }
  const reportPath = path.relative(path.dirname(logFile), reportFile).split(path.sep).join('/');
  const { log: next, stats } = updateDebtLog(previous, report, { reportPath });
  if (stats.skippedOlder) warn(`${stats.skippedOlder} entr${stats.skippedOlder === 1 ? 'y was' : 'ies were'} updated by a newer report and left unchanged`);
  writeJson(logFile, next);
  writeText(mdFile, renderDebtLog(next));
  const open = next.entries.filter((e) => e.status === 'open').length;
  log(
    `Debt log for ${reportSlug(report)}: ${stats.added} added, ${stats.updated} updated, ${stats.reopened} reopened, ${stats.resolved} resolved — ` +
      `open ${open} · resolved ${next.entries.length - open}`,
  );
  log(`Wrote ${displayPath(logFile)} and ${displayPath(mdFile)}`);
  return 0;
}

runMain(import.meta.url, main);
