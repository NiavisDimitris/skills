#!/usr/bin/env node
// Fetch a Jira issue into ticket.json (acceptance criteria, expected behaviours,
// Figma / preview / PR links, branches) and, only with --write, post a comment,
// create sub-tasks from a fix plan's debt list, or create one ticket per untracked
// debt item of a triaged report (--tickets-from) and record it in report.json.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CliError, displayPath, parseCli, readJsonFile, runMain, usageError, writeJson } from './lib/args.mjs';
import { textToAdf } from './lib/adf.mjs';
import { DASH, parseDebtItems, sourceLocation } from './lib/fixplan.mjs';
import { describeUrl, fetchWithRetry, readJsonResponse } from './lib/http.mjs';
import { computeScorecard, resolveOptions, triageIndex } from './lib/ranking.mjs';
import { validateConfig, validateReport } from './lib/schema-check.mjs';
import { buildJiraTicket } from './lib/ticket-extract.mjs';
import { ownerOf, triageLists } from './lib/triage.mjs';

const HELP = `Fetch a Jira issue for design QA, or write results back to it.

Usage:
  node scripts/jira-fetch.mjs --issue <KEY> --out <dir>
  node scripts/jira-fetch.mjs --issue <KEY> --comment <file> [--write]
  node scripts/jira-fetch.mjs --issue <KEY> --subtasks <report-fixplan.md> [--write] [--issuetype Sub-task]
  node scripts/jira-fetch.mjs --tickets-from <report.json> [--parent KEY] [--project KEY]
      [--issuetype Sub-task|Task] [--labels design-qa,design-debt] [--config <file>] [--write]

Options:
  --issue <KEY>        issue key, e.g. ABC-123 (required)
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
  --quiet              only print errors
  -h, --help           show this help

Environment:
  JIRA_BASE_URL        e.g. https://your-site.atlassian.net
  JIRA_EMAIL           Atlassian account email
  JIRA_API_TOKEN       API token (id.atlassian.com → Security → API tokens)

ticket.json: { provider, key, url, title, status, description (plain text from ADF),
acceptanceCriteria, expectedBehaviors [{ acRef, text, state, trigger }], figmaUrls,
previewUrls, prUrls, otherUrls, branches, attachments, fetchedAt }. Links are read
from the description, comments and remote links.

Exit codes: 0 ok · 1 error (issue not found, request failed) · 2 bad arguments ·
6 authentication (credentials missing or rejected)`;

const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

function credentials() {
  const base = process.env.JIRA_BASE_URL;
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  const missing = [['JIRA_BASE_URL', base], ['JIRA_EMAIL', email], ['JIRA_API_TOKEN', token]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new CliError(`missing environment variable(s): ${missing.join(', ')} (see --help)`, 6);
  if (!/^https?:\/\//.test(base)) throw usageError(`JIRA_BASE_URL must start with https:// (got "${base}")`);
  return { base: base.replace(/\/+$/, ''), auth: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` };
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
      { label },
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

async function errorText(res) {
  try {
    const json = JSON.parse(await res.text());
    return [...(json.errorMessages || []), ...Object.values(json.errors || {})].join('; ') || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

async function fetchIssue(api, key, fields) {
  const res = await api('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`, null, `issue ${key}`);
  if (res.status === 404) throw new CliError(`issue ${key} was not found (or this account cannot see it)`, 1);
  if (!res.ok) throw new CliError(`fetching ${key} failed: ${await errorText(res)} (${describeUrl(res.url)})`, 1);
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
    parent: { type: 'string' },
    project: { type: 'string' },
    labels: { type: 'string' },
    config: { type: 'string' },
    write: { type: 'boolean' },
    quiet: { type: 'boolean' },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const log = values.quiet ? () => {} : (msg) => console.log(msg);
  if (values['tickets-from']) {
    if (values.issue || values.out || values.comment || values.subtasks) {
      throw usageError('--tickets-from runs on its own (no --issue, --out, --comment or --subtasks)');
    }
    return ticketsFromReport(values, log);
  }
  for (const flag of ['parent', 'project', 'labels', 'config']) {
    if (values[flag]) throw usageError(`--${flag} is only used with --tickets-from`);
  }
  if (!values.issue) throw usageError('--issue <KEY> is required (see --help)');
  const key = values.issue.trim().toUpperCase();
  if (!KEY_RE.test(key)) throw usageError(`--issue: "${values.issue}" is not an issue key like ABC-123`);
  if (!values.out && !values.comment && !values.subtasks) throw usageError('nothing to do: pass --out <dir>, --comment <file> or --subtasks <fixplan.md>');
  if (values.write && !values.comment && !values.subtasks) throw usageError('--write needs --comment <file> or --subtasks <fixplan.md>');

  const readText = (file, label) => {
    try {
      return readFileSync(file, 'utf8');
    } catch (err) {
      throw usageError(`cannot read ${label} ${file}: ${err.code === 'ENOENT' ? 'file not found' : err.message}`);
    }
  };
  const commentText = values.comment ? readText(values.comment, 'comment file') : null;
  if (commentText !== null && !commentText.trim()) throw usageError(`comment file ${values.comment} is empty`);
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
    const file = path.join(path.resolve(values.out), 'ticket.json');
    writeJson(file, ticket);
    log(`${ticket.key}: ${ticket.title ?? '(no title)'} [${ticket.status ?? 'no status'}]`);
    log(`  ${ticket.acceptanceCriteria.length} acceptance criteria · states: ${[...new Set(ticket.expectedBehaviors.map((b) => b.state).filter(Boolean))].join(', ') || 'none'}`);
    log(`  Figma: ${ticket.figmaUrls.length} · preview: ${ticket.previewUrls.length} · PRs: ${ticket.prUrls.length} · branches: ${ticket.branches.join(', ') || 'none'}`);
    log(`Wrote ${displayPath(file)}`);
  }

  if (commentText !== null) {
    const body = { body: textToAdf(commentText) };
    if (!values.write) {
      log(`[dry run] would add a comment to ${key} (${body.body.content.length} paragraph(s)); re-run with --write to post:`);
      log(commentText.trim().split(/\r?\n/).map((l) => `  | ${l}`).join('\n'));
    } else {
      const res = await api('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, body, `comment on ${key}`);
      if (!res.ok) throw new CliError(`posting the comment failed: ${await errorText(res)}`, 1);
      const json = await readJsonResponse(res, 'comment');
      log(`Posted comment ${json.id ?? ''} on ${key}`);
    }
  }

  if (debt) {
    if (!debt.length) {
      log(`no "## Debt" items in ${values.subtasks}; nothing to create`);
      return 0;
    }
    const project = key.replace(/-\d+$/, '');
    const issuetype = values.issuetype || 'Sub-task';
    const existing = values.write ? (await fetchIssue(api, key, 'subtasks')).fields?.subtasks ?? [] : [];
    const existingText = existing.map((s) => s?.fields?.summary ?? '').join('\n');
    const tracked = debt.filter((item) => item.ticket);
    for (const item of tracked) log(`skip ${item.id}: already tracked by ${item.ticket}`);
    const planned = debt.filter((item) => !item.ticket && !new RegExp(`\\b${item.id}\\b`).test(existingText));
    for (const item of debt) {
      if (!item.ticket && !planned.includes(item)) log(`skip ${item.id}: a sub-task already mentions it`);
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
        log(`[dry run] would create ${issuetype} under ${key}: ${summary}`);
        continue;
      }
      const res = await api('POST', '/rest/api/3/issue', { fields }, `create sub-task ${item.id}`);
      if (!res.ok) throw new CliError(`creating the sub-task for ${item.id} failed: ${await errorText(res)}`, 1);
      const json = await readJsonResponse(res, 'create issue');
      log(`Created ${json.key ?? '(unknown key)'} — ${summary}`);
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
    `Severity: ${f.severity} · Owner: ${ownerOf(f)} · State: ${f.state ?? DASH}`,
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
  const warn = (msg) => console.error(`warning: ${msg}`);
  const reportFile = path.resolve(values['tickets-from']);
  const report = readJsonFile(reportFile, 'report', 2);
  let config = {};
  if (values.config) {
    config = readJsonFile(path.resolve(values.config), 'config', 2);
    const cv = validateConfig(config);
    if (!cv.valid) throw usageError(`--config is invalid:\n${cv.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
  }
  const options = resolveOptions(config);
  const check = validateReport(report, { options, skipScorecard: true });
  if (!check.valid) {
    throw new CliError(`${displayPath(reportFile)} is not a valid report:\n${check.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`, 1);
  }
  if (!report.triage) throw usageError(`${displayPath(reportFile)} has no triage block: run triage.mjs first`);

  const index = triageIndex(report);
  const todo = triageLists(report, options).debt.filter((f) => !index.get(f.id)?.ticket);
  if (!todo.length) {
    log('Every debt item already has a ticket; nothing to create.');
    return 0;
  }

  const debtConfig = config.ticket?.debt ?? {};
  const autoParent =
    (debtConfig.parent === undefined || debtConfig.parent === 'auto') && report.meta?.ticket?.provider === 'jira' && KEY_RE.test(report.meta.ticket.key ?? '')
      ? report.meta.ticket.key
      : null;
  const parent = values.parent ? values.parent.trim().toUpperCase() : autoParent;
  if (parent && !KEY_RE.test(parent)) throw usageError(`--parent: "${values.parent}" is not an issue key like ABC-123`);
  const project = values.project ? values.project.trim().toUpperCase() : debtConfig.project ?? (parent ? parent.replace(/-\d+$/, '') : null);
  if (!project) throw usageError('no parent issue (meta.ticket.key) and no project: pass --parent KEY or --project KEY');
  if (!PROJECT_RE.test(project)) throw usageError(`--project: "${project}" is not a Jira project key like ABC`);
  const issuetype = values.issuetype ?? debtConfig.issueType ?? (parent ? 'Sub-task' : 'Task');
  if (/sub-?task/i.test(issuetype) && !parent) throw usageError('a Sub-task needs a parent: pass --parent KEY, or --issuetype Task with --project KEY');
  const labels = values.labels ? values.labels.split(',').map((l) => l.trim()).filter(Boolean) : debtConfig.labels ?? ['design-qa', 'design-debt'];
  const badLabel = labels.find((l) => /\s/.test(l));
  if (badLabel) throw usageError(`Jira labels cannot contain spaces (got "${badLabel}")`);

  const reportPath = displayPath(reportFile);
  const payloads = todo.map((f) => ({ finding: f, fields: debtIssueFields(f, index.get(f.id), report, { project, parent, issuetype, labels, reportPath }) }));
  const target = parent ? `under ${parent}` : `in project ${project}`;
  if (!values.write) {
    log(`[dry run] would create ${payloads.length} ${issuetype} issue(s) ${target}; re-run with --write to create them and record them in the report:`);
    for (const p of payloads) {
      log(`\n# ${p.finding.id} — ${p.fields.summary}`);
      log(JSON.stringify({ fields: p.fields }, null, 2));
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
      if (!res.ok) throw new CliError(`creating the ticket for ${p.finding.id} failed: ${await errorText(res)}`, 1);
      const json = await readJsonResponse(res, 'create issue');
      if (!json.key) throw new CliError(`Jira did not return a key for ${p.finding.id}`, 1);
      created.set(p.finding.id, { provider: 'jira', key: json.key, url: `${creds.base}/browse/${json.key}`, createdAt: new Date().toISOString() });
      log(`Created ${json.key} ${target} — ${p.fields.summary}`);
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
      `Recorded ${created.size} ticket(s) in ${reportPath}` +
        (sc.unexplained !== undefined ? ` — unexplained ${sc.unexplained}, debt ${sc.debt.ticketed}/${sc.debt.count} ticketed, verdict ${sc.verdict}` : ''),
    );
    const after = validateReport(next, { options });
    for (const e of after.errors) warn(`${e.path}: ${e.message}`);
    log('Next: debt-log.mjs --report ' + reportPath + ', then re-render the report.');
  }
  if (failure) throw failure;
  return 0;
}

runMain(import.meta.url, main);
