// Pull what design QA needs out of a ticket: acceptance criteria, expected
// behaviours per state (with trigger), Figma / preview / PR links and branches.
import { adfToText } from './adf.mjs';
import { matchStateSynonym } from './state-discovery.mjs';
import { extractUrls } from './target-url.mjs';

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

/** Branch names: feature/… style tokens, "branch: name" and GitHub /tree/<branch> links. */
export function extractBranches(text) {
  const s = String(text ?? '');
  const out = [];
  const push = (b) => {
    const v = b.replace(/[.,;:)\]'"`]+$/, '');
    if (v && !out.includes(v)) out.push(v);
  };
  for (const m of s.replace(URL_RE, ' ').matchAll(BRANCH_PREFIX)) push(m[1]);
  for (const m of s.matchAll(/\bbranch(?:\s+name)?\s*[:=]\s*`?([A-Za-z0-9._\-/]+)`?/gi)) push(m[1]);
  for (const m of s.matchAll(/github\.com\/[^/\s]+\/[^/\s]+\/tree\/([A-Za-z0-9._\-/]+)/g)) push(m[1]);
  return out;
}

/**
 * Normalised ticket.json from a Jira REST v3 issue.
 * opts: { baseUrl, remoteLinks: [{ object: { url, title } }], now: Date }
 */
export function buildJiraTicket(issue, { baseUrl = '', remoteLinks = [], now = new Date() } = {}) {
  const f = issue?.fields || {};
  const description = adfToText(f.description);
  const comments = (f.comment?.comments || []).map((c) => adfToText(c?.body)).filter(Boolean);
  const remote = (remoteLinks || []).map((l) => l?.object?.url).filter(Boolean);
  const allText = [description, ...comments, ...remote].join('\n');
  const urls = extractUrls(allText);
  const acceptanceCriteria = extractAcceptanceCriteria(description);
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return {
    provider: 'jira',
    key: issue?.key ?? null,
    url: issue?.key && base ? `${base}/browse/${issue.key}` : null,
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
    prUrls: urls.prUrls,
    otherUrls: urls.otherUrls,
    branches: extractBranches(allText),
    attachments: (f.attachment || []).map((a) => ({ filename: a?.filename ?? null, url: a?.content ?? null, mimeType: a?.mimeType ?? null })),
    fetchedAt: now.toISOString(),
  };
}
