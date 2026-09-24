// What did the user hand us (Figma link, app URL, ticket key, surface name),
// what kind of deployment is an app URL, and which URL should be captured.
import { parseFigmaUrl } from './figma-url.mjs';

export const TICKET_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const PREVIEW_HOST = /(\.vercel\.app|\.netlify\.app|\.pages\.dev)$|preview/i;
const STAGING_HOST = /staging|(^|[.-])stg\d*([.-]|$)/i;
const LOCAL_HOST = /^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|::1)$|\.localhost$/i;
const CODE_HOSTS = /(^|\.)(github\.com|githubusercontent\.com|gitlab\.com|bitbucket\.org)$/i;
const ATLASSIAN_HOSTS = /(^|\.)(atlassian\.net|atlassian\.com|jira\.com)$/i;
const FIGMA_HOSTS = /(^|\.)figma\.com$/i;

function toUrl(value) {
  try {
    const u = new URL(String(value).trim());
    return /^https?:$/.test(u.protocol) ? u : null;
  } catch {
    return null;
  }
}

/** local | preview | staging | prod for an app URL. */
export function appKind(url) {
  const u = toUrl(url);
  if (!u) return 'prod';
  const host = u.hostname.toLowerCase();
  if (LOCAL_HOST.test(host)) return 'local';
  if (PREVIEW_HOST.test(host)) return 'preview';
  if (STAGING_HOST.test(host)) return 'staging';
  return 'prod';
}

/** Pull request / merge request link? */
export function isPrUrl(url) {
  const u = toUrl(url);
  if (!u) return false;
  const host = u.hostname.toLowerCase();
  if (/(^|\.)github\.com$/.test(host)) return /^\/[^/]+\/[^/]+\/pull\/\d+/.test(u.pathname);
  if (/(^|\.)gitlab\.com$/.test(host)) return /\/-\/merge_requests\/\d+/.test(u.pathname);
  if (/(^|\.)bitbucket\.org$/.test(host)) return /^\/[^/]+\/[^/]+\/pull-requests\/\d+/.test(u.pathname);
  return false;
}

/** Ticket key from an issue link (Jira browse, Linear issue), else null. */
export function ticketFromUrl(url) {
  const u = toUrl(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  if (ATLASSIAN_HOSTS.test(host) || /\/browse\/[A-Z][A-Z0-9]+-\d+/.test(u.pathname)) {
    const m = /\/browse\/([A-Z][A-Z0-9]+-\d+)/.exec(u.pathname) || /[?&]selectedIssue=([A-Z][A-Z0-9]+-\d+)/.exec(u.search);
    if (m) return { key: m[1], provider: 'jira' };
  }
  if (/(^|\.)linear\.app$/.test(host)) {
    const m = /\/issue\/([A-Z][A-Z0-9]+-\d+)/i.exec(u.pathname);
    if (m) return { key: m[1].toUpperCase(), provider: 'linear' };
  }
  return null;
}

/**
 * Classify one input:
 *   { kind: "figma-url", fileKey, nodeId, url }
 *   { kind: "ticket-key", key, provider?, url? }   (ABC-123, or a Jira/Linear issue link)
 *   { kind: "pr-url", url }                         (GitHub PR / GitLab MR / Bitbucket PR)
 *   { kind: "app-url", url, appKind }               (any other http(s) URL)
 *   { kind: "surface-name", name }                  (anything else)
 */
export function classifyInput(input) {
  const s = String(input ?? '').trim();
  if (!s) return { kind: 'surface-name', name: '' };
  const figma = parseFigmaUrl(s);
  if (figma) return { kind: 'figma-url', fileKey: figma.fileKey, nodeId: figma.nodeId, url: figma.url };
  if (TICKET_KEY.test(s)) return { kind: 'ticket-key', key: s };
  const u = toUrl(s);
  if (u) {
    const ticket = ticketFromUrl(s);
    if (ticket) return { kind: 'ticket-key', key: ticket.key, provider: ticket.provider, url: s };
    if (isPrUrl(s)) return { kind: 'pr-url', url: s };
    return { kind: 'app-url', url: s, appKind: appKind(s) };
  }
  return { kind: 'surface-name', name: s };
}

const URL_RE = /https?:\/\/[^\s<>"'`|\\^{}]+/gi;

function cleanUrl(raw) {
  let url = raw.replace(/[.,;:!?*_~]+$/, '');
  // Drop unbalanced closing brackets: "(see https://x.test/a)" → https://x.test/a
  for (const [open, close] of [['(', ')'], ['[', ']']]) {
    while (url.endsWith(close) && url.split(open).length < url.split(close).length) url = url.slice(0, -1);
  }
  return url.replace(/[.,;:!?*_~]+$/, '');
}

/**
 * Every http(s) URL in a text, classified:
 * { figmaUrls, previewUrls, prUrls, otherUrls } (deduplicated, in order).
 * Preview: *.vercel.app, *.netlify.app, *.pages.dev, hosts containing "preview"
 * or "staging". Other: anything else that is not Figma, a code host or Atlassian.
 */
export function extractUrls(text) {
  const out = { figmaUrls: [], previewUrls: [], prUrls: [], otherUrls: [] };
  const push = (list, v) => {
    if (!list.includes(v)) list.push(v);
  };
  for (const m of String(text ?? '').matchAll(URL_RE)) {
    const url = cleanUrl(m[0]);
    const u = toUrl(url);
    if (!u) continue;
    const host = u.hostname.toLowerCase();
    if (FIGMA_HOSTS.test(host)) {
      if (parseFigmaUrl(url)) push(out.figmaUrls, url);
      continue;
    }
    if (isPrUrl(url)) {
      push(out.prUrls, url);
      continue;
    }
    if (CODE_HOSTS.test(host) || ATLASSIAN_HOSTS.test(host)) continue;
    if (PREVIEW_HOST.test(host) || /staging/i.test(host)) push(out.previewUrls, url);
    else push(out.otherUrls, url);
  }
  return out;
}

function joinRoute(base, route) {
  if (!route) return base;
  if (/^https?:\/\//.test(route)) return route;
  return `${String(base).replace(/\/+$/, '')}/${String(route).replace(/^\/+/, '')}`;
}

function surfaceOf(config, surface) {
  const surfaces = config?.surfaces && typeof config.surfaces === 'object' ? config.surfaces : {};
  return surface ? surfaces[surface] ?? null : Object.values(surfaces)[0] ?? null;
}

/**
 * Pick the URL to capture:
 *   1. an explicit URL (source "explicit"),
 *   2. the ticket's first preview URL (source "ticket"; the surface route is appended
 *      when the preview URL has no path) — needsConfirmation unless
 *      config.ticket.trustPreviewUrl is true,
 *   3. config.app.baseUrl + the surface route (source "config").
 * Returns { url, kind, source, needsConfirmation } or null when nothing is known.
 */
export function resolveTarget({ explicitUrl = null, ticket = null, config = null, surface = null } = {}) {
  const route = surfaceOf(config, surface)?.route ?? null;
  if (explicitUrl) {
    return { url: explicitUrl, kind: appKind(explicitUrl), source: 'explicit', needsConfirmation: false };
  }
  const preview = Array.isArray(ticket?.previewUrls) ? ticket.previewUrls.find((u) => toUrl(u)) : null;
  if (preview) {
    const u = toUrl(preview);
    const bare = (u.pathname === '/' || u.pathname === '') && !u.search && !u.hash;
    const url = bare && route ? joinRoute(`${u.protocol}//${u.host}`, route) : preview;
    return { url, kind: appKind(url), source: 'ticket', needsConfirmation: config?.ticket?.trustPreviewUrl !== true };
  }
  const base = config?.app?.baseUrl;
  if (base) {
    const url = joinRoute(base, route);
    return { url, kind: appKind(url), source: 'config', needsConfirmation: false };
  }
  return null;
}
