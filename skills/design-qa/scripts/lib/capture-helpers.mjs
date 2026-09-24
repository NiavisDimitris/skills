// Pure helpers for capture.mjs: env placeholders, headers, cookies, auth
// types, state lists and per-state URLs. No browser code here, so tests can
// cover them without Chromium.
import { usageError } from './args.mjs';
import { driverProblems, loadSchema, validateAgainstSchema, validateConfig } from './schema-check.mjs';
import { normalizeStateName } from './state-discovery.mjs';

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
});

/** Expand ${ENV_VAR} placeholders in strings (recursively); a missing variable is a usage error. */
export function expandEnv(value, env = process.env, where = 'input') {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
      if (env[name] === undefined) throw usageError(`environment variable ${name} is not set (referenced as \${${name}} in ${where})`);
      return env[name];
    });
  }
  if (Array.isArray(value)) return value.map((v) => expandEnv(v, env, where));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v, env, where)]));
  }
  return value;
}

/** --auth value → none | basic | cookie | storage-state | login (storageState accepted). */
export function normalizeAuthType(type) {
  const t = String(type ?? 'none').trim();
  const v = t === 'storageState' || t === 'storage_state' ? 'storage-state' : t;
  if (!AUTH_TYPES.includes(v)) throw usageError(`--auth must be one of ${AUTH_TYPES.join(', ')} (got "${type}")`);
  return v;
}

/** ["name=value", "Name: value"] → { name: value } with ${ENV} expansion. */
export function parseHeaders(list = [], env = process.env) {
  const out = {};
  for (const item of list) {
    const m = /^\s*([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*(?:=|:)\s?(.*)$/.exec(item);
    if (!m) throw usageError(`--header: expected name=value (got "${item}")`);
    out[m[1]] = expandEnv(m[2], env, `--header ${m[1]}`);
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
    if (type === 'basic') out.httpCredentials = { username: out.user, password: out.pass };
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
 */
export function isDrivable(name, driver = {}) {
  if (normalizeStateName(name) === 'with-data') return true;
  return DRIVING_KEYS.some((k) => driver && driver[k] !== undefined && driver[k] !== null && driver[k] !== '');
}

/** Loading states (or long delayed mocks) must not wait for network idle. */
export function isLoadingState(name, driver = {}) {
  return normalizeStateName(name) === 'loading' || (Number(driver?.mock?.delayMs) || 0) >= 1000;
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

/** Validate one DRIVER against the config schema; returns warnings, throws usage errors. */
export function checkDriver(name, driver) {
  if (!driver || typeof driver !== 'object' || Array.isArray(driver)) {
    throw usageError(`state "${name}": the driver must be a JSON object`);
  }
  const schema = loadSchema('config');
  const res = validateAgainstSchema(driver, { ...schema.definitions.driver, definitions: schema.definitions });
  const problems = driverProblems(driver);
  const errors = [...res.errors.map((e) => `${e.path === '(root)' ? '' : `${e.path}: `}${e.message}`), ...problems.filter((p) => p.level === 'error').map((p) => p.message)];
  if (errors.length) throw usageError(`state "${name}": ${errors.join('; ')}`);
  return [...res.warnings.map((w) => `${w.path}: ${w.message}`), ...problems.filter((p) => p.level === 'warning').map((p) => p.message)];
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
  return list;
}

/** Validate a grab file: { "<elementClass>": { selector, props: [..], limit? } }. */
export function checkGrab(grab) {
  if (!grab || typeof grab !== 'object' || Array.isArray(grab)) throw usageError('--grab: expected an object { "<elementClass>": { "selector", "props": [] } }');
  for (const [cls, g] of Object.entries(grab)) {
    const ok = g && typeof g.selector === 'string' && g.selector && Array.isArray(g.props) && g.props.every((p) => typeof p === 'string');
    if (!ok) throw usageError(`--grab ${cls}: expected { "selector": string, "props": [string], "limit"?: number }`);
    if (g.limit !== undefined && !(Number.isInteger(g.limit) && g.limit >= 1)) throw usageError(`--grab ${cls}: limit must be an integer >= 1`);
  }
  return grab;
}

/**
 * Capture defaults from design-qa.config.json for one surface:
 * { url, states, auth, envPrefix, loginConfig, headers, fullPage, reducedMotion }.
 * The URL is app.baseUrl + surface.route; explicit CLI flags override every value.
 */
export function configDefaults(config, surfaceName = null) {
  const check = validateConfig(config);
  if (!check.valid) {
    throw usageError(`--config is invalid:\n${check.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
  }
  const names = Object.keys(config.surfaces || {});
  const name = surfaceName ?? (names.length === 1 ? names[0] : null);
  if (!name) throw usageError(`--config has ${names.length} surfaces; pass --surface (one of: ${names.join(', ') || 'none'})`);
  const surface = config.surfaces[name];
  if (!surface) throw usageError(`surface "${name}" is not in the config (have: ${names.join(', ') || 'none'})`);
  const base = String(config.app.baseUrl).replace(/\/+$/, '');
  const route = String(surface.route || '');
  const auth = config.app.auth || {};
  return {
    surface: name,
    url: /^https?:\/\//.test(route) ? route : `${base}/${route.replace(/^\/+/, '')}`,
    states: surface.states && Object.keys(surface.states).length ? surface.states : null,
    auth: auth.type ?? 'none',
    envPrefix: auth.envPrefix ?? null,
    loginConfig: auth.login ?? null,
    headers: config.app.headers || {},
    fullPage: surface.fullPage === true,
    reducedMotion: config.capture?.reducedMotion === true,
  };
}
