#!/usr/bin/env node
// Capture the app (or, with --side design, a coded prototype) in every state with
// Playwright Chromium at deviceScaleFactor 1: one whole-page screenshot (inner scroll
// panels unrolled), computed styles, a DOM snapshot and a motion trace per state +
// capture.json / design-capture.json.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CliError, displayPath, ensureDir, oneLine, parseCli, parseJsonArg, readJsonFile, runMain, toNumber, usageError, writeJson } from './lib/args.mjs';
import {
  DEFAULT_GRAB,
  buildStateUrl,
  checkDriver,
  checkGrab,
  classifySignIn,
  clippedMessage,
  compileSignInPattern,
  configDefaults,
  describePreCapture,
  ensureOutSubdir,
  expandEnv,
  fitViewport,
  holdsMock,
  hostOf,
  isDrivable,
  isLoadingState,
  loadStates,
  makeRedactor,
  missingSessionMessage,
  mergeManifest,
  mergePreCapture,
  normalizeAuthType,
  normalizePreCapture,
  parseHeaders,
  preCaptureCss,
  preCaptureFor,
  parseKeys,
  redirectLocation,
  removeStateFiles,
  resolveAuth,
  sameLocation,
  scaleFactor,
  secretEnvEntries,
  signInHelp,
  stateFiles,
  unlinkSymlink,
  writeFileNoFollow,
} from './lib/capture-helpers.mjs';
import { auditSelectors, collectAuditElements } from './lib/audit-collect.mjs';
import { isMissingModule, missingDependencyMessage } from './lib/deps.mjs';
import { assertRunOwnsOutput } from './lib/pass.mjs';
import { pngSize } from './lib/png.mjs';
import { exactStateName } from './lib/state-discovery.mjs';
import { appKind, designSource } from './lib/target-url.mjs';

const HELP = `Capture the app in each state (screenshot + computed styles + DOM snapshot + motion).

Usage:
  node scripts/capture.mjs --url <url> --width <w> --height <h> --out <dir> [options]
  node scripts/capture.mjs --config design-qa.config.json [--surface <name>] --width <w> --height <h> --out <dir> [options]
  node scripts/capture.mjs --side design --url <prototype-url> --width <w> --height <h> --out <dir> [options]
  node scripts/capture.mjs --probe (--url <url> | --config design-qa.config.json [--surface <name>]) [auth options]

Options:
  --url <url>              page to capture; may contain {fixture}/{id} (replaced by a state's
                           "fixture" driver value, otherwise ?fixture=<value> is appended)
  --width <px>, --height <px>
                           the design frame size; captures run at DPR 1. It sets the layout
                           viewport: exactly W×H for a frame up to --max-viewport-height tall,
                           else W × --max-viewport-height. The screenshot always covers the whole
                           page: its full scroll height and width, after scrolling through it so
                           lazy content renders and unrolling inner scroll panels (an app shell's
                           main panel) by growing the viewport to their content
  --max-viewport-height <px>
                           tallest frame laid out as one screen (default 1440, or 1000 for
                           frames narrower than 768 px); config: capture.maxViewportHeight
  --viewport-only          opt-out: screenshot only the layout viewport (above the fold), no
                           unrolling; config capture.viewportOnly; a state's "viewportOnly" wins
  --full-page              accepted for compatibility: the whole page is the default
  --wait <selector>        wait until visible before capturing: an element that proves the data
                           rendered (a row, not the page heading), present in every state, else
                           use per-state "wait" keys; capture then still waits up to 5 s for
                           network idle. Default: network idle
  --auth <type>            none (default) | basic | cookie | storage-state | login
  --env-prefix <PREFIX>    credential variables prefix (default DESIGN_QA_APP):
                           basic/login → <PREFIX>_USER, <PREFIX>_PASS; cookie → <PREFIX>_COOKIE
                           ("name=value; name2=value2"); storage-state → <PREFIX>_STORAGE_STATE (path),
                           else the config's app.auth.storageState (a PATH saved by
                           setup.mjs save-session; ~ and \${ENV} expanded, relative to the config's
                           folder; app side only). Neither, or a missing file: exit 2 with the
                           path and "sign in again with setup.mjs save-session". The session
                           file's content is never printed. basic credentials answer only the
                           --url origin's 401 challenges
  --login-config '<json>'  { "url", "userSelector", "passSelector", "submitSelector", "successSelector" }
  --header name=value      extra HTTP header, repeatable, sent only with requests to the app's own
                           origin (redirect hops included), never to third-party hosts: those
                           requests are made by capture itself, and a redirect off the origin is
                           followed without the headers (as is one answering a POST). EventSource
                           and WebSocket connections get no extra headers
  --allow-navigation       do not fail states that end on another URL of the same host (a state's
                           own "allowNavigation" wins; only its true allows another host, with a
                           warning); config: capture.allowNavigation. Sign-in pages are still detected
  --signed-in-selector <s> an element only the signed-in app renders (nav, user menu), checked in
                           every state after its driver: not visible = a sign-in page; visible =
                           never one, whatever fields it shows (config: app.auth.signedInSelector)
  --sign-in-url <regex>    final URLs matching it (case-insensitive) are sign-in pages
                           (config: app.auth.signInUrlPattern)
  --pre-capture '<json>'   { "localStorage": {…}, "sessionStorage": {…}, "hide": [sel],
                           "remove": [sel], "click": [sel] } applied to every state (an entry
                           { "selector", "states": [names] } to those states only), merged over
                           the config's app.preCapture + surfaces.<name>.preCapture (app side
                           only; with --side design only this flag applies)
  --probe                  load the target once with the auth, headers and storage state, print
                           { reachable, status, finalUrl, signIn, signedIn, title, detail } and
                           capture nothing (--width/--height optional, --out not needed). Exit 0
                           reachable and not a sign-in page · 6 sign-in needed · 5 unreachable or
                           an HTTP error. Use it instead of curl: a sign-in page is not an outage
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
                           auth type / env prefix / login / signedInSelector / signInUrlPattern,
                           headers, preCapture, viewportOnly, maxViewportHeight, reducedMotion,
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
  --run <id>               this pass's run id (default: DESIGN_QA_RUN_ID); refused (exit 5) when
                           the report folder --out lies in (its nearest ancestor with a run lock)
                           belongs to another run; an --out under no locked folder is not checked
  --quiet                  only print errors
  -h, --help               show this help

DRIVER (all keys optional): { "fixture", "query": "?state=empty", "mock": { "urlPattern":
"**/api/items*", "status", "body", "delayMs", "contentType" }, "storage": { "local": {…},
"session": {…} }, "action": "hover"|"focus"|"active"|"click"|"keyboard", "selector", "keys":
"Tab Tab", "settleMs" (default 250), "viewport": { "width", "height" }, "reducedMotion",
"wait": "<selector for this state>", "allowNavigation": true, "allowSignIn": true,
"viewportOnly": true, "source": "<file:line>" (in code, no runtime driver: not captured,
CANNOT_VERIFY) }. A
urlPattern glob matches the whole URL, query string included: "**/api/items" misses
/api/items?page=1 (use "**/api/items*", or "**/api/items{,?**}"); a mock that matched no
request is a warning and a degradation. A mock
with only delayMs delays the request, then lets it through; in a loading state a delayed request
is held unanswered until the capture is done. "active" holds the mouse button down on the
selector while capturing. A state whose page ends on another URL (a redirect, a script
navigating away) fails, unless its driver sets "allowNavigation": true (an action meant
to navigate) or --allow-navigation is given; if every state does, the run exits 5. Scheme, host
and path are compared: an http → https upgrade of the same host, a trailing slash, the query and
the fragment do not count.
Sign-in pages (a redirect to a sign-in URL, #/login, a sign-in, magic-link or "session
expired" page, HTTP 401/403, --sign-in-url, a --signed-in-selector not visible) are never
saved. with-data (else the first state) is captured first: a sign-in page there exits 6 with
how to supply a session; a later one marks that state (failure kind sign-in) and the run goes
on (exit 1), and after a signed-in with-data a password field alone does not make one (a
change-password dialog). A state meant to show a sign-in page sets "allowSignIn": true.
Values may use \${ENV_VAR} placeholders (a missing variable is an error); their values never
reach the evidence: the manifest keeps the drivers as written, and URLs and messages show
\${ENV_VAR} instead (a bare base URL such as \${APP_URL} stays readable). Without
--states/--state a single "with-data" state is captured.
State names that would write the same file ("with data" / "with-data", "Empty" / "empty")
are rejected. Each state runs in a fresh page and browser context seeded with the same
signed-in storage, so mocks and storage never leak between states. A state other than
with-data whose driver changes nothing (no fixture, query, mock, storage, action or viewport)
is skipped and listed under degradations instead of being captured. Loading states (named
"loading" or a synonym such as "Skeleton", exactly, or a mock delay >= 1 s) do not wait for
network idle: they wait for --wait (or the state's "wait") if given, else settle 1.5 s.
A failed or skipped state's files are deleted, so no stale evidence is left in --out.

Writes <out>/app/<state>.png, <out>/computed/<state>.json, <out>/dom/<state>.json,
<out>/motion/<state>.json, <out>/audit/<state>.json and <out>/capture.json { side, url, kind,
frame, viewport, dpr, fullPage, viewportOnly, maxViewportHeight, preCapture, signInChecks,
commit, branch, timestamp, failure, states: { <state>: { driver, url, frame, viewport,
fullPage, page, size, unrolled, clipped, partial, screenshot, computed, dom, motion, audit,
sameAs, requests, settleMs, durationMs, scroll, signedIn, preCapture, warnings, degradations } },
degradations }.
requests (app side): the URL paths of the XHR / fetch requests the page made to its own
origin while the state loaded (at most 20; no query strings, no values, no other hosts):
what a state's mock "urlPattern" can name (e.g. "**/api/orders*").
audit/<state>.json (design-audit/<state>.json with --side design; compact JSON): every
rendered element of the unrolled
whole page as lib/audit-collect.mjs records it (computed styles, authored var() tokens,
library selector matches, rects in screenshot pixels), read after the state's action without
moving the mouse; the input of scripts/ds-audit.mjs. Its selectors come from the config's
designSystem.libraries and componentCatalog. audit is null for a failed or skipped state, and
when the collector fails (a degradation "audit:<state>"; the state itself is kept).
sameAs: the with-data state's id when this state's screenshot is exactly the with-data one
(same PNG bytes; its driver changed nothing; a plain warning says so), else null. frame is the --width/--height asked
for, viewport the layout viewport, page the page's full scroll size in CSS px after
unrolling, size the PNG written; unrolled: [{ selector, axis: "y", addedPx }] panels opened
up; clipped: [{ selector, axis: "x"|"y", hiddenPx, rect }] scroll panels whose content the
screenshot still hides (sideways scrollers are never unrolled), rect in screenshot pixels,
also printed as warnings on stderr. partial: [] or why only part of the page is in the
screenshot, each also a "capture-coverage:<state>" degradation: a panel left as it scrolls
(unrolling it showed little content, or moved what is level with it on a screen-high frame),
an endless page cut once it grew by 2× the frame's height. Whole-page captures use document
coordinates everywhere. preCapture lists storage keys and selectors, never values; per state
{ clicked, removed, matched: [{ selector, kind, count, areaPx, rects }] }.
A failed state has screenshot null, error and failure { kind: sign-in | navigation | http |
unreachable | stopped | error, finalUrl, detail }; failure at the top is what stopped the run.
--side design writes design/, design-computed/, design-dom/, design-motion/, design-audit/ and
design-capture.json instead (plus "source": { kind: "prototype", url, label, tool, frame }),
so both sides can share one evidence folder; compare them with scripts/compare.mjs.

computed/<state>.json: { "<elementClass>": { selector, count, inlineStyleOutliers,
samples: [ { "<prop>": "<computed value>", …, "__rect", "__visible", "__el", "__vars" } ] },
"rootTokens": { "--token": "<resolved value>" } }. Reserved keys (skip keys starting
with __ when looping over properties): __rect is the integer box covering the element in
screenshot pixels (document coordinates for the whole-page capture, viewport coordinates
with --viewport-only; it may lie outside the image for elements outside the captured
area, such as rows hidden in a clipped panel); __visible is false for zero-size, display:none or
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
CSSTransition|CSSAnimation|Animation, target, selector (the element's path, as in audit/),
rect (its box in page pixels), pseudoElement, element: { elementClass, index } | null, transitionProperty, animationName, properties, durationMs, delayMs, easing,
iterations, playState } ] from document.getAnimations() right after the state's action
(before settleMs), keyframes: { "<name>": "@keyframes … { … }" } (same-origin stylesheets) }.
Screenshots are still taken with animations disabled. A motion problem never fails a state:
it is listed under that state's degradations (and the manifest's).

Environment: DESIGN_QA_UNROLL_MAX_HEIGHT caps how tall the viewport may grow while unrolling
scroll panels (default 16000 px). DESIGN_QA_BROWSER_CHANNEL=chrome uses an installed Chrome instead of Playwright's
Chromium; DESIGN_QA_COMMIT / DESIGN_QA_BRANCH override git detection.

Exit codes: 0 ok · 1 some states failed (see capture.json) · 2 bad arguments · 3 the
screenshot is an integer multiple of the page or viewport (device scale) · 4 browser
launch failure (run \`npx playwright install chromium\`) · 5 unreachable, HTTP error, login flow failure, or every
state ended on another page; or another run owns the report folder (--run) · 6 with-data (else the first state) landed on a sign-in page: the
target needs a signed-in session`;

class StateFailure extends Error {}

/** The page ended on another URL (a redirect to a sign-in page, a script navigating away). */
class NavigationFailure extends StateFailure {
  constructor(message, finalUrl) {
    super(message);
    this.finalUrl = finalUrl;
  }
}

/** The page is a sign-in page, not the app: the session is missing or expired. Stops the run (exit 6). */
class SignInFailure extends StateFailure {
  constructor(message, finalUrl, detail) {
    super(message);
    this.finalUrl = finalUrl;
    this.detail = detail;
  }
}

/** A page call that did not settle in time (a blocked main thread). */
class PageTimeout extends StateFailure {}
/** Data request paths recorded per state (capture.json states.<state>.requests). */
const MAX_REQUESTS = 20;

/** Exit code of a run (or probe) that landed on a sign-in page. */
const EXIT_SIGN_IN = 6;

/** Pre-capture clicks: how long to wait for a visible dismiss button to take the click. */
const PRE_CAPTURE_CLICK_MS = 5000;

/** Full-page scroll-through: at most this many screens, this long apart. */
const SCROLL_STEPS = 60;
const SCROLL_STEP_MS = 100;

/** Inner scroll containers: overflow below this many px is rounding, not hidden content. */
const MIN_HIDDEN_PX = 8;
/** Unrolling: at most this many rounds, and the viewport never grows past this height. */
const UNROLL_ROUNDS = 6;
const UNROLL_MAX_HEIGHT = 16000;
/** An unrolled panel whose gained area is less than this share content is left as it scrolls. */
const MIN_CONTENT_SHARE = 0.5;
/** Endless pages: the page may grow by this many design-frame heights while scrolled through. */
const MAX_GROWTH_FRAMES = 2;

/** DESIGN_QA_UNROLL_MAX_HEIGHT (an integer ≥ 100) or the default. */
function unrollMaxHeight(env) {
  const raw = env.DESIGN_QA_UNROLL_MAX_HEIGHT;
  if (raw === undefined || raw === '') return UNROLL_MAX_HEIGHT;
  return toNumber(raw, 'DESIGN_QA_UNROLL_MAX_HEIGHT', { min: 100, max: 100000, integer: true });
}

/** After a --wait / "wait" selector appears, how long to still wait for the network to go idle. */
const NETWORK_IDLE_AFTER_WAIT_MS = 5000;

const SIDES = ['app', 'design'];

const firstLine = (msg) => String(msg ?? '').split('\n')[0].trim();
const px = (n) => Math.round(n).toLocaleString('en-US');

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

// Init script: only the top document of the app's own origin gets the values (never a
// third-party frame, which could read them); file: prototypes have an opaque origin.
function applyStorage(storage) {
  if (window !== window.top) return;
  if (storage.origin && storage.origin !== 'null' && location.origin !== storage.origin) return;
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

// preCapture hide/remove as a constructed style sheet: in place from the first paint (no
// layout jump), allowed by a Content-Security-Policy that blocks inline <style>. Called as
// an init script and again before the screenshot (idempotent).
function installPreCaptureCss({ css, origin }) {
  if (window !== window.top) return false;
  if (origin && origin !== 'null' && location.origin !== origin) return false;
  try {
    if (window.__designQaSheet && document.adoptedStyleSheets.includes(window.__designQaSheet)) return true;
    const sheet = window.__designQaSheet || new CSSStyleSheet();
    sheet.replaceSync(css);
    window.__designQaSheet = sheet;
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return true;
  } catch {
    return false;
  }
}

// preCapture hide/remove: per matching selector, its elements and their area in screenshot
// pixels, read with the sheet off for a moment (display: none has no box).
function measureHidden({ hide, remove, fullPage }) {
  const sheet = window.__designQaSheet;
  if (sheet) sheet.disabled = true;
  const ox = fullPage ? window.scrollX : 0;
  const oy = fullPage ? window.scrollY : 0;
  const out = [];
  for (const [kind, list] of [['hide', hide], ['remove', remove]]) {
    for (const selector of list) {
      let els = [];
      try {
        els = Array.from(document.querySelectorAll(selector));
      } catch {
        // an invalid selector matches nothing
      }
      const rects = els
        .filter((el) => !els.some((o) => o !== el && o.contains(el)))
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width && r.height)
        .map((r) => ({ x: Math.round(r.left + ox), y: Math.round(r.top + oy), w: Math.round(r.width), h: Math.round(r.height) }));
      if (els.length) out.push({ selector, kind, count: els.length, areaPx: rects.reduce((n, r) => n + r.w * r.h, 0), rects: rects.slice(0, 5) });
    }
  }
  if (sheet) sheet.disabled = false;
  return out;
}

// preCapture remove: take the elements out of the DOM right before the page is read, so the
// screenshot, computed styles and DOM outline do not carry them. → elements removed.
function removeElements(selectors) {
  let removed = 0;
  for (const selector of selectors) {
    try {
      for (const el of document.querySelectorAll(selector)) {
        el.remove();
        removed += 1;
      }
    } catch {
      // an invalid selector removes nothing
    }
  }
  return removed;
}

// Full-page captures: scroll one screen at a time to the bottom so lazy-loaded and
// virtualised content renders, then back to the top. The page may grow while scrolling;
// once it has grown by more than maxGrowth it is endless (infinite scroll): stop, and
// `limit` is the height to capture.
async function scrollThrough({ maxSteps, stepMs, maxGrowth }) {
  const root = document.scrollingElement || document.documentElement;
  const to = (top) => window.scrollTo({ top, left: 0, behavior: 'instant' });
  const limit = root.scrollHeight + maxGrowth;
  let y = 0;
  let steps = 0;
  let capped = false;
  while (steps < maxSteps) {
    const bottom = root.scrollHeight - window.innerHeight;
    if (y >= bottom) break;
    if (root.scrollHeight > limit) {
      capped = true;
      break;
    }
    y = Math.min(y + Math.max(200, window.innerHeight), bottom);
    to(y);
    steps += 1;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  to(0);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return { steps, complete: steps < maxSteps, capped, limit, height: root.scrollHeight };
}

// Scroll containers other than the document whose content overflows them: an app shell's
// main panel (overflow: auto inside a 100vh body), a wide table's sideways scroller. Each
// element gets a stable id (window.__designQaScroll) so later calls can find it again
// without touching the DOM. `main`: it overflows vertically and covers a large share of
// the layout viewport (≥ 40 % of its width and height), so it holds the page's content.
// An element with overflow hidden or clip counts only when it is main-sized, and only
// vertically (`cut`: a custom or virtual scroller that moves its content by script); a
// carousel track or a truncated card is not reported. <html> is left out: the document's
// own overflow is in the whole-page screenshot even when it is hidden.
// rect: CSS px, viewport coordinates; scroll: the window's scroll offset.
function findScrollContainers({ layout, minHidden }) {
  const registry = window.__designQaScroll || (window.__designQaScroll = []);
  const root = document.scrollingElement || document.documentElement;
  const scrolls = (v) => v === 'auto' || v === 'scroll' || v === 'overlay';
  const cuts = (v) => v === 'hidden' || v === 'clip';
  const outline = (el) => {
    const cls = Array.from(el.classList || []).slice(0, 3).map((c) => `.${CSS.escape(c)}`).join('');
    const base = `${el.tagName.toLowerCase()}${el.id ? `#${CSS.escape(el.id)}` : ''}${cls}`;
    if (el.id) return base;
    try {
      const all = document.querySelectorAll(base);
      if (all.length > 1) return `${base}:nth-of-type(${Array.from(el.parentElement?.children || []).filter((c) => c.tagName === el.tagName).indexOf(el) + 1})`;
    } catch {
      // keep the outline
    }
    return base;
  };
  const out = [];
  for (const el of document.querySelectorAll('body, body *')) {
    if (el === root || /^(TEXTAREA|SELECT|INPUT|IFRAME|OPTION)$/.test(el.tagName)) continue;
    const hiddenY = el.scrollHeight - el.clientHeight;
    const hiddenX = el.scrollWidth - el.clientWidth;
    if (hiddenY <= minHidden && hiddenX <= minHidden) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 32 || r.height < 32) continue;
    const large = r.width >= 0.4 * layout.width && r.height >= 0.4 * layout.height;
    const cut = large && cuts(cs.overflowY) && hiddenY > minHidden;
    const y = (scrolls(cs.overflowY) && hiddenY > minHidden) || cut;
    const x = scrolls(cs.overflowX) && hiddenX > minHidden;
    if (!x && !y) continue;
    let id = registry.indexOf(el);
    if (id === -1) id = registry.push(el) - 1;
    out.push({
      id,
      selector: outline(el),
      hiddenY: y ? hiddenY : 0,
      hiddenX: x ? hiddenX : 0,
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      main: y && large,
      cut,
    });
  }
  return { containers: out, scroll: { x: window.scrollX, y: window.scrollY } };
}

// Lazy content inside scroll containers: scroll each one through to its bottom, a
// screen at a time, then back to its top.
async function scrollContainersThrough({ ids, maxSteps, stepMs }) {
  for (const id of ids) {
    const el = (window.__designQaScroll || [])[id];
    if (!el || !el.isConnected) continue;
    let steps = 0;
    while (steps < maxSteps && el.scrollTop < el.scrollHeight - el.clientHeight - 1) {
      const before = el.scrollTop;
      el.scrollTop = Math.min(el.scrollTop + Math.max(100, el.clientHeight), el.scrollHeight - el.clientHeight);
      if (el.scrollTop <= before) break; // overflow: clip, or a script holding it in place
      steps += 1;
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
    el.scrollTop = 0;
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

// Last resort for a container a taller viewport does not unroll (a fixed-height panel):
// let it take its content's height, and let every ancestor that would then clip it
// grow too. Inline !important styles on those elements only. → selectors changed.
// The previous inline values are kept per id (window.__designQaUndo) for undoUnroll.
function unrollWithStyles({ ids }) {
  const changed = [];
  const undo = window.__designQaUndo || (window.__designQaUndo = {});
  for (const id of ids) {
    const el = (window.__designQaScroll || [])[id];
    if (!el || !el.isConnected) continue;
    const saved = (undo[id] = []);
    const set = (target, props) => {
      for (const [k, v] of Object.entries(props)) {
        saved.push([target, k, target.style.getPropertyValue(k), target.style.getPropertyPriority(k)]);
        target.style.setProperty(k, v, 'important');
      }
    };
    set(el, { height: 'auto', 'max-height': 'none', 'overflow-y': 'visible', 'flex-shrink': '0', 'flex-basis': 'auto' });
    changed.push(id);
    for (let a = el.parentElement; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (a.scrollHeight > a.clientHeight + 1 && (cs.overflowY !== 'visible' || a === document.body || a === document.documentElement)) {
        set(a, { height: 'auto', 'max-height': 'none', 'overflow-y': 'visible' });
      }
    }
  }
  return changed;
}

function undoUnroll({ ids }) {
  for (const id of ids) {
    for (const [el, k, v, p] of ((window.__designQaUndo || {})[id] || []).reverse()) {
      if (v) el.style.setProperty(k, v, p);
      else el.style.removeProperty(k);
    }
  }
}

// Before unrolling: where each element level with the containers (not in or around them) is.
function markChrome({ ids }) {
  const boxes = ids.map((id) => (window.__designQaScroll || [])[id]).filter((el) => el && el.isConnected);
  const rects = boxes.map((el) => el.getBoundingClientRect());
  const top = Math.min(...rects.map((r) => r.top));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  const marks = [];
  for (const el of document.querySelectorAll('body *')) {
    if (marks.length >= 3000) break;
    if (boxes.some((c) => c.contains(el) || el.contains(c))) continue;
    const r = el.getBoundingClientRect();
    if (r.width && r.height && r.top < bottom && r.bottom > top) marks.push([el, r.top + window.scrollY]);
  }
  window.__designQaChrome = marks;
}

// The element beside the containers that moved furthest since markChrome (> minPx), or null.
function movedChrome({ minPx }) {
  let worst = null;
  for (const [el, y] of window.__designQaChrome || []) {
    const px = el.isConnected ? el.getBoundingClientRect().top + window.scrollY - y : 0;
    if (Math.abs(px) > minPx && (!worst || Math.abs(px) > Math.abs(worst.px))) worst = { el, px };
  }
  if (!worst) return null;
  const cls = Array.from(worst.el.classList || []).slice(0, 2).map((c) => `.${CSS.escape(c)}`).join('');
  return { selector: `${worst.el.tagName.toLowerCase()}${worst.el.id ? `#${CSS.escape(worst.el.id)}` : ''}${cls}`, px: Math.round(worst.px) };
}

// Share (0–1) of a container's band from `from` to `to` px holding text, images, controls
// or painted boxes not spanning the whole band (a virtual list's spacer does).
function exposedContent({ id, from, to }) {
  const el = (window.__designQaScroll || [])[id];
  if (!el || !el.isConnected) return 1;
  const r = el.getBoundingClientRect();
  const top = r.top + from;
  const bottom = Math.min(r.bottom, r.top + to);
  if (bottom - top < 8) return 1;
  const spans = [];
  for (const d of el.querySelectorAll('*')) {
    const b = d.getBoundingClientRect();
    if (!b.width || !b.height || b.bottom <= top || b.top >= bottom) continue;
    const cs = getComputedStyle(d);
    if (cs.visibility !== 'visible' || Number(cs.opacity) === 0) continue;
    const text = Array.from(d.childNodes).some((n) => n.nodeType === 3 && n.nodeValue.trim());
    const replaced = /^(img|svg|canvas|video|picture|iframe|input|textarea|select|button)$/i.test(d.tagName);
    const paints = cs.backgroundImage !== 'none' || !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(cs.backgroundColor) || parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderBottomWidth) > 0;
    if (!text && !replaced && (!paints || (b.top <= top && b.bottom >= bottom))) continue;
    spans.push([Math.max(top, b.top), Math.min(bottom, b.bottom)]);
  }
  spans.sort((p, q) => p[0] - q[0]);
  let covered = 0;
  let end = top;
  for (const [s, e] of spans) {
    if (e <= end) continue;
    covered += e - Math.max(s, end);
    end = e;
  }
  return covered / (bottom - top);
}

// The page's full scroll size in CSS px (never smaller than the viewport).
function pageSize() {
  const root = document.scrollingElement || document.documentElement;
  const body = document.body;
  return {
    width: Math.max(root.scrollWidth, body ? body.scrollWidth : 0, window.innerWidth),
    height: Math.max(root.scrollHeight, body ? body.scrollHeight : 0, window.innerHeight),
  };
}

// What the page shows that a sign-in page shows: visible password fields (current, not
// new), a user name or e-mail field, sign-in, sign-up, "continue" or "session ended"
// wording in the title, headings or buttons, another action (delete, save…), how much
// there is to interact with (a sign-in page is small), and whether an open dialog's only
// password field is a current one (a "session expired" modal). Read as data only.
function signInSignals() {
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const words = /\b(sign|log)[\s-]?(in|on)\b|\blogin\b|\bsso\b|single sign-on|\bauthenticat/i;
  const textOf = (el) => String(el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
  const inputs = Array.from(document.querySelectorAll('input, textarea, select')).filter(visible);
  const typing = inputs.filter((i) => i.tagName !== 'INPUT' || !['hidden', 'submit', 'button', 'checkbox', 'radio', 'image', 'reset', 'file', 'range', 'color'].includes(i.type));
  const passwords = inputs.filter((i) => i.tagName === 'INPUT' && i.type === 'password');
  const isNew = (i) => (i.getAttribute('autocomplete') || '').toLowerCase().includes('new-password');
  const usernameField = typing.some((i) => {
    if (i.tagName !== 'INPUT' || i.type === 'password') return false;
    const hint = `${i.name} ${i.id} ${i.getAttribute('autocomplete') || ''} ${i.getAttribute('placeholder') || ''} ${i.getAttribute('aria-label') || ''}`;
    return i.type === 'email' || /user|e-?mail|login|identifier/i.test(hint);
  });
  const headings = Array.from(document.querySelectorAll('h1, h2, legend, [role=heading]')).filter(visible).map(textOf).join(' ');
  const buttons = Array.from(document.querySelectorAll('button, input[type=submit], [role=button]')).filter(visible).map(textOf).join(' ');
  const titled = `${document.title || ''} ${headings}`;
  return {
    passwordFields: passwords.length,
    loginPasswordFields: passwords.filter((i) => !isNew(i)).length,
    newPasswordFields: passwords.filter(isNew).length,
    textInputs: typing.length,
    usernameField,
    signInTitle: words.test(titled),
    signInButton: words.test(buttons),
    signUp: /\bsign[\s-]?up\b|\bregister\b|create (an |your )?account/i.test(`${titled} ${buttons}`),
    continueWording: /\b(continue|next|send (me )?(a )?(magic )?(link|code)|email me)\b/i.test(buttons) || /welcome back|magic link/i.test(headings),
    sessionEnded: /session (has |is )?(expired|timed out|ended)|\b(signed|logged) out\b|\b(sign|log) in again\b|please (sign|log) in\b/i.test(`${titled} ${buttons}`),
    otherAction: /\b(delete|remove|deactivate|close|confirm|save|update|change)\b/i.test(buttons),
    interactive: Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [role=button], [role=link]')).filter(visible).length,
    signInDialog: Array.from(document.querySelectorAll('[role=dialog], [role=alertdialog], [aria-modal=true], dialog[open]'))
      .filter(visible)
      .some((d) => {
        const inside = passwords.filter((i) => d.contains(i));
        return inside.length === 1 && !isNew(inside[0]);
      }),
  };
}

// Each sample keeps the flat { "<prop>": value } map and adds reserved keys:
// __rect { x, y, w, h } — integer box covering the element in screenshot pixels
// (document coordinates for whole-page captures, viewport coordinates with viewportOnly) — __visible (non-zero size and not
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
  // The target's path in the audit's form (a test id or id anchors it; tag.class:nth-of-type
  // otherwise, up to 5 steps) and its untransformed box in page pixels, so an animation on
  // an element that was not grabbed can still be found and pinned.
  const hashLike = (c) => /(^|[-_])(?=[a-z]*\d)(?=\d*[a-z])[a-z0-9]{5,}$/i.test(c) || /^(css|sc|jss|emotion|styled|tw|svelte)-/.test(c);
  const autoId = (id) => /^:|[:]|\d{3,}|^(?=[a-z]*\d)(?=\d*[a-z])[a-z0-9]{6,}$/i.test(id);
  const pathOf = (el) => {
    const parts = [];
    for (let cur = el; cur && cur.nodeType === 1 && parts.length < 5; cur = cur.parentElement) {
      const tag = cur.tagName.toLowerCase();
      const testid = cur.getAttribute('data-testid');
      if (testid) {
        parts.unshift(`${tag}[data-testid="${CSS.escape(testid)}"]`);
        break;
      }
      if (cur.id && !autoId(cur.id)) {
        parts.unshift(`${tag}#${CSS.escape(cur.id)}`);
        break;
      }
      const stable = Array.from(cur.classList || []).find((c) => !hashLike(c));
      let seg = stable ? `${tag}.${CSS.escape(stable)}` : tag;
      const same = cur.parentElement && tag !== 'body' && tag !== 'html' ? Array.from(cur.parentElement.children).filter((c) => c.tagName === cur.tagName) : [];
      if (same.length > 1) seg += `:nth-of-type(${same.indexOf(cur) + 1})`;
      parts.unshift(seg);
      if (tag === 'body' || tag === 'html') break;
    }
    return parts.join(' > ');
  };
  const boxOf = (el) => {
    const r = el.getBoundingClientRect();
    // A scale or rotation in flight changes the bounding box: keep the layout size, same centre.
    const w = el.offsetWidth || r.width;
    const h = el.offsetHeight || r.height;
    const x = Math.round(r.left + r.width / 2 - w / 2 + window.scrollX);
    const y = Math.round(r.top + r.height / 2 - h / 2 + window.scrollY);
    return { x, y, w: Math.round(w), h: Math.round(h) };
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
      selector: target && target.tagName ? pathOf(target) : null,
      rect: target && target.getBoundingClientRect ? boxOf(target) : null,
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

/** The page's sign-in signals, or null when it cannot be read (navigating, closed); a blocked page still times out. */
async function readSignInSignals(page, timeout) {
  await page.waitForLoadState('domcontentloaded', { timeout: Math.min(5000, timeout) }).catch(() => {});
  try {
    return await withTimeout(page.evaluate(signInSignals), timeout, 'reading the page for sign-in signals');
  } catch (err) {
    if (err instanceof PageTimeout) throw err;
    return null;
  }
}

/**
 * Is the page signed in? Waits up to `waitMs` for the signed-in selector (0: look once),
 * reads the sign-in signals and classifies them (classifySignIn in capture-helpers.mjs).
 */
async function signInVerdict(page, run, plannedUrl, { useSelector = true, waitMs = 0, allowSignIn = false, trusted = false } = {}) {
  if (allowSignIn) return { signIn: false, signedIn: null, detail: null };
  const selector = useSelector ? run.signedInSelector : null;
  let signedInVisible = null;
  if (selector) {
    const target = page.locator(selector).first();
    signedInVisible = waitMs > 0
      ? await target.waitFor({ state: 'visible', timeout: waitMs }).then(() => true, () => false)
      : await target.isVisible().catch(() => false);
  }
  // Read even when the selector is visible: a sign-in dialog over the shell still counts.
  const signals = await readSignInSignals(page, run.timeout);
  const frames = await readCoveringFrames(page, run.timeout);
  return classifySignIn({ plannedUrl, finalUrl: page.url(), signals, frames, signedInSelector: selector, signedInVisible, signInPattern: run.signInPattern, trusted });
}

/**
 * Frames that cover at least half of the viewport count as the page (a sign-in form
 * loaded in a full-window frame): their URL and sign-in signals, same-origin or not.
 * Smaller frames (an embedded widget) are not looked at. → [{ url, signals }].
 */
async function readCoveringFrames(page, timeout) {
  const vp = page.viewportSize();
  if (!vp) return [];
  const out = [];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame() || frame.isDetached()) continue;
    try {
      const box = await (await frame.frameElement()).boundingBox();
      if (!box) continue;
      const w = Math.max(0, Math.min(box.x + box.width, vp.width) - Math.max(box.x, 0));
      const h = Math.max(0, Math.min(box.y + box.height, vp.height) - Math.max(box.y, 0));
      if (w * h < 0.5 * vp.width * vp.height) continue;
      let signals = null;
      try {
        signals = await withTimeout(frame.evaluate(signInSignals), timeout, 'reading a frame for sign-in signals');
      } catch (err) {
        if (err instanceof PageTimeout) throw err;
      }
      out.push({ url: frame.url(), signals });
    } catch (err) {
      if (err instanceof PageTimeout) throw err;
      // a frame that went away while it was read
    }
  }
  return out;
}

/**
 * Unroll the page's main inner scroll containers (an app shell's panel with overflow:
 * auto) so the whole-page screenshot holds their content. Each round scrolls them
 * through (lazy rows render), then grows the viewport height by their hidden overflow:
 * such panels are sized from the viewport, so this shows them as the app lays them out.
 * A panel the taller viewport does not unroll (a fixed height) gets inline styles that
 * let it, and its clipping ancestors, take their content's height (a warning says so).
 * Each change is checked: the area a panel gained must show content, and with `checkChrome`
 * (a screen-high frame) nothing level with it may move; a panel that fails is put back,
 * added to `skip` and listed in `fallbacks`. Bounded by UNROLL_ROUNDS and run.unrollMaxHeight;
 * what is left is reported as clipped. → [{ selector, axis: "y", addedPx }].
 */
async function unrollContainers(page, run, layout, { warnings, quietNetwork, checkChrome, skip, fallbacks }) {
  const evaluate = (fn, arg, what) => withTimeout(page.evaluate(fn, arg), run.timeout, what);
  const find = async () => (await evaluate(findScrollContainers, { layout, minHidden: MIN_HIDDEN_PX }, 'finding scroll containers')).containers;
  const settle = async () => {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))).catch(() => {});
    await page.waitForTimeout(100);
    if (quietNetwork) await page.waitForLoadState('networkidle', { timeout: Math.min(2000, run.timeout) }).catch(() => {});
  };
  const seen = new Map(); // id → { selector, most hidden px seen }
  const mark = async (list) => {
    if (checkChrome) await evaluate(markChrome, { ids: list.map((c) => c.id) }, 'reading the page around its panels');
  };
  // The containers (as found before the change) that it left wrong, each with the reason.
  const verify = async (changed) => {
    const moved = checkChrome ? await evaluate(movedChrome, { minPx: MIN_HIDDEN_PX }, 'reading the page around its panels') : null;
    if (moved) return changed.map((c) => ({ c, reason: `unrolling it moved ${moved.selector} by ${px(moved.px)} px, away from where the screen shows it` }));
    const bad = [];
    for (const c of changed) {
      const share = await evaluate(exposedContent, { id: c.id, from: c.rect.h, to: c.rect.h + c.hiddenY }, 'checking an unrolled panel');
      if (share < MIN_CONTENT_SHARE) bad.push({ c, reason: `unrolled, ${Math.round(share * 100)}% of the ${px(c.hiddenY)} px it gained showed content (a virtual list draws only the rows in view)` });
    }
    return bad;
  };
  const leave = (bad) => {
    for (const { c, reason } of bad) {
      skip.add(c.id);
      seen.delete(c.id);
      fallbacks.push({ selector: c.selector, reason: `the ${c.selector} panel was left as it scrolls: ${reason}` });
    }
  };
  let height = page.viewportSize()?.height ?? layout.height;
  for (let round = 0; round < UNROLL_ROUNDS; round++) {
    let mains = (await find()).filter((c) => c.main && !skip.has(c.id));
    if (!mains.length) break;
    await evaluate(scrollContainersThrough, { ids: mains.map((c) => c.id), maxSteps: SCROLL_STEPS, stepMs: SCROLL_STEP_MS }, 'scrolling through the page\'s panels');
    const ids = new Set(mains.map((c) => c.id));
    mains = (await find()).filter((c) => ids.has(c.id) && c.main);
    if (!mains.length) break;
    for (const c of mains) seen.set(c.id, { selector: c.selector, hidden: Math.max(seen.get(c.id)?.hidden ?? 0, c.hiddenY) });
    if (height >= run.unrollMaxHeight) break;
    const next = Math.min(run.unrollMaxHeight, height + Math.max(...mains.map((c) => c.hiddenY)));
    await mark(mains);
    await page.setViewportSize({ width: layout.width, height: next });
    await settle();
    const after = new Map((await find()).map((c) => [c.id, c]));
    const stuck = mains.filter((c) => (after.get(c.id)?.hiddenY ?? 0) >= c.hiddenY - 1);
    const bad = stuck.length < mains.length ? await verify(mains.filter((c) => !stuck.includes(c))) : [];
    if (stuck.length === mains.length || bad.length) {
      // A taller viewport changed nothing, or changed it wrongly: keep the layout viewport.
      await page.setViewportSize({ width: layout.width, height });
      await settle();
      if (bad.length) {
        leave(bad);
        break;
      }
    } else {
      height = next;
    }
    if (stuck.length) {
      await mark(stuck);
      await evaluate(unrollWithStyles, { ids: stuck.map((c) => c.id) }, 'unrolling fixed-height panels');
      await settle();
      const wrong = await verify(stuck);
      if (wrong.length) {
        await evaluate(undoUnroll, { ids: wrong.map((b) => b.c.id) }, 'putting a panel back');
        await settle();
        leave(wrong);
      }
      for (const c of stuck.filter((x) => !wrong.some((b) => b.c === x))) {
        skip.add(c.id);
        warnings.push(`the ${c.selector} panel has a fixed height; it was unrolled by overriding its height and overflow (and those of the elements around it), so its layout may differ slightly from the app's`);
      }
    }
  }
  const left = new Map((await find()).map((c) => [c.id, c.hiddenY]));
  return [...seen].map(([id, s]) => ({ selector: s.selector, axis: 'y', addedPx: Math.max(0, Math.round(s.hidden - (left.get(id) ?? 0))) })).filter((u) => u.addedPx > 0);
}

/** Scroll containers whose content the screenshot still does not show, rects in screenshot pixels. */
async function clippedContainers(page, run, layout, wholePage) {
  const { containers, scroll } = await withTimeout(page.evaluate(findScrollContainers, { layout, minHidden: MIN_HIDDEN_PX }), run.timeout, 'finding scroll containers');
  const ox = wholePage ? scroll.x : 0;
  const oy = wholePage ? scroll.y : 0;
  const out = [];
  for (const c of containers) {
    const x0 = Math.floor(c.rect.x + ox);
    const y0 = Math.floor(c.rect.y + oy);
    const rect = { x: x0, y: y0, w: Math.ceil(c.rect.x + c.rect.w + ox) - x0, h: Math.ceil(c.rect.y + c.rect.h + oy) - y0 };
    // `cut` (overflow hidden, not scrollable by the user) only shapes the warning's wording.
    if (c.hiddenY) out.push(Object.defineProperty({ selector: c.selector, axis: 'y', hiddenPx: Math.round(c.hiddenY), rect }, 'cut', { value: c.cut, enumerable: false }));
    if (c.hiddenX) out.push({ selector: c.selector, axis: 'x', hiddenPx: Math.round(c.hiddenX), rect });
  }
  return out;
}

async function captureState(browser, run, plan) {
  const { name, driver } = plan;
  const started = Date.now();
  const warnings = [];
  const degradations = [];
  // A per-state driver viewport is a frame too: a tall one gets the same long-page rule.
  const frame = driver.viewport ?? run.frame;
  const viewport = driver.viewport ? fitViewport(frame, run.maxViewportHeight).viewport : run.viewport;
  // The whole page, always, unless this state (or the run) opts out with viewportOnly.
  const fullPage = !(driver.viewportOnly ?? run.viewportOnly);
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
    // The app's own data requests (XHR / fetch to its origin): URL paths only, no query or
    // values, so a driver's mock can name them ("urlPattern": "**/api/orders*").
    const requests = new Set();
    if (run.side === 'app') {
      page.on('request', (req) => {
        try {
          if (!['xhr', 'fetch'].includes(req.resourceType()) || requests.size >= MAX_REQUESTS) return;
          const u = new URL(req.url());
          if (u.origin === run.appOrigin) requests.add(u.pathname);
        } catch {
          // an unparsable URL: not recorded
        }
      });
    }
    if (driver.mock) await page.route(driver.mock.urlPattern, mockHandler(driver.mock, timers, mockState));
    // preCapture storage first, the state's own storage over it (same key: the state wins).
    const pc = preCaptureFor(run.preCapture, name);
    const pcCss = preCaptureCss(pc);
    const local = { ...(pc?.localStorage ?? {}), ...(driver.storage?.local ?? {}) };
    const session = { ...(pc?.sessionStorage ?? {}), ...(driver.storage?.session ?? {}) };
    if (Object.keys(local).length || Object.keys(session).length) await page.addInitScript(applyStorage, { local, session, origin: run.pageOrigin });
    if (pcCss) await page.addInitScript(installPreCaptureCss, { css: pcCss, origin: run.pageOrigin });

    let response;
    try {
      response = await page.goto(plan.url, { waitUntil: plan.loading ? 'domcontentloaded' : 'load', timeout: run.timeout });
    } catch (err) {
      throw Object.assign(new CliError(`state "${name}": could not load ${plan.safeUrl}: ${firstLine(run.redact(err.message))}`, 5), {
        failure: { kind: 'unreachable', finalUrl: null, detail: firstLine(run.redact(err.message)) },
      });
    }
    const allowSignIn = driver.allowSignIn === true;
    const status = response ? response.status() : 0;
    if ((status === 401 || status === 403) && !allowSignIn) {
      throw new SignInFailure(`${plan.safeUrl} answered HTTP ${status}: the page needs a signed-in session`, page.url(), `HTTP ${status}`);
    }
    if (status >= 400) {
      throw Object.assign(new CliError(`state "${name}": ${plan.safeUrl} answered HTTP ${status}`, 5), {
        failure: { kind: 'http', finalUrl: run.redactUrl(page.url()), detail: `HTTP ${status}` },
      });
    }
    // A redirect (302 to /login) or a script navigating away is not this state: its
    // screenshot would be the sign-in page under the state's name. A sign-in page is told
    // apart from another route, and caught at the planned URL too (a sign-in form, the
    // signed-in selector missing), even when navigation is allowed.
    const redirected = Boolean(response?.request().redirectedFrom());
    const allowNavigation = driver.allowNavigation ?? run.allowNavigation;
    let signedIn = null;
    // A driver state after a signed-in base page (plan.trusted), or this state's own page
    // before its action: a password field alone does not make it a sign-in page.
    let trusted = Boolean(plan.trusted) && !redirected;
    let offHost = null;
    // mode "load" / "final": only a page that moved is classified (sign-in or another
    // route); "wait" / "now": the full check, waiting for the signed-in selector or not.
    const checkPage = async (when, mode) => {
      const now = page.url();
      const moved = !sameLocation(plan.url, now);
      const otherHost = moved && hostOf(now) !== hostOf(plan.url);
      const full = mode === 'wait' || mode === 'now';
      if (full || (moved && (!allowNavigation || otherHost))) {
        const verdict = await signInVerdict(page, run, plan.url, {
          useSelector: full,
          waitMs: mode === 'wait' ? (plan.loading ? Math.min(5000, run.timeout) : run.timeout) : 0,
          allowSignIn,
          trusted,
        });
        if (verdict.signIn) {
          const where = page.url();
          throw new SignInFailure(`landed on a sign-in page ${when} (${where}): ${verdict.detail}`, where, verdict.detail);
        }
        if (full && verdict.signedIn !== null) signedIn = verdict.signedIn;
      }
      if (!moved) return;
      // Another host is never this state under the run-wide flag; a state's own
      // "allowNavigation": true keeps it, marked.
      if (otherHost && allowNavigation && driver.allowNavigation === true) {
        offHost ??= hostOf(now);
        return;
      }
      if (allowNavigation && !otherHost) return;
      if (otherHost && allowNavigation) {
        throw new NavigationFailure(`ended on another host (${now}) instead of ${plan.url}; the run-wide allowNavigation covers the same host only: set "allowNavigation": true on the state if it is meant to leave the app`, now);
      }
      const how = redirected && when === 'on load' ? 'the server redirected' : `the page navigated away ${when}`;
      throw new NavigationFailure(
        `ended on ${now} instead of ${plan.url} (${how}); another route is not this state — check the URL` +
          `, or set "allowNavigation": true if ${driver.action ? 'the action is' : 'the state is'} meant to navigate`,
        now,
      );
    };
    await checkPage('on load', 'load');

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
    // The page has rendered: is it the signed-in app?
    await checkPage('after loading', 'wait');
    if (driver.action) trusted = true;

    // preCapture clicks (a dismiss button), each once and only when visible.
    const clicked = [];
    for (const selector of pc?.click ?? []) {
      const target = page.locator(selector).first();
      if (!(await target.isVisible().catch(() => false))) continue;
      try {
        await target.click({ timeout: Math.min(PRE_CAPTURE_CLICK_MS, run.timeout) });
        clicked.push(selector);
      } catch (err) {
        warnings.push(`preCapture click "${selector}" failed: ${firstLine(err.message)}`);
      }
    }
    if (clicked.length) {
      await page.waitForTimeout(150);
      await checkPage('after the preCapture clicks', 'load');
    }

    // Whole page: scroll through once so lazy and virtualised content renders, then unroll
    // the main inner scroll containers, all before the state's action (scrolling or a
    // resize after a hover would move the hovered element away from the mouse).
    const unrolled = [];
    // Why only part of the page is in the screenshot (capture-coverage degradations), and
    // the height to stop at on an endless page.
    const partial = [];
    let endless = null;
    const unrollState = { skip: new Set(), fallbacks: [] };
    const unroll = async () => {
      try {
        const opts = { warnings, quietNetwork: !plan.loading, checkChrome: frame.height <= viewport.height, ...unrollState };
        for (const u of await unrollContainers(page, run, viewport, opts)) {
          const same = unrolled.find((x) => x.selector === u.selector);
          if (same) same.addedPx += u.addedPx;
          else unrolled.push(u);
        }
      } catch (err) {
        if (err instanceof PageTimeout) throw err;
        warnings.push(`unrolling the page's scroll panels failed: ${firstLine(run.redact(err.message))}`);
      }
    };
    if (fullPage) {
      try {
        const maxGrowth = MAX_GROWTH_FRAMES * frame.height;
        const scrolled = await withTimeout(page.evaluate(scrollThrough, { maxSteps: SCROLL_STEPS, stepMs: SCROLL_STEP_MS, maxGrowth }), run.timeout, 'scrolling through the page');
        if (scrolled.capped) {
          endless = scrolled.limit;
          partial.push(`the page kept growing while scrolled through (endless scrolling): captured its first ${px(endless)} px (it may grow by ${MAX_GROWTH_FRAMES}× the design frame's height, ${px(maxGrowth)} px)`);
        } else if (!scrolled.complete) warnings.push(`stopped scrolling after ${scrolled.steps} screens; content further down may not have loaded`);
        if (!plan.loading) await page.waitForLoadState('networkidle', { timeout: Math.min(NETWORK_IDLE_AFTER_WAIT_MS, run.timeout) }).catch(() => {});
      } catch (err) {
        if (err instanceof PageTimeout) throw err;
        warnings.push(`scrolling through the page failed: ${firstLine(run.redact(err.message))}`);
      }
      await unroll();
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
    // An action that opened more content (a click, a key) may have filled a panel again;
    // hover and active stay put (a resize would move the element away from the mouse).
    if (fullPage && driver.action && !['hover', 'active'].includes(driver.action)) await unroll();
    await checkPage('before the screenshot', 'now');

    if (driver.mock && mockState.hits === 0) {
      const reason = `mock urlPattern "${driver.mock.urlPattern}" matched no request`;
      warnings.push(reason);
      degradations.push({
        step: `mock:${name}`,
        reason,
        impact: `State "${name}" may show the real response instead of the mocked one; fix the pattern (a glob matches the whole URL, query string included).`,
      });
    }
    if (offHost) {
      const reason = `ended on another host (${offHost}), not the target's (${hostOf(plan.url)})`;
      warnings.push(reason);
      degradations.push({ step: `capture:${name}`, reason, impact: `State "${name}" shows another site; check that it is the designed state.` });
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

    // preCapture: the hide/remove sheet is still in place (an app may reset adopted sheets)
    // and removed elements leave the DOM before anything is read.
    // What they cover is measured first (matched: per selector, its elements and their area).
    let removed = 0;
    let matched = [];
    if (pc) {
      if (pcCss) await withTimeout(page.evaluate(installPreCaptureCss, { css: pcCss, origin: run.pageOrigin }), run.timeout, 'applying preCapture styles');
      if (pcCss) matched = await withTimeout(page.evaluate(measureHidden, { hide: pc.hide, remove: pc.remove, fullPage }), run.timeout, 'measuring preCapture');
      if (pc.remove.length) removed = await withTimeout(page.evaluate(removeElements, pc.remove), run.timeout, 'applying preCapture remove');
    }

    const [screenshot, computed, dom, motion, auditFile] = stateFiles(run.dirs, name);
    const scroll = await withTimeout(
      page.evaluate(() => ({ x: Math.round(window.scrollX), y: Math.round(window.scrollY) })),
      run.timeout,
      'reading the scroll position',
    );
    // The page's full scroll size (after unrolling), and what still scrolls out of sight.
    const pageBox = await withTimeout(page.evaluate(pageSize), run.timeout, 'measuring the page');
    const clipped = await clippedContainers(page, run, viewport, fullPage);
    for (const c of clipped) {
      const reason = clippedMessage(c);
      warnings.push(reason);
      degradations.push({
        step: `capture:${name}`,
        reason,
        impact: c.axis === 'y'
          ? `Content of "${name}" inside ${c.selector} is not in the screenshot; compare it in the ledgers, or report the panel (rect in the capture's clipped list).`
          : `Content of "${name}" inside ${c.selector} is cut off sideways, as the app shows it; check whether the design shows it.`,
      });
    }
    // Panels left as they scroll, an endless page cut: the state is captured in part.
    partial.push(...unrollState.fallbacks.map((f) => f.reason));
    for (const reason of partial) {
      warnings.push(reason);
      degradations.push({ step: `capture-coverage:${name}`, reason, impact: `Only part of "${name}" is in the screenshot: what is left out is not compared.` });
    }
    // Full page: the whole scroll width and height (wider than the viewport when the page
    // overflows sideways), an endless page to its cap. Viewport only: the current (layout) viewport.
    const cut = fullPage && endless && pageBox.height > endless ? { x: 0, y: 0, width: pageBox.width, height: endless } : null;
    const buffer = await page.screenshot({ fullPage, ...(cut ? { clip: cut } : {}), animations: 'disabled', caret: 'hide', timeout: run.timeout });
    const size = pngSize(buffer);
    const shown = page.viewportSize() ?? viewport;
    const expected = cut ?? (fullPage ? pageBox : shown);
    const factor = scaleFactor(size, expected);
    if (factor || size.width < shown.width || (!fullPage && size.height !== shown.height)) {
      const why = factor ? ` It is ${factor}× the ${fullPage ? 'page' : 'viewport'}: the capture ran at device scale factor ${factor}.` : '';
      throw new CliError(
        `state "${name}": the screenshot is ${size.width}×${size.height} but the ${fullPage ? `page is ${expected.width}×${expected.height}` : `viewport is ${shown.width}×${shown.height}`}.${why} ` +
          'Captures must run at deviceScaleFactor 1 to match a scale-1 Figma export; never compare screenshots at different scales.',
        3,
      );
    }

    const styles = await withTimeout(page.evaluate(grabComputedStyles, { grab: run.grab, fullPage }), run.timeout, 'reading computed styles');
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
    // Design-system audit: every rendered element of the unrolled whole page, read in place
    // (page.evaluate never moves the mouse, so a hover or a held button stays as it is).
    let audit = null;
    if (run.auditOptions) {
      try {
        audit = await withTimeout(page.evaluate(collectAuditElements, { ...run.auditOptions, fullPage }), Math.max(run.timeout, 20000), 'the design-system audit');
      } catch (err) {
        // Never fails the state: the screenshot and the grab stand without the audit.
        degradations.push({
          step: `audit:${name}`,
          reason: `the design-system audit collector failed: ${firstLine(run.redact(err?.message ?? err))}`,
          impact: `ds-audit.mjs has no data for state "${name}": its tokens and components are checked only through the grab.`,
        });
      }
    }
    const title = await withTimeout(page.title(), run.timeout, 'reading the page title');
    const finalUrl = page.url();
    await checkPage('during the capture', 'final');
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
    let auditPath = null;
    if (audit) {
      try {
        // Compact: thousands of elements per page.
        writeFileNoFollow(path.join(run.outDir, auditFile), `${JSON.stringify(audit)}\n`);
        auditPath = auditFile;
      } catch (err) {
        degradations.push({ step: `audit:${name}`, reason: `writing the audit file failed: ${firstLine(err.message)}`, impact: `ds-audit.mjs has no data for state "${name}".` });
      }
    }
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
      driver,
      url: plan.safeUrl,
      frame,
      viewport,
      fullPage,
      page: pageBox,
      size,
      unrolled,
      clipped,
      partial,
      screenshot,
      computed,
      dom,
      motion: motionPath,
      ...(run.auditOptions ? { audit: auditPath } : {}),
      ...(run.side === 'app' ? { requests: [...requests].map((p) => run.redactUrl(p)) } : {}),
      settleMs,
      durationMs: Date.now() - started,
      scroll,
      signedIn,
      ...(pc ? { preCapture: { clicked, removed, matched } } : {}),
      warnings,
      degradations,
    };
  } finally {
    mockState.release();
    for (const t of timers) clearTimeout(t);
    await context.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Drivers that change nothing
// ---------------------------------------------------------------------------

/** sha256 of a file inside --out, or null (missing, unreadable, a symlink). */
function fileHash(outDir, rel) {
  if (!rel) return null;
  try {
    const file = path.join(outDir, rel);
    if (lstatSync(file).isSymbolicLink()) return null;
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/** The page structure of a dom/<state>.json (its URL and title left out: a query changes them). */
function domHash(outDir, rel) {
  if (!rel) return null;
  try {
    const dom = JSON.parse(readFileSync(path.join(outDir, rel), 'utf8'));
    return createHash('sha256').update(JSON.stringify({ elements: dom.elements, texts: dom.texts })).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Set sameAs on every state of the (merged) manifest: the with-data state's id when the
 * state's screenshot is exactly the with-data screenshot (same PNG bytes), else null. Only
 * exact equality counts (a hover that changes one pixel is not the same). The identical DOM
 * outline is named as supporting evidence. Adds one plain warning per such state (once).
 * → [{ state, sameAs, message }].
 */
function markSameAs(manifest, outDir, side) {
  const entries = Object.entries(manifest.states ?? {});
  const base = entries.find(([name, e]) => exactStateName(name) === 'with-data' && e?.screenshot);
  const baseShot = base ? fileHash(outDir, base[1].screenshot) : null;
  const baseDom = base ? domHash(outDir, base[1].dom) : null;
  const out = [];
  for (const [name, entry] of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const same = Boolean(baseShot && entry.screenshot && name !== base[0] && fileHash(outDir, entry.screenshot) === baseShot);
    entry.sameAs = same ? base[0] : null;
    let message = null;
    if (same) {
      const dom = baseDom && domHash(outDir, entry.dom) === baseDom ? ' (its page text and structure are identical too)' : '';
      message =
        `${name} looks exactly like ${base[0]}: the driver changed nothing${dom}. ` +
        `Either the ${side === 'design' ? 'prototype' : 'app'} does not implement this state, or the driver is wrong.`;
      entry.warnings = Array.isArray(entry.warnings) ? entry.warnings : [];
      if (entry.warnings.includes(message)) message = null;
      else entry.warnings.push(message);
    }
    out.push({ state: name, sameAs: entry.sameAs, message });
  }
  return out;
}

// ---------------------------------------------------------------------------
// --probe: is the target reachable, and signed in?
// ---------------------------------------------------------------------------

/**
 * Load the target once with the run's auth, headers, storage state and preCapture
 * storage, and print { url, reachable, status, finalUrl, signIn, signedIn, title, detail }
 * as JSON. Nothing is written. Exit 0 reachable and not a sign-in page, 6 sign-in needed,
 * 5 unreachable or an HTTP error (reachable says which), 4 no browser.
 */
async function runProbe(o) {
  // The with-data state's fixture and query fill {fixture}/{id}; nothing else of a driver applies.
  const base = o.states.find((s) => exactStateName(s.name) === 'with-data')?.driver ?? {};
  const target = buildStateUrl(o.url, { fixture: base.fixture, query: base.query }, 'with-data');
  const out = { url: o.redactUrl(target), reachable: false, status: null, finalUrl: null, signIn: false, signedIn: null, title: null, detail: null };
  let code = 0;
  const { chromium } = await loadPlaywright();
  const browser = await launchBrowser(chromium, o.env);
  const appOrigin = new URL(o.url).origin;
  const run = {
    contextOptions: {
      viewport: o.fitted.viewport,
      deviceScaleFactor: 1,
      colorScheme: 'light',
      ignoreHTTPSErrors: appKind(o.url) === 'local',
      ...(o.credentials.httpCredentials ? { httpCredentials: o.credentials.httpCredentials } : {}),
    },
    headers: o.headers,
    appOrigin,
    redact: o.redact,
    redactUrl: o.redactUrl,
    timeout: o.timeout,
    signedInSelector: o.signedInSelector,
    signInPattern: o.signInPattern,
  };
  let context = null;
  try {
    let storageState = o.credentials.storageStatePath ?? null;
    if (o.auth === 'login') storageState = await login(browser, run, o.credentials, o.loginConfig, o.url, o.prefix);
    context = await browser.newContext({ ...run.contextOptions, ...(storageState ? { storageState } : {}) });
    if (o.credentials.cookies.length) await context.addCookies(o.credentials.cookies);
    await routeAppHeaders(context, o.headers, appOrigin);
    const page = await context.newPage();
    const pc = o.preCapture;
    if (pc && (Object.keys(pc.localStorage).length || Object.keys(pc.sessionStorage).length)) {
      await page.addInitScript(applyStorage, { local: pc.localStorage, session: pc.sessionStorage, origin: appOrigin });
    }
    let response = null;
    try {
      response = await page.goto(target, { waitUntil: 'load', timeout: o.timeout });
    } catch (err) {
      out.detail = `could not load the page: ${firstLine(o.redact(err.message))}`;
      code = 5;
    }
    if (!code) {
      out.reachable = true;
      out.status = response ? response.status() : null;
      if (out.status === 401 || out.status === 403) {
        Object.assign(out, { signIn: true, signedIn: false, detail: `HTTP ${out.status}: the page needs a signed-in session` });
        code = EXIT_SIGN_IN;
      } else if (out.status >= 400) {
        out.detail = `the page answered HTTP ${out.status}`;
        code = 5;
      } else {
        await page.waitForLoadState('networkidle', { timeout: Math.min(10000, o.timeout) }).catch(() => {});
        if (o.wait) await page.locator(o.wait).first().waitFor({ state: 'visible', timeout: o.timeout }).catch(() => {});
        const verdict = await signInVerdict(page, run, target, { useSelector: true, waitMs: run.signedInSelector ? o.timeout : 0 });
        Object.assign(out, { signIn: verdict.signIn, signedIn: verdict.signedIn });
        if (verdict.signIn) {
          out.detail = `a sign-in page: ${verdict.detail}`;
          code = EXIT_SIGN_IN;
        } else if (!sameLocation(target, page.url())) {
          out.detail = `reachable, but the page moved to another URL (not a sign-in page): capture that URL${hostOf(page.url()) === hostOf(target) ? ', or pass --allow-navigation' : ''}`;
        } else {
          out.detail = verdict.signedIn ? `signed in: "${run.signedInSelector}" is visible` : 'reachable; no sign-in page detected';
        }
      }
      out.finalUrl = o.redactUrl(page.url());
      // The title is page data: one line, redacted, bounded.
      out.title = oneLine(o.redactUrl(await withTimeout(page.title(), o.timeout, 'reading the page title').catch(() => ''))).slice(0, 200) || null;
    }
  } catch (err) {
    if (!(err instanceof CliError) && !(err instanceof StateFailure)) throw err;
    out.detail = firstLine(o.redact(err.message));
    code = err instanceof CliError ? err.exitCode : 5;
  } finally {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  if (out.detail) out.detail = o.redact(out.detail);
  console.log(JSON.stringify(out, null, 2));
  if (!o.quiet && code === EXIT_SIGN_IN) console.error(`probe: ${out.url} shows a sign-in page (${out.detail}). ${signInHelp({ auth: o.auth, prefix: o.prefix, url: out.url })}`);
  else if (!o.quiet && code) console.error(`probe: ${out.url} ${out.reachable ? 'is reachable but' : 'is not reachable:'} ${out.detail}`);
  return code;
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
    'max-viewport-height': { type: 'string' },
    'viewport-only': { type: 'boolean' },
    'signed-in-selector': { type: 'string' },
    'sign-in-url': { type: 'string' },
    'pre-capture': { type: 'string' },
    probe: { type: 'boolean' },
    timeout: { type: 'string' },
    out: { type: 'string' },
    config: { type: 'string' },
    surface: { type: 'string' },
    screen: { type: 'string' },
    side: { type: 'string' },
    run: { type: 'string' },
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
  const configFile = values.config ? path.resolve(values.config) : null;
  const config = configFile ? readJsonFile(configFile, 'config') : null;
  const cfg = config ? configDefaults(config, values.surface ?? null, { side, screen: values.screen ?? null }) : null;
  if (cfg && !values.url) values.url = cfg.url;
  if (side === 'design' && !values.url) {
    throw usageError('--side design needs --url <prototype-url> (or surfaces.<name>.prototype / screens.<id>.prototype in --config)');
  }
  const probe = Boolean(values.probe);
  if (probe) {
    for (const flag of ['out', 'states', 'state', 'driver', 'grab', 'full-page', 'viewport-only']) if (values[flag] !== undefined) throw usageError(`--probe captures nothing: drop --${flag}`);
    values.width ??= '1440';
    values.height ??= '900';
  }
  for (const flag of ['url', 'width', 'height', ...(probe ? [] : ['out'])]) if (!values[flag]) throw usageError(`--${flag} is required (see --help)`);
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
  const maxViewportHeight = values['max-viewport-height'] !== undefined
    ? toNumber(values['max-viewport-height'], 'max-viewport-height', { min: 100, max: 20000, integer: true })
    : cfg?.maxViewportHeight ?? null;
  // The frame asked for, and the layout viewport: a long-page frame is laid out on a
  // screen-high viewport; the capture covers the whole page either way.
  const frame = { width, height };
  const fitted = fitViewport(frame, maxViewportHeight);
  const unrollCap = unrollMaxHeight(env);
  // As written (recorded in capture.json) and expanded (used in memory only).
  const signedInSelector = values['signed-in-selector'] ?? cfg?.signedInSelector ?? null;
  const signedInSelectorExpanded = signedInSelector ? expandEnv(signedInSelector, env, 'signed-in selector', envUsed) : null;
  const signInUrl = values['sign-in-url'] ?? cfg?.signInUrlPattern ?? null;
  const signInPattern = compileSignInPattern(
    signInUrl ? expandEnv(signInUrl, env, 'sign-in URL pattern', envUsed) : null,
    values['sign-in-url'] !== undefined ? '--sign-in-url' : 'app.auth.signInUrlPattern',
  );
  // preCapture: config (app, then surface; app side only) with --pre-capture merged over it.
  // template: as written (manifest: keys and selectors only); preCapture: values expanded, memory only.
  const preCaptureTemplate = mergePreCapture(
    cfg?.preCapture ?? null,
    values['pre-capture'] ? normalizePreCapture(parseJsonArg(values['pre-capture'], 'pre-capture'), '--pre-capture') : null,
  );
  const preCapture = preCaptureTemplate ? expandEnv(preCaptureTemplate, env, 'preCapture', envUsed) : null;
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
  // The whole page is always captured; --full-page and surfaces.<name>.fullPage are accepted
  // for compatibility. The opt-out is --viewport-only (config capture.viewportOnly, or a
  // state's own viewportOnly, which wins).
  if (values['full-page'] && values['viewport-only']) throw usageError('--full-page and --viewport-only contradict each other (the whole page is the default)');
  const viewportOnly = Boolean(values['viewport-only'] ?? cfg?.viewportOnly);
  // A saved session: <PREFIX>_STORAGE_STATE wins, else app.auth.storageState (app side
  // only), a PATH relative to the config's folder. The file's content is never printed.
  const credentials = resolveAuth(auth, prefix, env, url, { storageState: cfg?.storageState ?? null, configDir: configFile ? path.dirname(configFile) : process.cwd() });
  if (credentials.storageStatePath && !existsSync(credentials.storageStatePath)) {
    throw usageError(missingSessionMessage({ path: credentials.storageStatePath, source: credentials.storageStateSource, prefix }));
  }
  // Header values and preCapture storage values long enough to be tokens are scrubbed too.
  const storageValues = preCapture ? [...Object.values(preCapture.localStorage), ...Object.values(preCapture.sessionStorage)].map((v) => (typeof v === 'string' ? v : JSON.stringify(v))) : [];
  const headerSecrets = [...Object.values(headers).map(String), ...storageValues].filter((v) => v && v.length >= 8);
  const envEntries = secretEnvEntries(envUsed);
  const redact = makeRedactor({ secrets: [...credentials.secrets, ...headerSecrets], envEntries });
  // URLs and page text keep short credential values (a user name may be a path segment).
  const redactUrl = makeRedactor({ secrets: [...credentials.secrets, ...headerSecrets].filter((s) => String(s).length >= 8), envEntries });
  const safeUrl = redactUrl(url);
  const signInChecks = { signedInSelector, signInUrlPattern: signInUrl };
  if (auth !== 'none' && auth !== 'basic' && !signedInSelector) warn('no signed-in element is set (app.auth.signedInSelector): sign-in pages are found by guesswork only');
  if (probe) {
    return runProbe({
      env, url, states, fitted, timeout, auth, prefix, credentials, loginConfig, headers, wait,
      signedInSelector: signedInSelectorExpanded, signInPattern, preCapture, redact, redactUrl, quiet: Boolean(values.quiet),
    });
  }
  const outDir = path.resolve(values.out);
  // The report folder is the locked ancestor of --out (<dir>/evidence, evidence/screens/<id>,
  // evidence/backfill): another run's folder is refused before anything is written.
  assertRunOwnsOutput(outDir, values.run);
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
  // The base state (with-data, else the first) is captured first: the others are judged after it.
  const baseAt = plans.findIndex((p) => exactStateName(p.name) === 'with-data');
  if (baseAt > 0) plans.unshift(...plans.splice(baseAt, 1));

  const kind = appKind(url);
  const { commit, branch } = gitInfo(env);
  const dirs = side === 'design'
    ? { shots: 'design', computed: 'design-computed', dom: 'design-dom', motion: 'design-motion', audit: 'design-audit', manifest: 'design-capture.json' }
    : { shots: 'app', computed: 'computed', dom: 'dom', motion: 'motion', audit: 'audit', manifest: 'capture.json' };
  // Design-system audit, both sides (a coded prototype is a DOM too: design-audit/<state>.json
  // gives the design side element data below the fold): selectors of the component
  // libraries and the catalog, evaluated in the page by the collector.
  const auditOptions = { selectors: config ? auditSelectors(config, path.dirname(configFile)) : [] };
  const manifestFile = path.join(outDir, dirs.manifest);
  const manifest = {
    side,
    ...(side === 'design' ? { source: designSource(safeUrl, { frame: { width, height } }) } : {}),
    url: safeUrl,
    kind,
    frame,
    viewport: fitted.viewport,
    dpr: 1,
    fullPage: !viewportOnly,
    viewportOnly,
    maxViewportHeight: maxViewportHeight ?? null,
    preCapture: describePreCapture(preCaptureTemplate),
    signInChecks,
    commit,
    branch,
    timestamp: new Date().toISOString(),
    failure: null,
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
  // A with-data state kept from the previous capture of the same page counts as the signed-in base.
  const previousBase = Boolean(previous && (previous.side ?? 'app') === side && previous.url === safeUrl &&
    Object.entries(previous.states ?? {}).some(([n, e]) => exactStateName(n) === 'with-data' && e?.screenshot && !plans.some((p) => p.name === n)));
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
    // A state whose screenshot is byte-for-byte the with-data one: its driver changed nothing.
    for (const { state, sameAs, message } of markSameAs(out, outDir, side)) if (sameAs && message) warn(`state "${state}": ${message}`);
    unlinkSymlink(manifestFile);
    writeJson(manifestFile, out);
    return out;
  };
  const failedEntry = (plan, message, failure = null) => ({
    driver: plan.template,
    url: plan.safeUrl,
    screenshot: null,
    computed: null,
    dom: null,
    motion: null,
    ...(dirs.audit ? { audit: null } : {}),
    settleMs: plan.driver.settleMs ?? 250,
    durationMs: 0,
    warnings: plan.warnings.map(redact),
    error: message,
    failure,
  });
  // A run that stops (a sign-in page, an unreachable app) leaves no evidence for the
  // states it did not reach either: their old files are deleted and they are listed.
  const stopAfter = (index, reason) => {
    for (const later of plans.slice(index + 1)) {
      removeStateFiles(outDir, dirs, later.name);
      manifest.states[later.name] = failedEntry(later, `not captured: ${reason}`, { kind: 'stopped', finalUrl: null, detail: reason });
    }
  };

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
      ...(dirs.audit ? { audit: null } : {}),
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
    viewport: fitted.viewport,
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
    // Storage and preCapture styles are applied to the top document of this origin only.
    pageOrigin: appOrigin,
    frame,
    viewport: fitted.viewport,
    viewportOnly,
    maxViewportHeight,
    // The tallest the viewport may grow while unrolling panels (DESIGN_QA_UNROLL_MAX_HEIGHT).
    unrollMaxHeight: unrollCap,
    signedInSelector: signedInSelectorExpanded,
    signInPattern,
    preCapture,
    reducedMotion: Boolean(values['reduced-motion'] ?? cfg?.reducedMotion),
    // A state's own "allowNavigation" wins over this run-wide default.
    allowNavigation: Boolean(values['allow-navigation'] ?? cfg?.allowNavigation),
    storageState: credentials.storageStatePath ?? null,
    cookies: credentials.cookies,
    redact,
    redactUrl,
    wait,
    timeout,
    grab,
    outDir,
    side,
    dirs,
    auditOptions,
  };

  let failures = 0;
  let final = manifest;
  try {
    if (auth === 'login') {
      try {
        run.storageState = await login(browser, run, credentials, loginConfig, url, prefix);
      } catch (err) {
        manifest.degradations.push({ step: 'capture:login', reason: err.message, impact: 'No state was captured.' });
        manifest.failure = { kind: 'login', state: null, finalUrl: null, detail: firstLine(err.message) };
        throw err;
      }
    }
    let navigationFailures = 0;
    let lastFinalUrl = null;
    let baseSignedIn = previousBase;
    let firstSignIn = null;
    let capturedCount = 0;
    for (const [index, plan] of plans.entries()) {
      const isBase = index === 0 && !previousBase;
      plan.trusted = !isBase && baseSignedIn && hostOf(plan.url) === hostOf(url);
      try {
        const result = await captureState(browser, run, plan);
        capturedCount += 1;
        if (isBase) baseSignedIn = true;
        result.driver = plan.template;
        result.warnings = [...plan.warnings, ...result.warnings].map(redact);
        result.degradations = result.degradations.map((d) => ({ ...d, reason: redact(d.reason) }));
        manifest.states[plan.name] = result;
        manifest.degradations.push(...result.degradations);
        const notes = result.warnings.length ? ` — ${result.warnings.length} warning(s): ${result.warnings.join('; ')}` : '';
        const unrolled = result.unrolled.length ? `, unrolled ${result.unrolled.map((u) => u.selector).join(', ')}` : '';
        const shape = result.fullPage
          ? `${result.size.width}×${result.size.height} whole page, layout viewport ${result.viewport.width}×${result.viewport.height}${unrolled}`
          : `${result.size.width}×${result.size.height} viewport only`;
        log(`captured ${plan.name} → ${result.screenshot} (${shape}, ${result.durationMs} ms)${notes}`);
        // Content the screenshot still does not show, in plain words, on stderr.
        for (const c of result.clipped) warn(`state "${plan.name}": ${redact(clippedMessage(c))}`);
      } catch (err) {
        // No stale evidence: a state that failed has no files, whatever an earlier run left.
        removeStateFiles(outDir, dirs, plan.name);
        if (err instanceof SignInFailure) {
          const finalUrl = redactUrl(err.finalUrl);
          const detail = redact(err.detail);
          const message = firstLine(redact(err.message));
          manifest.states[plan.name] = failedEntry(plan, message, { kind: 'sign-in', finalUrl, detail });
          firstSignIn ??= { kind: 'sign-in', state: plan.name, finalUrl, detail };
          // The base state is a sign-in page: the session is missing, nothing else can be captured.
          if (isBase) {
            manifest.failure = firstSignIn;
            manifest.degradations.push({ step: `capture:${plan.name}`, reason: message, impact: 'Capture stopped at a sign-in page: no state was captured from it.' });
            stopAfter(index, `capture stopped: state "${plan.name}" landed on a sign-in page`);
            throw new CliError(`state "${plan.name}" landed on a sign-in page, not the app: ${message}. ${signInHelp({ auth, prefix, url: safeUrl })}`, EXIT_SIGN_IN);
          }
          failures += 1;
          manifest.degradations.push({ step: `capture:${plan.name}`, reason: message, impact: `State "${plan.name}" showed a sign-in page and was not captured; the other states were.` });
          console.error(`state "${plan.name}" landed on a sign-in page: ${message}`);
          continue;
        }
        if (err instanceof CliError) {
          err.message = redact(err.message);
          const failure = err.failure ? { ...err.failure, detail: redact(err.failure.detail) } : { kind: 'error', finalUrl: null, detail: firstLine(err.message) };
          manifest.states[plan.name] = failedEntry(plan, firstLine(err.message), failure);
          manifest.failure = { ...failure, state: plan.name };
          manifest.degradations.push({ step: `capture:${plan.name}`, reason: err.message, impact: 'Capture stopped; later states were not captured.' });
          stopAfter(index, `capture stopped at state "${plan.name}"`);
          throw err;
        }
        failures += 1;
        let kind = 'error';
        if (err instanceof NavigationFailure) {
          navigationFailures += 1;
          lastFinalUrl = err.finalUrl;
          kind = 'navigation';
        }
        const message = firstLine(redact(err instanceof StateFailure ? err.message : err?.message ?? err));
        manifest.states[plan.name] = failedEntry(plan, message, { kind, finalUrl: kind === 'navigation' ? redactUrl(err.finalUrl) : null, detail: message });
        manifest.degradations.push({ step: `capture:${plan.name}`, reason: message, impact: `No screenshot for state "${plan.name}".` });
        console.error(`state "${plan.name}" failed: ${message}`);
      }
    }
    if (firstSignIn && !capturedCount && !previousBase) {
      manifest.failure = firstSignIn;
      throw new CliError(`every state landed on a sign-in page, not the app. ${signInHelp({ auth, prefix, url: safeUrl })}`, EXIT_SIGN_IN);
    }
    if (navigationFailures === plans.length) {
      const message =
        `every state ended on another page (last: ${redactUrl(lastFinalUrl)}) instead of ${safeUrl}: ` +
        'a routing problem — check the URL' +
        (run.allowNavigation ? ' (capture the final URL)' : ' (when the app always redirects, say to a locale prefix, capture the final URL or pass --allow-navigation)');
      manifest.failure = { kind: 'navigation', state: null, finalUrl: redactUrl(lastFinalUrl), detail: message };
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
