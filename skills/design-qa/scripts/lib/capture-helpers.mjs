// Pure helpers for capture.mjs: env placeholders, secret redaction, headers,
// cookies, auth types, state lists, per-state URLs and output paths, and the
// manifest merge. No browser code here, so tests can cover them without Chromium.
import { lstatSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { scriptCommand, usageError } from './args.mjs';
import { storageStateFromConfig, tildePath } from './setup.mjs';
import { driverProblems, loadSchema, validateAgainstSchema, validateConfig } from './schema-check.mjs';
import { exactStateName } from './state-discovery.mjs';

export const AUTH_TYPES = Object.freeze(['none', 'basic', 'cookie', 'storage-state', 'login']);

/** Elements and properties grabbed when no --grab file is given. */
export const DEFAULT_GRAB = Object.freeze({
  body: { selector: 'body', props: ['font-family', 'font-size', 'line-height', 'color', 'background-color'], limit: 1 },
  heading: {
    selector: 'h1, h2, h3, [role=heading]',
    props: ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'color', 'margin-top', 'margin-bottom'],
    limit: 3,
  },
  text: { selector: 'p, li, td', props: ['font-size', 'font-weight', 'line-height', 'letter-spacing', 'color'], limit: 3 },
  button: {
    selector: 'button, [role=button]',
    props: [
      'font-size', 'font-weight', 'line-height', 'color', 'background-color', 'border-radius', 'border-top-width',
      'border-top-color', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'height', 'box-shadow',
    ],
    limit: 3,
  },
  link: { selector: 'a[href]', props: ['font-size', 'font-weight', 'color', 'text-decoration-line'], limit: 3 },
  input: {
    selector: 'input, select, textarea',
    props: ['font-size', 'color', 'background-color', 'border-top-width', 'border-top-color', 'border-radius', 'height', 'padding-left'],
    limit: 3,
  },
  // Spinners, toasts, banners: where load and state-change animations usually live.
  feedback: {
    selector: '[role=status], [role=alert], [role=progressbar], [aria-busy=true]',
    props: ['color', 'background-color', 'border-radius', 'opacity'],
    limit: 3,
  },
});

/**
 * Expand ${ENV_VAR} placeholders in strings (recursively); a missing variable is a usage error.
 * `used` (a Map) collects every substituted variable as name → value, so the values can
 * be kept out of the evidence (secretEnvEntries + makeRedactor).
 */
export function expandEnv(value, env = process.env, where = 'input', used = null) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
      if (env[name] === undefined) throw usageError(`environment variable ${name} is not set (referenced as \${${name}} in ${where})`);
      if (used) used.set(name, String(env[name]));
      return env[name];
    });
  }
  if (Array.isArray(value)) return value.map((v) => expandEnv(v, env, where, used));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v, env, where, used)]));
  }
  return value;
}

/**
 * A bare location (http(s)/file URL without credentials, query or fragment), such as
 * the ${APP_URL} base URL: not a secret, so it stays readable in the evidence.
 */
export function isPlainLocation(value) {
  try {
    const u = new URL(String(value));
    return /^(https?|file):$/.test(u.protocol) && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return false;
  }
}

/** Substituted env variables whose values must never reach the evidence: [[name, value]]. */
export function secretEnvEntries(used) {
  return [...(used ?? new Map())].filter(([, v]) => String(v).length >= 3 && !isPlainLocation(v));
}

/** --auth value → none | basic | cookie | storage-state | login (storageState accepted). */
export function normalizeAuthType(type) {
  const t = String(type ?? 'none').trim();
  const v = t === 'storageState' || t === 'storage_state' ? 'storage-state' : t;
  if (!AUTH_TYPES.includes(v)) throw usageError(`--auth must be one of ${AUTH_TYPES.join(', ')} (got "${type}")`);
  return v;
}

/** ["name=value", "Name: value"] → { name: value } with ${ENV} expansion. */
export function parseHeaders(list = [], env = process.env, used = null) {
  const out = {};
  for (const item of list) {
    const m = /^\s*([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*(?:=|:)\s?(.*)$/.exec(item);
    if (!m) throw usageError(`--header: expected name=value (got "${item}")`);
    out[m[1]] = expandEnv(m[2], env, `--header ${m[1]}`, used);
  }
  return out;
}

/** "name=value; name2=value2" → Playwright cookies bound to the app URL's host. */
export function parseCookieString(cookie, appUrl) {
  const u = new URL(appUrl);
  const scope = `${u.protocol}//${u.host}/`;
  return String(cookie)
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const i = part.indexOf('=');
      if (i <= 0) throw usageError('the cookie variable must look like "name=value; name2=value2"');
      return { name: part.slice(0, i).trim(), value: part.slice(i + 1).trim(), url: scope };
    });
}

/**
 * Resolve credentials for an auth type from <prefix>_USER/_PASS/_COOKIE/_STORAGE_STATE.
 * Returns { httpCredentials?, cookies, storageStatePath?, storageStateSource?, user?,
 * pass?, secrets: [] }. Basic credentials are bound to the origin of `appUrl` (the app,
 * or the prototype with --side design): a third-party frame or image answering 401
 * never gets them.
 * storage-state: the <prefix>_STORAGE_STATE variable wins; else `storageState`, the
 * config's app.auth.storageState pointer (a PATH: ~ and ${ENV} expanded, relative to
 * `configDir`, the config file's folder). storageStateSource says which ("env" |
 * "config"). The file is never read here. Neither: a usage error naming both and
 * setup.mjs save-session.
 */
export function resolveAuth(type, prefix, env, appUrl, { storageState = null, configDir = process.cwd() } = {}) {
  const need = (suffix) => {
    const name = `${prefix}_${suffix}`;
    if (!env[name]) throw usageError(`--auth ${type} needs the ${name} environment variable`);
    return env[name];
  };
  const out = { cookies: [], secrets: [] };
  if (type === 'basic' || type === 'login') {
    out.user = need('USER');
    out.pass = need('PASS');
    out.secrets.push(out.user, out.pass);
    if (type === 'basic') out.httpCredentials = { username: out.user, password: out.pass, origin: new URL(appUrl).origin };
  } else if (type === 'cookie') {
    const cookie = need('COOKIE');
    out.secrets.push(cookie);
    out.cookies = parseCookieString(cookie, appUrl);
    out.secrets.push(...out.cookies.map((c) => c.value));
  } else if (type === 'storage-state') {
    const session = storageStateFromConfig(
      { app: { auth: { envPrefix: prefix, ...(typeof storageState === 'string' && storageState.trim() ? { storageState } : {}) } } },
      { env, configDir },
    );
    if (!session.path) {
      throw usageError(
        `--auth storage-state needs a saved session: set ${prefix}_STORAGE_STATE to its path, or app.auth.storageState in design-qa.config.json. ` +
          `To save one (the person signs in in a browser window; nothing is typed for them): ${scriptCommand('setup.mjs')} save-session`,
      );
    }
    out.storageStatePath = session.path;
    out.storageStateSource = session.source;
  }
  return out;
}

/**
 * The usage error for a saved session that is not there: the path (with ~ for the home
 * folder), where it came from, and how to save a fresh one. Never the file's content.
 */
export function missingSessionMessage({ path: file, source, prefix = 'DESIGN_QA_APP' }) {
  const from = source === 'env' ? `${prefix}_STORAGE_STATE` : 'app.auth.storageState';
  return (
    `the saved session ${tildePath(file)} (from ${from}) does not exist. Sign in again: ${scriptCommand('setup.mjs')} save-session ` +
    `(it opens a browser window, the person signs in, and the path is recorded in the config)${source === 'env' ? `, or point ${prefix}_STORAGE_STATE at an existing session file` : ''}`
  );
}

/** Replace every secret in a message with ***. */
export function redact(message, secrets = []) {
  let text = String(message ?? '');
  for (const s of secrets) if (s && s.length >= 3) text = text.split(s).join('***');
  return text;
}

// The forms a value takes once it is put in a URL: encoded as a path segment or a
// query value, and first decoded when it was written into a query string ("a+b" is
// "a b" there, then re-encoded as "a+b"; "%2F" is "/").
function encodedForms(value) {
  const bases = new Set([value]);
  const decoders = [(v) => new URLSearchParams(`v=${v}`).get('v'), decodeURIComponent];
  for (const d of decoders) {
    try {
      bases.add(d(value));
    } catch {
      // not decodable
    }
  }
  const forms = new Set();
  const encoders = [(v) => v, encodeURIComponent, encodeURI, (v) => new URLSearchParams({ v }).toString().slice(2)];
  for (const base of bases) {
    for (const e of encoders) {
      try {
        forms.add(e(base));
      } catch {
        // lone surrogates cannot be encoded
      }
    }
  }
  return [...forms];
}

/**
 * text → text with every secret removed: substituted env values (envEntries,
 * [[name, value]]) become "${NAME}", other secrets (credentials, header values)
 * "***". URL-encoded forms are replaced too, so a token passed in a query string
 * is caught in page URLs and error messages. Longest values first.
 */
export function makeRedactor({ secrets = [], envEntries = [] } = {}) {
  const pairs = [];
  for (const [name, value] of envEntries) for (const form of encodedForms(String(value))) pairs.push([form, `\${${name}}`]);
  for (const s of secrets) if (s) for (const form of encodedForms(String(s))) pairs.push([form, '***']);
  const list = pairs.filter(([v]) => v.trim().length >= 3).sort((a, b) => b[0].length - a[0].length);
  return (message) => {
    let text = String(message ?? '');
    for (const [value, mask] of list) if (text.includes(value)) text = text.split(value).join(mask);
    return text;
  };
}

const PLACEHOLDER = /\{(?:fixture|id)\}|%7B(?:fixture|id)%7D/gi;

function mergeQuery(url, query) {
  const q = String(query).replace(/^[?&]+/, '');
  if (!q) return url;
  const u = new URL(url);
  for (const [k, v] of new URLSearchParams(q)) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * URL for one state: a fixture replaces {fixture}/{id} in the URL (or is appended
 * as ?fixture=<value>); a query ("?state=empty" or "state=empty") is merged in.
 */
export function buildStateUrl(baseUrl, driver = {}, stateName = 'state') {
  let url = String(baseUrl);
  const hasPlaceholder = new RegExp(PLACEHOLDER.source, 'i').test(url);
  if (driver.fixture !== undefined && driver.fixture !== null && driver.fixture !== '') {
    const value = encodeURIComponent(String(driver.fixture));
    url = hasPlaceholder ? url.replace(PLACEHOLDER, value) : mergeQuery(url, `fixture=${value}`);
  } else if (hasPlaceholder) {
    throw usageError(`state "${stateName}": the URL contains {fixture}/{id} but the state has no "fixture" driver`);
  }
  if (driver.query) url = mergeQuery(url, driver.query);
  return url;
}

const DRIVING_KEYS = ['fixture', 'query', 'mock', 'storage', 'action', 'viewport'];

/**
 * Can this state be put on screen? with-data always can (default render); any
 * other state needs a fixture, query, mock, storage, action or viewport —
 * otherwise its screenshot would just be the default page under another name.
 * The name must be a with-data label exactly ("Default", "with data"), so
 * "Data table" with an empty driver is skipped, not captured as the default page.
 */
export function isDrivable(name, driver = {}) {
  if (exactStateName(name) === 'with-data') return true;
  return DRIVING_KEYS.some((k) => driver && driver[k] !== undefined && driver[k] !== null && driver[k] !== '');
}

/**
 * Loading states (or long delayed mocks) must not wait for network idle. The name
 * must be a loading label exactly ("loading", "Skeleton", "Items / Loading"), so
 * "Pending orders" or "Fetching done" is not a loading state.
 */
export function isLoadingState(name, driver = {}) {
  return exactStateName(name) === 'loading' || (Number(driver?.mock?.delayMs) || 0) >= 1000;
}

/**
 * Should the state's mocked request be held (never answered) until the capture is
 * done? Yes for a loading state whose mock has a delay — a state named loading, or a
 * delay-only mock (no status/body) of a second or more — so the loading UI cannot
 * finish before the screenshot. A delayed mock with a status or body in a state not
 * named loading is answered after its delay ("show the empty list after 5 s").
 */
export function holdsMock(name, driver = {}) {
  const mock = driver?.mock;
  const delay = Number(mock?.delayMs) || 0;
  if (!mock || delay <= 0) return false;
  if (exactStateName(name) === 'loading') return true;
  return delay >= 1000 && mock.status === undefined && mock.body === undefined;
}

/**
 * Where the page is, for "did it navigate away?": scheme, host and decoded path
 * (trailing slashes ignored). Query and fragment may change without counting.
 */
export function locationKey(href) {
  try {
    const u = new URL(String(href));
    let p = u.pathname;
    try {
      p = decodeURIComponent(p);
    } catch {
      // keep the encoded path
    }
    return `${u.protocol}//${u.host}${p.replace(/\/+$/, '') || '/'}`;
  } catch {
    return String(href);
  }
}

/**
 * Did the page stay where it was planned? Same locationKey, or the same place after
 * an http → https upgrade of the same host (http://h/items → https://h/items).
 * Hash routes are not compared: "#/login" counts as the same place.
 */
export function sameLocation(planned, final) {
  const a = locationKey(planned);
  const b = locationKey(final);
  return a === b || (a.startsWith('http://') && b.startsWith('https://') && a.slice('http://'.length) === b.slice('https://'.length));
}

// ---------------------------------------------------------------------------
// Sign-in detection
// ---------------------------------------------------------------------------

/**
 * Built-in sign-in URL heuristic, matched against host + path + fragment: a segment
 * named login, signin, sso, oauth, saml, authorize… (login.example.com, /auth/login,
 * #/sign-in). "/authors" or "/blogin" do not match: the word must be a whole segment part.
 */
const SIGN_IN_URL = /(^|[/._#-])(login|log-in|logon|signin|sign-in|sign_in|sso|oauth2?|openid|saml2?|authorize|auth|session\/new)([/._?#-]|$)/i;

/** Host, path and fragment of a URL: where the sign-in words would be. */
function signInHaystack(href) {
  try {
    const u = new URL(String(href));
    return `${u.host}${u.pathname}${u.hash}`;
  } catch {
    return String(href ?? '');
  }
}

/** Does the URL look like a sign-in page (built-in heuristic, host included: login.idp.example)? */
export function looksLikeSignInUrl(href) {
  return SIGN_IN_URL.test(signInHaystack(href));
}

/**
 * Does the URL's path or fragment name a sign-in page (/login, #/sign-in)? The host is left
 * out: a preview host built from a branch name (shop-git-fix-login.vercel.app) is not a
 * sign-in page, and must never switch the sign-in check off.
 */
export function looksLikeSignInPath(href) {
  try {
    const u = new URL(String(href));
    return SIGN_IN_URL.test(`${u.pathname}${u.hash}`);
  } catch {
    return false;
  }
}

export function hostOf(href) {
  try {
    return new URL(String(href)).host;
  } catch {
    return '';
  }
}

/**
 * Did the page move to a sign-in URL? Its path or fragment names a sign-in page, or it is
 * on ANOTHER host whose name does (login.idp.example). The planned host's own name never counts.
 */
function signInDestination(plannedUrl, finalUrl) {
  if (looksLikeSignInPath(finalUrl)) return true;
  return hostOf(finalUrl) !== hostOf(plannedUrl) && looksLikeSignInUrl(finalUrl);
}

/** app.auth.signInUrlPattern / --sign-in-url → a case-insensitive RegExp over the whole URL (usage error when invalid). */
export function compileSignInPattern(pattern, where = 'app.auth.signInUrlPattern') {
  if (pattern === undefined || pattern === null || pattern === '') return null;
  try {
    return new RegExp(String(pattern), 'i');
  } catch (err) {
    throw usageError(`${where} is not a valid regular expression: ${err.message}`);
  }
}

/** Fragment of a URL ("" when none or unparsable). */
function hashOf(href) {
  try {
    return new URL(String(href)).hash;
  } catch {
    return '';
  }
}

/**
 * Is the page a sign-in page instead of the app? Precedence, first match wins:
 *   1. allowSignIn (the state is meant to show a sign-in page) → never; the only blanket exemption;
 *   2. signInPattern (app.auth.signInUrlPattern) matches the final URL, or the URL of a frame
 *      covering the page, but not the planned URL → yes;
 *   3. a frame covering the page whose URL is a sign-in URL, or that holds a sign-in dialog or form → yes;
 *   4. signedInSelector configured (app.auth.signedInSelector): visible → no (signed in, whatever
 *      fields the page shows, e.g. a change-password dialog); not visible → yes;
 *   5. an open dialog ([role=dialog], [role=alertdialog], [aria-modal=true], <dialog open>) whose
 *      only password field is a current one (a "session expired" modal) → yes, unless `trusted`;
 *   6. the page stayed on its planned URL and that URL's path or fragment is a sign-in page
 *      (QA of the sign-in screen) → no. The host is never looked at: a preview host named after
 *      a "fix-login" branch is not a sign-in page;
 *   7. heuristics: the page moved to a sign-in URL (path or fragment, or another host whose
 *      name says so); the page moved and shows a sign-in form or title; a small page that says
 *      the session ended; or, at the planned URL, a small page whose form is a sign-in form
 *      (isSignInForm), its password branch skipped when `trusted`.
 * `trusted`: a state reached by a driver from a page captured as signed in, on the same host,
 * that did not move: a password field alone does not make it a sign-in page.
 * `signals` come from the page (signInSignals in capture.mjs), `frames` ([{ url, signals }])
 * from the frames covering most of the viewport; either may be null when unreadable.
 * → { signIn, signedIn: true | false | null (no selector configured and no sign-in seen), detail }.
 */
export function classifySignIn({ plannedUrl, finalUrl, signals = null, frames = [], signedInSelector = null, signedInVisible = null, signInPattern = null, allowSignIn = false, trusted = false }) {
  const no = (signedIn = null) => ({ signIn: false, signedIn, detail: null });
  const yes = (detail) => ({ signIn: true, signedIn: false, detail });
  if (allowSignIn) return no();
  if (signInPattern && !signInPattern.test(String(plannedUrl))) {
    if (signInPattern.test(String(finalUrl))) return yes(`the page URL matches the sign-in URL pattern /${signInPattern.source}/`);
    const framed = frames.find((f) => signInPattern.test(String(f.url)));
    if (framed) return yes(`a frame covering the page shows a URL matching the sign-in URL pattern /${signInPattern.source}/`);
  }
  for (const f of frames) {
    if (f.signals?.signInDialog) return yes('a sign-in dialog covers the page inside a frame');
    if (signInDestination(plannedUrl, f.url)) return yes('a frame covering the page shows a sign-in URL');
    if (isSignInForm(f.signals)) return yes('a frame covering the page shows a sign-in form');
  }
  if (signedInSelector) {
    return signedInVisible ? no(true) : yes(`the signed-in selector "${signedInSelector}" is not visible, so the signed-in app did not render`);
  }
  const moved = !sameLocation(plannedUrl, finalUrl) || hashOf(plannedUrl) !== hashOf(finalUrl);
  const trust = trusted && !moved;
  if (signals?.signInDialog && !trust) return yes('a sign-in dialog (a password field in an open dialog) covers the page');
  if (!moved && looksLikeSignInPath(plannedUrl)) return no();
  if (moved && signInDestination(plannedUrl, finalUrl)) return yes('the page moved to a sign-in URL');
  const s = signals || {};
  const pw = Number(s.loginPasswordFields) || 0;
  const wording = Boolean(s.signInTitle || s.signInButton);
  if (moved && (pw > 0 || (s.usernameField && wording) || s.signInTitle)) {
    return yes(pw > 0 ? 'the page moved to a page with a password field' : 'the page moved to a page that asks to sign in');
  }
  if (s.sessionEnded && (Number(s.interactive) || 0) <= 10) return yes('the page says the session ended');
  if (isSignInForm(s, { password: !trust })) return yes(pw ? 'a sign-in form (one password field) is on the page' : 'a sign-in form (an e-mail or user name field only) is on the page');
  return no();
}

/**
 * A small page whose only form is a sign-in form, not a sign-up form: one current-password field
 * and a user name, sign-in wording, or nothing else to type in and no other action (delete, save…);
 * or, with no password field, a lone e-mail or user name field with sign-in or "continue" wording
 * (a magic-link or identifier-first form).
 */
function isSignInForm(s, { password = true } = {}) {
  if (!s || (s.signUp && !s.signInTitle && !s.signInButton)) return false;
  const pw = Number(s.loginPasswordFields) || 0;
  const interactive = Number(s.interactive) || 0;
  const inputs = Number(s.textInputs) || 0;
  if (password && pw === 1 && !s.newPasswordFields && interactive <= 25 && inputs <= 3) {
    return Boolean(s.usernameField || s.signInTitle || s.signInButton || (inputs === 1 && !s.otherAction));
  }
  return !s.passwordFields && inputs === 1 && interactive <= 10 && Boolean(s.usernameField && (s.signInTitle || s.signInButton || s.continueWording));
}

/**
 * What to do when a capture lands on a sign-in page, in plain words, for the auth
 * type in use. Never contains a credential: only variable names and the redacted URL.
 */
export function signInHelp({ auth = 'none', prefix = 'DESIGN_QA_APP', url = '<url>' } = {}) {
  const save =
    `save a signed-in session with \`${scriptCommand('setup.mjs')} save-session\` (a browser window opens, the person signs in, ` +
    'and the session path is recorded as app.auth.storageState); or by hand: sign in once in a browser and save the session with ' +
    `\`npx playwright codegen --save-storage=<file outside the repository> ${url}\`, ` +
    `then set ${prefix}_STORAGE_STATE=<that file> and capture with --auth storage-state (config: app.auth.type "storageState")`;
  const why = {
    'storage-state': `The session in ${prefix}_STORAGE_STATE did not sign in (expired, or saved for another host). Save a fresh one: ${save}.`,
    cookie: `The cookie in ${prefix}_COOKIE was not accepted (expired, or for another host). Use a fresh cookie, or ${save}.`,
    basic: `The ${prefix}_USER / ${prefix}_PASS credentials were not enough: the app has its own sign-in. ${save[0].toUpperCase()}${save.slice(1)}.`,
    login: `The login flow (app.auth.login) did not leave a signed-in session. Check its selectors and successSelector, or ${save}.`,
  }[auth] ?? `To supply a session: ${save}.`;
  return (
    `The target needs a signed-in session; this page is not the app, so nothing was saved under the state's name. ${why} ` +
    `Check the session with \`${scriptCommand('capture.mjs')} --probe\` before capturing again (a sign-in page is not an unreachable app). ` +
    'If the app page legitimately shows a password field, set app.auth.signedInSelector to an element only the signed-in app renders; ' +
    'if this state is meant to show a sign-in page, set "allowSignIn": true on its driver.'
  );
}

// ---------------------------------------------------------------------------
// Tall frames
// ---------------------------------------------------------------------------

/** Default capture.maxViewportHeight: 1440, or 1000 for frames narrower than 768 px (phones). */
export function defaultMaxViewportHeight(width) {
  return Number(width) < 768 ? 1000 : 1440;
}

/**
 * The layout viewport for a design frame: a frame up to maxViewportHeight is a screen,
 * laid out at exactly W×H; a taller frame is a long page, laid out at W × maxViewportHeight
 * so 100vh layouts get a real screen height. Either way the capture covers the whole
 * page (capture.mjs), so the viewport only decides the layout. → { viewport, capped }.
 */
export function fitViewport(frame, maxViewportHeight = null) {
  const max = maxViewportHeight ?? defaultMaxViewportHeight(frame.width);
  if (frame.height <= max) return { viewport: { width: frame.width, height: frame.height }, capped: false };
  return { viewport: { width: frame.width, height: max }, capped: true };
}

/**
 * Is a screenshot the device-scale error? `expected` is what a DPR 1 capture of it
 * would measure (the viewport, or the page's scroll size for a whole-page capture).
 * A PNG that is an integer multiple (≥ 2) of it in both dimensions is: → the factor, or null.
 * (The page may change by a pixel between the measure and the screenshot: ±factor px.)
 */
export function scaleFactor(size, expected) {
  if (!expected?.width || !expected?.height) return null;
  const k = size.width / expected.width;
  if (!Number.isInteger(k) || k < 2) return null;
  return Math.abs(size.height - k * expected.height) <= k ? k : null;
}

/** "1,850" */
const px = (n) => Math.round(n).toLocaleString('en-US');

/** A plain-words line for a scroll container whose content the screenshot still does not show. */
export function clippedMessage(c) {
  if (c.axis === 'y' && c.cut) return `content is cut off inside ${c.selector}: ${px(c.hiddenPx)} px not shown (overflow hidden; the page scrolls it by script, so the screenshot cannot hold it)`;
  return c.axis === 'y'
    ? `the ${c.selector} panel still hides ${px(c.hiddenPx)} px of content below its fold (it scrolls inside the page; not in the screenshot)`
    : `the ${c.selector} panel scrolls sideways and hides ${px(c.hiddenPx)} px of content (not unrolled: the cut-off may itself be a finding)`;
}

// ---------------------------------------------------------------------------
// Pre-capture hook
// ---------------------------------------------------------------------------

const PRE_CAPTURE_KEYS = ['localStorage', 'sessionStorage', 'hide', 'remove', 'click'];

/**
 * Validate a preCapture block ({ localStorage, sessionStorage, hide, remove, click })
 * and return it with every key present. A hide, remove or click entry is a selector, or
 * { selector, states: [names] } to apply it to those states only. Selectors may not
 * contain { or } (they are also written into a style sheet). Throws usage errors.
 */
export function normalizePreCapture(value, where = 'preCapture') {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw usageError(`${where}: expected an object { localStorage, sessionStorage, hide, remove, click }`);
  const unknown = Object.keys(value).filter((k) => !PRE_CAPTURE_KEYS.includes(k));
  if (unknown.length) throw usageError(`${where}: unknown key(s) ${unknown.join(', ')} (expected ${PRE_CAPTURE_KEYS.join(', ')})`);
  const out = { localStorage: {}, sessionStorage: {}, hide: [], remove: [], click: [] };
  for (const area of ['localStorage', 'sessionStorage']) {
    const v = value[area];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'object' || Array.isArray(v)) throw usageError(`${where}.${area}: expected an object { "<key>": "<value>" }`);
    out[area] = { ...v };
  }
  const isSelector = (s) => typeof s === 'string' && s.trim();
  for (const list of ['hide', 'remove', 'click']) {
    const v = value[list];
    if (v === undefined || v === null) continue;
    const ok = (e) => isSelector(e) || (e && typeof e === 'object' && isSelector(e.selector) && Array.isArray(e.states) && e.states.length && e.states.every(isSelector));
    if (!Array.isArray(v) || !v.every(ok)) throw usageError(`${where}.${list}: expected an array of CSS selectors (or { "selector", "states": [names] })`);
    for (const e of v) if (/[{}]/.test(e.selector ?? e)) throw usageError(`${where}.${list}: "${e.selector ?? e}" is not a selector (no { or })`);
    out[list] = v.map((e) => (typeof e === 'string' ? e : { selector: e.selector, states: [...e.states] }));
  }
  return out;
}

/** `over` merged over `base`: storage keys of `over` win, selector lists are joined without repeats. */
export function mergePreCapture(base, over) {
  if (!base) return over ?? null;
  if (!over) return base;
  const join = (a, b) => [...new Map([...a, ...b].map((e) => [JSON.stringify(e), e])).values()];
  return {
    localStorage: { ...base.localStorage, ...over.localStorage },
    sessionStorage: { ...base.sessionStorage, ...over.sessionStorage },
    hide: join(base.hide, over.hide),
    remove: join(base.remove, over.remove),
    click: join(base.click, over.click),
  };
}

/** The preCapture block for one state: hide, remove and click as plain selectors, entries for other states left out. */
export function preCaptureFor(pc, state) {
  if (!pc) return null;
  const pick = (list) => list.filter((e) => typeof e === 'string' || e.states.includes(state)).map((e) => e.selector ?? e);
  return { ...pc, hide: pick(pc.hide), remove: pick(pc.remove), click: pick(pc.click) };
}

/** The style sheet for a state's preCapture: hide → visibility hidden, remove → display none. */
export function preCaptureCss(pc) {
  if (!pc) return '';
  return [...pc.hide.map((s) => `${s} { visibility: hidden !important; }`), ...pc.remove.map((s) => `${s} { display: none !important; }`)].join('\n');
}

/** What capture.json records of a preCapture block: storage keys and selectors, never storage values. */
export function describePreCapture(pc) {
  if (!pc) return null;
  return {
    localStorage: Object.keys(pc.localStorage),
    sessionStorage: Object.keys(pc.sessionStorage),
    hide: [...pc.hide],
    remove: [...pc.remove],
    click: [...pc.click],
  };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The absolute URL a redirect response points to, or null (not a redirect, no usable Location). */
export function redirectLocation(status, location, from) {
  if (!REDIRECT_STATUSES.has(Number(status)) || !location) return null;
  try {
    return new URL(String(location), String(from)).toString();
  } catch {
    return null;
  }
}

/** "Tab Tab Shift+Tab" / "Tab,Enter" → ["Tab", "Tab", "Shift+Tab"]. */
export function parseKeys(keys) {
  return String(keys ?? '')
    .split(/[\s,]+/)
    .filter(Boolean);
}

export function fileSafe(name) {
  return String(name).replace(/[^A-Za-z0-9._-]+/g, '-');
}

/** Two state names that write the same files ("with data"/"with-data", "Empty"/"empty" on a case-insensitive disk). */
export function sameStateFile(a, b) {
  return fileSafe(a).toLowerCase() === fileSafe(b).toLowerCase();
}

/** Evidence files of one state, relative to --out: [screenshot, computed, dom, motion, audit?] (audit on the app side). */
export function stateFiles(dirs, name) {
  const base = fileSafe(name);
  const files = [`${dirs.shots}/${base}.png`, `${dirs.computed}/${base}.json`, `${dirs.dom}/${base}.json`, `${dirs.motion}/${base}.json`];
  // The design-system audit file (audit/<state>.json, design-audit/<state>.json) goes with the others.
  if (dirs.audit) files.push(`${dirs.audit}/${base}.json`);
  return files;
}

/** Delete a state's evidence files, so a failed or skipped state never leaves stale evidence behind. */
export function removeStateFiles(outDir, dirs, name) {
  for (const rel of stateFiles(dirs, name)) {
    try {
      rmSync(path.join(outDir, rel), { force: true });
    } catch {
      // a directory or an unremovable file: nothing written there by capture
    }
  }
}

/**
 * Make <outDir>/<sub> a real directory: a symlink there (say, committed in a PR
 * checkout) is removed instead of followed, so evidence is never written outside --out.
 */
export function ensureOutSubdir(outDir, sub) {
  const dir = path.join(outDir, sub);
  let st = null;
  try {
    st = lstatSync(dir);
  } catch {
    st = null;
  }
  if (st?.isSymbolicLink()) unlinkSync(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Remove a symlink at `file` (never its target); anything else is left alone. */
export function unlinkSymlink(file) {
  try {
    if (lstatSync(file).isSymbolicLink()) unlinkSync(file);
  } catch {
    // nothing there
  }
}

/**
 * Write a file without following a symlink at its path: whatever is there (a
 * previous capture, or a link to a file outside --out) is unlinked and the file is
 * created afresh, exclusively.
 */
export function writeFileNoFollow(file, data) {
  let st = null;
  try {
    st = lstatSync(file);
  } catch {
    st = null;
  }
  if (st && !st.isDirectory()) unlinkSync(file);
  writeFileSync(file, data, { flag: 'wx' });
}

/** Validate one DRIVER against the config schema; returns warnings, throws usage errors. */
export function checkDriver(name, driver) {
  if (!driver || typeof driver !== 'object' || Array.isArray(driver)) {
    throw usageError(`state "${name}": the driver must be a JSON object`);
  }
  const schema = loadSchema('config');
  const res = validateAgainstSchema(driver, { ...schema.definitions.driver, definitions: schema.definitions });
  const problems = driverProblems(driver);
  const errors = [...res.errors.map((e) => `${e.path === '(root)' ? '' : `${e.path}: `}${e.message}`), ...problems.filter((p) => p.level === 'error').map((p) => p.message)];
  if (driver.allowNavigation !== undefined && typeof driver.allowNavigation !== 'boolean') errors.push('allowNavigation: expected true or false');
  if (errors.length) throw usageError(`state "${name}": ${errors.join('; ')}`);
  // allowNavigation is read by capture even where the schema does not list it yet.
  const warnings = res.warnings.filter((w) => !(w.path === 'allowNavigation' && /unknown key/.test(w.message)));
  return [...warnings.map((w) => `${w.path}: ${w.message}`), ...problems.filter((p) => p.level === 'warning').map((p) => p.message)];
}

/**
 * Ordered [[name, driver]] to capture. --state <name> captures only that state,
 * with --driver, else the states file's (or config's) driver for that name, else {}.
 * Otherwise every state of the states file; defaults to [["with-data", {}]].
 */
export function loadStates({ statesFile = null, stateName = null, driver = null } = {}) {
  if (statesFile !== null && (!statesFile || typeof statesFile !== 'object' || Array.isArray(statesFile))) {
    throw usageError('--states: expected an object { "<state>": { …driver } }');
  }
  let list;
  if (stateName) {
    if (!driver && statesFile && !Object.prototype.hasOwnProperty.call(statesFile, stateName)) {
      throw usageError(`state "${stateName}" has no driver: pass --driver, or use one of: ${Object.keys(statesFile).join(', ') || 'none'}`);
    }
    list = [[stateName, driver ?? statesFile?.[stateName] ?? {}]];
  } else if (statesFile && Object.keys(statesFile).length) {
    list = Object.entries(statesFile).map(([name, d]) => [name, d ?? {}]);
  } else {
    list = [['with-data', {}]];
  }
  for (const [name] of list) {
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name)) throw usageError(`state name "${name}" may only contain letters, digits, space, ".", "_" and "-"`);
  }
  // Each state writes <dir>/<fileSafe(name)>.png|json: names that map to the same file
  // ("with data" / "with-data", or "Empty" / "empty" on a case-insensitive disk) would
  // overwrite each other's evidence.
  for (let i = 0; i < list.length; i++) {
    for (let j = 0; j < i; j++) {
      if (sameStateFile(list[i][0], list[j][0])) {
        throw usageError(
          `states "${list[j][0]}" and "${list[i][0]}" would write the same evidence files (${fileSafe(list[i][0])}.png); rename one`,
        );
      }
    }
  }
  return list;
}

/** Validate a grab file: { "<elementClass>": { selector, props: [..], limit? } }. */
export function checkGrab(grab) {
  if (!grab || typeof grab !== 'object' || Array.isArray(grab)) throw usageError('--grab: expected an object { "<elementClass>": { "selector", "props": [] } }');
  for (const [cls, g] of Object.entries(grab)) {
    if (cls === 'rootTokens' || cls.startsWith('__')) throw usageError(`--grab: "${cls}" is reserved; rename that element class`);
    const ok = g && typeof g.selector === 'string' && g.selector && Array.isArray(g.props) && g.props.every((p) => typeof p === 'string');
    if (!ok) throw usageError(`--grab ${cls}: expected { "selector": string, "props": [string], "limit"?: number }`);
    if (g.limit !== undefined && !(Number.isInteger(g.limit) && g.limit >= 1)) throw usageError(`--grab ${cls}: limit must be an integer >= 1`);
  }
  return grab;
}

/**
 * Capture defaults from design-qa.config.json for one surface:
 * { url, states, auth, envPrefix, loginConfig, headers, signedInSelector, signInUrlPattern,
 *   preCapture (app.preCapture with surfaces.<name>.preCapture merged over it), fullPage
 *   (ignored: always the whole page), viewportOnly, maxViewportHeight, reducedMotion,
 *   allowNavigation, prototype, screens }.
 * With side "design" the app's auth, headers, sign-in checks and preCapture are not used.
 * The app URL is app.baseUrl + surface.route; with side "design" it is the surface's
 * prototype URL (or null). A screen ({ screen: "<id>" }) takes route / prototype from
 * surfaces.<name>.screens.<id> instead. Explicit CLI flags override every value.
 */
export function configDefaults(config, surfaceName = null, { side = 'app', screen = null } = {}) {
  const check = validateConfig(config);
  if (!check.valid) {
    throw usageError(`--config is invalid:\n${check.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
  }
  const names = Object.keys(config.surfaces || {});
  const name = surfaceName ?? (names.length === 1 ? names[0] : null);
  // A config without surfaces (a first pass: setup wrote only the app settings) gives the
  // app-wide settings; the page comes from --url, else app.baseUrl.
  const bare = !name && !names.length;
  if (!name && !bare) throw usageError(`--config has ${names.length} surfaces; pass --surface (one of: ${names.join(', ')})`);
  const surface = bare ? { route: '' } : config.surfaces[name];
  if (!surface) throw usageError(`surface "${name}" is not in the config (have: ${names.join(', ') || 'none'})`);
  const screens = surface.screens && Object.keys(surface.screens).length ? surface.screens : null;
  let target = surface;
  if (screen) {
    if (!screens?.[screen]) throw usageError(`surface "${name}" has no screen "${screen}" (have: ${Object.keys(screens || {}).join(', ') || 'none'})`);
    target = screens[screen];
  }
  const base = String(config.app.baseUrl).replace(/\/+$/, '');
  const route = String(target.route ?? surface.route ?? '');
  const auth = config.app.auth || {};
  const prototype = target.prototype ?? null;
  let url = /^https?:\/\//.test(route) ? route : `${base}/${route.replace(/^\/+/, '')}`;
  // Design side: the prototype URL (null when the config has none; --url must then be given).
  if (side === 'design') url = prototype;
  // The app's sign-in checks and pre-capture hook describe the app, never the prototype.
  const app = side !== 'design';
  return {
    surface: name,
    screen: screen ?? null,
    url,
    states: surface.states && Object.keys(surface.states).length ? surface.states : null,
    auth: app ? auth.type ?? 'none' : 'none',
    envPrefix: auth.envPrefix ?? null,
    loginConfig: app ? auth.login ?? null : null,
    // The saved session's PATH (app.auth.storageState), app side only; resolveAuth expands it.
    storageState: app && typeof auth.storageState === 'string' && auth.storageState.trim() ? auth.storageState : null,
    headers: app ? config.app.headers || {} : {},
    signedInSelector: app ? auth.signedInSelector ?? null : null,
    signInUrlPattern: app ? auth.signInUrlPattern ?? null : null,
    preCapture: app
      ? mergePreCapture(normalizePreCapture(config.app.preCapture, 'app.preCapture'), normalizePreCapture(surface.preCapture, `surfaces.${name}.preCapture`))
      : null,
    // Accepted for compatibility only: every capture covers the whole page now.
    fullPage: surface.fullPage === true,
    viewportOnly: config.capture?.viewportOnly === true,
    maxViewportHeight: config.capture?.maxViewportHeight ?? null,
    reducedMotion: config.capture?.reducedMotion === true,
    allowNavigation: config.capture?.allowNavigation === true,
    prototype: surface.prototype ?? null,
    screens,
  };
}

const stepState = (step) => String(step ?? '').replace(/^[^:]*:/, '');

/**
 * Merge a re-capture of some states (`recaptured`: the names this run captured or
 * skipped) into the previous manifest of the same evidence folder. Only when both
 * describe the same capture — side, url, viewport and fullPage — are the previous
 * manifest's other states (and their degradations) kept; re-captured states, and
 * old states writing the same files, are replaced. Returns { manifest, kept: [names],
 * replaced: [names], mismatch: null | "what differs" } (on a mismatch, `next` as is).
 */
export function mergeManifest(previous, next, recaptured = []) {
  if (!previous || typeof previous !== 'object' || !previous.states || typeof previous.states !== 'object' || Array.isArray(previous.states)) {
    return { manifest: next, kept: [], replaced: [], mismatch: null };
  }
  const diffs = [];
  if ((previous.side ?? 'app') !== next.side) diffs.push(`side (${previous.side ?? 'app'})`);
  if (previous.url !== next.url) diffs.push(`url (${previous.url})`);
  const pv = previous.viewport ?? {};
  const pf = previous.frame;
  if (pv.width !== next.viewport?.width || pv.height !== next.viewport?.height) diffs.push(`viewport (${pv.width}×${pv.height})`);
  // Two long frames share the capped viewport: the frame asked for must match too.
  else if (pf && next.frame && (pf.width !== next.frame.width || pf.height !== next.frame.height)) diffs.push(`frame (${pf.width}×${pf.height})`);
  if (Boolean(previous.fullPage) !== Boolean(next.fullPage)) diffs.push(`fullPage (${Boolean(previous.fullPage)})`);
  if (diffs.length) return { manifest: next, kept: [], replaced: [], mismatch: diffs.join(', ') };

  const fresh = new Map(Object.entries(next.states ?? {}));
  const states = [];
  const kept = [];
  const replaced = [];
  for (const [name, entry] of Object.entries(previous.states)) {
    if (fresh.has(name)) {
      states.push([name, fresh.get(name)]);
      fresh.delete(name);
    } else if (recaptured.some((r) => sameStateFile(r, name))) {
      replaced.push(name);
    } else {
      states.push([name, entry]);
      kept.push(name);
    }
  }
  states.push(...fresh);
  const keptSet = new Set(kept);
  const degradations = [
    ...(Array.isArray(previous.degradations) ? previous.degradations : []).filter((d) => keptSet.has(stepState(d?.step))),
    ...(next.degradations ?? []),
  ];
  if (kept.length && (previous.commit ?? null) !== (next.commit ?? null)) {
    degradations.push({
      step: 'capture:merge',
      reason: `kept ${kept.join(', ')} from a capture of commit ${previous.commit ?? 'unknown'}; re-captured ${recaptured.join(', ')} at ${next.commit ?? 'unknown'}`,
      impact: 'The evidence mixes two builds; re-capture every state before a final verdict.',
    });
  }
  return { manifest: { ...next, states: Object.fromEntries(states), degradations }, kept, replaced, mismatch: null };
}
