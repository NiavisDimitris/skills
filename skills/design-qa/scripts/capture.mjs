#!/usr/bin/env node
// Capture the app (or, with --side design, a coded prototype) in every state with
// Playwright Chromium at deviceScaleFactor 1: one screenshot, computed styles, a DOM
// snapshot and a motion trace per state + capture.json / design-capture.json.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CliError, displayPath, ensureDir, parseCli, parseJsonArg, readJsonFile, runMain, toNumber, usageError, writeJson } from './lib/args.mjs';
import {
  DEFAULT_GRAB,
  buildStateUrl,
  checkDriver,
  checkGrab,
  configDefaults,
  ensureOutSubdir,
  expandEnv,
  holdsMock,
  isDrivable,
  isLoadingState,
  loadStates,
  makeRedactor,
  mergeManifest,
  normalizeAuthType,
  parseHeaders,
  parseKeys,
  redirectLocation,
  removeStateFiles,
  resolveAuth,
  sameLocation,
  secretEnvEntries,
  stateFiles,
  unlinkSymlink,
  writeFileNoFollow,
} from './lib/capture-helpers.mjs';
import { isMissingModule, missingDependencyMessage } from './lib/deps.mjs';
import { pngSize } from './lib/png.mjs';
import { exactStateName } from './lib/state-discovery.mjs';
import { appKind, designSource } from './lib/target-url.mjs';

const HELP = `Capture the app in each state (screenshot + computed styles + DOM snapshot + motion).

Usage:
  node scripts/capture.mjs --url <url> --width <w> --height <h> --out <dir> [options]
  node scripts/capture.mjs --config design-qa.config.json [--surface <name>] --width <w> --height <h> --out <dir> [options]
  node scripts/capture.mjs --side design --url <prototype-url> --width <w> --height <h> --out <dir> [options]

Options:
  --url <url>              page to capture; may contain {fixture}/{id} (replaced by a state's
                           "fixture" driver value, otherwise ?fixture=<value> is appended)
  --width <px>, --height <px>
                           viewport — use the Figma frame size; captures run at DPR 1
  --full-page              capture the full scroll height (width must still match)
  --wait <selector>        wait until visible before capturing: an element that proves the data
                           rendered (a row, not the page heading), present in every state, else
                           use per-state "wait" keys; capture then still waits up to 5 s for
                           network idle. Default: network idle
  --auth <type>            none (default) | basic | cookie | storage-state | login
  --env-prefix <PREFIX>    credential variables prefix (default DESIGN_QA_APP):
                           basic/login → <PREFIX>_USER, <PREFIX>_PASS; cookie → <PREFIX>_COOKIE
                           ("name=value; name2=value2"); storage-state → <PREFIX>_STORAGE_STATE (path).
                           basic credentials answer only the --url origin's 401 challenges
  --login-config '<json>'  { "url", "userSelector", "passSelector", "submitSelector", "successSelector" }
  --header name=value      extra HTTP header, repeatable, sent only with requests to the app's own
                           origin (redirect hops included), never to third-party hosts: those
                           requests are made by capture itself, and a redirect off the origin is
                           followed without the headers (as is one answering a POST). EventSource
                           and WebSocket connections get no extra headers
  --allow-navigation       do not fail states that end on another URL (every state; a state's
                           "allowNavigation": false still checks it); config: capture.allowNavigation
  --states <file>          { "<state>": DRIVER } — see below
  --state <name>           capture only this state; its driver is --driver, else the one in
                           --states / --config, else none. Merged into an existing manifest in
                           --out of the same side, URL, viewport and fullPage (others are kept)
  --driver '<json>'        DRIVER for --state
  --grab <file>            { "<elementClass>": { "selector", "props": [..], "limit": 3 } }
                           (default: body, headings, text, buttons, links, inputs)
  --reduced-motion         emulate prefers-reduced-motion: reduce
  --timeout <ms>           navigation / wait / action timeout (default 30000)
  --config <file>          take defaults from design-qa.config.json: URL (app.baseUrl + route), states,
                           auth type / env prefix / login, headers, fullPage, reducedMotion,
                           allowNavigation.
                           Explicit flags win; --state <name> alone picks that state's driver
  --surface <name>         which config surface (optional when the config has only one)
  --screen <id>            multi-screen config: take the URL from surfaces.<name>.screens.<id>
                           (route for the app side, prototype for the design side)
  --side app|design        app (default): the build under test. design: a coded prototype
                           (Figma Make, Framer, v0, Lovable, static HTML incl. file: URLs,
                           localhost…) captured with the same pipeline and viewport as the
                           design source of truth; the URL defaults to surfaces.<name>.prototype
                           with --config. Use the same --states and --grab for both sides
  --out <dir>              output directory (required)
  --quiet                  only print errors
  -h, --help               show this help

DRIVER (all keys optional): { "fixture", "query": "?state=empty", "mock": { "urlPattern":
"**/api/items*", "status", "body", "delayMs", "contentType" }, "storage": { "local": {…},
"session": {…} }, "action": "hover"|"focus"|"active"|"click"|"keyboard", "selector", "keys":
"Tab Tab", "settleMs" (default 250), "viewport": { "width", "height" }, "reducedMotion",
"wait": "<selector for this state>", "allowNavigation": true }. A urlPattern glob matches the
whole URL, query string included: "**/api/items" misses /api/items?page=1 (use "**/api/items*",
or "**/api/items{,?**}"); a mock that matched no request is a warning and a degradation. A mock
with only delayMs delays the request, then lets it through; in a loading state a delayed request
is held unanswered until the capture is done. "active" holds the mouse button down on the
selector while capturing. A state whose page ends on another URL (a redirect to a sign-in page,
a script navigating away) fails, unless its driver sets "allowNavigation": true (an action meant
to navigate) or --allow-navigation is given; if every state does, the run exits 5. Scheme, host
and path are compared: an http → https upgrade of the same host, a trailing slash, the query and
the fragment (so hash routes such as #/login) do not count. Values may use \${ENV_VAR}
placeholders (a missing variable is an error); their values never reach the evidence: the
manifest keeps the drivers as written, and URLs and messages show \${ENV_VAR} instead (a bare
base URL such as \${APP_URL} stays readable). Without --states/--state a single "with-data"
state is captured.
State names that would write the same file ("with data" / "with-data", "Empty" / "empty")
are rejected. Each state runs in a fresh page and browser context seeded with the same
signed-in storage, so mocks and storage never leak between states. A state other than
with-data whose driver changes nothing (no fixture, query, mock, storage, action or viewport)
is skipped and listed under degradations instead of being captured. Loading states (named
"loading" or a synonym such as "Skeleton", exactly, or a mock delay >= 1 s) do not wait for
network idle: they wait for --wait (or the state's "wait") if given, else settle 1.5 s.
A failed or skipped state's files are deleted, so no stale evidence is left in --out.

Writes <out>/app/<state>.png, <out>/computed/<state>.json, <out>/dom/<state>.json,
<out>/motion/<state>.json and <out>/capture.json { side, url, kind, viewport, dpr, fullPage,
commit, branch, timestamp, states: { <state>: { driver, url, screenshot, computed, dom,
motion, settleMs, durationMs, scroll, warnings, degradations } }, degradations }.
--side design writes design/, design-computed/, design-dom/, design-motion/ and
design-capture.json instead (plus "source": { kind: "prototype", url, label, tool, frame }),
so both sides can share one evidence folder; compare them with scripts/compare.mjs.

computed/<state>.json: { "<elementClass>": { selector, count, inlineStyleOutliers,
samples: [ { "<prop>": "<computed value>", …, "__rect", "__visible", "__el", "__vars" } ] },
"rootTokens": { "--token": "<resolved value>" } }. Reserved keys (skip keys starting
with __ when looping over properties): __rect is the integer box covering the element in
screenshot pixels (document coordinates with --full-page, viewport coordinates otherwise;
the same when the page is not scrolled, and it may lie outside the image for elements
outside the captured area); __visible is false for zero-size, display:none or
visibility:hidden elements; __el { tag, id, classes, component (data-component or
data-ds-component), variant (data-variant), testid, role, text, selector }; __vars
{ "<prop>": ["--token", …] } names the :root custom properties whose resolved value equals
that computed value. rootTokens lists every :root custom property once per page (colours
resolved to rgb(), lengths to px). Use __rect for findings' evidence crops.

motion/<state>.json: { state, side, trigger, reducedMotion, elements: { "<elementClass>":
{ selector, count, samples: [ { transition-property, transition-duration,
transition-timing-function, transition-delay, animation-name, animation-duration,
animation-timing-function, animation-delay, animation-iteration-count, __selector } ] } },
actionTarget (the same longhands for the driver's selector, or null), animations: [ { type:
CSSTransition|CSSAnimation|Animation, target, pseudoElement, element: { elementClass, index }
| null, transitionProperty, animationName, properties, durationMs, delayMs, easing,
iterations, playState } ] from document.getAnimations() right after the state's action
(before settleMs), keyframes: { "<name>": "@keyframes … { … }" } (same-origin stylesheets) }.
Screenshots are still taken with animations disabled. A motion problem never fails a state:
it is listed under that state's degradations (and the manifest's).

Environment: DESIGN_QA_BROWSER_CHANNEL=chrome uses an installed Chrome instead of Playwright's
Chromium; DESIGN_QA_COMMIT / DESIGN_QA_BRANCH override git detection.

Exit codes: 0 ok · 1 some states failed (see capture.json) · 2 bad arguments · 3 screenshot
size differs from the viewport (device scale) · 4 browser launch failure (run
\`npx playwright install chromium\`) · 5 navigation or authentication failure`;

class StateFailure extends Error {}

/** The page ended on another URL (a redirect to a sign-in page, a script navigating away). */
class NavigationFailure extends StateFailure {
  constructor(message, finalUrl) {
    super(message);
    this.finalUrl = finalUrl;
  }
}

/** A page call that did not settle in time (a blocked main thread). */
class PageTimeout extends StateFailure {}

/** After a --wait / "wait" selector appears, how long to still wait for the network to go idle. */
const NETWORK_IDLE_AFTER_WAIT_MS = 5000;

const SIDES = ['app', 'design'];

const firstLine = (msg) => String(msg ?? '').split('\n')[0].trim();

function gitInfo(env) {
  let commit = env.DESIGN_QA_COMMIT || env.GITHUB_SHA || null;
  let branch = env.DESIGN_QA_BRANCH || env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || null;
  const git = (args) => {
    try {
      return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim() || null;
    } catch {
      return null;
    }
  };
  if (!commit) commit = git(['rev-parse', 'HEAD']);
  if (!branch) {
    const b = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    branch = b && b !== 'HEAD' ? b : null;
  }
  return { commit, branch };
}

// ---------------------------------------------------------------------------
// In-page functions (serialised by Playwright: no references to module scope)
// ---------------------------------------------------------------------------

function applyStorage(storage) {
  const put = (area, entries) => {
    try {
      for (const [k, v] of Object.entries(entries || {})) area.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
    } catch {
      // storage is unavailable on opaque documents (about:blank)
    }
  };
  put(window.localStorage, storage.local);
  put(window.sessionStorage, storage.session);
}

// Each sample keeps the flat { "<prop>": value } map and adds reserved keys:
// __rect { x, y, w, h } — integer box covering the element in screenshot pixels
// (document coordinates for full-page captures, viewport coordinates otherwise;
// identical when the page is not scrolled) — __visible (non-zero size and not
// display:none / visibility:hidden), __el (tag, id, classes, data-component /
// data-ds-component, data-variant, data-testid, role, text, outline selector) and
// __vars ({ "<prop>": ["--token", …] }: root custom properties whose resolved value
// equals the computed value). The page's root tokens are listed once under rootTokens.
function grabComputedStyles({ grab, fullPage }) {
  const offsetX = fullPage ? window.scrollX : 0;
  const offsetY = fullPage ? window.scrollY : 0;
  const outline = (el) => {
    const cls = Array.from(el.classList || []).slice(0, 3).map((c) => `.${CSS.escape(c)}`).join('');
    return `${el.tagName.toLowerCase()}${el.id ? `#${CSS.escape(el.id)}` : ''}${cls}`;
  };
  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    classes: Array.from(el.classList || []),
    component: el.getAttribute('data-component') || el.getAttribute('data-ds-component') || null,
    variant: el.getAttribute('data-variant') || null,
    testid: el.getAttribute('data-testid') || null,
    role: el.getAttribute('role') || null,
    text: String(el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    selector: outline(el),
  });

  // Root tokens: custom properties named in same-origin stylesheets or enumerable on
  // :root, resolved to computed form (colours → rgb(), lengths → px) with a probe.
  const rootTokens = {};
  const resolvedToToken = new Map();
  try {
    const names = new Set();
    const visit = (rules) => {
      for (const rule of Array.from(rules || [])) {
        try {
          if (rule.style) for (const p of Array.from(rule.style)) if (p.startsWith('--')) names.add(p);
          if (rule.cssRules) visit(rule.cssRules);
        } catch {
          // unreadable rule
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        visit(sheet.cssRules);
      } catch {
        // cross-origin stylesheet
      }
    }
    const rootCs = getComputedStyle(document.documentElement);
    for (const p of Array.from(rootCs)) if (p.startsWith('--')) names.add(p);
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;left:-9999px;top:0';
    (document.body || document.documentElement).appendChild(probe);
    for (const name of Array.from(names).sort()) {
      const raw = rootCs.getPropertyValue(name).trim();
      if (!raw) continue;
      let value = raw;
      try {
        if (CSS.supports('color', raw)) {
          probe.style.color = raw;
          value = getComputedStyle(probe).color;
        } else if (/^-?[\d.]+(px|rem|em|pt|vh|vw)$/.test(raw)) {
          probe.style.width = raw;
          value = getComputedStyle(probe).width;
        }
      } catch {
        value = raw;
      }
      rootTokens[name] = value;
      if (!resolvedToToken.has(value)) resolvedToToken.set(value, []);
      resolvedToToken.get(value).push(name);
    }
    probe.remove();
  } catch {
    // tokens are best effort
  }

  const out = {};
  for (const [cls, spec] of Object.entries(grab)) {
    let elements = [];
    try {
      elements = Array.from(document.querySelectorAll(spec.selector));
    } catch (err) {
      out[cls] = { selector: spec.selector, count: 0, samples: [], inlineStyleOutliers: 0, error: `invalid selector: ${err.message}` };
      continue;
    }
    const limit = spec.limit || 3;
    const samples = elements.slice(0, limit).map((el) => {
      const cs = getComputedStyle(el);
      const sample = {};
      const vars = {};
      for (const prop of spec.props) {
        const name = prop.startsWith('--') || prop.includes('-') ? prop : prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
        sample[prop] = cs.getPropertyValue(name).trim();
        const tokens = resolvedToToken.get(sample[prop]);
        if (tokens && sample[prop]) vars[prop] = tokens;
      }
      const r = el.getBoundingClientRect();
      const x0 = Math.floor(r.left + offsetX);
      const y0 = Math.floor(r.top + offsetY);
      sample.__rect = { x: x0, y: y0, w: Math.ceil(r.right + offsetX) - x0, h: Math.ceil(r.bottom + offsetY) - y0 };
      sample.__visible = r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse';
      sample.__el = describe(el);
      sample.__vars = vars;
      return sample;
    });
    const inlineStyleOutliers = elements.filter((el) => (el.getAttribute('style') || '').trim() !== '').length;
    out[cls] = { selector: spec.selector, count: elements.length, samples, inlineStyleOutliers };
  }
  out.rootTokens = rootTokens;
  return out;
}

const MOTION_PROPS = [
  'transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay',
  'animation-name', 'animation-duration', 'animation-timing-function', 'animation-delay', 'animation-iteration-count',
];

// Per grabbed element (same elementClass + index as computed/) the computed transition
// and animation longhands, the action target's longhands, and @keyframes text from
// same-origin stylesheets.
function grabMotion({ grab, props, actionSelector }) {
  const outline = (el) => {
    const cls = Array.from(el.classList || []).slice(0, 3).map((c) => `.${CSS.escape(c)}`).join('');
    return `${el.tagName.toLowerCase()}${el.id ? `#${CSS.escape(el.id)}` : ''}${cls}`;
  };
  const longhands = (el) => {
    const cs = getComputedStyle(el);
    const sample = {};
    for (const p of props) sample[p] = cs.getPropertyValue(p).trim();
    sample.__selector = outline(el);
    return sample;
  };
  const elements = {};
  for (const [cls, spec] of Object.entries(grab)) {
    let list = [];
    try {
      list = Array.from(document.querySelectorAll(spec.selector));
    } catch {
      list = [];
    }
    elements[cls] = { selector: spec.selector, count: list.length, samples: list.slice(0, spec.limit || 3).map(longhands) };
  }
  let actionTarget = null;
  if (actionSelector) {
    try {
      const el = document.querySelector(actionSelector);
      if (el) actionTarget = { selector: actionSelector, ...longhands(el) };
    } catch {
      actionTarget = null;
    }
  }
  const keyframes = {};
  const errors = [];
  const visit = (rules) => {
    for (const rule of Array.from(rules || [])) {
      if (typeof CSSKeyframesRule !== 'undefined' && rule instanceof CSSKeyframesRule) keyframes[rule.name] = rule.cssText;
      else if (rule.cssRules) visit(rule.cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      visit(sheet.cssRules);
    } catch (err) {
      errors.push(`stylesheet ${sheet.href || '(inline)'} unreadable: ${err.message}`);
    }
  }
  return { elements, actionTarget, keyframes, errors };
}

// document.getAnimations() right after the state's action: what actually runs.
// Each target is mapped to the grabbed element it is (elementClass + index), if any.
function collectAnimations({ grab }) {
  const outline = (el) => {
    if (!el || !el.tagName) return null;
    const cls = Array.from(el.classList || []).slice(0, 3).map((c) => `.${CSS.escape(c)}`).join('');
    return `${el.tagName.toLowerCase()}${el.id ? `#${CSS.escape(el.id)}` : ''}${cls}`;
  };
  const lists = {};
  for (const [cls, spec] of Object.entries(grab)) {
    try {
      lists[cls] = Array.from(document.querySelectorAll(spec.selector)).slice(0, spec.limit || 3);
    } catch {
      lists[cls] = [];
    }
  }
  const elementOf = (target) => {
    for (const [cls, list] of Object.entries(lists)) {
      const index = list.indexOf(target);
      if (index !== -1) return { elementClass: cls, index };
    }
    return null;
  };
  return document.getAnimations().map((a) => {
    const effect = a.effect || null;
    const timing = effect && effect.getTiming ? effect.getTiming() : {};
    const target = effect ? effect.target : null;
    const type = a.constructor && a.constructor.name ? a.constructor.name : 'Animation';
    let frames = [];
    try {
      frames = effect && effect.getKeyframes ? effect.getKeyframes() : [];
    } catch {
      frames = [];
    }
    const frameEasing = frames.length && frames[0].easing ? frames[0].easing : null;
    const kebab = (k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    const properties = [...new Set(frames.flatMap((f) => Object.keys(f).filter((k) => !['offset', 'computedOffset', 'easing', 'composite'].includes(k)).map(kebab)))];
    const iterations = timing.iterations === Infinity ? 'infinite' : timing.iterations ?? 1;
    return {
      type,
      target: outline(target),
      pseudoElement: (effect && effect.pseudoElement) || null,
      element: target ? elementOf(target) : null,
      transitionProperty: type === 'CSSTransition' ? a.transitionProperty : null,
      animationName: type === 'CSSAnimation' ? a.animationName : null,
      properties,
      durationMs: typeof timing.duration === 'number' ? timing.duration : null,
      delayMs: typeof timing.delay === 'number' ? timing.delay : 0,
      // CSS animations (and transitions in some engines) carry the timing function on the keyframes.
      easing: (!timing.easing || timing.easing === 'linear') && frameEasing ? frameEasing : timing.easing || 'linear',
      iterations,
      playState: a.playState,
    };
  });
}

function walkDom(limits) {
  const isVisible = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    return Array.from(el.getClientRects()).some((r) => r.width > 0 && r.height > 0);
  };
  const clean = (s, n = 200) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const implicitRole = (el) => {
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'label') return 'label';
    if (tag === 'th') return 'columnheader';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (['button', 'submit', 'reset'].includes(type)) return 'button';
      return 'textbox';
    }
    return tag;
  };
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const text = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
      if (text.trim()) return clean(text);
    }
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return clean(label.textContent);
    }
    return clean(el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder') || el.textContent || el.value);
  };
  const selector =
    'h1,h2,h3,h4,h5,h6,[role=heading],button,[role=button],a[href],[role=link],label,th,[role=columnheader],' +
    'input,select,textarea,[role=textbox],[role=combobox],[role=checkbox],[role=switch],[role=tab],[role=menuitem],[role=alert],[role=status]';
  const elements = [];
  for (const el of document.querySelectorAll(selector)) {
    if (elements.length >= limits.maxElements) break;
    const role = el.getAttribute('role') || implicitRole(el);
    const entry = { role, name: nameOf(el), text: clean(el.innerText), visible: isVisible(el) };
    if (role === 'heading') entry.level = Number(el.getAttribute('aria-level')) || Number(el.tagName.slice(1)) || null;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') entry.disabled = true;
    elements.push(entry);
  }
  const texts = [];
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let truncated = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue.replace(/\s+/g, ' ').trim();
    if (!text || !node.parentElement || skip.has(node.parentElement.tagName) || !isVisible(node.parentElement)) continue;
    if (texts.length >= limits.maxTexts) {
      truncated = true;
      break;
    }
    texts.push(text);
  }
  return { elements, texts, truncated };
}

// ---------------------------------------------------------------------------
// Browser steps
// ---------------------------------------------------------------------------

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (err) {
    if (!isMissingModule(err, 'playwright')) throw err;
    throw new CliError(missingDependencyMessage('playwright', err), 4);
  }
}

async function launchBrowser(chromium, env) {
  const channel = env.DESIGN_QA_BROWSER_CHANNEL || undefined;
  try {
    return await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  } catch (err) {
    throw new CliError(
      `could not launch Chromium (${firstLine(err.message)}). Run \`npx playwright install chromium\`` +
        ' (or set DESIGN_QA_BROWSER_CHANNEL=chrome to use an installed Chrome).',
      4,
    );
  }
}

// Answers (or holds) the requests a state's mock matches. `state` counts them:
// hits (requests matched), answered (responses sent or passed on) and, for a
// loading state, hold: a promise resolved when the capture is done, until which
// the request is held open so the loading UI cannot finish before the screenshot.
function mockHandler(mock, timers, state) {
  return async (route) => {
    state.hits += 1;
    try {
      if (state.hold) {
        await state.hold;
        return; // never answered: the page is being closed
      }
      if (mock.delayMs) {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, mock.delayMs);
          if (typeof t.unref === 'function') t.unref();
          timers.add(t);
        });
      }
      if (mock.status !== undefined || mock.body !== undefined) {
        const isText = typeof mock.body === 'string';
        const status = mock.status ?? 200;
        await route.fulfill({
          status,
          contentType: mock.contentType ?? (isText ? 'text/plain; charset=utf-8' : 'application/json'),
          body: status === 204 || status === 304 ? '' : isText ? mock.body : JSON.stringify(mock.body ?? null),
        });
      } else {
        // Let it through, via the app-header route (registered on the context) if any.
        await route.fallback();
      }
      state.answered += 1;
    } catch {
      // The page was closed while a delayed request was pending.
    }
  };
}

/** Redirect hops capture follows itself before re-sending a request with the app headers. */
const MAX_REDIRECTS = 20;

/**
 * Send --header / app.headers only with requests to the app's own origin, never to
 * analytics, CDN or other third-party hosts (a deployment-protection bypass secret
 * or a bearer token must not leave the app), redirect hops included. Playwright
 * copies headers given to route.continue() onto every redirect hop and never routes
 * a hop, so an app-origin request is fetched here with the headers and without
 * following redirects:
 * - not a redirect: that response is handed to the page;
 * - a redirect leaving the origin (a CDN, a sign-in host), or one answering a POST:
 *   the 3xx is handed to the page, whose browser follows it without the headers;
 * - a GET/HEAD redirect whose every hop stays on the origin (/ → /en/): the chain is
 *   walked here first, then the request is re-sent with the headers, which the
 *   browser keeps on those hops (the chain is requested twice).
 * EventSource streams never end, so they cannot be fetched here: they are sent
 * without the headers (cookies still apply), as are WebSockets, which routes never see.
 * Context routes run after the page's mock routes, so a mock answers first and a
 * let-through mock request still gets the headers.
 */
async function routeAppHeaders(context, headers, origin) {
  const entries = Object.entries(headers ?? {});
  if (!entries.length || !origin || origin === 'null') return;
  const extra = Object.fromEntries(entries.map(([k, v]) => [k.toLowerCase(), String(v)]));
  // A page answered from here has no network address, so Chromium counts it as public
  // and blocks its requests to localhost (Local Network Access): allow that for the app.
  await context.grantPermissions(['local-network-access'], { origin }).catch(() => {});
  const isHome = (url) => {
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  };
  // Does the redirect chain starting at `url` end without ever leaving the origin?
  const staysHome = async (route, url, withHeaders) => {
    let next = url;
    for (let hop = 0; next && hop < MAX_REDIRECTS; hop++) {
      if (!isHome(next)) return false;
      const response = await route.fetch({ url: next, headers: withHeaders, maxRedirects: 0, timeout: 0 });
      next = redirectLocation(response.status(), response.headers().location, next);
    }
    return !next;
  };
  await context.route('**/*', async (route) => {
    const request = route.request();
    try {
      if (!isHome(request.url()) || request.resourceType() === 'eventsource') {
        await route.continue();
        return;
      }
      const withHeaders = { ...request.headers(), ...extra };
      const response = await route.fetch({ headers: withHeaders, maxRedirects: 0, timeout: 0 });
      const next = redirectLocation(response.status(), response.headers().location, request.url());
      if (next && ['GET', 'HEAD'].includes(request.method()) && (await staysHome(route, next, withHeaders))) {
        await route.continue({ headers: withHeaders });
        return;
      }
      await route.fulfill({ response });
    } catch {
      // The page was closed while the request was pending, or the app could not be reached.
      await route.abort().catch(() => {});
    }
  });
}

async function performAction(page, driver, timeout) {
  const target = driver.selector ? page.locator(driver.selector).first() : null;
  switch (driver.action) {
    case 'hover':
      await target.hover({ timeout });
      return null;
    case 'focus':
      await target.focus({ timeout });
      return null;
    case 'click':
      await target.click({ timeout });
      return null;
    case 'active': {
      await target.scrollIntoViewIfNeeded({ timeout });
      const box = await target.boundingBox({ timeout });
      if (!box) throw new Error(`"${driver.selector}" has no visible box`);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      return async () => {
        await page.mouse.up().catch(() => {});
      };
    }
    case 'keyboard':
      if (target) await target.focus({ timeout });
      for (const key of parseKeys(driver.keys)) await page.keyboard.press(key);
      return null;
    default:
      return null;
  }
}

async function login(browser, run, auth, loginConfig, appUrl, prefix) {
  const context = await browser.newContext(run.contextOptions);
  try {
    await routeAppHeaders(context, run.headers, run.appOrigin);
    const page = await context.newPage();
    const loginUrl = new URL(loginConfig.url, appUrl).toString();
    try {
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: run.timeout });
    } catch (err) {
      throw new CliError(`login page ${run.redactUrl(loginUrl)} could not be opened: ${firstLine(run.redact(err.message))}`, 5);
    }
    await page.locator(loginConfig.userSelector).first().fill(auth.user, { timeout: run.timeout });
    await page.locator(loginConfig.passSelector).first().fill(auth.pass, { timeout: run.timeout });
    await page.locator(loginConfig.submitSelector).first().click({ timeout: run.timeout });
    if (loginConfig.successSelector) {
      await page.locator(loginConfig.successSelector).first().waitFor({ state: 'visible', timeout: run.timeout });
    } else {
      await page.waitForLoadState('networkidle', { timeout: run.timeout }).catch(() => {});
    }
    return await context.storageState();
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(
      `login failed: ${firstLine(run.redact(err.message))} (credentials come from ${prefix}_USER / ${prefix}_PASS and are never printed)`,
      5,
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/** A page call that never settles (a page blocking its main thread) fails the state instead of hanging the run. */
function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new PageTimeout(`${what} did not finish within ${ms} ms (the page may be blocking its main thread)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function captureState(browser, run, plan) {
  const { name, driver } = plan;
  const started = Date.now();
  const warnings = [];
  const degradations = [];
  const viewport = driver.viewport ?? run.viewport;
  const reduced = driver.reducedMotion ?? run.reducedMotion;
  const timers = new Set();
  const mockState = { hits: 0, answered: 0, hold: null, release: () => {} };
  if (plan.hold) mockState.hold = new Promise((resolve) => (mockState.release = resolve));
  const context = await browser.newContext({
    ...run.contextOptions,
    viewport,
    reducedMotion: reduced ? 'reduce' : 'no-preference',
    ...(run.storageState ? { storageState: run.storageState } : {}),
  });
  try {
    if (run.cookies.length) await context.addCookies(run.cookies);
    await routeAppHeaders(context, run.headers, run.appOrigin);
    const page = await context.newPage();
    if (driver.mock) await page.route(driver.mock.urlPattern, mockHandler(driver.mock, timers, mockState));
    if (driver.storage) await page.addInitScript(applyStorage, { local: driver.storage.local || {}, session: driver.storage.session || {} });

    let response;
    try {
      response = await page.goto(plan.url, { waitUntil: plan.loading ? 'domcontentloaded' : 'load', timeout: run.timeout });
    } catch (err) {
      throw new CliError(`state "${name}": could not load ${plan.safeUrl}: ${firstLine(run.redact(err.message))}`, 5);
    }
    const status = response ? response.status() : 0;
    if (status >= 400) {
      const hint = status === 401 || status === 403 ? ' — the page needs authentication (see --auth)' : '';
      throw new CliError(`state "${name}": ${plan.safeUrl} answered HTTP ${status}${hint}`, 5);
    }
    // A redirect (302 to /login) or a script navigating away is not this state: its
    // screenshot would be the sign-in page under the state's name.
    const redirected = Boolean(response?.request().redirectedFrom());
    const allowNavigation = driver.allowNavigation ?? run.allowNavigation;
    const checkLocation = (when) => {
      if (allowNavigation) return;
      const now = page.url();
      if (sameLocation(plan.url, now)) return;
      const how = redirected && when === 'on load' ? 'the server redirected' : `the page navigated away ${when}`;
      throw new NavigationFailure(
        `ended on ${now} instead of ${plan.url} (${how}); a sign-in page or another route is not this state — check --auth and the URL` +
          `, or set "allowNavigation": true if ${driver.action ? 'the action is' : 'the state is'} meant to navigate`,
        now,
      );
    };
    checkLocation('on load');

    const waitFor = driver.wait ?? run.wait;
    if (waitFor) {
      try {
        await page.locator(waitFor).first().waitFor({ state: 'visible', timeout: run.timeout });
      } catch {
        warnings.push(`"${waitFor}" was not visible within ${run.timeout} ms`);
      }
      // The selector proves the page rendered, not that its data arrived: still give
      // pending requests a bounded chance to finish (a loading state keeps its request open).
      if (!plan.loading) await page.waitForLoadState('networkidle', { timeout: Math.min(NETWORK_IDLE_AFTER_WAIT_MS, run.timeout) }).catch(() => {});
    } else if (plan.loading) {
      await page.waitForTimeout(1500);
    } else {
      try {
        await page.waitForLoadState('networkidle', { timeout: run.timeout });
      } catch {
        warnings.push(`the network did not go idle within ${run.timeout} ms`);
      }
    }

    let release = null;
    if (driver.action) {
      try {
        release = await performAction(page, driver, run.timeout);
      } catch (err) {
        throw new StateFailure(`action "${driver.action}" on "${driver.selector ?? 'page'}" failed: ${firstLine(err.message)}`);
      }
    }
    // Motion trace before settling: transitions started by the action are still running.
    const motionProblem = (what, err) => {
      if (err instanceof PageTimeout) throw err;
      const reason = `${what}: ${firstLine(run.redact(err?.message ?? err))}`;
      degradations.push({ step: `motion:${name}`, reason, impact: `Motion for state "${name}" is incomplete; check transitions by hand.` });
    };
    let animations = [];
    try {
      animations = await withTimeout(page.evaluate(collectAnimations, { grab: run.grab }), run.timeout, 'document.getAnimations()');
    } catch (err) {
      motionProblem('document.getAnimations() failed', err);
    }
    const settleMs = driver.settleMs ?? 250;
    await page.waitForTimeout(settleMs);
    checkLocation('before the screenshot');

    if (driver.mock && mockState.hits === 0) {
      const reason = `mock urlPattern "${driver.mock.urlPattern}" matched no request`;
      warnings.push(reason);
      degradations.push({
        step: `mock:${name}`,
        reason,
        impact: `State "${name}" may show the real response instead of the mocked one; fix the pattern (a glob matches the whole URL, query string included).`,
      });
    }
    if (plan.namedLoading && driver.mock && mockState.answered > 0) {
      const reason = `the mocked request was answered before the screenshot (delayMs ${driver.mock.delayMs ?? 0})`;
      warnings.push(reason);
      degradations.push({
        step: `mock:${name}`,
        reason,
        impact: `The "${name}" screenshot may show loaded content, not the loading UI; give the mock a delayMs so capture holds the request.`,
      });
    }

    const [screenshot, computed, dom, motion] = stateFiles(run.dirs, name);
    const scroll = await withTimeout(
      page.evaluate(() => ({ x: Math.round(window.scrollX), y: Math.round(window.scrollY) })),
      run.timeout,
      'reading the scroll position',
    );
    const buffer = await page.screenshot({ fullPage: run.fullPage, animations: 'disabled', caret: 'hide', timeout: run.timeout });
    const size = pngSize(buffer);
    if (size.width !== viewport.width || (!run.fullPage && size.height !== viewport.height)) {
      const why =
        size.width === viewport.width * 2
          ? ' It is 2× the viewport: the capture ran at device scale factor 2.'
          : run.fullPage && size.width > viewport.width
            ? ' The page is wider than the viewport (horizontal overflow).'
            : '';
      throw new CliError(
        `state "${name}": the screenshot is ${size.width}×${size.height} but the viewport is ${viewport.width}×${viewport.height}.${why} ` +
          'Captures must run at deviceScaleFactor 1 to match a scale-1 Figma export; never compare screenshots at different scales.',
        3,
      );
    }

    const styles = await withTimeout(page.evaluate(grabComputedStyles, { grab: run.grab, fullPage: run.fullPage }), run.timeout, 'reading computed styles');
    let motionGrab = { elements: {}, actionTarget: null, keyframes: {}, errors: [] };
    try {
      motionGrab = await withTimeout(
        page.evaluate(grabMotion, { grab: run.grab, props: MOTION_PROPS, actionSelector: driver.action ? driver.selector ?? null : null }),
        run.timeout,
        'reading transition/animation styles',
      );
    } catch (err) {
      motionProblem('reading transition/animation styles failed', err);
    }
    for (const e of motionGrab.errors) degradations.push({ step: `motion:${name}`, reason: run.redact(e), impact: 'Keyframes from that stylesheet are not listed.' });
    let ariaSnapshot = null;
    const body = page.locator('body');
    if (typeof body.ariaSnapshot === 'function') {
      try {
        ariaSnapshot = await withTimeout(body.ariaSnapshot({ timeout: 10000 }), Math.max(run.timeout, 10000), 'the accessibility snapshot');
      } catch (err) {
        if (err instanceof PageTimeout) throw err;
        warnings.push(`ariaSnapshot failed: ${firstLine(err.message)}`);
      }
    }
    const walked = await withTimeout(page.evaluate(walkDom, { maxTexts: 5000, maxElements: 2000 }), run.timeout, 'reading the DOM');
    const title = await withTimeout(page.title(), run.timeout, 'reading the page title');
    const finalUrl = page.url();
    checkLocation('during the capture');
    if (release) await release();

    // Every page read succeeded: only now write this state's files, so a failed
    // state never leaves a fresh screenshot next to stale styles (or the reverse).
    // Directories and files are created afresh: a symlink planted at one of these paths
    // (a PR checkout can commit one) is removed, never written through.
    for (const sub of Object.values(run.dirs).filter((d) => !d.endsWith('.json'))) ensureOutSubdir(run.outDir, sub);
    removeStateFiles(run.outDir, run.dirs, name);
    writeFileNoFollow(path.join(run.outDir, screenshot), buffer);
    writeJson(path.join(run.outDir, computed), styles);
    writeJson(path.join(run.outDir, dom), {
      url: run.redactUrl(finalUrl),
      title: run.redactUrl(title),
      ariaSnapshot: ariaSnapshot === null ? null : run.redactUrl(ariaSnapshot),
      ...walked,
    });
    let motionPath = motion;
    try {
      writeJson(path.join(run.outDir, motion), {
        state: name,
        side: run.side,
        trigger: driver.action ?? null,
        reducedMotion: Boolean(reduced),
        elements: motionGrab.elements,
        actionTarget: motionGrab.actionTarget,
        animations,
        keyframes: motionGrab.keyframes,
      });
    } catch (err) {
      motionPath = null;
      motionProblem('writing the motion file failed', err);
    }

    return {
      driver, url: plan.safeUrl, viewport, screenshot, computed, dom, motion: motionPath, settleMs, durationMs: Date.now() - started, scroll, warnings, degradations,
    };
  } finally {
    mockState.release();
    for (const t of timers) clearTimeout(t);
    await context.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv) {
  const { values } = parseCli(argv, {
    url: { type: 'string' },
    width: { type: 'string' },
    height: { type: 'string' },
    'full-page': { type: 'boolean' },
    wait: { type: 'string' },
    auth: { type: 'string' },
    'env-prefix': { type: 'string' },
    'login-config': { type: 'string' },
    header: { type: 'string', multiple: true },
    states: { type: 'string' },
    state: { type: 'string' },
    driver: { type: 'string' },
    grab: { type: 'string' },
    'reduced-motion': { type: 'boolean' },
    'allow-navigation': { type: 'boolean' },
    timeout: { type: 'string' },
    out: { type: 'string' },
    config: { type: 'string' },
    surface: { type: 'string' },
    screen: { type: 'string' },
    side: { type: 'string' },
    quiet: { type: 'boolean' },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const env = process.env;
  const log = values.quiet ? () => {} : (msg) => console.log(msg);
  const warn = values.quiet ? () => {} : (msg) => console.error(`warning: ${msg}`);

  const side = values.side ?? 'app';
  if (!SIDES.includes(side)) throw usageError(`--side must be app or design (got "${values.side}")`);
  if (values.surface && !values.config) throw usageError('--surface needs --config <design-qa.config.json>');
  if (values.screen && !values.config) throw usageError('--screen needs --config <design-qa.config.json>');
  const cfg = values.config
    ? configDefaults(readJsonFile(path.resolve(values.config), 'config'), values.surface ?? null, { side, screen: values.screen ?? null })
    : null;
  if (cfg && !values.url) values.url = cfg.url;
  if (side === 'design' && !values.url) {
    throw usageError('--side design needs --url <prototype-url> (or surfaces.<name>.prototype / screens.<id>.prototype in --config)');
  }
  for (const flag of ['url', 'width', 'height', 'out']) if (!values[flag]) throw usageError(`--${flag} is required (see --help)`);
  // Every ${VAR} substituted anywhere is recorded: its value stays in memory and is
  // redacted from everything written or printed (unless it is a bare base URL).
  const envUsed = new Map();
  const url = expandEnv(values.url, env, '--url', envUsed);
  // A coded prototype may be a local HTML file; the app is always served over http(s).
  const protocols = side === 'design' ? /^(https?|file):$/ : /^https?:$/;
  try {
    if (!protocols.test(new URL(url).protocol)) throw new Error('protocol');
  } catch {
    throw usageError(`--url must be an absolute ${side === 'design' ? 'http(s) or file:' : 'http(s)'} URL (got "${values.url}")`);
  }
  const width = toNumber(values.width, 'width', { min: 1, max: 10000, integer: true });
  const height = toNumber(values.height, 'height', { min: 1, max: 20000, integer: true });
  const timeout = toNumber(values.timeout ?? '30000', 'timeout', { min: 100, integer: true });
  const auth = normalizeAuthType(values.auth ?? cfg?.auth);
  const prefix = values['env-prefix'] ?? cfg?.envPrefix ?? 'DESIGN_QA_APP';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) throw usageError(`--env-prefix must be an environment variable prefix (got "${prefix}")`);
  let loginConfig = cfg?.loginConfig ? expandEnv(cfg.loginConfig, env, 'app.auth.login', envUsed) : null;
  if (values['login-config']) loginConfig = expandEnv(parseJsonArg(values['login-config'], 'login-config'), env, '--login-config', envUsed);
  if (auth === 'login') {
    const missing = ['url', 'userSelector', 'passSelector', 'submitSelector'].filter((k) => !loginConfig?.[k]);
    if (missing.length) throw usageError(`--auth login needs --login-config with ${missing.join(', ')}`);
  }
  const headers = {
    ...expandEnv(cfg?.headers ?? {}, env, 'app.headers', envUsed),
    ...parseHeaders(values.header ?? [], env, envUsed),
  };
  if (values.driver && !values.state) throw usageError('--driver needs --state <name>');
  const statesFile = values.states ? readJsonFile(path.resolve(values.states), 'states file') : cfg?.states ?? null;
  const driver = values.driver ? parseJsonArg(values.driver, 'driver') : null;
  // template: the driver as written (with ${VAR} placeholders), the only form written
  // to the manifest; driver: the expanded copy, used in memory only.
  const states = loadStates({ statesFile, stateName: values.state ?? null, driver }).map(([name, template]) => {
    const expanded = expandEnv(template, env, `state "${name}"`, envUsed);
    return { name, template, driver: expanded, warnings: checkDriver(name, expanded) };
  });
  const grab = checkGrab(values.grab ? readJsonFile(path.resolve(values.grab), 'grab file') : DEFAULT_GRAB);
  const wait = values.wait ? expandEnv(values.wait, env, '--wait', envUsed) : null;
  const fullPage = Boolean(values['full-page'] ?? cfg?.fullPage);
  const outDir = path.resolve(values.out);
  const credentials = resolveAuth(auth, prefix, env, url);
  if (credentials.storageStatePath && !existsSync(credentials.storageStatePath)) {
    throw usageError(`${prefix}_STORAGE_STATE points to a missing file: ${credentials.storageStatePath}`);
  }
  // Header values long enough to be tokens are scrubbed too.
  const headerSecrets = Object.values(headers).map(String).filter((v) => v.length >= 8);
  const envEntries = secretEnvEntries(envUsed);
  const redact = makeRedactor({ secrets: [...credentials.secrets, ...headerSecrets], envEntries });
  // URLs and page text keep short credential values (a user name may be a path segment).
  const redactUrl = makeRedactor({ secrets: [...credentials.secrets, ...headerSecrets].filter((s) => String(s).length >= 8), envEntries });
  const safeUrl = redactUrl(url);
  const skipped = states.filter((s) => !isDrivable(s.name, s.driver));
  const plans = states
    .filter((s) => isDrivable(s.name, s.driver))
    .map((s) => {
      const stateUrl = buildStateUrl(url, s.driver, s.name);
      return {
        ...s,
        url: stateUrl,
        safeUrl: redactUrl(stateUrl),
        loading: isLoadingState(s.name, s.driver),
        namedLoading: exactStateName(s.name) === 'loading',
        hold: holdsMock(s.name, s.driver),
      };
    });

  const kind = appKind(url);
  const { commit, branch } = gitInfo(env);
  const dirs = side === 'design'
    ? { shots: 'design', computed: 'design-computed', dom: 'design-dom', motion: 'design-motion', manifest: 'design-capture.json' }
    : { shots: 'app', computed: 'computed', dom: 'dom', motion: 'motion', manifest: 'capture.json' };
  const manifestFile = path.join(outDir, dirs.manifest);
  const manifest = {
    side,
    ...(side === 'design' ? { source: designSource(safeUrl, { frame: { width, height } }) } : {}),
    url: safeUrl,
    kind,
    viewport: { width, height },
    dpr: 1,
    fullPage,
    commit,
    branch,
    timestamp: new Date().toISOString(),
    states: {},
    degradations: [],
  };
  // --state <name> re-captures one state into an existing evidence folder: merge it
  // into the previous manifest instead of dropping every other state.
  let previous = null;
  if (values.state && existsSync(manifestFile)) {
    try {
      previous = JSON.parse(readFileSync(manifestFile, 'utf8'));
    } catch {
      warn(`${displayPath(manifestFile)} is not readable JSON; writing a fresh manifest with only "${values.state}"`);
    }
  }
  const finish = () => {
    // Keep the manifest in the order the states were requested (skipped ones included).
    manifest.states = Object.fromEntries(states.map(({ name }) => [name, manifest.states[name]]).filter(([, v]) => v));
    let out = manifest;
    if (previous) {
      const merged = mergeManifest(previous, manifest, states.map(({ name }) => name));
      if (merged.mismatch) {
        warn(`${displayPath(manifestFile)} was captured with another ${merged.mismatch}; replaced by a fresh manifest with only this run's states`);
      } else if (merged.kept.length) {
        log(`kept ${merged.kept.length} state(s) from the previous ${dirs.manifest}: ${merged.kept.join(', ')}`);
      }
      out = merged.manifest;
    }
    unlinkSymlink(manifestFile);
    writeJson(manifestFile, out);
    return out;
  };
  const failedEntry = (plan, message) => ({
    driver: plan.template,
    url: plan.safeUrl,
    screenshot: null,
    computed: null,
    dom: null,
    motion: null,
    settleMs: plan.driver.settleMs ?? 250,
    durationMs: 0,
    warnings: plan.warnings.map(redact),
    error: message,
  });

  ensureDir(outDir);
  for (const { name, template, warnings } of skipped) {
    const reason = 'no runtime driver (needs a fixture, query, mock, storage, action or viewport)';
    removeStateFiles(outDir, dirs, name);
    manifest.states[name] = {
      driver: template,
      url: null,
      screenshot: null,
      computed: null,
      dom: null,
      motion: null,
      settleMs: null,
      durationMs: 0,
      warnings: [...warnings.map(redact), `not captured: ${reason}`],
      skipped: true,
    };
    manifest.degradations.push({ step: `capture:${name}`, reason, impact: `State "${name}" cannot be verified (CANNOT_VERIFY).` });
    log(`skipped ${name}: ${reason}`);
  }

  if (!plans.length) {
    finish();
    log(`Nothing to capture; wrote ${displayPath(manifestFile)}`);
    return 0;
  }
  const { chromium } = await loadPlaywright();
  const browser = await launchBrowser(chromium, env);
  const onSignal = (signal) => {
    browser.close().catch(() => {}).finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const appOrigin = new URL(url).origin;
  const contextOptions = {
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    ignoreHTTPSErrors: kind === 'local',
    // Basic credentials are bound to the captured URL's origin (resolveAuth): a
    // third-party frame or image answering 401 never gets them.
    ...(credentials.httpCredentials ? { httpCredentials: credentials.httpCredentials } : {}),
  };
  const run = {
    contextOptions,
    // Extra headers go to the app's origin only (routeAppHeaders), never extraHTTPHeaders.
    headers,
    appOrigin,
    viewport: { width, height },
    reducedMotion: Boolean(values['reduced-motion'] ?? cfg?.reducedMotion),
    // A state's own "allowNavigation" wins over this run-wide default.
    allowNavigation: Boolean(values['allow-navigation'] ?? cfg?.allowNavigation),
    storageState: credentials.storageStatePath ?? null,
    cookies: credentials.cookies,
    redact,
    redactUrl,
    wait,
    timeout,
    fullPage,
    grab,
    outDir,
    side,
    dirs,
  };

  let failures = 0;
  let final = manifest;
  try {
    if (auth === 'login') {
      try {
        run.storageState = await login(browser, run, credentials, loginConfig, url, prefix);
      } catch (err) {
        manifest.degradations.push({ step: 'capture:login', reason: err.message, impact: 'No state was captured.' });
        throw err;
      }
    }
    let navigationFailures = 0;
    let lastFinalUrl = null;
    for (const plan of plans) {
      try {
        const result = await captureState(browser, run, plan);
        result.driver = plan.template;
        result.warnings = [...plan.warnings, ...result.warnings].map(redact);
        result.degradations = result.degradations.map((d) => ({ ...d, reason: redact(d.reason) }));
        manifest.states[plan.name] = result;
        manifest.degradations.push(...result.degradations);
        const notes = result.warnings.length ? ` — ${result.warnings.length} warning(s): ${result.warnings.join('; ')}` : '';
        log(`captured ${plan.name} → ${result.screenshot} (${result.viewport.width}×${result.viewport.height}, ${result.durationMs} ms)${notes}`);
      } catch (err) {
        // No stale evidence: a state that failed has no files, whatever an earlier run left.
        removeStateFiles(outDir, dirs, plan.name);
        if (err instanceof CliError) {
          err.message = redact(err.message);
          manifest.states[plan.name] = failedEntry(plan, firstLine(err.message));
          manifest.degradations.push({ step: `capture:${plan.name}`, reason: err.message, impact: 'Capture stopped; later states were not captured.' });
          throw err;
        }
        failures += 1;
        if (err instanceof NavigationFailure) {
          navigationFailures += 1;
          lastFinalUrl = err.finalUrl;
        }
        const message = firstLine(redact(err instanceof StateFailure ? err.message : err?.message ?? err));
        manifest.states[plan.name] = failedEntry(plan, message);
        manifest.degradations.push({ step: `capture:${plan.name}`, reason: message, impact: `No screenshot for state "${plan.name}".` });
        console.error(`state "${plan.name}" failed: ${message}`);
      }
    }
    if (navigationFailures === plans.length) {
      const message =
        `every state ended on another page (last: ${redactUrl(lastFinalUrl)}) instead of ${safeUrl}: ` +
        'an authentication or routing problem — check --auth and its credentials, and the URL' +
        ' (when the app always redirects, say to a locale prefix, capture the final URL or pass --allow-navigation)';
      manifest.degradations.push({ step: 'capture:navigation', reason: message, impact: 'No state was captured.' });
      throw new CliError(message, 5);
    }
  } finally {
    final = finish();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await browser.close().catch(() => {});
  }
  const all = Object.values(final.states);
  const captured = all.filter((st) => st.screenshot).length;
  log(`Wrote ${displayPath(manifestFile)} (${captured}/${all.length} states captured)`);
  return failures ? 1 : 0;
}

runMain(import.meta.url, main);
