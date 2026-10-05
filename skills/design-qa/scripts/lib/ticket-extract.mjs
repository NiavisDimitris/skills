// Pull what design QA needs out of a ticket: acceptance criteria, expected
// behaviours per state (with trigger), Figma / preview / PR links and branches.
import { adfToText } from './adf.mjs';
import { matchStateSynonym } from './state-discovery.mjs';
import { extractUrls, normalizeTicketKey, trimEnd } from './target-url.mjs';

const AC_HEADING = /acceptance criteria|\bAC\b|definition of done/i;
const LIST_MARKER = /^(?:[-*•+]\s+|\d+[.)]\s+|[a-z][.)]\s+)?(?:\[[ xX]?\]\s*)?/;
const CHECKBOX = /^(?:[-*•+]\s+)?\[[ xX]?\]\s+/;
const GHERKIN = /^(given|when|then|and|but)\b/i;
const MODAL = /^(should|must)\b/i;

/** Heading text when the line is a heading ("## x", "h2. x", "**x**", "x:"), else null. */
export function headingText(line) {
  const t = line.trim();
  let m = /^#{1,6}\s+(.*)$/.exec(t) || /^h[1-6]\.\s+(.*)$/i.exec(t);
  if (m) return m[1].trim();
  if (/^[-*•+]\s|^\d+[.)]\s|^\[/.test(t)) return null;
  m = /^(\*\*|__)(.+?)\1:?$/.exec(t);
  if (m) return m[2].trim();
  if (t.length <= 60 && /:$/.test(t) && !/\s{2,}/.test(t) && t.split(/\s+/).length <= 6) return t.replace(/:$/, '').trim();
  return null;
}

function stripMarker(line) {
  return line.trim().replace(LIST_MARKER, '').replace(/^\*\*(.+)\*\*$/, '$1').trim();
}

/**
 * Acceptance criteria: every line under a heading matching
 * /acceptance criteria|AC\b|definition of done/i (until the next heading), plus,
 * anywhere, checkbox lines ("- [ ] …"), lines starting with Should/Must and
 * Given/When/Then scenarios (consecutive Given/When/Then/And/But lines are
 * joined into one criterion).
 */
export function extractAcceptanceCriteria(text) {
  const items = [];
  const push = (s) => {
    const v = s.replace(/\s+/g, ' ').trim();
    if (v && !items.includes(v)) items.push(v);
  };
  let inSection = false;
  let scenario = null;
  const flush = () => {
    if (scenario) push(scenario.parts.join(' '));
    scenario = null;
  };
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const heading = headingText(line);
    if (heading !== null) {
      flush();
      inSection = AC_HEADING.test(heading);
      continue;
    }
    const body = stripMarker(line);
    if (!body) continue;
    const g = GHERKIN.exec(body);
    if (g) {
      const kw = g[1].toLowerCase();
      const startsNew = kw === 'given' || !scenario || (kw === 'when' && scenario.sawThen);
      if ((kw === 'and' || kw === 'but') && !scenario) {
        if (inSection) push(body);
        continue;
      }
      if (startsNew) {
        flush();
        scenario = { parts: [], sawThen: false };
      }
      scenario.parts.push(body);
      if (kw === 'then') scenario.sawThen = true;
      continue;
    }
    flush();
    if (inSection || CHECKBOX.test(line) || MODAL.test(body)) push(body);
  }
  flush();
  return items;
}

const TRIGGER_CLAUSE = /\b(?:when|whenever|once|after|upon|if|while|during)\s+(.+?)(?=\s*(?:,|;|\bthen\b|\.\s|\.$|$))/i;
const ON_EVENT =
  /\bon\s+((?:mouse\s?over|hover(?:ing)?|click(?:ing)?|tap(?:ping)?|focus(?:ing)?|blur|load(?:ing)?|submit(?:ting)?|press(?:ing)?|scroll(?:ing)?|change|select(?:ing|ion)?|error|success|keyboard\s+focus|[a-z]+ing)(?:\s+(?:of|on)\s+[^,.;]+)?)/i;

/** The when/on/after… clause of a criterion ("the request fails", "hover"), or null. */
export function extractTrigger(text) {
  const s = String(text ?? '');
  const m = TRIGGER_CLAUSE.exec(s);
  if (m && m[1].trim()) return m[1].trim();
  const on = ON_EVENT.exec(s);
  return on ? on[1].trim() : null;
}

/** [{ acRef: "AC-1", text, state, trigger }] for a list of acceptance criteria. */
export function extractExpectedBehaviors(acceptanceCriteria) {
  return (acceptanceCriteria || []).map((text, i) => ({
    acRef: `AC-${i + 1}`,
    text,
    state: matchStateSynonym(text),
    trigger: extractTrigger(text),
  }));
}

const URL_RE = /https?:\/\/\S+/gi;
const BRANCH_PREFIX = /(?<![\w/.-])((?:feature|feat|fix|bugfix|hotfix|chore|release|refactor|design-qa)\/[A-Za-z0-9._\-/]+)/g;
const BRANCH_TRAILING = new Set('.,;:)]\'"`');

/** Branch names: feature/… style tokens, "branch: name" and GitHub /tree/<branch> links. */
export function extractBranches(text) {
  const s = String(text ?? '');
  const out = [];
  const push = (b) => {
    const v = trimEnd(b, BRANCH_TRAILING);
    if (v && !out.includes(v)) out.push(v);
  };
  for (const m of s.replace(URL_RE, ' ').matchAll(BRANCH_PREFIX)) push(m[1]);
  for (const m of s.matchAll(/\bbranch(?:\s+name)?\s*[:=]\s*`?([A-Za-z0-9._\-/]+)`?/gi)) push(m[1]);
  for (const m of s.matchAll(/github\.com\/[^/\s]+\/[^/\s]+\/tree\/([A-Za-z0-9._\-/]+)/g)) push(m[1]);
  return out;
}

// ---------------------------------------------------------------------------
// Saved MCP results (Atlassian MCP getJiraIssue, getJiraIssueRemoteIssueLinks)
// ---------------------------------------------------------------------------

/**
 * Parse a saved tool result: plain JSON, a JSON string, or a tool-result envelope
 * ({ content: [{ type: "text", text: "<json>" }] }). Returns every JSON value found.
 */
function savedJsonValues(text) {
  const out = [];
  const visit = (value, depth) => {
    if (depth > 6 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      const t = value.trim();
      if (!/^[[{"]/.test(t)) return;
      try {
        visit(JSON.parse(t), depth + 1);
      } catch {
        // not JSON: skip
      }
      return;
    }
    if (typeof value !== 'object') return;
    if (!Array.isArray(value) && Array.isArray(value.content) && value.content.some((c) => typeof c?.text === 'string')) {
      for (const c of value.content) if (typeof c?.text === 'string') visit(c.text, depth + 1);
      return;
    }
    out.push(value);
  };
  visit(String(text ?? '').replace(/^﻿/, ''), 0);
  return out;
}

/**
 * The Jira issue in a saved getJiraIssue result: the REST v3 issue object ({ key, fields }),
 * also when wrapped ({ issue }, { issues: [one] }, a tool-result envelope). Throws Error
 * when there is no issue in it.
 */
export function issueFromSaved(text) {
  const find = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 4) return null;
    if (!Array.isArray(v) && v.fields && typeof v.fields === 'object' && typeof v.key === 'string') return v;
    if (Array.isArray(v)) return v.length === 1 ? find(v[0], depth + 1) : null;
    for (const k of ['issue', 'data', 'result']) if (v[k]) return find(v[k], depth + 1);
    if (Array.isArray(v.issues) && v.issues.length === 1) return find(v.issues[0], depth + 1);
    return null;
  };
  for (const value of savedJsonValues(text)) {
    const issue = find(value, 0);
    if (issue) return issue;
  }
  throw new Error('the file holds no Jira issue (expected the getJiraIssue result: JSON with "key" and "fields")');
}

/** Remote links in a saved getJiraIssueRemoteIssueLinks result: [{ object: { url, title } }]. */
export function remoteLinksFromSaved(text) {
  for (const value of savedJsonValues(text)) {
    const list = Array.isArray(value) ? value : Array.isArray(value?.remoteLinks) ? value.remoteLinks : Array.isArray(value?.values) ? value.values : null;
    if (list) return list.filter((l) => l && typeof l === 'object' && typeof l.object?.url === 'string');
  }
  throw new Error('the remote-links file holds no list of remote links (expected the getJiraIssueRemoteIssueLinks result)');
}

/** The Jira site of a saved issue, from its "self" API link (https only), else null. */
export function issueBaseUrl(issue) {
  try {
    const u = new URL(String(issue?.self ?? ''));
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Normalised ticket.json from a Jira REST v3 issue.
 * opts: { baseUrl, remoteLinks: [{ object: { url, title } }], now: Date }
 * previewUrlSources maps every preview URL to where it was first found: "description",
 * "comment" or "remote-link" (resolveTarget only auto-trusts the description).
 */
export function buildJiraTicket(issue, { baseUrl = '', remoteLinks = [], now = new Date() } = {}) {
  const f = issue?.fields || {};
  const description = adfToText(f.description);
  const comments = (f.comment?.comments || []).map((c) => adfToText(c?.body)).filter(Boolean);
  const remote = (remoteLinks || []).map((l) => l?.object?.url).filter(Boolean);
  const allText = [description, ...comments, ...remote].join('\n');
  const urls = extractUrls(allText);
  const previewUrlSources = {};
  for (const [source, text] of [['description', description], ...comments.map((c) => ['comment', c]), ...remote.map((r) => ['remote-link', r])]) {
    for (const u of extractUrls(text).previewUrls) previewUrlSources[u] ??= source;
  }
  const acceptanceCriteria = extractAcceptanceCriteria(description);
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const key = normalizeTicketKey(issue?.key);
  return {
    provider: 'jira',
    key,
    url: key && base ? `${base}/browse/${key}` : null,
    title: f.summary ?? null,
    status: f.status?.name ?? null,
    issueType: f.issuetype?.name ?? null,
    labels: Array.isArray(f.labels) ? f.labels : [],
    parent: f.parent?.key ?? null,
    description,
    acceptanceCriteria,
    expectedBehaviors: extractExpectedBehaviors(acceptanceCriteria),
    figmaUrls: urls.figmaUrls,
    prototypeUrls: urls.prototypeUrls,
    previewUrls: urls.previewUrls,
    previewUrlSources,
    prUrls: urls.prUrls,
    otherUrls: urls.otherUrls,
    branches: extractBranches(allText),
    attachments: (f.attachment || []).map((a) => ({ filename: a?.filename ?? null, url: a?.content ?? null, mimeType: a?.mimeType ?? null })),
    fetchedAt: now.toISOString(),
  };
}
