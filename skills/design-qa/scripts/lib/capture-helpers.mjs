// Pure helpers for capture.mjs: env placeholders, secret redaction, headers,
// cookies, auth types, state lists, per-state URLs and output paths, and the
// manifest merge. No browser code here, so tests can cover them without Chromium.
import { lstatSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { usageError } from './args.mjs';
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
 * Returns { httpCredentials?, cookies, storageStatePath?, user?, pass?, secrets: [] }.
 * Basic credentials are bound to the origin of `appUrl` (the app, or the prototype
 * with --side design): a third-party frame or image answering 401 never gets them.
 */
export function resolveAuth(type, prefix, env, appUrl) {
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
    out.storageStatePath = need('STORAGE_STATE');
  }
  return out;
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

/** Evidence files of one state, relative to --out: [screenshot, computed, dom, motion]. */
export function stateFiles(dirs, name) {
  const base = fileSafe(name);
  return [`${dirs.shots}/${base}.png`, `${dirs.computed}/${base}.json`, `${dirs.dom}/${base}.json`, `${dirs.motion}/${base}.json`];
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
 * { url, states, auth, envPrefix, loginConfig, headers, fullPage, reducedMotion,
 *   allowNavigation, prototype, screens }.
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
  if (!name) throw usageError(`--config has ${names.length} surfaces; pass --surface (one of: ${names.join(', ') || 'none'})`);
  const surface = config.surfaces[name];
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
  return {
    surface: name,
    screen: screen ?? null,
    url,
    states: surface.states && Object.keys(surface.states).length ? surface.states : null,
    auth: side === 'design' ? 'none' : auth.type ?? 'none',
    envPrefix: auth.envPrefix ?? null,
    loginConfig: side === 'design' ? null : auth.login ?? null,
    headers: side === 'design' ? {} : config.app.headers || {},
    fullPage: surface.fullPage === true,
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
  if (pv.width !== next.viewport?.width || pv.height !== next.viewport?.height) diffs.push(`viewport (${pv.width}×${pv.height})`);
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
