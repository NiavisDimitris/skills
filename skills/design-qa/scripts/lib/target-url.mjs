// What did the user hand us (Figma link, Figma prototype, coded prototype, app URL,
// ticket key, surface name), what kind of deployment is an app URL, and which URL
// should be captured.
import { parseFigmaUrl } from './figma-url.mjs';

export const TICKET_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const PREVIEW_HOST = /(\.vercel\.app|\.netlify\.app|\.pages\.dev)$|preview/i;
const STAGING_HOST = /staging|(^|[.-])stg\d*([.-]|$)/i;
const LOCAL_HOST = /^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|::1)$|\.localhost$/i;
const CODE_HOSTS = /(^|\.)(github\.com|githubusercontent\.com|gitlab\.com|bitbucket\.org)$/i;
const ATLASSIAN_HOSTS = /(^|\.)(atlassian\.net|atlassian\.com|jira\.com)$/i;
const FIGMA_HOSTS = /(^|\.)figma\.com$/i;

/** Hosts of prototyping tools: a URL there is a coded prototype (design source), not the app. */
const PROTOTYPE_TOOLS = [
  ['figma-make', (u) => (/(^|\.)figma\.com$/i.test(u.hostname) && /^\/make\//.test(u.pathname)) || /(^|\.)figma\.site$/i.test(u.hostname)],
  ['framer', (u) => /(^|\.)(framer\.app|framer\.website|framer\.ai|framercanvas\.com)$/i.test(u.hostname) || (/(^|\.)framer\.com$/i.test(u.hostname) && /^\/projects\//.test(u.pathname))],
  ['v0', (u) => /(^|\.)(v0\.dev|v0\.app|vusercontent\.net)$/i.test(u.hostname)],
  ['lovable', (u) => /(^|\.)(lovable\.app|lovable\.dev|lovableproject\.com)$/i.test(u.hostname)],
];
const TOOL_LABELS = { 'figma-make': 'Figma Make prototype', framer: 'Framer prototype', v0: 'v0 prototype', lovable: 'Lovable prototype', html: 'HTML prototype', other: 'Prototype' };

function toUrl(value) {
  try {
    const u = new URL(String(value).trim());
    return /^https?:$/.test(u.protocol) ? u : null;
  } catch {
    return null;
  }
}

/**
 * Prototyping tool behind a URL: figma-make | framer | v0 | lovable from the host;
 * html for file: URLs and *.html / *.htm pages; null for anything else (any other URL
 * can still be a prototype when the user says so: prototypeTool(url, { assume: true }) → "other").
 */
export function prototypeTool(url, { assume = false } = {}) {
  let u;
  try {
    u = new URL(String(url ?? '').trim());
  } catch {
    return null;
  }
  if (u.protocol === 'file:') return 'html';
  if (!/^https?:$/.test(u.protocol)) return null;
  for (const [tool, test] of PROTOTYPE_TOOLS) if (test(u)) return tool;
  if (/\.html?$/i.test(u.pathname)) return assume ? 'html' : null;
  return assume ? 'other' : null;
}

/**
 * meta.source for a design source URL:
 * { kind: "figma" | "figma-prototype" | "prototype", url, label, tool, frame }.
 * Figma design/file links → figma; figma.com/proto → figma-prototype; any other URL
 * (Figma Make, Framer, v0, Lovable, static HTML, localhost…) → prototype.
 * Returns null for a value that is not a URL.
 */
export function designSource(url, { label = null, frame = null } = {}) {
  const s = String(url ?? '').trim();
  const figma = parseFigmaUrl(s);
  if (figma) {
    const kind = figma.kind === 'proto' ? 'figma-prototype' : 'figma';
    const name = figma.fileName ? `${figma.fileName} (${kind === 'figma' ? 'Figma' : 'Figma prototype'})` : null;
    return { kind, url: s, label: label ?? name, tool: null, frame };
  }
  const tool = prototypeTool(s, { assume: true });
  if (!tool) return null;
  return { kind: 'prototype', url: s, label: label ?? TOOL_LABELS[tool], tool, frame };
}

/** local | preview | staging | prod for an app URL (file: URLs are local). */
export function appKind(url) {
  if (/^file:/i.test(String(url ?? '').trim())) return 'local';
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
 *   { kind: "figma-url", fileKey, nodeId, url }                     (design / file link)
 *   { kind: "figma-prototype", fileKey, nodeId, startingNodeId, url } (figma.com/proto link)
 *   { kind: "prototype", url, tool, appKind }   (Figma Make, Framer, v0, Lovable host; or any
 *                                                http(s)/file URL when { prototype: true },
 *                                                i.e. given with --prototype <url>)
 *   { kind: "ticket-key", key, provider?, url? }   (ABC-123, or a Jira/Linear issue link)
 *   { kind: "pr-url", url }                         (GitHub PR / GitLab MR / Bitbucket PR)
 *   { kind: "app-url", url, appKind }               (any other http(s) URL)
 *   { kind: "surface-name", name }                  (anything else)
 */
export function classifyInput(input, { prototype = false } = {}) {
  const s = String(input ?? '').trim();
  if (!s) return { kind: 'surface-name', name: '' };
  const figma = parseFigmaUrl(s);
  if (figma && figma.kind === 'proto') {
    return { kind: 'figma-prototype', fileKey: figma.fileKey, nodeId: figma.nodeId, startingNodeId: figma.startingNodeId, url: figma.url };
  }
  if (figma) return { kind: 'figma-url', fileKey: figma.fileKey, nodeId: figma.nodeId, url: figma.url };
  if (TICKET_KEY.test(s)) return { kind: 'ticket-key', key: s };
  const tool = prototypeTool(s, { assume: prototype });
  if (tool) return { kind: 'prototype', url: s, tool, appKind: appKind(s) };
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
 * { figmaUrls, prototypeUrls, previewUrls, prUrls, otherUrls } (deduplicated, in order).
 * Figma: design/file/proto links. Prototype: Figma Make, Framer, v0, Lovable.
 * Preview: *.vercel.app, *.netlify.app, *.pages.dev, hosts containing "preview"
 * or "staging". Other: anything else that is not Figma, a code host or Atlassian.
 */
export function extractUrls(text) {
  const out = { figmaUrls: [], prototypeUrls: [], previewUrls: [], prUrls: [], otherUrls: [] };
  const push = (list, v) => {
    if (!list.includes(v)) list.push(v);
  };
  for (const m of String(text ?? '').matchAll(URL_RE)) {
    const url = cleanUrl(m[0]);
    const u = toUrl(url);
    if (!u) continue;
    const host = u.hostname.toLowerCase();
    if (prototypeTool(url)) {
      push(out.prototypeUrls, url);
      continue;
    }
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
