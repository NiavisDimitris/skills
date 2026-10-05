// One pass, one command per stage: the bookkeeping behind scripts/pass.mjs (the capture
// plan for every screen and state, fingerprints that tell what is stale, pass.json, short
// output), and the run-ownership helper every script that writes into a report folder
// uses. node: built-ins only; no browser code (tests cover it without Chromium).
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CliError, oneLine, scriptCommand, shellArg, writeJson } from './args.mjs';
import { checkDriver, isDrivable } from './capture-helpers.mjs';
import { RUN_LOCK_FILE, assertRunOwnsDir, callerRunId } from './run-lock.mjs';
import { isVerifiedRow } from './ranking.mjs';
import { describeDriver, driverKind, keyState, normalizeStateName, stateId, stateLabel } from './state-discovery.mjs';
import { triageLists } from './triage.mjs';

export const PASS_FILE = 'pass.json';
export const PASS_KIND = 'design-qa-pass';
export const PASS_VERSION = 1;
/** The steps of `pass.mjs evidence`, in order (--only takes one of them). */
export const EVIDENCE_STEPS = Object.freeze(['discover', 'capture', 'design', 'diff', 'compare', 'audit', 'worklist', 'backfill']);
/** Default design frame of a coded prototype when nothing gives one (--frame overrides). */
export const DEFAULT_PROTOTYPE_FRAME = Object.freeze({ width: 1440, height: 900 });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const posix = (p) => p.split(path.sep).join('/');

// ---------------------------------------------------------------------------
// Run ownership
// ---------------------------------------------------------------------------

/**
 * The report folder that `target` (an output file or folder) lies in: the nearest of
 * `target` and its ancestors, up to `maxUp` levels, that holds a run lock
 * (.design-qa-run.json). null when there is none (an output outside any locked folder,
 * or a folder of an older pass). The folder must be a real directory, not a link.
 */
export function lockedReportDir(target, { maxUp = 5 } = {}) {
  let dir = path.resolve(target);
  for (let i = 0; i <= maxUp; i += 1) {
    const lock = path.join(dir, RUN_LOCK_FILE);
    try {
      if (existsSync(lock) && lstatSync(dir).isDirectory()) return dir;
    } catch {
      // unreadable: keep looking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * For scripts that write `target` (a file or folder) somewhere under a report folder:
 * refuse (CliError, exit 5) when the locked report folder it lies in belongs to another
 * run. `runFlag` is the script's --run value (else DESIGN_QA_RUN_ID). No locked folder
 * above `target`, or no run id given: passes (assertRunOwnsDir's rules). Returns the
 * report folder (or null).
 */
export function assertRunOwnsOutput(target, runFlag) {
  const dir = lockedReportDir(target);
  if (!dir) return null;
  assertRunOwnsDir(dir, { runId: callerRunId(runFlag) });
  return dir;
}

// ---------------------------------------------------------------------------
// Files, fingerprints, pass.json
// ---------------------------------------------------------------------------

/** Parsed JSON, or null when the file is missing or unreadable. */
export function readJsonOrNull(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

/** "size:mtime" of a file (null when missing): what tells a step its input changed. */
export function stamp(file) {
  try {
    const st = statSync(file);
    return st.isFile() ? `${st.size}:${Math.round(st.mtimeMs)}` : null;
  } catch {
    return null;
  }
}

/** A short stable hash of any JSON value. */
export function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 16);
}

export function readPass(dir) {
  const p = readJsonOrNull(path.join(dir, PASS_FILE));
  return isObj(p) && p.kind === PASS_KIND ? p : null;
}

export function writePass(dir, pass) {
  writeJson(path.join(dir, PASS_FILE), { ...pass, updatedAt: new Date().toISOString() });
}

/** A new pass.json body. */
export function newPass({ runId, feature, dir, config, surface, url, design, ticket, label }) {
  const now = new Date().toISOString();
  return {
    kind: PASS_KIND,
    version: PASS_VERSION,
    runId,
    feature,
    dir,
    config: config ?? null,
    surface: surface ?? null,
    url: url ?? null,
    design: design ?? null,
    ticket: ticket ?? null,
    label: label ?? null,
    startedAt: now,
    updatedAt: now,
    stages: {},
    steps: {},
    states: {},
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** A printable command: each argument quoted for the shell when it needs it ({ raw } as given). */
export function command(...parts) {
  return parts.flat().filter((p) => p !== null && p !== undefined && p !== false).map((p) => (typeof p === 'object' ? p.raw : shellArg(String(p)))).join(' ');
}

/** A URL for a printed command: as given, or a "${NAME}" placeholder when it carries a secret. */
export const urlArg = (url, name) => (urlHasSecret(url) ? { raw: `"\${${name}}"` } : url);

/** A printed command that runs one of this skill's scripts from the working directory: scriptCmd('pass.mjs', 'status', '--dir', d). */
export function scriptCmd(name, ...args) {
  const rest = command(...args);
  return `${scriptCommand(name)}${rest ? ` ${rest}` : ''}`;
}

/**
 * A child script's output as lines to relay: each folded to one line, blank lines and the
 * child's own "Next:" / "Do:" lines dropped (the pass prints its own; the child's stay in its log).
 */
export function childLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((l) => oneLine(l))
    .filter((l) => l && !/^(Next|Do):/.test(l));
}

// ---------------------------------------------------------------------------
// Secrets in what a pass writes and prints
// ---------------------------------------------------------------------------

const SECRET_ENV = /(TOKEN|SECRET|PASS|PASSWORD|COOKIE|BYPASS|API_?KEY|CREDENTIALS?)$/i;

// A query parameter is secret when its name says so, or its value is token-shaped (long and
// opaque): preview share links, protection bypass tokens, signatures. Short values (node-id,
// ?empty=1, ?page=2) are kept, so design links and state routes stay readable.
const SECRET_PARAM = /token|secret|key|sig|signature|auth|pass|session|share|bypass|code|jwt|access|credential|cookie|^t$/i;
const secretParam = (k, v) => SECRET_PARAM.test(k) || /^[A-Za-z0-9_\-.~%+/=]{16,}$/.test(v);

/** Does this URL carry something to keep out of logs: user info or a secret-looking query value? */
export function urlHasSecret(url) {
  try {
    const u = new URL(String(url));
    return Boolean(u.username || u.password || [...u.searchParams].some(([k, v]) => secretParam(k, v)));
  } catch {
    return false;
  }
}

/** A URL with its user info and every secret-looking query value replaced by *** (keys kept). */
export function redactUrl(url) {
  try {
    const u = new URL(String(url));
    if (!urlHasSecret(url)) return String(url);
    if (u.username) u.username = '***';
    if (u.password) u.password = '***';
    const params = [...u.searchParams];
    if (params.length) u.search = params.map(([k, v]) => `${encodeURIComponent(k)}=${secretParam(k, v) ? '***' : encodeURIComponent(v)}`).join('&');
    return u.toString().replace(/%2A%2A%2A/g, '***');
  } catch {
    return String(url);
  }
}

/**
 * A redactor for everything a pass writes (logs, pass.json) or prints: every http(s) URL
 * loses its query values and user info, and the values of secret-looking environment
 * variables (…_TOKEN, …_PASS, …_COOKIE, …_BYPASS, …) and of `extra` become ***.
 */
export function makePassRedactor({ env = process.env, extra = [] } = {}) {
  const secrets = [...Object.entries(env).filter(([k, v]) => SECRET_ENV.test(k) && typeof v === 'string' && v.length >= 6).map(([, v]) => v), ...extra.filter((v) => typeof v === 'string' && v.length >= 6)].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = String(text ?? '');
    for (const s of secrets) out = out.split(s).join('***');
    return out.replace(/\bhttps?:\/\/[^\s'"<>`)]+/g, (m) => redactUrl(m));
  };
}

/** The query values and user info of a URL: what must not appear anywhere else either. */
export function urlSecrets(url) {
  try {
    const u = new URL(String(url));
    return [...[...u.searchParams].filter(([k, v]) => secretParam(k, v)).map(([, v]) => v), decodeURIComponent(u.username), decodeURIComponent(u.password)].filter((v) => v && v.length >= 6);
  } catch {
    return [];
  }
}

/** <dir>/.design-qa-pass-private.json: the pass's URLs with their query strings (mode 600; never uploaded or served). */
export const PRIVATE_FILE = '.design-qa-pass-private.json';

export function readPrivate(dir) {
  const p = readJsonOrNull(path.join(dir, PRIVATE_FILE));
  return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
}

export function writePrivate(dir, data) {
  const file = path.join(dir, PRIVATE_FILE);
  try {
    if (lstatSync(file).isSymbolicLink()) throw new CliError(`refusing to write ${file}: it is a symbolic link`, 1);
  } catch (err) {
    if (err instanceof CliError) throw err;
  }
  writeFileSync(file, `${JSON.stringify(data)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** The feature of a report folder name: a sibling folder's "--<run id>" suffix removed. */
export function featureOfFolder(name) {
  return String(name).replace(/--\d{8}T\d{6}Z-[0-9a-f]{6}$/, '').toLowerCase();
}

/** At most `max` lines; the rest counted. → { shown, hidden } */
export function capLines(lines, max) {
  if (lines.length <= max) return { shown: lines, hidden: 0 };
  return { shown: lines.slice(0, Math.max(0, max - 1)), hidden: lines.length - Math.max(0, max - 1) };
}

/**
 * The lines of a child's output worth showing an agent: errors and warnings first
 * (each folded to one line), then the rest, at most `max`.
 */
export function relevantLines(text, max = 8) {
  const lines = childLines(text);
  const important = lines.filter((l) => /\berror\b|\bwarning\b|refus|fail|missing|not found|cannot|denied|problem/i.test(l));
  const pick = important.length ? important : lines.slice(-max);
  return pick.slice(0, max);
}

// ---------------------------------------------------------------------------
// The capture plan
// ---------------------------------------------------------------------------

/** "1440x900" / "1440×900" → { width, height }; null when not a size. */
export function parseSize(text) {
  const m = /^\s*(\d{1,5})\s*[x×]\s*(\d{1,5})\s*$/i.exec(String(text ?? ''));
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return width >= 1 && height >= 1 ? { width, height } : null;
}

const sizeOf = (f) => {
  const w = Math.round(Number(f?.width));
  const h = Math.round(Number(f?.height));
  return w >= 1 && h >= 1 ? { width: w, height: h } : null;
};
const sameSize = (a, b) => Boolean(a && b) && a.width === b.width && a.height === b.height;

/**
 * The driver of one designed state from surfaces.<name>.states: the key "<screen>/<state>"
 * first (then "<variantOf>/<state>" for a breakpoint variant), else a plain key that names
 * the same state ("Empty", "with data"). with-data without a key is the default render
 * ({}). → { key, driver } or null.
 */
export function driverFor(surface, { screen = null, variantOf = null, state, passStates = null }) {
  const lookup = (states, from) => {
    for (const prefix of [screen, variantOf].filter(Boolean)) {
      const key = `${prefix}/${state}`;
      if (isObj(states[key])) return { key, driver: states[key], from };
    }
    // A key that spells the id ("hover-tile") wins over one whose name maps to it ("Empty").
    const plain = Object.entries(states).filter(([key, driver]) => !key.includes('/') && isObj(driver));
    const hit = plain.find(([key]) => stateId(key) === state) ?? plain.find(([key]) => normalizeStateName(key) === state);
    return hit ? { key: hit[0], driver: hit[1], from } : null;
  };
  // The pass's own drivers (<dir>/states.json) win over the config's.
  return (
    (isObj(passStates) ? lookup(passStates, 'pass') : null) ??
    lookup(isObj(surface?.states) ? surface.states : {}, 'config') ??
    (state === 'with-data' ? { key: null, driver: {}, from: 'default' } : null)
  );
}

/** The route-bearing screen of the config for a design screen: itself, else the screen it is a variant of. */
function configScreenFor(surface, id, variantOf) {
  const screens = isObj(surface?.screens) ? surface.screens : null;
  if (!screens || !id) return null;
  if (isObj(screens[id])) return id;
  if (variantOf && isObj(screens[variantOf])) return variantOf;
  return null;
}

/**
 * Plan the evidence of a pass: every screen with its frame size, capture folder and
 * route, and every designed state with its driver or the reason it cannot be captured.
 *   matrix      state-matrix.json rows
 *   census      design-census.json (Figma source), null for a prototype
 *   spec        evidence/figma-spec.json (Figma source)
 *   surface     the config's surfaces.<name> (may be null), surfaceName its name
 *   prototype   { url, frame } for a coded prototype source
 *   onlyStates  --states list (full or local ids), null for every state
 *   url         the pass's --url: the route of the one Figma screen nothing else routes,
 *               unless a routed screen has that path (→ urlScreen)
 * → { multi, screens: [{ id, key, out, frame, variantOf, configScreen, problem, states:
 *     [{ id, local, kind, designFrame, driverKey, driver, status, hook, note }] }] }
 * status: planned · no-driver · excluded · no-route.
 */
export function planEvidence({ matrix, census = null, spec = null, surface: configSurface = null, surfaceName = '<surface>', prototype = null, onlyStates = null, passDrivers = null, url = null }) {
  const passStates = passDrivers?.states ?? null;
  const passRoutes = passDrivers?.screens ?? {};
  // Screens from the pass's file complete the config's (key by key: the file wins).
  const merged = { ...(isObj(configSurface?.screens) ? configSurface.screens : {}) };
  for (const [id, sc] of Object.entries(passRoutes)) merged[id] = { ...(isObj(merged[id]) ? merged[id] : {}), ...sc };
  const surface = Object.keys(passRoutes).length ? { ...(configSurface ?? {}), screens: merged } : configSurface;
  const rows = Array.isArray(matrix) ? matrix.filter((r) => isObj(r) && typeof r.state === 'string') : [];
  const multi = rows.some((r) => typeof r.screen === 'string' && r.screen);
  const censusScreens = Array.isArray(census?.screens) ? census.screens : [];
  const kindOf = new Map();
  const triggerOf = new Map();
  for (const s of censusScreens) {
    for (const st of s.states ?? []) {
      kindOf.set(`${multi ? s.id : ''}/${st.state}`, st.kind ?? 'state');
      if (st.trigger) triggerOf.set(`${multi ? s.id : ''}/${st.state}`, st.trigger);
    }
  }
  const configScreens = isObj(surface?.screens) && Object.keys(surface.screens).length ? surface.screens : null;
  const wanted = onlyStates && onlyStates.length ? new Set(onlyStates) : null;
  const order = [];
  const byKey = new Map();
  const variantOfScreen = (id) => censusScreens.find((s) => s.id === id)?.variantOf ?? null;
  const configScreenOf = (id) => (prototype ? (id && configScreens?.[id] ? id : null) : configScreenFor(surface, id, variantOfScreen(id)));
  // The app route and the prototype of a screen (config screens merged with the pass's file).
  const routeOf = (id) => (configScreenOf(id) ? surface?.screens?.[configScreenOf(id)]?.route ?? (prototype ? null : surface?.route ?? null) : null);
  // --url routes the one Figma screen nothing else routes, unless a routed screen has its path.
  let urlScreen = null;
  const given = url;
  if (multi && !prototype && given) {
    const ids = [...new Set(rows.map((r) => r.screen))];
    const unrouted = ids.filter((id) => !routeOf(id));
    const pathOf = (r) => {
      try {
        return `/${(/^https?:/.test(r) ? new URL(r).pathname : r.split(/[?#]/)[0]).replace(/^\/+|\/+$/g, '')}`;
      } catch {
        return null;
      }
    };
    const here = pathOf(given);
    const taken = ids.map(routeOf).some((r) => typeof r === 'string' && pathOf(r) === here);
    if (here && unrouted.length === 1 && !taken) urlScreen = unrouted[0];
  }
  for (const row of rows) {
    const id = multi ? row.screen : null;
    const key = id ?? 'main';
    if (!byKey.has(key)) {
      const cs = id ? censusScreens.find((s) => s.id === id) : censusScreens.find((s) => s.nodeId === spec?.nodeId) ?? censusScreens[0];
      const variantOf = cs?.variantOf ?? null;
      const frame = sizeOf(prototype?.frame) ?? sizeOf(cs?.frame) ?? sizeOf(spec?.frame) ?? sizeOf(row.designed?.frame);
      const configScreen = configScreenOf(id);
      // A route only the pass's file gives: capture gets the URL itself (the config has no such screen).
      const passRoute = configScreen && passRoutes[configScreen]?.route && configSurface?.screens?.[configScreen]?.route !== passRoutes[configScreen].route ? passRoutes[configScreen].route : null;
      const route = id && id === urlScreen ? given : routeOf(id);
      const screenPrototype = id ? surface?.screens?.[id]?.prototype ?? null : null;
      let problem = null;
      if (multi && !route) {
        problem = {
          status: 'no-route',
          hook: `states.json screens.${variantOf ?? id}.route`,
          note: `No route for screen "${id}"${variantOf ? ` (a breakpoint variant of ${variantOf})` : ''}: add it to the pass's states.json as "screens": { "${variantOf ?? id}": { "route": "/…" } } (or surfaces.${surfaceName}.screens.${variantOf ?? id}.route in the config).`,
        };
      }
      if (!frame) problem = { status: 'no-frame', hook: null, note: `The design frame size of ${id ?? 'the screen'} is unknown.` };
      byKey.set(key, { id, key, out: id ? `evidence/screens/${id}` : 'evidence', frame, variantOf, configScreen, passRoute, route, prototype: screenPrototype, nodeId: cs?.nodeId ?? null, problem, states: [] });
      order.push(key);
    }
    const screen = byKey.get(key);
    const local = multi ? row.state.slice(row.state.indexOf('/') + 1) : row.state;
    const kind = kindOf.get(`${multi ? id : ''}/${local}`) ?? (prototype ? 'state' : 'state');
    const designFrame = sizeOf(row.designed?.frame);
    const entry = { id: row.state, local, kind, trigger: triggerOf.get(`${multi ? id : ''}/${local}`) ?? null, designFrame, designName: row.designed?.name ?? null, designNode: row.designed?.nodeId ?? null, driverKey: null, driverFrom: null, driver: null, status: 'planned', hook: null, note: null };
    if (wanted && !wanted.has(row.state) && !wanted.has(local)) {
      Object.assign(entry, { status: 'excluded', note: 'Excluded by --states.' });
    } else if (screen.problem) {
      Object.assign(entry, { status: screen.problem.status, hook: screen.problem.hook, note: screen.problem.note });
    } else {
      const found = driverFor(surface, { screen: id, variantOf: screen.variantOf, state: local, passStates });
      if (!found || !isDrivable(local, found.driver)) {
        const hook = `states.json "${row.state}"`;
        Object.assign(entry, {
          status: 'no-driver',
          hook,
          driverKey: found?.key ?? null,
          note:
            `No driver: nothing puts "${local}" on screen. Add one to the pass's states.json as "${row.state}": { … } (fixture, query, mock, storage or action; references/state-matrix.md), ` +
            `or at surfaces.${surfaceName}.states.${found?.key ?? local} in the config. If the code has no such state, set it MISSING_IN_CODE in findings.json "states" with a note.`,
        });
      } else {
        let driver = found.driver;
        // A state frame of another size is captured at its own size (an overlay is opened over the screen instead).
        if (kind !== 'overlay' && designFrame && !sameSize(designFrame, screen.frame) && !driver.viewport) driver = { ...driver, viewport: designFrame };
        Object.assign(entry, { driverKey: found.key, driverFrom: found.from, driver });
      }
    }
    screen.states.push(entry);
  }
  return { multi, urlScreen, screens: order.map((k) => byKey.get(k)) };
}

/**
 * State-matrix rows for a coded prototype (no Figma spec): the prototype shows with-data
 * and every state the config drives on it (the same drivers run on both sides). Per screen
 * when the config lists screens with a prototype each.
 */
export function prototypeMatrix({ surface = null, frame, screens = null, passStates = null }) {
  const ids = Array.isArray(screens) && screens.length ? screens : [null];
  const multi = ids[0] !== null;
  const configKeys = Object.keys(isObj(surface?.states) ? surface.states : {});
  const passKeys = Object.keys(isObj(passStates) ? passStates : {});
  // A key names the state it spells ("hover-tile"); a with-data synonym ("default") is with-data.
  const idOf = (key) => (normalizeStateName(key) === 'with-data' ? 'with-data' : stateId(key));
  const rows = [];
  const clashes = [];
  for (const screen of ids) {
    const keys = new Set(['with-data']);
    const take = (keyOf, key, { plainForEvery }) => {
      const slash = key.indexOf('/');
      let id = null;
      if (slash >= 0) {
        if (!multi || key.slice(0, slash) === screen) id = idOf(key.slice(slash + 1));
      } else if (!multi || plainForEvery) id = idOf(key);
      if (!id) return;
      const scope = `${slash >= 0 ? key.slice(0, slash) : ''}/${id}`;
      if (keyOf.has(scope) && keyOf.get(scope) !== key) clashes.push(`"${oneLine(keyOf.get(scope))}" and "${oneLine(key)}" are both state "${id}"`);
      keyOf.set(scope, key);
      keys.add(id);
    };
    // A "<screen>/<state>" key belongs to that screen only. A plain key of the config's
    // surface-level states applies to every screen; a plain key in the pass's states.json
    // only in a single-screen pass (evidence refuses it in a multi-screen one).
    const fromConfig = new Map();
    const fromPass = new Map();
    for (const key of configKeys) take(fromConfig, key, { plainForEvery: true });
    for (const key of passKeys) take(fromPass, key, { plainForEvery: false });
    for (const state of keys) {
      rows.push({
        state: screen ? `${screen}/${state}` : state,
        ...(screen ? { screen } : {}),
        label: stateLabel(state),
        designed: { nodeId: '', name: `Prototype${screen ? ` ${screen}` : ''} – ${stateLabel(state)}`, frame },
        specified: null,
        implemented: null,
        captured: null,
        result: 'CANNOT_VERIFY',
        note: 'Pending capture; compare replaces this with PASS/FAIL.',
        findings: [],
      });
    }
  }
  if (clashes.length) throw new CliError(`two state keys name one state: ${[...new Set(clashes)].join('; ')}. Rename or remove one of each pair`, 3);
  return rows;
}

/** Plain (unscoped) keys of the config's surface-level states: they apply to every screen of a multi-screen pass. */
export function expandedConfigStates(surface) {
  return Object.keys(isObj(surface?.states) ? surface.states : {}).filter((k) => !k.includes('/') && normalizeStateName(k) !== 'with-data');
}

/**
 * Rewrite the provisional matrix for what the plan found: a designed state the pass
 * cannot put on screen is CANNOT_VERIFY with the hook named (never MISSING_IN_CODE by
 * default: that is a judgement for findings.json), an excluded one says so.
 */
export function annotateMatrix(matrix, plan) {
  const byId = new Map(plan.screens.flatMap((s) => s.states.map((st) => [st.id, st])));
  return matrix.map((row) => {
    const st = byId.get(row.state);
    // A state the plan drives (states.json or the config) is implemented: capture and compare decide it.
    if (st?.status === 'planned' && st.driver && !row.implemented && row.result === 'MISSING_IN_CODE') {
      return { ...row, implemented: { driver: driverKind(st.driver) ?? 'fixture', detail: describeDriver(st.driver) }, result: 'CANNOT_VERIFY', note: 'Pending capture; compare replaces this with PASS/FAIL.' };
    }
    if (!st || st.status === 'planned') return row;
    return { ...row, result: 'CANNOT_VERIFY', note: st.note };
  });
}

/** What a capture.json entry says about a state: captured · failed · skipped · missing. */
export function captureOutcome(entry, base) {
  if (!isObj(entry)) return { status: 'missing' };
  if (entry.screenshot && existsSync(path.join(base, entry.screenshot))) {
    return { status: 'captured', wholePage: wholePage(entry) };
  }
  if (entry.skipped) return { status: 'no-driver', detail: 'no runtime driver' };
  const kind = entry.failure?.kind ?? 'error';
  return { status: kind === 'sign-in' ? 'sign-in' : kind === 'stopped' ? 'stopped' : 'failed', detail: oneLine(entry.error ?? entry.failure?.detail ?? 'not captured') };
}

/** Did a captured state's PNG cover its whole page? { covered, page, size, clipped }. */
export function wholePage(entry) {
  const page = sizeOf(entry?.page);
  const size = sizeOf(entry?.size);
  const clipped = Array.isArray(entry?.clipped) ? entry.clipped.length : 0;
  const covered = Boolean(entry?.fullPage) && Boolean(page && size) && size.width >= page.width && size.height >= page.height;
  return { covered, page, size, clipped };
}

/**
 * The report summary's whole-page line: states captured over their full height and width,
 * and each captured state that is not verified with why ("review/promo: not implemented in
 * the app"), so "9 of 9 captured" beside "8 of 9 verified" explains itself.
 */
export function wholePageLine(report) {
  const rows = (Array.isArray(report?.stateMatrix) ? report.stateMatrix : []).filter((r) => isObj(r) && isObj(r.captured?.page));
  const whole = rows.filter((r) => r.captured.page.fullPage && (r.captured.page.image?.height ?? 0) >= r.captured.page.height && (r.captured.page.image?.width ?? 0) >= r.captured.page.width);
  const why = (r) => ({ MISSING_IN_CODE: 'not implemented in the app', NOT_SPECIFIED: 'not in the design', CANNOT_VERIFY: 'cannot verify (see report.html)' })[r.result] ?? 'not compared';
  const unverified = rows.filter((r) => !isVerifiedRow(r, report));
  const listed = unverified.slice(0, 3).map((r) => `${oneLine(r.state)}: ${why(r)}`);
  const more = unverified.length > 3 ? `; ${unverified.length - 3} more` : '';
  return `Whole page: ${whole.length} of ${rows.length} states captured over their full height and width${listed.length ? ` · captured, not verified: ${listed.join('; ')}${more}` : ''}`;
}

/**
 * The fix-now list as the fix plan has it (the fix-now bucket, then any other blocker): one
 * line each, "  fix now DQ-017 BLOCKER: <title cut to 90>", at most max, then where the rest is.
 * → { count, lines }.
 */
export function fixNowLines(report, { max = 10, fixplan = 'report-fixplan.md' } = {}) {
  const list = triageLists(report).fixNow;
  const cut = (t) => (t.length > 90 ? `${t.slice(0, 89)}…` : t);
  const lines = list.slice(0, max).map((f) => `  fix now ${oneLine(f.id)} ${oneLine(f.severity)}: ${cut(oneLine(f.title ?? ''))}`);
  if (list.length > max) lines.push(`  … ${list.length - max} more fix-now finding(s) in ${fixplan}`);
  return { count: list.length, lines };
}

/** Count rows with result FAIL anywhere in a compare.json. */
export function countFails(value) {
  let n = 0;
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (isObj(v)) {
      if (v.result === 'FAIL') n += 1;
      for (const x of Object.values(v)) if (x && typeof x === 'object') walk(x);
    }
  };
  walk(value);
  return n;
}

export { posix };

// ---------------------------------------------------------------------------
// The pass's own drivers: <dir>/states.json
// ---------------------------------------------------------------------------

export const PASS_STATES_FILE = 'states.json';

/**
 * Read <dir>/states.json: { "<state>" | "<screen>/<state>": DRIVER, …, "screens"?: { "<id>":
 * { "route": "/…" } } } (keys starting with $ are comments). The same drivers as the config's
 * surfaces.<name>.states, for this pass only; they win over the config's. Every driver is
 * checked with the config's rules. → { file, exists, states, screens, problems: [line],
 * warnings: [line] }; problems name the key inside the file.
 */
export function readPassDrivers(dir, { designed = null } = {}) {
  const file = path.join(dir, PASS_STATES_FILE);
  const out = { file, exists: existsSync(file), states: {}, screens: {}, problems: [], warnings: [] };
  if (!out.exists) return out;
  const rel = `${PASS_STATES_FILE}`;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    out.problems.push(`${rel}: not valid JSON (${oneLine(err.message)})`);
    return out;
  }
  if (!isObj(raw)) {
    out.problems.push(`${rel}: expected an object { "<state>" or "<screen>/<state>": { …driver } }`);
    return out;
  }
  const known = designed ? new Set(designed) : null;
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('$')) continue;
    const at = `${rel} "${oneLine(key)}"`;
    if (key === 'screens') {
      if (!isObj(value)) {
        out.problems.push(`${at}: expected { "<screen id>": { "route": "/…" } }`);
        continue;
      }
      for (const [id, sc] of Object.entries(value)) {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
          out.problems.push(`${at}.${oneLine(id)}: a screen id is kebab-case, like "orders"`);
          continue;
        }
        const keys = isObj(sc) ? Object.keys(sc) : [];
        const unknown = keys.filter((k) => !['route', 'prototype', 'figma', 'name'].includes(k));
        const str = (k) => typeof sc[k] === 'string' && sc[k].trim();
        if (!isObj(sc) || !['route', 'prototype', 'figma'].some(str)) {
          out.problems.push(`${at}.${id}: expected { "route": "/app/path", "prototype": "<url>", "figma": "<figma link>" } (any of them)`);
          continue;
        }
        if (unknown.length) out.problems.push(`${at}.${id}: unknown key(s) ${unknown.map(oneLine).join(', ')} (route, prototype, figma, name)`);
        const entry = {};
        if (sc.route !== undefined) {
          if (str('route')) entry.route = sc.route.trim();
          else out.problems.push(`${at}.${id}.route: expected a path such as "/orders" (relative to app.baseUrl) or an absolute URL`);
        }
        if (sc.prototype !== undefined) {
          if (str('prototype') && /^(https?:\/\/|file:|\$\{)/.test(sc.prototype.trim())) entry.prototype = sc.prototype.trim();
          else out.problems.push(`${at}.${id}.prototype: must be an http(s) or file: URL (or a \${NAME} placeholder)`);
        }
        if (sc.figma !== undefined) {
          if (str('figma') && /^https:\/\/([\w-]+\.)?figma\.com\//.test(sc.figma.trim())) entry.figma = sc.figma.trim();
          else out.problems.push(`${at}.${id}.figma: must be a figma.com link`);
        }
        if (str('name')) entry.name = sc.name.trim();
        out.screens[id] = entry;
      }
      continue;
    }
    if (!isObj(value)) {
      out.problems.push(`${at}: the driver must be an object like { "action": "click", "selector": "…" }`);
      continue;
    }
    const local = key.includes('/') ? key.slice(key.indexOf('/') + 1) : key;
    try {
      for (const w of checkDriver(local, value)) out.warnings.push(`${at}: ${oneLine(w)}`);
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      out.problems.push(`${at}: ${oneLine(err.message.replace(/^state "[^"]*": /, ''))}`);
      continue;
    }
    if (!isDrivable(normalizeStateName(local) ?? local, value)) {
      out.problems.push(`${at}: drives nothing: give it a fixture, query, mock, storage or action (a "wait" alone shows the default page)`);
      continue;
    }
    if (known && !designedIdFor(key, known)) {
      out.warnings.push(`${at}: not a designed state of this pass (a design-backfill state goes in backfill, not here)`);
    }
    out.states[key] = value;
  }
  return out;
}

/**
 * The designed state a states.json key drives, or null: "<screen>/<state>" names a state of
 * that screen, a plain key a state of any screen; the key spells its id ("hover-tile") or
 * a name that maps to it ("Empty"). designed: the matrix's state ids.
 */
export function designedIdFor(key, designed) {
  const ids = [...designed];
  const slash = key.indexOf('/');
  const of = (screen) => ids.filter((id) => (screen === null ? true : id.startsWith(`${screen}/`)));
  const local = (id) => id.slice(id.indexOf('/') + 1);
  const pick = (list, name) => {
    const st = keyState(name, new Set(list.map(local)));
    return list.find((id) => local(id) === st) ?? null;
  };
  return slash < 0 ? pick(of(null), key) : pick(of(key.slice(0, slash)), key.slice(slash + 1));
}

// ---------------------------------------------------------------------------
// Driver suggestions: what to click, hover or mock, from the with-data audit
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set(['state', 'with', 'data', 'default', 'the', 'a', 'an', 'of', 'and', 'or', 'on', 'in', 'to', 'for', 'is', 'open', 'opened', 'view', 'frame', 'screen', 'page', 'variant', 'copy', 'new']);
const CONTROLS = new Set(['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch', 'select', 'textbox', 'slider']);
const words = (text) =>
  String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));

/** The action a state name implies, else the census trigger, else click. */
export function actionFor(local, trigger = null) {
  const w = String(local).toLowerCase();
  if (/(^|-)hover(ed)?($|-)/.test(w)) return 'hover';
  if (/(^|-)focus(ed)?($|-)/.test(w)) return 'focus';
  if (/(^|-)(active|pressed)($|-)/.test(w)) return 'active';
  if (trigger === 'hover') return 'hover';
  return 'click';
}

/** empty · loading · error (a mock state), or null. */
export function mockKind(local) {
  const w = String(local).toLowerCase();
  if (/(^|-)(empty|no-?results?|no-?data|zero|blank|none)($|-)/.test(w)) return 'empty';
  if (/(^|-)(loading|skeleton|spinner|pending)($|-)/.test(w)) return 'loading';
  if (/(^|-)(error|failed|failure|offline|unavailable)($|-)/.test(w)) return 'error';
  return null;
}

const cssString = (text) => JSON.stringify(String(text));

/** A short selector for an audited element: test id, id, aria-label, text, else its path. */
export function shortSelector(el, label) {
  for (const a of ['data-testid', 'data-test-id', 'data-test']) if (el.attrs?.[a]) return `[${a}=${cssString(oneLine(el.attrs[a]).slice(0, 60))}]`;
  if (el.id && /^[A-Za-z][\w-]{0,60}$/.test(el.id)) return `#${el.id}`;
  if (el.attrs?.['aria-label']) return `${el.tag}[aria-label=${cssString(oneLine(el.attrs['aria-label']).slice(0, 60))}]`;
  const role = el.role && !['button', 'link'].includes(el.role) ? `[role=${el.role}]` : el.tag;
  if (label) return `${role}:has-text(${cssString(oneLine(label).slice(0, 40))})`;
  return el.path ?? el.tag;
}

/** Each control of an audit with a label (its own text, else a child's), in page order. */
export function auditControls(audit) {
  const els = Array.isArray(audit?.elements) ? audit.elements : [];
  const byParent = new Map();
  for (const e of els) {
    if (!byParent.has(e.p)) byParent.set(e.p, []);
    byParent.get(e.p).push(e);
  }
  const labelOf = (e, depth = 0) => {
    if (e.text) return e.text;
    if (depth > 3) return null;
    for (const c of byParent.get(e.i) ?? []) {
      const t = labelOf(c, depth + 1);
      if (t) return t;
    }
    return null;
  };
  return els
    .filter((e) => (CONTROLS.has(e.control) || (e.role && CONTROLS.has(String(e.role).toLowerCase()))) && e.rect && e.rect.w > 0 && e.rect.h > 0)
    .map((e) => ({ el: e, label: labelOf(e) ? oneLine(labelOf(e)).slice(0, 60) : null }));
}

/**
 * Up to `max` ready-to-paste driver lines for one undriven state, from the screen's
 * with-data audit (controls whose label shares words with the state or its frame name;
 * for an overlay, the control nearest the overlay's position on the screen), or a mock
 * template from the data requests the with-data capture saw. → { lines, how }; how
 * says where they came from, or why there is none.
 */
export function suggestDrivers({ id, local, designName = null, screenName = null, trigger = null, audit = null, requests = [], anchor = null, max = 3 }) {
  const line = (driver) => `"${oneLine(id)}": ${JSON.stringify(driver)}`;
  const mk = mockKind(local);
  if (mk) {
    const paths = [...new Set((requests ?? []).filter((p) => typeof p === 'string' && p.startsWith('/')))].slice(0, max);
    if (!paths.length) return { lines: [], how: 'no data request was seen while capturing with-data: find the request the page loads its data with, then { "mock": { "urlPattern": "**/<path>*", … } }' };
    const pattern = (p) => `**${p.replace(/\/+$/, '')}*`;
    const driver = (p) =>
      mk === 'empty'
        ? { mock: { urlPattern: pattern(p), status: 200, body: [] } }
        : mk === 'loading'
          ? { mock: { urlPattern: pattern(p), delayMs: 60000 } }
          : { mock: { urlPattern: pattern(p), status: 500, body: { error: 'test' } } };
    return { lines: paths.map((p) => line(driver(p))), how: `mock one of the page's data requests${mk === 'empty' ? ' (shape the body like its real empty response)' : ''}` };
  }
  const controls = auditControls(audit);
  if (!controls.length) return { lines: [], how: audit ? 'no interactive element on the with-data capture' : 'no audit of with-data yet (capture it first)' };
  const action = actionFor(local, trigger);
  const screenWords = new Set(words(screenName));
  const wanted = [...new Set([...words(local), ...words(designName)])].filter((w) => !screenWords.has(w) && !['hover', 'focus', 'active', 'pressed', 'selected', 'expanded'].includes(w));
  const scored = controls
    .map((c) => {
      const have = new Set([...words(c.label), ...words(c.el.attrs?.['data-testid']), ...words(c.el.id)]);
      const hits = wanted.filter((w) => have.has(w)).length;
      return { ...c, score: hits * 10 + (hits && c.el.control === 'tab' ? 2 : 0) + (hits && c.el.vis ? 1 : 0) };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.el.i - b.el.i);
  const dist = (c) => (anchor ? Math.hypot(c.el.rect.x + c.el.rect.w / 2 - anchor.x, c.el.rect.y + c.el.rect.h - anchor.y) : 0);
  let picked = anchor ? [...scored].sort((a, b) => b.score - a.score || dist(a) - dist(b)) : scored;
  let how = `controls whose label matches "${wanted.join(' ')}"${anchor ? ', nearest where the design places the overlay first' : ''}`;
  if (!picked.length && anchor) {
    picked = [...controls].sort((a, b) => dist(a) - dist(b));
    how = `controls nearest where the design places the ${trigger ? `${trigger} ` : ''}overlay (${Math.round(anchor.x)}, ${Math.round(anchor.y)})`;
  }
  if (!picked.length && ['hover', 'focus', 'active'].includes(action) && !wanted.length) {
    picked = controls.filter((c) => c.el.vis);
    how = `${action} targets on the page (the state name does not say which element)`;
  }
  if (!picked.length) return { lines: [], how: `no control matches "${wanted.join(' ') || local}"` };
  const seen = new Set();
  const lines = [];
  for (const c of picked) {
    const selector = shortSelector(c.el, c.label);
    if (seen.has(selector)) continue;
    seen.add(selector);
    lines.push(line({ action, selector }));
    if (lines.length >= max) break;
  }
  return { lines, how };
}
