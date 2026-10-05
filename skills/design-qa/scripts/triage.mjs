#!/usr/bin/env node
// Record the person's triage in report.json: the listed findings are fixed now,
// every other triageable finding becomes debt (to be ticketed and logged), so every
// diff is either fixed or tracked.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CliError, displayPath, formatIssues, oneLine, parseCli, readJsonFile, runMain, scriptCommand, shellArg, usageError, writeJson } from './lib/args.mjs';
import { TRIAGE_SOURCES, computeScorecard, isTriageable, resolveOptions, scorecardHeadline } from './lib/ranking.mjs';
import { isRfc3339DateTime, validateConfig, validateReport } from './lib/schema-check.mjs';
import { assertRunOwnsDir, callerRunId } from './lib/run-lock.mjs';
import { applyTriage, buildTriage, recommendedFixIds, reportSlug, sameInstant, triageLists } from './lib/triage.mjs';

const HELP = `Record which findings get fixed now; everything else becomes debt.

Usage:
  node scripts/triage.mjs --report <report.json> --fix <ids> [options]
  node scripts/triage.mjs --report <report.json> --selection <selection.json> [options]
  node scripts/triage.mjs --report <report.json> --default [options]
  node scripts/triage.mjs --report <report.json> --ticket <id>=<key or URL> [--ticket …] [options]

Choose exactly one of:
  --fix <ids>              comma-separated finding ids to fix now (e.g. DQ-001,DQ-003);
                           "none" fixes nothing now (an empty value is an error, so an
                           unset variable never turns every finding into debt)
  --selection <file>       selection.json exported by report.html:
                           { feature, slug, reportGeneratedAt, fixNow: [ids], debt: [ids],
                             decidedBy, decidedAt }
  --default                the recommendation: the fix-now rank bucket and every blocker are
                           fixed now, the rest of the debt bucket becomes debt (use in CI)
  --ticket <id>=<ticket>   record the ticket created for a debt finding by other means than
                           jira-fetch.mjs --write (an Atlassian, Linear or GitHub MCP call):
                           DQ-004=ABC-456 (a Jira key: its URL is built from config
                           ticket.baseUrl, else from meta.ticket.url's site) or
                           DQ-004=https://acme.atlassian.net/browse/ABC-456 (Jira /browse/KEY,
                           Linear /issue/KEY, GitHub /issues/<n>). Repeatable. The finding must
                           be triaged "debt"; the triage itself is not changed

Options for --ticket:
  --provider <p>           jira | linear | github (default: from the URL's host, else jira)
  --replace                overwrite a ticket already recorded for the finding (otherwise a
                           different key is refused; the same key again changes nothing)

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
  --run <id>               this pass's run id (default: DESIGN_QA_RUN_ID); refused (exit 5)
                           when the report folder's run lock names another run
  --quiet                  only print warnings and errors
  -h, --help               show this help

Triageable findings are FIX_CODE findings with severity BLOCKER, WARNING or
DS_CANDIDATE (DISMISSED and INTENTIONAL findings never are). Listed ids become
"fix-now", every other triageable finding "debt". A BLOCKER can never be debt: unlisted
blockers stay fix-now (with a warning). Tickets already recorded for a finding are
kept. report.json (schemaVersion 2.0) is rewritten in place with the triage block and
a recomputed scorecard (unexplained, debt, loopClosed), then validated. Next: ticket the debt with
jira-fetch.mjs --tickets-from <report.json> (or an MCP, then --ticket), log it with debt-log.mjs,
and re-render. build-report.mjs keeps the triage and its ticket keys on every rebuild.

Exit codes: 0 ok · 1 invalid report (including not JSON) or write failure · 2 bad arguments,
report not found, a stale selection, or a --ticket for an unknown or non-debt finding (or a
report without a triage) · 5 another run owns the report folder`;

const ID_RE = /^DQ-\d{3,}$/;
const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;
export const TICKET_PROVIDERS = Object.freeze(['jira', 'linear', 'github']);

/**
 * One --ticket value → { findingId, provider, key, url }. "DQ-004=ABC-456" (a Jira or Linear
 * key; the URL comes from baseUrl, a site such as https://acme.atlassian.net) or
 * "DQ-004=<URL>" (Jira /browse/KEY, Linear /issue/KEY/…, GitHub /<owner>/<repo>/issues/<n>).
 * Throws Error with a readable message.
 */
export function parseTicketArg(value, { provider = null, baseUrl = null } = {}) {
  const m = /^\s*(DQ-\d{3,})\s*=\s*(\S+)\s*$/i.exec(String(value ?? ''));
  if (!m) throw new Error(`--ticket "${oneLine(value)}": expected <finding id>=<ticket key or URL>, e.g. DQ-004=ABC-456`);
  const findingId = m[1].toUpperCase();
  const ref = m[2];
  if (/^https?:\/\//i.test(ref)) {
    let u;
    try {
      u = new URL(ref);
    } catch {
      throw new Error(`--ticket ${findingId}: "${oneLine(ref)}" is not a URL`);
    }
    const host = u.hostname.toLowerCase();
    const p = provider ?? (host === 'github.com' ? 'github' : host === 'linear.app' || host.endsWith('.linear.app') ? 'linear' : 'jira');
    let key = null;
    if (p === 'github') {
      const g = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/.exec(u.pathname);
      key = g ? `${g[1]}/${g[2]}#${g[3]}` : null;
    } else {
      const k = (p === 'linear' ? /\/issue\/([A-Za-z][A-Za-z0-9_]*-\d+)/ : /\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)\/?$/).exec(u.pathname);
      key = k ? k[1].toUpperCase() : null;
    }
    if (!key) throw new Error(`--ticket ${findingId}: cannot read a ${p} issue key from ${oneLine(ref)} (expected ${p === 'github' ? '/<owner>/<repo>/issues/<n>' : p === 'linear' ? '/issue/KEY-1' : '/browse/KEY-1'})`);
    return { findingId, provider: p, key, url: `${u.origin}${u.pathname}` };
  }
  const key = ref.toUpperCase();
  if (!KEY_RE.test(key)) throw new Error(`--ticket ${findingId}: "${oneLine(ref)}" is neither an issue key like ABC-456 nor a URL`);
  const p = provider ?? 'jira';
  if (p === 'github') throw new Error(`--ticket ${findingId}: give the GitHub issue URL (https://github.com/<owner>/<repo>/issues/<n>)`);
  if (!baseUrl) throw new Error(`--ticket ${findingId}: no site to build the URL of ${key} from (config ticket.baseUrl, or meta.ticket.url): give the URL instead, e.g. ${findingId}=https://<site>/browse/${key}`);
  const base = baseUrl.replace(/\/+$/, '');
  return { findingId, provider: p, key, url: p === 'linear' ? `${base}/issue/${key}` : `${base}/browse/${key}` };
}

/**
 * Record tickets on debt triage items: [{ findingId, provider, key, url }]. A finding that is
 * not triaged "debt" is refused; a different ticket already recorded is refused unless
 * replace. Returns { report, recorded: [ids], unchanged: [ids] }; throws Error.
 */
export function recordTickets(report, tickets, { now = new Date().toISOString(), replace = false } = {}) {
  if (!report?.triage || !Array.isArray(report.triage.items)) throw new Error('the report has no triage block: record the triage first (the review, or triage.mjs --fix/--default)');
  const next = structuredClone(report);
  const ids = new Set((next.findings ?? []).map((f) => f.id));
  const recorded = [];
  const unchanged = [];
  const seen = new Set();
  for (const t of tickets) {
    if (seen.has(t.findingId)) throw new Error(`${t.findingId} is given twice`);
    seen.add(t.findingId);
    if (!ids.has(t.findingId)) throw new Error(`unknown finding id: ${t.findingId}`);
    const item = next.triage.items.find((i) => i.findingId === t.findingId);
    if (!item) throw new Error(`${t.findingId} is not triaged (not an open FIX_CODE finding): only debt gets a ticket`);
    if (item.decision !== 'debt') throw new Error(`${t.findingId} is triaged "${item.decision}", not debt: only debt gets a ticket`);
    if (item.ticket && item.ticket.key === t.key && item.ticket.provider === t.provider) {
      unchanged.push(t.findingId);
      continue;
    }
    if (item.ticket && !replace) throw new Error(`${t.findingId} already has ticket ${item.ticket.key}: pass --replace to record ${t.key} instead`);
    item.ticket = { provider: t.provider, key: t.key, url: t.url, createdAt: now };
    recorded.push(t.findingId);
  }
  return { report: next, recorded, unchanged };
}

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
    ticket: { type: 'string', multiple: true },
    provider: { type: 'string' },
    replace: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    run: { type: 'string' },
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
  const modes = [values.fix !== undefined, Boolean(values.selection), Boolean(values.default), Boolean(values.ticket)].filter(Boolean).length;
  if (modes !== 1) throw usageError('choose exactly one of --fix <ids>, --selection <selection.json>, --default or --ticket <id>=<key>');
  if ((values.provider !== undefined || values.replace) && !values.ticket) throw usageError('--provider and --replace go with --ticket');
  if (values.provider !== undefined && !TICKET_PROVIDERS.includes(values.provider)) throw usageError(`--provider must be one of ${TICKET_PROVIDERS.join(', ')} (got "${oneLine(values.provider)}")`);
  if (values['allow-stale'] && !values.selection) throw usageError('--allow-stale goes with --selection');
  if (values.source && !TRIAGE_SOURCES.includes(values.source)) {
    throw usageError(`--source must be one of ${TRIAGE_SOURCES.join(', ')} (got "${oneLine(values.source)}")`);
  }

  const reportFile = path.resolve(values.report);
  const runId = callerRunId(values.run);
  if (!values['dry-run'] || runId) assertRunOwnsDir(path.dirname(reportFile), { runId });
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

  if (values.ticket) {
    // Tickets created through an MCP (or by hand): recorded on the debt items, nothing else changes.
    const site = (u) => {
      const m = typeof u === 'string' ? /^(https?:\/\/[^/]+)\/(?:browse|issue)\//.exec(u) : null;
      return m ? m[1] : null;
    };
    const baseUrl = (typeof config.ticket?.baseUrl === 'string' && /^https?:\/\//.test(config.ticket.baseUrl) ? config.ticket.baseUrl : null) ?? site(report.meta?.ticket?.url);
    let result;
    try {
      const tickets = values.ticket.map((v) => parseTicketArg(v, { provider: values.provider ?? null, baseUrl }));
      result = recordTickets(report, tickets, { replace: Boolean(values.replace) });
    } catch (err) {
      throw usageError(oneLine(err.message));
    }
    const next = result.report;
    next.scorecard = computeScorecard(next, options);
    const after = validateReport(next, { options });
    if (!after.valid) throw new CliError(`the report with the tickets does not validate:\n${formatIssues(after.errors)}`, 1);
    const byFinding = new Map(next.triage.items.map((i) => [i.findingId, i]));
    for (const id of result.recorded) log(`Recorded ${oneLine(id)} → ${oneLine(byFinding.get(id).ticket.key)} (${oneLine(byFinding.get(id).ticket.provider)}) ${oneLine(byFinding.get(id).ticket.url)}`);
    for (const id of result.unchanged) log(`${oneLine(id)} already has ${oneLine(byFinding.get(id).ticket.key)}; unchanged`);
    const sc = next.scorecard;
    log(`  Debt ${sc.debt.ticketed}/${sc.debt.count} ticketed · unexplained ${oneLine(sc.unexplained)} · ${oneLine(scorecardHeadline(sc))}`);
    if (values['dry-run']) {
      log('[dry run] report.json not written');
      return 0;
    }
    if (result.recorded.length) {
      writeJson(reportFile, next);
      log(`Wrote ${oneLine(displayPath(reportFile))}`);
    }
    const cfg = values.config ? ` --config ${shellArg(displayPath(path.resolve(values.config)))}` : '';
    log(`Do: After the next command, re-render the report: ${scriptCommand('render-report.mjs')} --in ${shellArg(displayPath(reportFile))} --recompute --write-back${cfg}${runId ? ` --run ${runId}` : ''}`);
    log(`Next: ${scriptCommand('debt-log.mjs')} --report ${shellArg(displayPath(reportFile))}${cfg}${runId ? ` --run ${runId}` : ''}`);
    return 0;
  }

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
  log(`  Verdict ${oneLine(scorecardHeadline(sc))} · unexplained ${oneLine(sc.unexplained)} · loop ${sc.loopClosed ? 'closed' : 'open'}`);
  if (values['dry-run']) {
    log('[dry run] report.json not written');
    return 0;
  }
  writeJson(reportFile, next);
  log(`Wrote ${oneLine(displayPath(reportFile))}`);
  if (needTickets) {
    log('Do: The next command previews the tickets; then run it with --write, then debt-log.mjs and render-report.mjs.');
    log(`Next: ${scriptCommand('jira-fetch.mjs')} --tickets-from ${shellArg(displayPath(reportFile))}${runId ? ` --run ${runId}` : ''}`);
  }
  return 0;
}

runMain(import.meta.url, main);
