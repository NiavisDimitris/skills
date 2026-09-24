#!/usr/bin/env node
// Fetch a Jira issue into ticket.json (acceptance criteria, expected behaviours,
// Figma / preview / PR links, branches) and, only with --write, post a comment
// or create sub-tasks from a fix plan's debt list.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CliError, displayPath, parseCli, runMain, usageError, writeJson } from './lib/args.mjs';
import { textToAdf } from './lib/adf.mjs';
import { parseDebtItems } from './lib/fixplan.mjs';
import { describeUrl, fetchWithRetry, readJsonResponse } from './lib/http.mjs';
import { buildJiraTicket } from './lib/ticket-extract.mjs';

const HELP = `Fetch a Jira issue for design QA, or write results back to it.

Usage:
  node scripts/jira-fetch.mjs --issue <KEY> --out <dir>
  node scripts/jira-fetch.mjs --issue <KEY> --comment <file> [--write]
  node scripts/jira-fetch.mjs --issue <KEY> --subtasks <report-fixplan.md> [--write] [--issuetype Sub-task]

Options:
  --issue <KEY>        issue key, e.g. ABC-123 (required)
  --out <dir>          write <dir>/ticket.json (required unless --comment/--subtasks)
  --comment <file>     post the file's text as a comment (one paragraph per line)
  --subtasks <file>    create one sub-task per "## Debt" bullet of a fix plan
                       (skips DQ ids that already have a sub-task)
  --issuetype <name>   sub-task issue type name (default "Sub-task")
  --write              actually post / create. Without it, --comment and --subtasks
                       only print what would be sent (dry run)
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
    write: { type: 'boolean' },
    quiet: { type: 'boolean' },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const log = values.quiet ? () => {} : (msg) => console.log(msg);
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
    const planned = debt.filter((item) => !new RegExp(`\\b${item.id}\\b`).test(existingText));
    for (const item of debt) {
      if (!planned.includes(item)) log(`skip ${item.id}: a sub-task already mentions it`);
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

runMain(import.meta.url, main);
