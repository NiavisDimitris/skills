#!/usr/bin/env node
// Fetch a Jira issue into ticket.json (acceptance criteria, expected behaviours,
// Figma / preview / PR links, branches) and, only with --write, post a comment,
// create sub-tasks from a fix plan's debt list, or create one ticket per untracked
// debt item of a triaged report (--tickets-from) and record it in report.json.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CliError, displayPath, formatIssues, oneLine, parseCli, readJsonFile, runMain, scriptCommand, usageError, writeJson } from './lib/args.mjs';
import { textToAdf } from './lib/adf.mjs';
import { DASH, parseDebtItems, sourceLocation } from './lib/fixplan.mjs';
import { apiBaseUrl, describeUrl, fetchWithRetry, readJsonResponse, retryMessage } from './lib/http.mjs';
import { computeScorecard, resolveOptions, triageIndex } from './lib/ranking.mjs';
import { shellArg } from './lib/review-context.mjs';
import { validateConfig, validateReport } from './lib/schema-check.mjs';
import { assertRunOwnsDir, callerRunId } from './lib/run-lock.mjs';
import { normalizeTicketKey } from './lib/target-url.mjs';
import { buildJiraTicket, issueBaseUrl, issueFromSaved, remoteLinksFromSaved } from './lib/ticket-extract.mjs';
import { DEBT_OWNER, triageLists } from './lib/triage.mjs';

const HELP = `Fetch a Jira issue for design QA, or write results back to it.

Usage:
  node scripts/jira-fetch.mjs --from-issue <saved-issue.json> [--remote-links <file>] [--site <url>]
      [--issue <KEY>] --out <dir>
  node scripts/jira-fetch.mjs --issue <KEY> --out <dir>
  node scripts/jira-fetch.mjs --issue <KEY> --comment <file> [--write]
  node scripts/jira-fetch.mjs --issue <KEY> --subtasks <report-fixplan.md> [--write] [--issuetype Sub-task]
  node scripts/jira-fetch.mjs --tickets-from <report.json> [--parent KEY] [--project KEY]
      [--issuetype Sub-task|Task] [--labels design-qa,design-debt] [--config <file>] [--write] [--run <id>]

In an interactive session read the issue with the Atlassian MCP (getJiraIssue, or your
host's equivalent), save the result as returned and convert it with --from-issue: no
credentials, the same ticket.json as the REST path. --issue <KEY> --out is for CI and
hosts without that MCP (it needs JIRA_* credentials).

Options:
  --from-issue <file>  a saved getJiraIssue result (the issue JSON, the tool-result
                       envelope or a JSON string); writes <out>/ticket.json, no network
  --remote-links <f>   a saved getJiraIssueRemoteIssueLinks result (Figma links often live
                       there); with --from-issue
  --site <url>         the Jira site (https://your-site.atlassian.net) for ticket.url when
                       the saved issue has no "self" link; with --from-issue
  --issue <KEY>        issue key, e.g. ABC-123 (with --from-issue: checked against the file)
  --out <dir>          write <dir>/ticket.json (required unless --comment/--subtasks)
  --comment <file>     post the file's text as a comment (one paragraph per line)
  --subtasks <file>    create one sub-task per "## Debt" bullet of a fix plan
                       (skips DQ ids that already have a sub-task)
  --issuetype <name>   issue type for --subtasks / --tickets-from (default "Sub-task" with a
                       parent, "Task" without)
  --tickets-from <f>   one ticket per triage "debt" item of report.json that has no ticket
                       yet: summary "[Design debt] <title>", a description with severity,
                       owner, state, where, expected vs actual, fix, evidence and the finding
                       id; created under --parent (default: the report's Jira ticket, as a
                       Sub-task) or in --project as a Task. With --write the tickets are
                       written back into report.json and its scorecard is recomputed.
  --parent <KEY>       parent issue for --tickets-from (default: meta.ticket.key)
  --project <KEY>      project for --tickets-from when there is no parent
  --labels <a,b>       labels for --tickets-from (default design-qa,design-debt)
  --config <file>      design-qa.config.json: ticket.debt { project, issueType, parent,
                       labels } defaults and pixel-diff tolerances for the scorecard
  --write              actually post / create. Without it, --comment, --subtasks and
                       --tickets-from only print what would be sent (dry run)
  --run <id>           your run id (or DESIGN_QA_RUN_ID): --tickets-from --write into a
                       report folder whose run is not finished needs it
  --quiet              only print errors
  -h, --help           show this help

Environment:
  JIRA_BASE_URL        e.g. https://your-site.atlassian.net (https:// required; http:// only
                       for localhost)
  JIRA_EMAIL           Atlassian account email
  JIRA_API_TOKEN       API token (id.atlassian.com → Security → API tokens)

ticket.json: { provider, key, url, title, status, description (plain text from ADF),
acceptanceCriteria, expectedBehaviors [{ acRef, text, state, trigger }], figmaUrls,
prototypeUrls, previewUrls, prUrls, otherUrls, branches, attachments, fetchedAt }. Links are read
from the description, comments and remote links; previewUrlSources maps each preview URL to
where it was found (description, comment or remote-link).

Reads (GET) are retried on HTTP 429/5xx and network errors; writes (comments, issues) only
on HTTP 429 or when no connection could be made, so nothing is posted twice. Each request
times out after 30 s (DESIGN_QA_HTTP_TIMEOUT_MS, in ms). Credentials are only sent to
JIRA_BASE_URL: a redirect to another host is refused.

Exit codes: 0 ok · 1 error (issue not found, request failed) · 2 bad arguments ·
6 authentication (credentials missing or rejected)`;

// Warnings quote Jira and report text: always one line.
const warn = (msg) => console.error(`warning: ${oneLine(msg)}`);

/**
 * JSON for the terminal: JSON.stringify escapes line breaks inside strings but not
 * U+0085, U+2028, U+2029 or the C1 controls, which some readers treat as line breaks.
 */
const printableJson = (value) => JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** A text file shown as a quoted preview: every line prefixed, so none starts a line of its own. */
const quotedLines = (text) =>
  text
    .split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/)
    .map((l) => `  | ${l.replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, ' ')}`)
    .join('\n');

function credentials() {
  const base = process.env.JIRA_BASE_URL;
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  const missing = [['JIRA_BASE_URL', base], ['JIRA_EMAIL', email], ['JIRA_API_TOKEN', token]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    // One line, so an agent does not burn calls: the MCP path needs no credentials.
    throw new CliError(
      `no Jira credentials (${missing.join(', ')} not set): read the issue with the Atlassian MCP (getJiraIssue) and run --from-issue <saved.json> --out <dir>, or ask the user to paste the ticket; --issue is for CI`,
      6,
    );
  }
  return { base: apiBaseUrl(base, 'JIRA_BASE_URL'), auth: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` };
}

function makeApi({ base, auth }) {
  return async function api(method, apiPath, body, label) {
    const res = await fetchWithRetry(
      `${base}${apiPath}`,
      {
        method,
        headers: { Authorization: auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      },
      // sameOrigin: never follow a redirect off JIRA_BASE_URL with the credentials.
      { label, sameOrigin: true, onRetry: (info) => warn(retryMessage(label, info)) },
    );
    if (res.status === 401 || res.status === 403) {
      throw new CliError(
        `Jira rejected the credentials (HTTP ${res.status}) for ${label}. Check JIRA_EMAIL / JIRA_API_TOKEN (an API token, not a password) and that the account can see the issue.`,
        6,
      );
    }
    return res;
  };
}

/** Write <out>/ticket.json and print its summary. */
function writeTicket(ticket, out, log) {
  const file = path.join(path.resolve(out), 'ticket.json');
  writeJson(file, ticket);
  // Ticket text is written by anyone who can edit the issue: every value folded to one line.
  log(`${oneLine(ticket.key)}: ${oneLine(ticket.title ?? '(no title)')} [${oneLine(ticket.status ?? 'no status')}]`);
  log(`  ${ticket.acceptanceCriteria.length} acceptance criteria · states: ${[...new Set(ticket.expectedBehaviors.map((b) => oneLine(b.state)).filter(Boolean))].join(', ') || 'none'}`);
  log(`  Figma: ${ticket.figmaUrls.length} · prototype: ${ticket.prototypeUrls.length} · preview: ${ticket.previewUrls.length} · PRs: ${ticket.prUrls.length} · branches: ${ticket.branches.map(oneLine).join(', ') || 'none'}`);
  log(`Wrote ${oneLine(displayPath(file))}`);
}

/** --from-issue: ticket.json from a saved Atlassian MCP getJiraIssue result (no network, no credentials). */
function fromSavedIssue(values, log) {
  for (const flag of ['comment', 'subtasks', 'tickets-from', 'write', 'parent', 'project', 'labels', 'config', 'issuetype', 'run']) {
    if (values[flag]) throw usageError(`--from-issue only writes ticket.json (no --${flag})`);
  }
  if (!values.out) throw usageError('--from-issue needs --out <dir>');
  const readText = (file, label) => {
    try {
      return readFileSync(file, 'utf8');
    } catch (err) {
      throw usageError(`cannot read ${label} ${oneLine(file)}: ${err.code === 'ENOENT' ? 'file not found' : oneLine(err.message)}`);
    }
  };
  let issue;
  let remoteLinks = [];
  try {
    issue = issueFromSaved(readText(values['from-issue'], '--from-issue'));
    if (values['remote-links']) remoteLinks = remoteLinksFromSaved(readText(values['remote-links'], '--remote-links'));
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw usageError(`${oneLine(err.message)}`);
  }
  const key = normalizeTicketKey(issue.key);
  if (!key) throw usageError(`--from-issue ${oneLine(values['from-issue'])}: the issue has no key like ABC-123`);
  if (values.issue && normalizeTicketKey(values.issue) !== key) {
    throw usageError(`--issue ${oneLine(values.issue)} does not match the saved issue ${key}`);
  }
  const site = values.site ? apiBaseUrl(values.site, '--site') : issueBaseUrl(issue);
  const ticket = buildJiraTicket(issue, { baseUrl: site ?? '', remoteLinks });
  writeTicket(ticket, values.out, log);
  if (!ticket.url) log('  no Jira site in the saved issue: pass --site https://<your-site>.atlassian.net for ticket.url');
  return 0;
}

async function errorText(res) {
  try {
    const json = JSON.parse(await res.text());
    return oneLine([...(json.errorMessages || []), ...Object.values(json.errors || {})].join('; ')) || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** errorText for a failed write; a 5xx may still have been applied, so a blind re-run could duplicate it. */
async function writeErrorText(res) {
  const text = await errorText(res);
  return res.status >= 500 ? `${text} (Jira may have applied it anyway: check the issue before re-running)` : text;
}

async function fetchIssue(api, key, fields) {
  const res = await api('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`, null, `issue ${key}`);
  if (res.status === 404) throw new CliError(`issue ${key} was not found (or this account cannot see it)`, 1);
  if (!res.ok) throw new CliError(`fetching ${key} failed: ${await errorText(res)} (${oneLine(describeUrl(res.url))})`, 1);
  return readJsonResponse(res, `issue ${key}`);
}

async function main(argv) {
  const { values } = parseCli(argv, {
    issue: { type: 'string' },
    out: { type: 'string' },
    comment: { type: 'string' },
    subtasks: { type: 'string' },
    issuetype: { type: 'string' },
    'tickets-from': { type: 'string' },
    'from-issue': { type: 'string' },
    'remote-links': { type: 'string' },
    site: { type: 'string' },
    parent: { type: 'string' },
    project: { type: 'string' },
    labels: { type: 'string' },
    config: { type: 'string' },
    write: { type: 'boolean' },
    run: { type: 'string' },
    quiet: { type: 'boolean' },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const log = values.quiet ? () => {} : (msg) => console.log(msg);
  if (values['from-issue']) return fromSavedIssue(values, log);
  if (values['remote-links'] || values.site) throw usageError('--remote-links and --site are only used with --from-issue');
  if (values['tickets-from']) {
    if (values.issue || values.out || values.comment || values.subtasks) {
      throw usageError('--tickets-from runs on its own (no --issue, --out, --comment or --subtasks)');
    }
    return ticketsFromReport(values, log);
  }
  for (const flag of ['parent', 'project', 'labels', 'config', 'run']) {
    if (values[flag]) throw usageError(`--${flag} is only used with --tickets-from`);
  }
  if (!values.issue) throw usageError('--issue <KEY> is required (see --help)');
  const key = normalizeTicketKey(values.issue);
  if (!key) throw usageError(`--issue: "${oneLine(values.issue)}" is not an issue key like ABC-123`);
  if (!values.out && !values.comment && !values.subtasks) throw usageError('nothing to do: pass --out <dir>, --comment <file> or --subtasks <fixplan.md>');
  if (values.write && !values.comment && !values.subtasks) throw usageError('--write needs --comment <file> or --subtasks <fixplan.md>');

  const readText = (file, label) => {
    try {
      return readFileSync(file, 'utf8');
    } catch (err) {
      throw usageError(`cannot read ${label} ${oneLine(file)}: ${err.code === 'ENOENT' ? 'file not found' : oneLine(err.message)}`);
    }
  };
  const commentText = values.comment ? readText(values.comment, 'comment file') : null;
  if (commentText !== null && !commentText.trim()) throw usageError(`comment file ${oneLine(values.comment)} is empty`);
  const debt = values.subtasks ? parseDebtItems(readText(values.subtasks, 'fix plan')) : null;

  // A pure dry run (no --out, no --write) never touches the network or needs credentials.
  let creds = null;
  let api = null;
  if (values.out || values.write) {
    creds = credentials();
    api = makeApi(creds);
  }

  if (values.out) {
    const issue = await fetchIssue(api, key, 'summary,description,status,attachment,labels,issuetype,parent,subtasks,issuelinks,comment');
    let remoteLinks = [];
    const rl = await api('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`, null, `remote links of ${key}`);
    if (rl.ok) remoteLinks = await readJsonResponse(rl, 'remote links').catch(() => []);
    const ticket = buildJiraTicket(issue, { baseUrl: creds.base, remoteLinks: Array.isArray(remoteLinks) ? remoteLinks : [] });
    writeTicket(ticket, values.out, log);
  }

  if (commentText !== null) {
    const body = { body: textToAdf(commentText) };
    if (!values.write) {
      log(`[dry run] would add a comment to ${key} (${body.body.content.length} paragraph(s)); re-run with --write to post:`);
      log(quotedLines(commentText.trim()));
    } else {
      const res = await api('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, body, `comment on ${key}`);
      if (!res.ok) throw new CliError(`posting the comment failed: ${await writeErrorText(res)}`, 1);
      const json = await readJsonResponse(res, 'comment');
      log(`Posted comment ${oneLine(json.id ?? '')} on ${key}`);
    }
  }

  if (debt) {
    if (!debt.length) {
      log(`no "## Debt" items in ${oneLine(values.subtasks)}; nothing to create`);
      return 0;
    }
    const project = key.replace(/-\d+$/, '');
    const issuetype = values.issuetype || 'Sub-task';
    const existing = values.write ? (await fetchIssue(api, key, 'subtasks')).fields?.subtasks ?? [] : [];
    const existingText = existing.map((s) => s?.fields?.summary ?? '').join('\n');
    const tracked = debt.filter((item) => item.ticket);
    for (const item of tracked) log(`skip ${oneLine(item.id)}: already tracked by ${oneLine(item.ticket)}`);
    const planned = debt.filter((item) => !item.ticket && !new RegExp(`\\b${item.id}\\b`).test(existingText));
    for (const item of debt) {
      if (!item.ticket && !planned.includes(item)) log(`skip ${oneLine(item.id)}: a sub-task already mentions it`);
    }
    for (const item of planned) {
      const summary = `${item.id} — ${item.title}`.slice(0, 250);
      const fields = {
        project: { key: project },
        parent: { key },
        issuetype: { name: issuetype },
        summary,
        description: textToAdf([item.line, item.summary ? `Fix: ${item.summary}` : null, item.evidence ? `Evidence: ${item.evidence}` : null].filter(Boolean).join('\n')),
        labels: ['design-qa'],
      };
      if (!values.write) {
        log(`[dry run] would create ${oneLine(issuetype)} under ${key}: ${oneLine(summary)}`);
        continue;
      }
      const res = await api('POST', '/rest/api/3/issue', { fields }, `create sub-task ${item.id}`);
      if (!res.ok) throw new CliError(`creating the sub-task for ${oneLine(item.id)} failed: ${await writeErrorText(res)}`, 1);
      const json = await readJsonResponse(res, 'create issue');
      log(`Created ${normalizeTicketKey(json.key) ?? '(unknown key)'} — ${oneLine(summary)}`);
    }
    if (!values.write) log('Re-run with --write to create them (existing sub-tasks are checked then).');
  }
  return 0;
}

// ---------------------------------------------------------------------------
// --tickets-from: one Jira ticket per untracked debt item of a triaged report
// ---------------------------------------------------------------------------

const PROJECT_RE = /^[A-Z][A-Z0-9_]+$/;
const day = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(String(iso ?? '')) ? String(iso).slice(0, 10) : null);

/** Jira issue fields for one debt item (ADF description, one paragraph per line). */
export function debtIssueFields(finding, item, report, { project, parent = null, issuetype, labels, reportPath }) {
  const f = finding;
  const figma = f.element?.figmaLayerPath ? `Figma ${f.element.figmaLayerPath}` : f.element?.figmaNodeId ? `Figma node ${f.element.figmaNodeId}` : null;
  const location = sourceLocation(f);
  const where = [location !== DASH ? location : null, f.element?.selector ? `selector ${f.element.selector}` : null, figma].filter(Boolean).join(' · ') || DASH;
  const evidence = (Array.isArray(f.evidence) ? f.evidence : []).map((e) => e?.path).filter(Boolean);
  const triage = report.triage || {};
  const decided = [triage.decidedBy ? `by ${triage.decidedBy}` : null, day(triage.decidedAt) ? `on ${day(triage.decidedAt)}` : null].filter(Boolean).join(' ');
  const lines = [
    `Design debt deferred in design QA${decided ? ` ${decided}` : ''}${item?.reason ? `: ${item.reason}` : '.'}`,
    `Severity: ${f.severity} · Owner: ${DEBT_OWNER} · State: ${f.state ?? DASH}`,
    `Where: ${where}`,
    `Expected: ${f.expected?.value ?? DASH} (token ${f.expected?.token ?? 'none'}) · Actual: ${f.actual?.value ?? DASH} (token ${f.actual?.token ?? 'none'})`,
    `Fix: ${f.fix?.summary ?? DASH}`,
    `Patch hint: ${f.fix?.patchHint ?? DASH}`,
    `Evidence: ${evidence.join(', ') || DASH}`,
    `Finding ${f.id} · report ${reportPath}${report.meta?.ticket?.key ? ` · feature ticket ${report.meta.ticket.key}` : ''}`,
  ];
  return {
    project: { key: project },
    ...(parent ? { parent: { key: parent } } : {}),
    issuetype: { name: issuetype },
    summary: `[Design debt] ${f.title}`.slice(0, 250),
    description: textToAdf(lines.join('\n')),
    labels,
  };
}

async function ticketsFromReport(values, log) {
  const reportFile = path.resolve(values['tickets-from']);
  // Before any ticket is created: --write records them in report.json, so the folder must be this run's.
  const runId = callerRunId(values.run);
  if (values.write || runId) assertRunOwnsDir(path.dirname(reportFile), { runId });
  const report = readJsonFile(reportFile, 'report', 2);
  let config = {};
  if (values.config) {
    config = readJsonFile(path.resolve(values.config), 'config', 2);
    const cv = validateConfig(config);
    if (!cv.valid) throw usageError(`--config is invalid:\n${formatIssues(cv.errors)}`);
  }
  const options = resolveOptions(config);
  const check = validateReport(report, { options, skipScorecard: true });
  if (!check.valid) {
    throw new CliError(`${oneLine(displayPath(reportFile))} is not a valid report:\n${formatIssues(check.errors)}`, 1);
  }
  if (!report.triage) throw usageError(`${oneLine(displayPath(reportFile))} has no triage block: run triage.mjs first`);

  const index = triageIndex(report);
  const todo = triageLists(report, options).debt.filter((f) => !index.get(f.id)?.ticket);
  if (!todo.length) {
    log('Every debt item already has a ticket; nothing to create.');
    return 0;
  }

  const debtConfig = config.ticket?.debt ?? {};
  const autoParent =
    (debtConfig.parent === undefined || debtConfig.parent === 'auto') && report.meta?.ticket?.provider === 'jira' ? normalizeTicketKey(report.meta.ticket.key) : null;
  const parent = values.parent ? normalizeTicketKey(values.parent) : autoParent;
  if (values.parent && !parent) throw usageError(`--parent: "${oneLine(values.parent)}" is not an issue key like ABC-123`);
  const project = values.project ? values.project.trim().toUpperCase() : debtConfig.project ?? (parent ? parent.replace(/-\d+$/, '') : null);
  if (!project) throw usageError('no parent issue (meta.ticket.key) and no project: pass --parent KEY or --project KEY');
  if (!PROJECT_RE.test(project)) throw usageError(`--project: "${oneLine(project)}" is not a Jira project key like ABC`);
  const issuetype = values.issuetype ?? debtConfig.issueType ?? (parent ? 'Sub-task' : 'Task');
  if (/sub-?task/i.test(issuetype) && !parent) throw usageError('a Sub-task needs a parent: pass --parent KEY, or --issuetype Task with --project KEY');
  const labels = values.labels ? values.labels.split(',').map((l) => l.trim()).filter(Boolean) : debtConfig.labels ?? ['design-qa', 'design-debt'];
  const badLabel = labels.find((l) => /\s/.test(l));
  if (badLabel) throw usageError(`Jira labels cannot contain spaces (got "${oneLine(badLabel)}")`);

  const reportPath = displayPath(reportFile);
  const payloads = todo.map((f) => ({ finding: f, fields: debtIssueFields(f, index.get(f.id), report, { project, parent, issuetype, labels, reportPath }) }));
  const target = parent ? `under ${parent}` : `in project ${project}`;
  if (!values.write) {
    log(`[dry run] would create ${payloads.length} ${oneLine(issuetype)} issue(s) ${oneLine(target)}; re-run with --write to create them and record them in the report:`);
    for (const p of payloads) {
      log(`\n# ${oneLine(p.finding.id)} — ${oneLine(p.fields.summary)}`);
      log(printableJson({ fields: p.fields }));
    }
    return 0;
  }

  const creds = credentials();
  const api = makeApi(creds);
  const created = new Map();
  let failure = null;
  for (const p of payloads) {
    try {
      const res = await api('POST', '/rest/api/3/issue', { fields: p.fields }, `create a ticket for ${p.finding.id}`);
      if (!res.ok) throw new CliError(`creating the ticket for ${oneLine(p.finding.id)} failed: ${await writeErrorText(res)}`, 1);
      const json = await readJsonResponse(res, 'create issue');
      // The key goes into report.json and a URL: only an issue key like ABC-123.
      const newKey = normalizeTicketKey(json.key);
      if (!newKey) throw new CliError(`Jira did not return an issue key for ${oneLine(p.finding.id)}${json.key ? ` (got ${JSON.stringify(oneLine(String(json.key).slice(0, 40)))})` : ''}; check Jira before re-running`, 1);
      created.set(p.finding.id, { provider: 'jira', key: newKey, url: `${creds.base}/browse/${newKey}`, createdAt: new Date().toISOString() });
      log(`Created ${newKey} ${oneLine(target)} — ${oneLine(p.fields.summary)}`);
    } catch (err) {
      failure = err;
      break;
    }
  }
  if (created.size) {
    // Record what exists in Jira even when a later ticket failed, so a re-run never duplicates.
    const next = {
      ...report,
      triage: { ...report.triage, items: report.triage.items.map((i) => (created.has(i.findingId) ? { ...i, ticket: created.get(i.findingId) } : i)) },
    };
    next.scorecard = computeScorecard(next, options);
    writeJson(reportFile, next);
    const sc = next.scorecard;
    log(
      `Recorded ${created.size} ticket(s) in ${oneLine(reportPath)}` +
        (sc.unexplained !== undefined ? ` — unexplained ${sc.unexplained}, debt ${sc.debt.ticketed}/${sc.debt.count} ticketed, verdict ${sc.verdict}` : ''),
    );
    const after = validateReport(next, { options });
    for (const e of after.errors) warn(`${e.path}: ${e.message}`);
    log(`Do: After the next command, re-render the report: ${scriptCommand('render-report.mjs')} --in ${shellArg(reportPath)} --recompute --write-back${runId ? ` --run ${runId}` : ''}`);
    log(`Next: ${scriptCommand('debt-log.mjs')} --report ${shellArg(reportPath)}${runId ? ` --run ${runId}` : ''}`);
  }
  if (failure) throw failure;
  return 0;
}

runMain(import.meta.url, main);
