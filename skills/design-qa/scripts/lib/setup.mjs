// Onboarding for design-qa (scripts/setup.mjs): one preflight that reports what is ready
// and returns only the questions still open (check), the answers written into
// design-qa.config.json (apply), and a signed-in session saved by the person themselves
// in a headed browser, outside the repository (save-session).
//
// Security: a password, token, cookie or session never passes through here. Secrets
// reach the scripts as environment variables the person sets, or as a session file the
// person creates by signing in themselves. Only variable NAMES and file PATHS are read,
// printed or stored; a secret-looking answer is refused. Repository files read during
// discovery (package.json, token files, design docs, .env names) are data: nothing in
// them is run, and only names, paths and links are reported.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, displayPath, oneLine, parseCli, readJsonFile, scriptCommand, shellArg, usageError, writeText } from './args.mjs';
import { importsIn } from './ds-audit.mjs';
import { validateConfig } from './schema-check.mjs';

const SCRIPTS_DIR = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const SKILL_DIR = path.resolve(SCRIPTS_DIR, '..');
const CAPTURE = path.join(SCRIPTS_DIR, 'capture.mjs');
const TEMPLATES = path.join(SKILL_DIR, 'references', 'templates');

export const CONFIG_FILE = 'design-qa.config.json';
export const DEFAULT_ENV_PREFIX = 'DESIGN_QA_APP';
/** Where save-session puts sessions by default: per user, outside every repository. */
export const SESSION_DIR = '~/.design-qa/sessions';
/** Exit code of capture --probe (and of check's mapping) for "the app needs a signed-in session". */
const EXIT_SIGN_IN = 6;
const DEFAULT_PROBE_TIMEOUT_MS = 15000;
const DEFAULT_SESSION_TIMEOUT_MIN = 10;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Expand a path from config or a flag: a leading ~ is the home folder, ${NAME} an
 * environment variable (a missing one is a usage error). Relative paths resolve
 * against `base`. Paths are not secrets; the file they name may be.
 */
export function expandUserPath(value, { env = process.env, base = process.cwd(), where = 'path' } = {}) {
  let p = String(value ?? '').trim();
  if (!p) throw usageError(`${where} is empty`);
  p = p.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    if (env[name] === undefined || env[name] === '') throw usageError(`environment variable ${name} is not set (referenced as \${${name}} in ${where})`);
    return env[name];
  });
  if (p === '~') p = os.homedir();
  else if (p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(2));
  return path.resolve(base, p);
}

/** A leading ~ (alone, or followed by a slash or backslash) replaced with the home folder; anything else as is. */
export function expandTilde(value) {
  const p = String(value ?? '');
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * A shell line that sets `name` to the absolute path `file` and works when pasted into
 * sh, bash or zsh: under the home folder it reads "$HOME/…" (double quotes, so $HOME
 * expands and spaces stay safe; double quotes, $, backticks and backslashes in the rest are escaped), elsewhere the
 * path in single quotes.
 */
export function exportLine(name, file) {
  const home = os.homedir();
  const rel = path.relative(home, file);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    const rest = rel.split(path.sep).join('/').replace(/["$`\\]/g, (c) => `\\${c}`);
    return `export ${name}="$HOME/${rest}"`;
  }
  return `export ${name}='${String(file).replace(/'/g, `'\\''`)}'`;
}

/** An absolute path written with ~ when it is under the home folder (for config and messages). */
export function tildePath(abs) {
  const home = os.homedir();
  const rel = path.relative(home, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join('/')}` : abs;
}

/**
 * Which signed-in session capture should load, and from where. The environment variable
 * <envPrefix>_STORAGE_STATE wins; else app.auth.storageState from config (a PATH, with ~
 * and ${ENV} expanded relative to the config's folder). → { path, source: "env" | "config"
 * | null, envName, exists }. Never reads the file. This is the precedence capture.mjs is
 * meant to follow too.
 */
export function storageStateFromConfig(config, { env = process.env, configDir = process.cwd() } = {}) {
  const prefix = config?.app?.auth?.envPrefix || DEFAULT_ENV_PREFIX;
  const envName = `${prefix}_STORAGE_STATE`;
  if (env[envName]) {
    // As capture reads it: relative to the working folder. A leading ~ is the home folder
    // too, for a value set with quotes that kept the shell from expanding it.
    const p = path.resolve(expandTilde(env[envName]));
    return { path: p, source: 'env', envName, exists: existsSync(p) };
  }
  const pointer = config?.app?.auth?.storageState;
  if (typeof pointer === 'string' && pointer.trim()) {
    const p = expandUserPath(pointer, { env, base: configDir, where: 'app.auth.storageState' });
    return { path: p, source: 'config', envName, exists: existsSync(p) };
  }
  return { path: null, source: null, envName, exists: false };
}

/** Is `file` inside `dir` (symbolic links of existing ancestors resolved)? */
function isInside(dir, file) {
  const real = (p) => {
    const rest = [];
    for (let cur = path.resolve(p); ; ) {
      try {
        return path.join(realpathSync(cur), ...rest);
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) return path.resolve(p);
        rest.unshift(path.basename(cur));
        cur = parent;
      }
    }
  };
  const rel = path.relative(real(dir), real(file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The git work tree that holds `dir`, or null (no git, or not a repository). */
function gitRoot(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/** Does git ignore `file` (in the repository at `root`)? true · false · null when unknown. */
function gitIgnored(root, file) {
  if (!gitRoot(root)) return null;
  try {
    execFileSync('git', ['check-ignore', '-q', '--', file], { cwd: root, stdio: 'ignore' });
    return true;
  } catch (err) {
    return err.status === 1 ? false : null;
  }
}

/** A relative path from config must stay inside the repository (no ../, no absolute path). */
function repoRelative(value, where) {
  const p = String(value ?? '').trim();
  if (!p) throw new AnswerError(`${where}: empty path`);
  if (path.isAbsolute(p) || p.startsWith('~') || p.split(/[\\/]/).includes('..')) {
    throw new AnswerError(`${where}: "${oneLine(p)}" must be a path inside the repository, relative to the config file (no ../, ~ or absolute paths)`);
  }
  return p.split(path.sep).join('/').replace(/^\.\//, '');
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  [/\bfig[dou]_[A-Za-z0-9_-]{10,}/, 'a Figma token'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/, 'a GitHub token'],
  [/\bglpat-[A-Za-z0-9_-]{16,}/, 'a GitLab token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\bATATT[A-Za-z0-9_=-]{20,}/, 'an Atlassian API token'],
  [/\blin_api_[A-Za-z0-9]{20,}/, 'a Linear API key'],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}|\bsk-[A-Za-z0-9_-]{20,}/, 'an API key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'a cloud access key'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, 'a signed token (JWT)'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/i, 'an authorization header value'],
  [/^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i, 'a password inside a link'],
  [/[?&#;](?:access_?token|id_?token|token|api_?key|apikey|key|secret|password|passwd|pwd|sig|signature|session|sessionid|sid|auth|code)=[^&#\s]{6,}/i, 'a secret inside a link'],
  [/(?:^|;\s*)[A-Za-z0-9_.-]+=[^;\s]{12,};\s*[A-Za-z0-9_.-]+=/, 'cookies'],
  [/"(?:cookies|origins)"\s*:/, 'a saved browser session'],
  [/\b(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S{4,}/i, 'a password or token'],
];

/**
 * Does a string look like a password, token, cookie or session? → a short description of
 * what it looks like, or null. Errs on the side of refusing: a refused answer only costs
 * the person a rephrase; a stored secret ends up in git.
 */
export function looksSecret(value) {
  const s = String(value ?? '');
  for (const [re, what] of SECRET_PATTERNS) if (re.test(s)) return what;
  for (const word of s.split(/[\s"',;]+/)) {
    if (word.length >= 32 && /^[A-Za-z0-9_+/=-]+$/.test(word) && /[a-z]/.test(word) && /[A-Z]/.test(word) && /\d/.test(word)) {
      return 'a long random key';
    }
  }
  return null;
}

/** Every string inside a value (keys of plain objects included). */
function stringsIn(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      stringsIn(v, out);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Discovery (bounded, read-only, the working repository only)
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  'node_modules', 'bower_components', 'jspm_packages', 'vendor', 'dist', 'build', 'out', 'target', 'coverage',
  'storybook-static', 'qa-reports', 'tmp', 'temp', '__pycache__', 'venv', 'Pods', 'DerivedData',
]);
const MAX_DEPTH = 5;
const MAX_ENTRIES = 6000;
const MAX_TEXT_FILES = 150;
const READ_BYTES = 128 * 1024;
const MAX_LIST = 10;

/**
 * Well-known UI libraries: package (or a scope ending in "/") → how the design-system
 * audit recognises their elements (designSystem.libraries needs a classPrefix or a
 * selector). kind is always "third-party" here; the project's own design system is found
 * by its package name (DS_PACKAGE).
 */
export const KNOWN_LIBRARIES = Object.freeze([
  { match: '@mui/material', name: 'MUI', classPrefix: 'Mui' },
  { match: '@mui/joy', name: 'MUI Joy', classPrefix: 'MuiJoy' },
  { match: '@material-ui/core', name: 'Material-UI v4', classPrefix: 'Mui' },
  { match: 'antd', name: 'Ant Design', classPrefix: 'ant-' },
  { match: '@chakra-ui/react', name: 'Chakra UI', classPrefix: 'chakra-' },
  { match: '@mantine/core', name: 'Mantine', classPrefix: 'mantine-' },
  { match: '@radix-ui/', name: 'Radix UI', selector: '[data-radix-popper-content-wrapper], [data-radix-collection-item], [data-radix-scroll-area-viewport]' },
  { match: '@headlessui/react', name: 'Headless UI', selector: '[id^="headlessui-"]' },
  { match: 'react-bootstrap', name: 'React Bootstrap', selector: '.btn, .form-control, .form-select, .navbar, .card, .modal, .dropdown-menu' },
  { match: 'bootstrap', name: 'Bootstrap', selector: '.btn, .form-control, .form-select, .navbar, .card, .modal, .dropdown-menu' },
  { match: '@fluentui/react-components', name: 'Fluent UI', classPrefix: 'fui-' },
  { match: '@carbon/react', name: 'Carbon', classPrefix: 'cds--' },
  { match: '@blueprintjs/core', name: 'Blueprint', classPrefix: 'bp5-' },
  { match: '@angular/material', name: 'Angular Material', classPrefix: 'mat-' },
  { match: 'element-plus', name: 'Element Plus', classPrefix: 'el-' },
  { match: 'vuetify', name: 'Vuetify', classPrefix: 'v-' },
  { match: 'primereact', name: 'PrimeReact', selector: '.p-component' },
  { match: '@nextui-org/react', name: 'NextUI', selector: '[data-slot]' },
  { match: 'semantic-ui-react', name: 'Semantic UI', selector: '.ui' },
]);

/**
 * How a design-system library is recognised when nothing better is known: the attributes
 * capture records as a component name (__el.component). apply says so, so the agent can
 * replace it with what the components really render.
 */
export const DS_DEFAULT_SELECTOR = '[data-component], [data-ds-component]';

/** A scoped or workspace package that is probably the project's own design system. */
const DS_PACKAGE = /^@[^/]+\/(?:design-?system|ds|ui|ui-kit|uikit|components|component-library|react-components)$/i;

/** Dev-server ports by framework package, when the script names none. */
const FRAMEWORK_PORTS = [
  ['next', 3000], ['nuxt', 3000], ['react-scripts', 3000], ['@remix-run/dev', 3000], ['vite', 5173],
  ['@sveltejs/kit', 5173], ['astro', 4321], ['@angular/core', 4200], ['gatsby', 8000],
  ['@vue/cli-service', 8080], ['webpack-dev-server', 8080], ['parcel', 1234],
];

/** Read at most READ_BYTES of a text file; null when unreadable. */
function readHead(file, bytes = READ_BYTES) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readJsonQuiet(file) {
  const text = readHead(file, 1024 * 1024);
  if (text == null) return null;
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

const nonEmpty = (file) => {
  try {
    const st = statSync(file);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
};

/**
 * Walk the repository breadth-first: at most MAX_DEPTH levels and MAX_ENTRIES entries,
 * never into node_modules, build output or hidden folders, never through a symbolic link.
 * → [{ rel, abs, depth }] of files.
 */
function walkRepo(root) {
  const files = [];
  const queue = [{ abs: root, rel: '', depth: 0 }];
  let seen = 0;
  while (queue.length && seen < MAX_ENTRIES) {
    const dir = queue.shift();
    let entries;
    try {
      entries = readdirSync(dir.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (++seen > MAX_ENTRIES) break;
      const rel = dir.rel ? `${dir.rel}/${e.name}` : e.name;
      const abs = path.join(dir.abs, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name) || dir.depth + 1 > MAX_DEPTH) continue;
        queue.push({ abs, rel, depth: dir.depth + 1 });
      } else if (e.isFile()) {
        files.push({ rel, abs, depth: dir.depth, name: e.name });
      }
    }
  }
  return files;
}

/** Names (never values) defined in the repository's .env* files, root folder only. */
function envNamesIn(root) {
  const names = new Set();
  const files = [];
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return { files, names: [] };
  }
  for (const e of entries) {
    if (!e.isFile() || !/^\.env(\..+)?$/.test(e.name)) continue;
    files.push(e.name);
    const text = readHead(path.join(root, e.name), 64 * 1024) ?? '';
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (m) names.add(m[1]);
      if (names.size >= 200) break;
    }
  }
  return { files: files.sort(), names: [...names].sort() };
}

function packageCommand(manager, script, dir) {
  const inDir = dir ? `cd ${dir} && ` : '';
  if (manager === 'pnpm') return `${inDir}pnpm ${script}`;
  if (manager === 'yarn') return `${inDir}yarn ${script}`;
  if (manager === 'bun') return `${inDir}bun run ${script}`;
  return script === 'start' ? `${inDir}npm start` : `${inDir}npm run ${script}`;
}

function portFrom(scriptText, deps) {
  const m = /(?:--port[ =]|-p[ =]?|\bPORT=)(\d{2,5})\b/.exec(String(scriptText ?? ''));
  if (m) return Number(m[1]);
  for (const [pkg, port] of FRAMEWORK_PORTS) if (deps[pkg]) return port;
  return null;
}

/** "@acme/design-system" → "Acme design system"; a plain name stays as is. */
function prettyPackageName(name) {
  const m = /^@([^/]+)\/(.+)$/.exec(name);
  if (!m) return name;
  const scope = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  const rest = m[2].replace(/[-_]+/g, ' ').replace(/^ui$/i, 'UI').replace(/^ds$/i, 'DS');
  return `${scope} ${rest}`;
}

const SOURCE_FILE = /\.[cm]?[jt]sx?$/i;
const NOT_SOURCE = /(?:^|\/)(?:__tests__|__mocks__|e2e|cypress|tests?)\/|\.(?:test|spec|stories|story|d)\.[cm]?[jt]sx?$|(?:^|\/)[\w.-]+\.config\.[cm]?[jt]s$/i;
const MAX_SOURCE_READS = 1500;
const THEME_CALL = /\b(?:createTheme|extendTheme|experimental_extendTheme|createMuiTheme|extendBaseTheme)\s*\(/;
const THEME_EXPORT = /\bexport\s+(?:const|let)\s+\w{0,40}theme\w{0,40}\s*(?::[^=\n]{0,200})?=\s*\{/i;

const knownLibraryOf = (pkg) => KNOWN_LIBRARIES.find((l) => (l.match.endsWith('/') ? pkg.startsWith(l.match) : pkg === l.match));
const bareName = (spec) => (/^[./~#]|^@\//.test(spec) ? null : spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

/**
 * The app's own source, read once (bounded: MAX_SOURCE_READS files, READ_BYTES each): theme
 * modules by content (createTheme and the like, an exported theme object), token JSON with
 * $value, and what the code imports. A wrapper is a package whose manifest depends on a known
 * library, or a local folder that re-exports one; a package under the project's own scope is
 * offered too. → { files, wrappers: [library entries with wraps and importers], direct: { <library id>: files importing it } }.
 */
function scanSources(root, files, { tokens, manifests, deps, rootPkg }) {
  const seen = new Map(tokens.map((t) => [t.rel, t]));
  const recs = [];
  let jsonReads = 0;
  for (const f of files) {
    if (recs.length >= MAX_SOURCE_READS) break;
    if (/\.json$/i.test(f.name) && !seen.has(f.rel) && !/^(?:package(?:-lock)?|tsconfig[\w.-]*|composer|\.?[\w-]*rc)\.json$/i.test(f.name) && jsonReads++ < MAX_TEXT_FILES) {
      const text = readHead(f.abs, 64 * 1024) ?? '';
      if (/"\$value"\s*:/.test(text)) tokens.push({ rel: f.rel, rank: 0, kind: 'tokens', usable: true });
      continue;
    }
    if (!SOURCE_FILE.test(f.name) || NOT_SOURCE.test(f.rel)) continue;
    const text = readHead(f.abs) ?? '';
    const prior = seen.get(f.rel);
    if (THEME_CALL.test(text)) {
      if (prior) Object.assign(prior, { kind: 'mui-theme', rank: 1 });
      else tokens.push({ rel: f.rel, rank: 1, kind: 'mui-theme', usable: false });
    } else if (!prior && THEME_EXPORT.test(text)) tokens.push({ rel: f.rel, rank: 1, kind: 'theme', usable: false });
    const rec = { rel: f.rel, dir: path.posix.dirname(f.rel), index: /^index\./.test(f.name), theme: THEME_CALL.test(text), bare: new Set(), reexport: new Set(), local: [], localReexport: [] };
    for (const m of importsIn(text)) {
      if (m.type && m.keyword === 'import') continue;
      const bare = bareName(m.spec);
      if (bare) {
        rec.bare.add(bare);
        if (m.keyword === 'export') rec.reexport.add(bare);
        continue;
      }
      const target = path.posix.normalize(m.spec.startsWith('.') ? path.posix.join(rec.dir, m.spec) : m.spec.replace(/^(?:@|~)\//, 'src/')).replace(/\.[cm]?[jt]sx?$/, '').replace(/\/index$/, '');
      rec.local.push(target);
      if (m.keyword === 'export') rec.localReexport.push(target);
    }
    recs.push(rec);
  }
  const inside = (rel, w) => rel === w || rel.startsWith(`${w}/`);
  const stem = (rel) => rel.replace(/\.[cm]?[jt]sx?$/, '').replace(/\/index$/, '');
  const libIn = (rec) => [...rec.bare].map(knownLibraryOf).find(Boolean);
  // Local wrappers: a module that re-exports a known library, or an index that re-exports modules importing one.
  const byStem = new Map(recs.map((r) => [stem(r.rel), r]));
  const local = new Map();
  for (const r of recs) {
    const lib = [...r.reexport].map(knownLibraryOf).find(Boolean) ?? (r.index ? r.localReexport.map((t) => byStem.get(t)).filter(Boolean).map(libIn).find(Boolean) : null);
    if (lib) local.set(r.index ? r.dir : stem(r.rel), lib);
  }
  const wrappers = [];
  for (const [w, lib] of local) {
    const importers = recs.filter((r) => !inside(r.rel, w) && r.local.some((t) => inside(t, w))).length;
    if (importers) wrappers.push({ id: w, name: path.posix.basename(w), kind: 'design-system', selector: DS_DEFAULT_SELECTOR, package: w, wraps: lib.name, importers });
  }
  // Packages: a manifest that depends on a known library; the project's own scope.
  const ownScope = /^@([^/]+)\//.exec(rootPkg?.name ?? '')?.[1] ?? String(rootPkg?.name ?? '').split(/[-_.]/)[0];
  const workspace = new Map(manifests.filter((m) => m.dir && typeof m.pkg.name === 'string').map((m) => [m.pkg.name, m.pkg]));
  const imported = new Set(recs.flatMap((r) => [...r.bare]));
  const anyKnown = deps.some(knownLibraryOf);
  for (const name of [...new Set([...deps, ...imported])].sort()) {
    if (knownLibraryOf(name) || /^(?:react|react-dom|@types\/.*)$/.test(name)) continue;
    const pkg = workspace.get(name) ?? readJsonQuiet(path.join(root, 'node_modules', ...name.split('/'), 'package.json'));
    const needs = pkg && typeof pkg === 'object' ? Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) }) : [];
    const lib = needs.map(knownLibraryOf).find(Boolean);
    const own = anyKnown && ownScope && name.startsWith(`@${ownScope}/`) && deps.includes(name);
    if (!lib && !own) continue;
    const importers = recs.filter((r) => r.bare.has(name)).length;
    wrappers.push({ id: name, name: prettyPackageName(name), kind: 'design-system', selector: DS_DEFAULT_SELECTOR, package: name, ...(lib ? { wraps: lib.name } : {}), importers });
  }
  wrappers.sort((a, b) => b.importers - a.importers || (a.wraps ? 0 : 1) - (b.wraps ? 0 : 1) || a.id.localeCompare(b.id));
  // Files importing a known library straight, outside every local wrapper.
  const direct = {};
  for (const r of recs) {
    if (r.theme || [...local.keys()].some((w) => inside(r.rel, w))) continue;
    for (const b of r.bare) {
      const lib = knownLibraryOf(b);
      if (lib) direct[lib.match.replace(/\/$/, '')] = (direct[lib.match.replace(/\/$/, '')] ?? 0) + 1;
    }
  }
  for (const id of deps.map(knownLibraryOf).filter(Boolean).map((l) => l.match.replace(/\/$/, ''))) direct[id] ??= 0;
  return { files: recs.length, wrappers, direct };
}

/**
 * Sensible defaults found in the repository at `root`, for pre-filled questions. Bounded
 * and read-only; file contents are data. → { packageManager, devCommand, port, appUrl,
 * libraries: [{ id, name, kind, classPrefix?, selector?, package }], designSystemPackages,
 * tailwind, tokenFiles (JSON or CSS the audit reads: [{ path, kind }]), themeSources (JS, TS,
 * SCSS themes and Tailwind configs, to export to JSON first), designDocs, overlay:
 * { componentCatalog, tokenMap, knownDrifts }, figmaLinks, envFiles, envNames (names only),
 * ticketProvider, designQaFolder }.
 */
export function discoverRepo(root, { env = process.env } = {}) {
  const out = {
    packageManager: null,
    devCommand: null,
    port: null,
    appUrl: null,
    libraries: [],
    designSystemPackages: [],
    tailwind: false,
    tokenFiles: [],
    themeSources: [],
    designDocs: [],
    overlay: { componentCatalog: null, tokenMap: null, knownDrifts: null },
    figmaLinks: [],
    envFiles: [],
    envNames: [],
    ticketProvider: null,
    designQaFolder: existsSync(path.join(root, 'design-qa')),
  };

  // Package manifests: the root one, then one level of workspaces (apps/*, packages/*).
  const manifests = [];
  const rootPkg = readJsonQuiet(path.join(root, 'package.json'));
  if (rootPkg && typeof rootPkg === 'object') manifests.push({ dir: '', pkg: rootPkg });
  for (const group of ['apps', 'packages']) {
    let entries = [];
    try {
      entries = readdirSync(path.join(root, group), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries.filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 20)) {
      const pkg = readJsonQuiet(path.join(root, group, e.name, 'package.json'));
      if (pkg && typeof pkg === 'object') manifests.push({ dir: `${group}/${e.name}`, pkg });
    }
  }
  const lock = (f) => existsSync(path.join(root, f));
  const declared = typeof rootPkg?.packageManager === 'string' ? rootPkg.packageManager.split('@')[0] : null;
  out.packageManager = ['npm', 'pnpm', 'yarn', 'bun'].includes(declared)
    ? declared
    : lock('pnpm-lock.yaml') ? 'pnpm' : lock('yarn.lock') ? 'yarn' : lock('bun.lockb') || lock('bun.lock') ? 'bun' : manifests.length ? 'npm' : null;

  const deps = {};
  const workspaceNames = new Set();
  for (const { dir, pkg } of manifests) {
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
      if (pkg[key] && typeof pkg[key] === 'object') for (const name of Object.keys(pkg[key])) deps[name] = true;
    }
    if (dir && typeof pkg.name === 'string') workspaceNames.add(pkg.name);
  }
  // The dev command: the root's dev/start script, else the first workspace app that has one.
  for (const { dir, pkg } of manifests) {
    const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    const script = ['dev', 'start', 'serve'].find((s) => typeof scripts[s] === 'string');
    if (!script) continue;
    const own = {};
    for (const key of ['dependencies', 'devDependencies']) if (pkg[key] && typeof pkg[key] === 'object') Object.assign(own, pkg[key]);
    out.devCommand = packageCommand(out.packageManager ?? 'npm', script, dir);
    out.port = portFrom(scripts[script], Object.keys(own).length ? own : deps);
    break;
  }
  if (out.port) out.appUrl = `http://localhost:${out.port}`;

  // Component libraries in use.
  const names = Object.keys(deps).sort();
  for (const lib of KNOWN_LIBRARIES) {
    const pkgs = lib.match.endsWith('/') ? names.filter((n) => n.startsWith(lib.match)).slice(0, 10) : names.filter((n) => n === lib.match);
    if (!pkgs.length || out.libraries.some((l) => l.name === lib.name)) continue;
    if (lib.name === 'Bootstrap' && out.libraries.some((l) => l.name === 'React Bootstrap')) continue;
    out.libraries.push({
      id: lib.match.replace(/\/$/, ''),
      name: lib.name,
      kind: 'third-party',
      ...(lib.classPrefix ? { classPrefix: lib.classPrefix } : {}),
      ...(lib.selector ? { selector: lib.selector } : {}),
      package: pkgs.length === 1 ? pkgs[0] : pkgs,
    });
  }
  const dsPackages = [...new Set([...names, ...workspaceNames])].filter((n) => DS_PACKAGE.test(n)).sort();
  out.designSystemPackages = dsPackages;
  for (const pkg of dsPackages.slice(0, 3).reverse()) {
    out.libraries.unshift({ id: pkg, name: prettyPackageName(pkg), kind: 'design-system', selector: DS_DEFAULT_SELECTOR, package: pkg });
  }
  out.tailwind = Boolean(deps.tailwindcss);

  // Token and theme files, design docs, the design-qa overlay.
  const files = walkRepo(root);
  const tokens = [];
  let textReads = 0;
  for (const f of files) {
    const lower = f.name.toLowerCase();
    // usable: a file the design-system audit reads as is (JSON, or CSS custom properties);
    // a JS/TS/SCSS theme or a Tailwind config is exported to JSON once first.
    const inTokensDir = /(^|\/)tokens\//i.test(f.rel);
    const readable = /\.(?:json|css)$/.test(lower);
    if (/^(?:design-)?tokens?(?:\.[\w-]+)?\.(?:json|js|mjs|cjs|ts)$/.test(lower) || (inTokensDir && /\.(?:json|css|scss)$/.test(lower))) {
      tokens.push({ rel: f.rel, rank: 0, kind: 'tokens', usable: readable });
    } else if (/^theme(?:\.[\w-]+)?\.(?:json|js|mjs|cjs|ts|tsx|css|scss)$/.test(lower)) {
      tokens.push({ rel: f.rel, rank: 1, kind: 'theme', usable: readable });
    } else if (/^tailwind\.config\.(?:js|cjs|mjs|ts)$/.test(lower)) {
      tokens.push({ rel: f.rel, rank: 3, kind: 'tailwind', usable: false });
    } else if (/\.(?:css|scss)$/.test(lower) && textReads < MAX_TEXT_FILES) {
      textReads += 1;
      const text = readHead(f.abs) ?? '';
      const root = /:root\s*(?:,[^{]*)?\{([^}]*)\}/.exec(text);
      if (root && (root[1].match(/--[\w-]+\s*:/g) || []).length >= 5) tokens.push({ rel: f.rel, rank: 2, kind: 'css-variables', usable: readable });
    }
    if (f.depth <= 2 && /^design(?:[-_ ](?:rules|guidelines|system|principles))?\.md$/i.test(f.name)) out.designDocs.push(f.rel);
    if (f.rel === 'docs/design.md' && !out.designDocs.includes(f.rel)) out.designDocs.push(f.rel);
    if (/^design-qa\//.test(f.rel) && nonEmpty(f.abs)) {
      if (!out.overlay.componentCatalog && /^components?(?:[-.][\w-]+)?\.json$/i.test(f.name)) out.overlay.componentCatalog = f.rel;
      if (!out.overlay.tokenMap && /^token-?map(?:\.[\w-]+)?\.md$/i.test(f.name)) out.overlay.tokenMap = f.rel;
      if (!out.overlay.knownDrifts && /drifts?(?:\.[\w-]+)?\.md$/i.test(f.name)) out.overlay.knownDrifts = f.rel;
    }
  }
  const src = scanSources(root, files, { tokens, manifests, deps: names, rootPkg });
  for (const w of src.wrappers.slice(0, 2).reverse()) {
    const same = out.libraries.find((l) => l.id === w.id);
    if (same) Object.assign(same, w.wraps ? { wraps: w.wraps } : {}, { importers: w.importers });
    else out.libraries.unshift(w);
  }
  for (const lib of out.libraries) if (src.direct[lib.id] !== undefined) lib.importers = src.direct[lib.id];
  out.sourceFiles = src.files;
  tokens.sort((a, b) => a.rank - b.rank || a.rel.split('/').length - b.rel.split('/').length || a.rel.localeCompare(b.rel));
  out.tokenFiles = tokens.filter((t) => t.usable).slice(0, MAX_LIST).map((t) => ({ path: t.rel, kind: t.kind }));
  out.themeSources = tokens.filter((t) => !t.usable).slice(0, MAX_LIST).map((t) => ({ path: t.rel, kind: t.kind }));
  out.designDocs = out.designDocs.slice(0, MAX_LIST);
  // Figma links written in the design docs: offered as the library link, never opened here.
  const links = new Set();
  for (const doc of out.designDocs) {
    const text = readHead(path.join(root, doc), 64 * 1024) ?? '';
    for (const m of text.matchAll(/https:\/\/(?:www\.)?figma\.com\/(?:design|file)\/[A-Za-z0-9]{10,}[^\s)"'<>\]]*/g)) {
      if (!looksSecret(m[0])) links.add(m[0]);
      if (links.size >= 3) break;
    }
  }
  out.figmaLinks = [...links];

  const envInfo = envNamesIn(root);
  out.envFiles = envInfo.files;
  out.envNames = envInfo.names;
  // Names only: of the .env files, and of the variables set (non-empty) in this environment.
  const allNames = [...envInfo.names, ...Object.entries(env).filter(([, v]) => v).map(([k]) => k)];
  if (allNames.some((n) => /^(?:JIRA|ATLASSIAN)_/.test(n))) out.ticketProvider = 'jira';
  else if (allNames.some((n) => /^LINEAR_/.test(n))) out.ticketProvider = 'linear';
  return out;
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/** Every answer id apply accepts, and what it writes (a config path, env:NAME, action:…). */
export const ANSWER_WRITES = Object.freeze({
  'app-url': 'app.baseUrl',
  'sign-in': 'action:save-session',
  'app-start': 'app.start',
  'ds-tokens': 'designSystem.tokens',
  'ds-components': 'designSystem.libraries',
  hide: 'app.preCapture',
  'figma-access': 'figma.access',
  'figma-token': 'env:FIGMA_TOKEN',
  'ds-name': 'designSystem.name',
  'ds-files': 'designSystem',
  'ds-figma': 'designSystem.figmaLibrary',
  'ticket-tool': 'ticket.provider',
  'ticket-site': 'ticket.baseUrl',
  'ticket-token': 'env:JIRA_API_TOKEN',
  reports: 'report.commit',
  // Answered by the agent itself (agentChecks), never asked of the person.
  'signed-in-element': 'app.auth.signedInSelector',
});

/** Order of importance: questions are returned in this order. */
const QUESTION_ORDER = Object.keys(ANSWER_WRITES);

const opt = (value, label, description) => ({ value, label, description });
const LATER = opt('later', 'Ask me later', 'Nothing is saved; I ask again next time.');

const ROLE_INFO = {
  designRules: { label: 'Design rules', what: 'your written design rules (copy casing, focus, motion)' },
  componentCatalog: { label: 'Component list', what: 'the list that maps design components to code components' },
  knownDrifts: { label: 'Known differences', what: 'differences your team already accepted' },
  tokenMap: { label: 'Token map', what: 'how design values map to code values' },
};

/** Which designSystem key a design file is for, from its name (null when unclear). */
function roleOf(file) {
  const name = path.basename(String(file)).toLowerCase();
  if (/drift/.test(name)) return 'knownDrifts';
  if (/token-?map/.test(name)) return 'tokenMap';
  if (/^components?([-.][\w-]+)?\.json$/.test(name) || /catalog/.test(name)) return 'componentCatalog';
  if (/\.md$/.test(name) && /design|rules|guidelines/.test(name)) return 'designRules';
  return null;
}

/** Design files found in the repository that config does not point at yet: [{ role, path }]. */
function offeredDesignFiles(config, discovered) {
  const ds = config?.designSystem ?? {};
  const found = [
    ['designRules', discovered.designDocs[0]],
    ['componentCatalog', discovered.overlay.componentCatalog],
    ['knownDrifts', discovered.overlay.knownDrifts],
    ['tokenMap', discovered.overlay.tokenMap],
  ];
  return found.filter(([role, p]) => p && ds[role] === undefined).map(([role, p]) => ({ role, path: p }));
}

/** Library options: discovered ones (design system first), as { value, label, description }. */
function libraryOptions(discovered) {
  return discovered.libraries.slice(0, 3).map((l) => {
    const pkgs = [l.package].flat();
    const where = pkgs.length > 1 ? `${pkgs[0]} and ${pkgs.length - 1} more` : pkgs[0];
    const n = l.importers ? `; ${l.importers === 1 ? '1 file imports' : `${l.importers} files import`} it${l.kind === 'design-system' ? '' : ' directly'}` : '';
    return opt(l.id, l.name.split(/\s+/).slice(0, 5).join(' '), l.kind === 'design-system' ? `Your own components (${where}${n})${l.wraps ? `, built on ${l.wraps}` : ''}` : `A third-party library (${where}${n})`);
  });
}

/** A wrapper the app's code uses less than the library it wraps is offered, not chosen by default. */
const minorWrapper = (l, libs) => l.wraps && (l.importers ?? 0) < (libs.find((x) => x.name === l.wraps)?.importers ?? 0);

function isLocalUrl(url) {
  try {
    const host = new URL(String(url)).hostname;
    return host === 'localhost' || host === '[::1]' || host.endsWith('.localhost') || /^127\./.test(host);
  } catch {
    return false;
  }
}

/** The app URL to use for this pass: --url, else app.baseUrl. */
function appUrlOf(config, url) {
  return url || config?.app?.baseUrl || null;
}

/**
 * The questions still open, in order of importance, given the state of things. Pure:
 * every input is passed in. `probe` is the mapped probe result (see mapProbe).
 *
 * Kept small for a first run: at most MAX_QUESTIONS questions, and only those that change
 * what a pass can find (the app address, sign-in, style values, component libraries).
 *   - A question with exactly one plausible answer in the repository is not asked: it is
 *     `assumed` (apply --accept-assumed writes it; the person can correct it any time).
 *   - Low-stakes settings (start command, design-system name, design docs, report folder,
 *     a single library link found in the docs) are assumed from discovery, never asked.
 *   - The rest is `deferred` until a pass needs it, with the trigger that brings it back
 *     (`triggers`: ticket, figma, backfill; `ask`: ids asked explicitly, e.g. hide).
 * → { questions, assumed: [{ id, title, value, why, writes }], deferred: [{ id, when }] }.
 */
export function buildQuestions({ config, discovered, url, probe, env = process.env, agent = {}, display = true, triggers = {} }) {
  const ds = config?.designSystem ?? {};
  const forced = new Set(triggers.ask ?? []);
  const appUrl = appUrlOf(config, url);
  const local = !appUrl || isLocalUrl(appUrl);
  const ctx = { config, discovered, appUrl, probe, display, ds };
  const asked = [];
  const assumed = [];
  const deferred = [];
  const ask = (id, extra = {}) => {
    const q = QUESTION_BUILDERS[id](ctx);
    if (q) asked.push({ ...q, ...extra });
  };
  const assume = (id, value, why) => assumed.push({ id, title: QUESTION_TITLES[id], value, why, writes: ANSWER_WRITES[id] });
  const defer = (id, when) => deferred.push({ id, when });

  // Needed for every pass.
  if (!config?.app?.baseUrl && !forced.has('app-url')) {
    if (url) assume('app-url', originOf(url), 'The address given for this pass.');
    else if (discovered.appUrl) assume('app-url', discovered.appUrl, 'The dev server port in package.json.');
    else ask('app-url');
  }
  if (probe?.signInNeeded) ask('sign-in');
  // Style values and components are asked whenever the repository does not answer them alone.
  const themes = discovered.themeSources ?? [];
  if (ds.tokens === undefined && !forced.has('ds-tokens')) {
    if (discovered.tokenFiles.length === 1 && !themes.length) assume('ds-tokens', [discovered.tokenFiles[0].path], 'The only token file in the project.');
    else if (!discovered.tokenFiles.length && !themes.length) assume('ds-tokens', 'page', 'No token file or theme in the project, so the CSS variables on the page are used.');
    else ask('ds-tokens');
  }
  if (ds.libraries === undefined && !forced.has('ds-components')) {
    if (discovered.libraries.length === 1) assume('ds-components', [discovered.libraries[0].id], 'The only component library in package.json.');
    else ask('ds-components');
  }

  // Low stakes: assumed from discovery, never asked unless the person wants to change one.
  if (config?.app?.start === undefined && local && !forced.has('app-start')) {
    if (discovered.devCommand) assume('app-start', discovered.devCommand, 'The dev script in package.json.');
    else if (probe?.state === 'unreachable') ask('app-start');
    else defer('app-start', 'the app on this computer does not answer');
  }
  if (ds.name === undefined && !forced.has('ds-name')) {
    // A package that is surely the design system (its name says so, or it is built on a known library); never a folder.
    const name = discovered.libraries.find((l) => l.kind === 'design-system' && (l.id.startsWith('@') || !l.id.includes('/')) && (DS_PACKAGE.test(l.id) || l.wraps))?.name;
    if (name) assume('ds-name', name, 'Your own component package in package.json.');
  }
  const files = offeredDesignFiles(config, discovered);
  if (files.length && !forced.has('ds-files')) assume('ds-files', files.map((f) => f.path), 'Design files found in the project.');
  if (config?.report?.commit === undefined && !forced.has('reports')) assume('reports', 'no', 'Reports hold screenshots of the app, so they stay out of git unless you say otherwise.');

  // Deferred until a pass needs them.
  if (ds.figmaLibrary === undefined && !forced.has('ds-figma')) {
    if (discovered.figmaLinks.length === 1) assume('ds-figma', discovered.figmaLinks[0], `The only Figma link in ${discovered.designDocs[0] ?? 'the design docs'}.`);
    else if (triggers.backfill) ask('ds-figma');
    else defer('ds-figma', 'design backfill is requested (check --backfill)');
  }
  const preCaptureAnswered = config?.app?.preCapture !== undefined || Object.values(config?.surfaces ?? {}).some((s) => s && s.preCapture !== undefined);
  if (!preCaptureAnswered && !forced.has('hide')) {
    defer('hide', 'a capture shows a banner, chat bubble or notice the design leaves out, or the person mentions one (check --ask hide)');
  }
  const mcp = agent['figma-mcp'];
  const access = Array.isArray(config?.figma?.access) ? config.figma.access : null;
  if (!env.FIGMA_TOKEN && mcp !== true && !forced.has('figma-access')) {
    if (!triggers.figma) {
      if (!access || access.includes('rest')) defer('figma-access', 'the design is in Figma and the agent has no Figma tools (check --figma --agent figma-mcp=no)');
    } else if (mcp === undefined) {
      defer('figma-access', 'the agent reports whether it has Figma tools (--agent figma-mcp=yes|no)');
    } else if (!access) {
      ask('figma-access');
      ask('figma-token', { dependsOn: { id: 'figma-access', values: ['token'] } });
    } else if (access.includes('rest')) {
      ask('figma-token');
    }
  }
  const provider = config?.ticket?.provider;
  if (!triggers.ticket) {
    if (provider === undefined && !forced.has('ticket-tool')) defer('ticket-tool', 'a ticket key is given (check --ticket)');
  } else {
    let jira = provider === 'jira';
    if (provider === undefined && !forced.has('ticket-tool')) {
      if (discovered.ticketProvider) {
        assume('ticket-tool', discovered.ticketProvider, 'Ticket variables named in this environment or the .env files.');
        jira = discovered.ticketProvider === 'jira';
      } else {
        ask('ticket-tool');
      }
    }
    const dependsOn = provider === undefined && !discovered.ticketProvider ? { dependsOn: { id: 'ticket-tool', values: ['jira'] } } : {};
    if ((jira || dependsOn.dependsOn) && config?.ticket?.baseUrl === undefined && !forced.has('ticket-site')) ask('ticket-site', dependsOn);
    const jiraEnv = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'].every((n) => env[n]);
    if ((jira || dependsOn.dependsOn) && !jiraEnv && agent['ticket-mcp'] !== true && !forced.has('ticket-token')) {
      ask('ticket-token', { ...dependsOn, ...(agent['ticket-mcp'] === undefined ? { unless: 'ticket-mcp' } : {}) });
    }
  }

  // Questions asked explicitly (to correct an assumption, or a deferred one now needed).
  for (const id of forced) if (QUESTION_BUILDERS[id] && !asked.some((q) => q.id === id)) ask(id, { forced: true });

  const rank = (id) => QUESTION_ORDER.indexOf(id);
  const open = asked.filter((item) => !(item.unless && agent[item.unless] === true)).sort((a, b) => rank(a.id) - rank(b.id));
  // One round, one structured call: at most MAX_QUESTIONS, required first; the rest wait.
  const questions = [];
  for (const item of open) {
    if (item.forced || item.required || questions.filter((q) => !q.forced).length < MAX_QUESTIONS) questions.push(item);
    else deferred.push({ id: item.id, when: 'the questions above are answered (run check again)' });
  }
  return {
    questions: questions.map(({ forced: _f, ...item }) => ({ ...item, writes: ANSWER_WRITES[item.id] })),
    assumed,
    deferred,
  };
}

/** The origin of a URL (a ${VAR} placeholder as is). */
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** At most this many questions per round: one call of a 4-question UI tool. */
export const MAX_QUESTIONS = 4;

/** The question builders: each returns the question for the current state, or null. */
const QUESTION_BUILDERS = {
  'app-url': ({ discovered }) => {
    const suggestions = [];
    if (discovered.appUrl) suggestions.push(opt(discovered.appUrl, discovered.appUrl.replace(/^https?:\/\//, ''), 'Your local dev server, from package.json'));
    for (const port of [3000, 5173, 8080]) {
      const u = `http://localhost:${port}`;
      if (suggestions.length < 2 && !suggestions.some((s) => s.value === u)) suggestions.push(opt(u, `localhost:${port}`, 'A common address for a local dev server'));
    }
    return {
      id: 'app-url',
      title: 'App address',
      question: 'Where does the app run that I should check?',
      why: 'I compare the design with the running app, so I need its web address (a staging or preview link works too).',
      kind: 'text',
      options: suggestions,
      default: suggestions[0].value,
      required: true,
    };
  },
  'sign-in': ({ probe, display }) => ({
    id: 'sign-in',
    title: 'Sign-in',
    question: probe?.sessionUsed
      ? 'Your saved sign-in for the app has expired; shall I open a browser window so you can sign in again?'
      : 'The app shows a sign-in page first; shall I open a browser window so you can sign in once?',
    why: 'Without a signed-in view I would only photograph the sign-in page; you type your password in that window yourself, never in this chat.',
    kind: 'choice',
    options: [
      opt('now', 'Sign in now', 'A browser window opens; you sign in, and I keep the session in a private file on this computer, outside the project.'),
      opt('own-machine', 'On my own computer', 'For a remote session: I give you one command to run on your computer and say where to put the file.'),
      opt('other-address', 'Use another address', 'Check a version of the app that needs no sign-in, such as your local one.'),
    ],
    default: display ? 'now' : 'own-machine',
    required: true,
  }),
  'app-start': ({ discovered }) => {
    const options = [];
    if (discovered.devCommand) options.push(opt(discovered.devCommand, discovered.devCommand.split(/\s+/).slice(-5).join(' '), 'The dev script in package.json'));
    else options.push(opt('npm run dev', 'npm run dev', 'The usual command for a JavaScript app'));
    options.push(opt('none', 'It is always running', 'Nothing to start; I only check that it answers.'));
    return {
      id: 'app-start',
      title: 'Start app',
      question: 'How do you start the app on your computer?',
      why: 'If the app is not running when I check, I can start it myself in the background.',
      kind: 'text',
      options,
      default: options[0].value,
      required: false,
    };
  },
  'ds-tokens': ({ discovered }) => {
    const themes = discovered.themeSources ?? [];
    const files = discovered.tokenFiles.slice(0, themes.length ? 2 : 3).map((t) =>
      opt(t.path, path.basename(t.path), `${{ tokens: 'A token file', theme: 'A theme file', 'css-variables': 'CSS variables set for the whole page' }[t.kind]} (${t.path})`),
    );
    const code = themes.slice(0, 3 - files.length).map((t) =>
      opt(t.path, path.basename(t.path), `${t.kind === 'tailwind' ? 'Your Tailwind settings' : 'Your theme in code'}: I run it once with Node and save its values (${t.path}).`),
    );
    const options = [...files, ...code, opt('page', 'Read them from the page', 'Use the CSS variables the app defines when it runs; nothing to set up.')];
    if (options.length < 2) options.push(LATER);
    const lead = files.length ? files : code.length ? code.slice(0, 1) : [];
    return {
      id: 'ds-tokens',
      title: 'Style values',
      question: 'Where are your colors, spacing and text sizes defined in the code?',
      why: 'I check every color and spacing value on the page against these, which is how values outside your design system get caught.',
      kind: 'multi',
      options,
      default: lead.length ? lead.map((o) => o.value) : ['page'],
      required: false,
    };
  },
  'ds-components': ({ discovered }) => {
    const found = libraryOptions(discovered);
    const options = [...found, opt('none', found.length ? 'None of these' : 'No component library', 'Plain HTML and CSS, or components I should not check by library.')];
    if (options.length < 2) options.push(LATER);
    return {
      id: 'ds-components',
      title: 'Components',
      question: 'Which component libraries does the app use?',
      why: 'I check that screens use your design system’s components rather than lookalikes or raw third-party ones.',
      kind: 'multi',
      options,
      default: found.length ? found.filter((o) => !minorWrapper(discovered.libraries.find((l) => l.id === o.value), discovered.libraries)).map((o) => o.value) : ['none'],
      required: false,
    };
  },
  hide: () => ({
    id: 'hide',
    title: 'Hide first',
    question: 'Does the app show anything the design leaves out, like a promo banner, a chat bubble or a cookie notice, that I should hide before taking screenshots?',
    why: 'Hiding them every time keeps the screenshots comparable, and I remember the choice so you never have to repeat it.',
    kind: 'choice',
    options: [
      opt('none', 'Nothing to hide', 'Screenshots show the page as it loads.'),
      opt('find', 'Yes, find them', 'I look at the page and record how to hide or close each one; you can also name them in your own words.'),
    ],
    default: 'none',
    required: false,
  }),
  'figma-access': () => ({
    id: 'figma-access',
    title: 'Figma access',
    question: 'How should I read your Figma designs?',
    why: 'Comparing needs the exact sizes, colors and text styles from the design file, not just a picture of it.',
    kind: 'choice',
    options: [
      opt('token', 'With a Figma token', 'You create a personal access token in Figma’s settings and set FIGMA_TOKEN in your terminal yourself; never paste it here.'),
      opt('chat', 'Connect Figma to chat', 'You add Figma’s tools (its MCP server) to your coding agent; I then read designs through them.'),
      opt('manual', 'I will export by hand', 'You paste exported values and images when I ask; slower and less exact.'),
    ],
    default: 'token',
    required: false,
  }),
  'figma-token': () => ({
    id: 'figma-token',
    title: 'Figma token',
    question: 'Have you set FIGMA_TOKEN in the terminal this agent runs in?',
    why: 'I need it to export the design frames; set it yourself (Figma settings, personal access tokens) and never paste it into this chat.',
    kind: 'choice',
    options: [opt('done', 'Yes, it is set', 'I check again that I can see it (not its value).'), opt('later', 'Not this time', 'I use Figma tools in this chat, or ask you for exports.')],
    default: 'done',
    required: false,
  }),
  'ds-name': ({ discovered }) => {
    const names = [...new Set(discovered.libraries.filter((l) => l.kind === 'design-system').map((l) => l.name))].slice(0, 2);
    const options = [...names.map((n) => opt(n, n.split(/\s+/).slice(0, 5).join(' '), 'Found in package.json')), opt('none', 'No design system', 'Reports then just say "the design".')];
    if (options.length < 2) options.push(LATER);
    return {
      id: 'ds-name',
      title: 'System name',
      question: 'What is your design system called?',
      why: 'I use its name in reports and when I look up its components and styles.',
      kind: 'text',
      options,
      default: names[0] ?? null,
      required: false,
    };
  },
  'ds-files': ({ config, discovered }) => {
    const files = offeredDesignFiles(config, discovered);
    if (!files.length) return null;
    return {
      id: 'ds-files',
      title: 'Design docs',
      question: 'I found these design files in the project; should I use them?',
      why: 'Written rules, a component list and accepted differences keep me from reporting things your team already decided.',
      kind: 'multi',
      options: [
        ...files.slice(0, 3).map((f) => opt(f.path, ROLE_INFO[f.role].label, `${f.path}: ${ROLE_INFO[f.role].what}`)),
        opt('none', 'None of them', 'I leave them out; I will not ask again.'),
      ],
      default: files.slice(0, 3).map((f) => f.path),
      required: false,
    };
  },
  'ds-figma': ({ discovered }) => {
    const options = [
      ...discovered.figmaLinks.slice(0, 2).map((link, i) => opt(link, `Link ${i + 1} from the docs`, `Found in ${discovered.designDocs[0] ?? 'the design docs'}: ${link}`)),
      opt('none', 'No Figma library', 'The design files have no shared library, or I should not use it.'),
    ];
    if (options.length < 2) options.push(LATER);
    return {
      id: 'ds-figma',
      title: 'Library link',
      question: 'What is the link to your design system’s Figma library?',
      why: 'With the library I can tell a real library component from a lookalike and name the right color or spacing value.',
      kind: 'text',
      options,
      default: discovered.figmaLinks[0] ?? null,
      required: false,
    };
  },
  'ticket-tool': ({ discovered }) => ({
    id: 'ticket-tool',
    title: 'Tickets',
    question: 'Where do your tickets live, so I can read them when you give me one?',
    why: 'A ticket gives me the acceptance criteria and the design links, so I check the right things.',
    kind: 'choice',
    options: [opt('jira', 'Jira', 'Atlassian Jira.'), opt('linear', 'Linear', 'Linear issues.'), opt('github', 'GitHub Issues', 'Issues in the GitHub repository.'), opt('none', 'No tickets', 'I never look tickets up.')],
    default: discovered.ticketProvider ?? 'none',
    required: false,
  }),
  'ticket-site': () => ({
    id: 'ticket-site',
    title: 'Jira site',
    question: 'What is your Jira site’s address, like https://your-company.atlassian.net?',
    why: 'I use it to turn ticket keys like ABC-123 into links you can open.',
    kind: 'text',
    options: [opt('none', 'Skip this', 'Ticket keys stay plain text.'), LATER],
    default: null,
    required: false,
  }),
  'ticket-token': () => ({
    id: 'ticket-token',
    title: 'Jira access',
    question: 'Have you set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN in the terminal this agent runs in?',
    why: 'Without them, or Jira tools connected to this chat, I ask you to paste the ticket instead; never paste the token here.',
    kind: 'choice',
    options: [opt('done', 'Yes, they are set', 'I check again that I can see them (not their values).'), opt('later', 'Not this time', 'I ask you to paste the ticket when I need it.')],
    default: 'later',
    required: false,
  }),
  reports: ({ discovered }) => ({
    id: 'reports',
    title: 'Reports',
    question: 'Should the design QA reports be saved in git with the code?',
    why: 'Reports hold screenshots of the app, so many teams keep them out of git; I remember your answer.',
    kind: 'choice',
    options: [
      opt('no', 'Keep them out of git', `They stay on this computer${discovered.reportsIgnored === true ? ' (the folder is already ignored)' : '; I give you the line for .gitignore'}.`),
      opt('yes', 'Commit them', 'Teammates and CI see the same reports.'),
    ],
    default: 'no',
    required: false,
  }),
};

/** Ids `check --ask` accepts: every question the person can be asked. */
export const ASKABLE_IDS = Object.freeze(Object.keys(QUESTION_BUILDERS).filter((id) => id !== 'sign-in'));

/** The chip title of every question, also used for assumed entries. */
const QUESTION_TITLES = Object.freeze({
  'app-url': 'App address', 'sign-in': 'Sign-in', 'app-start': 'Start app', 'ds-tokens': 'Style values', 'ds-components': 'Components',
  hide: 'Hide first', 'figma-access': 'Figma access', 'figma-token': 'Figma token', 'ds-name': 'System name', 'ds-files': 'Design docs',
  'ds-figma': 'Library link', 'ticket-tool': 'Tickets', 'ticket-site': 'Jira site', 'ticket-token': 'Jira access', reports: 'Reports',
});

// ---------------------------------------------------------------------------
// Probe (capture.mjs --probe)
// ---------------------------------------------------------------------------

/**
 * Run capture.mjs --probe against the app with the config's auth, headers, sign-in checks
 * and pre-capture storage, through a temporary config holding one surface (so a config
 * with several surfaces, or none, still works). A session file is handed over as the
 * <prefix>_STORAGE_STATE variable of the child only. → { code, result, detail }.
 */
export async function probeApp({ config = null, url = null, surface = null, env = process.env, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, sessionPath = null, authNone = false, signedInSelector = null }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'design-qa-setup-'));
  try {
    const app = config?.app ? JSON.parse(JSON.stringify(config.app)) : { baseUrl: url };
    if (!app.baseUrl) app.baseUrl = url;
    app.auth = app.auth && typeof app.auth === 'object' ? app.auth : { type: 'none' };
    delete app.auth.storageState;
    if (sessionPath) app.auth.type = 'storageState';
    else if (authNone) {
      // No session yet: load the app without one, to learn whether it needs one.
      app.auth.type = 'none';
      delete app.auth.login;
    }
    if (signedInSelector) app.auth.signedInSelector = signedInSelector;
    let route = url || app.readyUrl || '/';
    let states;
    const surfaces = config?.surfaces && typeof config.surfaces === 'object' ? config.surfaces : {};
    const names = Object.keys(surfaces);
    const chosen = surface ? surfaces[surface] : names.length === 1 ? surfaces[names[0]] : null;
    if (surface && !chosen) throw usageError(`surface "${surface}" is not in the config (have: ${names.join(', ') || 'none'})`);
    if (!url && chosen?.route) {
      route = chosen.route;
      const withData = chosen.states?.['with-data'];
      if (withData) states = { 'with-data': { ...(withData.fixture ? { fixture: withData.fixture } : {}), ...(withData.query ? { query: withData.query } : {}) } };
      if (!states && chosen.fixture) states = { 'with-data': { fixture: chosen.fixture } };
    }
    const tmpConfig = { app, surfaces: { 'setup-probe': { route, ...(states ? { states } : {}) } } };
    const file = path.join(dir, CONFIG_FILE);
    writeFileSync(file, JSON.stringify(tmpConfig), { mode: 0o600 });
    const childEnv = { ...env };
    const prefix = app.auth.envPrefix || DEFAULT_ENV_PREFIX;
    if (sessionPath) childEnv[`${prefix}_STORAGE_STATE`] = sessionPath;
    const args = [CAPTURE, '--probe', '--config', file, '--surface', 'setup-probe', '--timeout', String(timeoutMs)];
    const res = await runNode(args, { env: childEnv, timeoutMs: timeoutMs * 3 + 30000 });
    let result = null;
    try {
      result = JSON.parse(res.stdout);
    } catch {
      // usage errors print no JSON
    }
    const detail = oneLine(res.stderr.split('\n').find((l) => l.trim()) ?? '').replace(/^capture\.mjs: error: /, '').slice(0, 400) || null;
    return { code: res.code, result, detail };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Spawn node with args (never through a shell); resolves { code, stdout, stderr }. */
function runNode(args, { env = process.env, timeoutMs = 60000, cwd = process.cwd() } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * A probe's exit code in plain words. 6 is always "needs a signed-in session", never
 * "unreachable"; 5 splits into "not reachable" and "answered with an HTTP error".
 * → { state: ok | sign-in | unreachable | http-error | config | no-browser | error, signInNeeded, … }.
 */
export function mapProbe(probe, { sessionUsed = null } = {}) {
  const r = probe.result ?? {};
  const base = { code: probe.code, status: r.status ?? null, finalUrl: r.finalUrl ?? null, signedIn: r.signedIn ?? null, detail: r.detail ?? probe.detail ?? null, sessionUsed, signInNeeded: false };
  if (probe.code === 0) return { ...base, state: 'ok' };
  if (probe.code === EXIT_SIGN_IN) return { ...base, state: 'sign-in', signInNeeded: true };
  if (probe.code === 5) return { ...base, state: r.reachable ? 'http-error' : 'unreachable' };
  if (probe.code === 4) return { ...base, state: 'no-browser' };
  if (probe.code === 2) return { ...base, state: 'config', detail: probe.detail ?? r.detail ?? null };
  return { ...base, state: 'error' };
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

const AGENT_CHECK_IDS = ['figma-mcp', 'ticket-mcp'];

/**
 * Assemble the check result from what was found. Pure: tools (doctor's result), the
 * probe (mapProbe) and discovery are passed in; `triggers` say what this pass needs
 * (buildQuestions). → { ready, checks, questions, assumed, deferred, agentChecks,
 * discovered, missing, next }.
 */
export function buildCheck({ root, configPath, config, configProblem = null, configWarnings = [], discovered, tools = null, probe = null, probeSkipped = null, url = null, env = process.env, agent = {}, display = true, session = null, ci = false, triggers = {} }) {
  const plan = buildQuestions({ config, discovered, url, probe, env, agent, display, triggers });
  const assumedUrl = plan.assumed.find((a) => a.id === 'app-url')?.value ?? null;
  const checks = [];
  const row = (id, ok, detail, fix = null, blocking = false) => checks.push({ id, ok, detail: oneLine(detail), fix: fix ? oneLine(fix) : null, blocking: Boolean(blocking) && ok === false });
  const rel = (p) => path.relative(root, p) || p;

  // Tools.
  if (tools) {
    for (const c of tools.checks) row(`tools:${c.name}`, c.ok, c.detail, c.fix, c.ok === false);
  }

  // Config.
  if (configProblem) row('config', false, configProblem, `Correct the keys listed (\`${scriptCommand('validate.mjs')} design-qa.config.json\` shows them), with ${scriptCommand('setup.mjs')} apply where a question covers the key; never by guessing.`, true);
  else if (!config) row('config', false, `no ${rel(configPath)} yet`, `${scriptCommand('setup.mjs')} apply creates it (with --accept-assumed and the answers).`, false);
  else row('config', true, `${rel(configPath)} is valid${configWarnings.length ? ` (${configWarnings.length} warning${configWarnings.length === 1 ? '' : 's'})` : ''}`);

  // App: address, reachable, signed in.
  const appUrl = appUrlOf(config, url);
  if (appUrl) row('app-url', true, `${appUrl}${url ? ' (--url)' : ''}`);
  else if (assumedUrl) row('app-url', false, `not saved yet; assumed ${assumedUrl}`, `Run ${scriptCommand('setup.mjs')} apply --accept-assumed.`, true);
  else row('app-url', false, 'no app address yet', 'Answer the "App address" question.', true);
  const target = appUrl ?? assumedUrl;
  if (config?.app?.start) row('app-start', true, `starts with: ${config.app.start}`);

  const auth = config?.app?.auth ?? {};
  const prefix = auth.envPrefix || DEFAULT_ENV_PREFIX;
  if (probeSkipped) {
    row('app-reachable', null, `not checked: ${probeSkipped}`);
  } else if (probe) {
    const where = probe.finalUrl && probe.finalUrl !== target ? ` (ended on ${probe.finalUrl})` : '';
    if (probe.state === 'ok') {
      row('app-reachable', true, `answers${probe.status ? ` with HTTP ${probe.status}` : ''}${where}`);
      if (probe.sessionUsed) row('sign-in', true, `signed in with the saved session (${probe.sessionUsed})${probe.signedIn === true ? `; "${auth.signedInSelector}" is visible` : ''}`);
      else row('sign-in', true, 'no sign-in page');
    } else if (probe.state === 'sign-in') {
      row('app-reachable', true, `answers, but with a sign-in page${where}`);
      row(
        'sign-in',
        false,
        probe.sessionUsed
          ? `the saved session (${probe.sessionUsed}) no longer signs in: ${probe.detail ?? 'a sign-in page'}`
          : `the app needs a signed-in session: ${probe.detail ?? 'a sign-in page'}. It is reachable; this is not an outage`,
        ci
          ? `Give the job a saved session: set ${prefix}_STORAGE_STATE to a session file (references/ci.md).`
          : `Answer the "Sign-in" question (${scriptCommand('setup.mjs')} save-session; the person signs in, the agent types nothing).`,
        true,
      );
    } else if (probe.state === 'unreachable') {
      const local = isLocalUrl(target);
      const start = config?.app?.start ?? plan.assumed.find((a) => a.id === 'app-start')?.value;
      row(
        'app-reachable',
        false,
        `cannot reach ${target}: ${probe.detail ?? 'no answer'}`,
        local
          ? start
            ? `Start the app in the background with \`${start}\`, wait until it answers, then run check again.`
            : 'Start the app (answer the "Start app" question so I can do it), then run check again.'
          : 'Check the address and your network (VPN, firewall), then run check again. A sign-in page would have been reported as such.',
        true,
      );
    } else if (probe.state === 'http-error') {
      row('app-reachable', false, `${target} answers with HTTP ${probe.status}: ${probe.detail ?? ''}`, 'Check the address (a wrong route, or a server error), then run check again.', true);
    } else if (probe.state === 'config') {
      row('app-reachable', false, `could not check: ${probe.detail ?? 'capture rejected the settings'}`, 'Fix what the message names (an environment variable is set by the person, never pasted in chat), then run check again.', true);
    } else if (probe.state === 'no-browser') {
      row('app-reachable', null, 'not checked: the browser does not launch', 'See the tools:chromium fix.');
    } else {
      row('app-reachable', false, `could not check: ${probe.detail ?? `capture --probe exited ${probe.code}`}`, `Run \`${scriptCommand('capture.mjs')} --probe --config design-qa.config.json\` to see the full message.`, true);
    }
  }
  if (session?.path && !session.exists) {
    const who = session.source === 'env' ? session.envName : 'app.auth.storageState';
    row('session-file', false, `${who} points to a missing file (${tildePath(session.path)})`, `Sign in again: ${scriptCommand('setup.mjs')} save-session.`, false);
  } else if (session?.path && session.exists) {
    let mode = null;
    try {
      mode = statSync(session.path).mode & 0o777;
    } catch {
      // unreadable: reported by the probe
    }
    if (mode !== null && process.platform !== 'win32' && mode & 0o077) {
      row('session-file', false, `the session file ${tildePath(session.path)} can be read by other users (mode ${mode.toString(8)})`, `chmod 600 '${session.path.replace(/'/g, `'\\''`)}'`, false);
    }
  }

  // Design system.
  const ds = config?.designSystem ?? {};
  if (typeof ds.name === 'string' && ds.name.trim()) row('ds-name', true, ds.name);
  const fileRow = (id, value, label, template) => {
    if (typeof value !== 'string' || !value.trim()) {
      if (value === null) row(id, null, `${label}: none`);
      return;
    }
    const abs = path.resolve(path.dirname(configPath), value);
    if (!isInside(path.dirname(configPath), abs)) row(id, false, `${label}: ${value} is outside the project`, 'Point it at a file inside the repository.');
    else if (nonEmpty(abs)) row(id, true, `${label}: ${value}`);
    else row(id, false, `${label}: ${value} is missing or empty`, template ? `Copy ${path.join(TEMPLATES, template)} to ${value} and fill it in.` : `Create ${value}.`);
  };
  if (Array.isArray(ds.tokens)) {
    if (!ds.tokens.length) row('ds-tokens', true, 'style values: read from the CSS variables on the page');
    ds.tokens.forEach((t, i) => fileRow(`ds-tokens:${i + 1}`, t, 'style values', null));
  }
  if (!ds.tokens?.length && discovered.themeSources?.length) {
    row(
      'ds-theme',
      null,
      `a theme in code was found (${discovered.themeSources.slice(0, 3).map((t) => t.path).join(', ')}) but no JSON or CSS token file is configured`,
      `The audit reads JSON or CSS only. With the person's agreement (it runs their theme file once): ${scriptCommand('setup.mjs')} export-theme --from ${discovered.themeSources[0].path}, then answer "Style values" with the file it saves.`,
    );
  }
  if (Array.isArray(ds.libraries)) {
    row('ds-components', true, ds.libraries.length ? `component libraries: ${ds.libraries.map((l) => `${l?.name ?? '?'} (${l?.kind ?? '?'})`).join(', ')}` : 'component libraries: none');
  }
  fileRow('ds-catalog', ds.componentCatalog, 'component list', 'component-catalog.template.json');
  fileRow('ds-token-map', ds.tokenMap, 'token map', 'token-map.template.md');
  fileRow('ds-drifts', ds.knownDrifts, 'known differences', 'known-drifts.template.md');
  fileRow('ds-rules', ds.designRules, 'design rules', null);
  if (typeof ds.figmaLibrary === 'string') row('ds-figma', true, `Figma library: ${ds.figmaLibrary}`);

  // Design access. A script cannot see the agent's tools: agentChecks ask the agent.
  const access = Array.isArray(config?.figma?.access) ? config.figma.access : null;
  const tokenSet = Boolean(env.FIGMA_TOKEN);
  const mcp = agent['figma-mcp'];
  if (tokenSet) row('figma', true, `FIGMA_TOKEN is set${access ? `; allowed: ${access.join(', ')}` : ''}`);
  else if (mcp === true) row('figma', true, `Figma tools are connected to the agent; FIGMA_TOKEN is not set${access ? `; allowed: ${access.join(', ')}` : ''}`);
  else if (access && access.length === 1 && access[0] === 'manual') row('figma', true, 'Figma: exports pasted by hand (figma.access is manual)');
  else {
    const inDotEnv = discovered.envNames.includes('FIGMA_TOKEN');
    row(
      'figma',
      mcp === false ? false : null,
      `FIGMA_TOKEN is not set${mcp === undefined ? ' and the agent has not said whether it has Figma tools (agentChecks figma-mcp)' : ' and the agent has no Figma tools'}${inDotEnv ? `; it is named in ${discovered.envFiles.join(', ')}, which the agent never reads` : ''}`,
      'Set FIGMA_TOKEN yourself in the terminal the agent runs in (or connect Figma’s tools to the agent); never paste it in chat. A coded prototype needs neither.',
    );
  }

  // Tickets.
  const provider = config?.ticket?.provider;
  if (provider && provider !== 'none') {
    const jiraEnv = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'].filter((n) => !env[n]);
    let ok = true;
    let detail = `tickets: ${provider}${config.ticket.baseUrl ? ` at ${config.ticket.baseUrl}` : ''}`;
    let fix = null;
    if (provider === 'jira') {
      if (!jiraEnv.length) detail += '; JIRA_* variables are set';
      else if (agent['ticket-mcp'] === true) detail += '; read through the agent’s Jira tools';
      else {
        ok = agent['ticket-mcp'] === false ? false : null;
        detail += `; ${jiraEnv.join(', ')} not set${agent['ticket-mcp'] === undefined ? ' (agentChecks ticket-mcp)' : ''}`;
        fix = 'Set the JIRA_* variables yourself, or connect Jira tools to the agent; otherwise paste the ticket text when asked.';
      }
    }
    row('tickets', ok, detail, fix);
  } else if (provider === 'none') row('tickets', true, 'tickets: none');

  // Things hidden before capture.
  const pc = config?.app?.preCapture;
  if (pc !== undefined) {
    const n = ['hide', 'remove', 'click'].reduce((s, k) => s + (Array.isArray(pc?.[k]) ? pc[k].length : 0), 0) + Object.keys(pc?.localStorage ?? {}).length + Object.keys(pc?.sessionStorage ?? {}).length;
    row('hide', true, n ? `${n} thing${n === 1 ? '' : 's'} hidden or dismissed before every capture` : 'nothing hidden before capture');
  }

  // Reports folder.
  const outDir = config?.report?.outDir || 'qa-reports';
  const commit = config?.report?.commit;
  const ignored = discovered.reportsIgnored;
  if (commit === false && ignored === false) row('reports', false, `reports go to ${outDir}/, which git does not ignore`, `Add the line "/${outDir.replace(/^\/+|\/+$/g, '')}/" to .gitignore.`);
  else if (commit === true && ignored === true) row('reports', false, `reports should be committed, but git ignores ${outDir}/`, `Remove ${outDir}/ from .gitignore, or answer that reports stay out of git.`);
  else if (commit !== undefined) row('reports', true, `reports go to ${outDir}/ (${commit ? 'committed' : 'kept out of git'})`);

  const agentChecks = [
    {
      id: 'figma-mcp',
      question: 'Do you have Figma tools in your tool list (an MCP server with tools such as get_metadata, get_screenshot or get_design_context)?',
      lookFor: ['get_metadata', 'get_screenshot', 'get_design_context', 'get_variable_defs'],
      answered: mcp === undefined ? null : mcp ? 'yes' : 'no',
      howToAnswer: 'Look at your own tool list, then run check again with --agent figma-mcp=yes|no.',
    },
    {
      id: 'ticket-mcp',
      question: 'Do you have Jira or Atlassian tools in your tool list (such as getJiraIssue)?',
      lookFor: ['getJiraIssue', 'searchJiraIssuesUsingJql'],
      answered: agent['ticket-mcp'] === undefined ? null : agent['ticket-mcp'] ? 'yes' : 'no',
      howToAnswer: 'Look at your own tool list, then run check again with --agent ticket-mcp=yes|no.',
    },
  ];
  const needsSession = (auth.type && auth.type !== 'none') || probe?.signInNeeded;
  if (needsSession && !auth.signedInSelector) {
    agentChecks.push({
      id: 'signed-in-element',
      question: 'Once a signed-in session works, which element does only the signed-in app show in every screen (the main navigation, the user menu)?',
      lookFor: [],
      answered: null,
      howToAnswer: 'Open the app signed in (capture or your browser tools), pick a stable selector such as [data-testid=app-nav], and save it with setup.mjs apply: {"signed-in-element": "<selector>"}. It makes sign-in detection exact both ways.',
    });
  }

  // ci mode never asks (and never writes the config, so nothing is assumed either).
  const questions = ci ? [] : plan.questions;
  const assumed = ci ? [] : plan.assumed;
  const missing = [];
  for (const c of checks) if (c.blocking) missing.push(`${c.id}: ${c.detail}${c.fix ? ` → ${c.fix}` : ''}`);
  const ready = !checks.some((c) => c.blocking) && !questions.some((qq) => qq.required);
  const next = [];
  if (questions.some((qq) => qq.id === 'sign-in')) next.push(`If the person picks "Sign in now": ${scriptCommand('setup.mjs')} save-session`);
  const writable = questions.some((qq) => !/^(env|action):/.test(qq.writes));
  if (assumed.length || writable) {
    next.push(`${scriptCommand('setup.mjs')} apply${assumed.length ? ' --accept-assumed' : ''}${writable ? ' --answers <answers.json>' : ''}`);
  }
  if (next.length || !ready) next.push(`${scriptCommand('setup.mjs')} check (again, until ready)`);
  return { ready, checks, questions, assumed, deferred: plan.deferred, agentChecks, discovered, missing, next };
}

/** "figma-mcp=yes" ×n → { "figma-mcp": true, … } (usage error on anything else). */
export function parseAgentFlags(list = []) {
  const out = {};
  for (const item of list) {
    const m = /^([a-z-]+)=(yes|no|true|false)$/i.exec(String(item).trim());
    if (!m || !AGENT_CHECK_IDS.includes(m[1])) throw usageError(`--agent: expected ${AGENT_CHECK_IDS.map((a) => `${a}=yes|no`).join(' or ')} (got "${oneLine(item)}")`);
    out[m[1]] = /^(yes|true)$/i.test(m[2]);
  }
  return out;
}

/** Load the config file: { config, problem, warnings }; a missing file is config null. */
function loadConfig(configPath) {
  if (!existsSync(configPath)) return { config: null, problem: null, warnings: [] };
  let config;
  try {
    config = readJsonFile(configPath, 'config');
  } catch (err) {
    return { config: null, problem: oneLine(err.message), warnings: [] };
  }
  const v = validateConfig(config);
  if (!v.valid) return { config, problem: `${path.basename(configPath)} is invalid: ${v.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join('; ')}${v.errors.length > 3 ? ` (+${v.errors.length - 3} more)` : ''}`, warnings: v.warnings };
  return { config, problem: null, warnings: v.warnings };
}

/** Is there a screen a headed browser can open on? (Remote, SSH, CI and cloud sessions: no.) */
export function hasDisplay({ env = process.env, platform = process.platform } = {}) {
  if (env.DESIGN_QA_NO_DISPLAY) return false;
  if (env.CI || env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return false;
  if (env.CODESPACES || env.GITPOD_WORKSPACE_ID || env.REMOTE_CONTAINERS || env.CLOUD_SHELL) return false;
  if (platform === 'darwin' || platform === 'win32') return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/** The whole check: tools, config, discovery, probe; then buildCheck. */
export async function runCheck({ configPath, surface = null, url = null, ci = false, quick = false, env = process.env, agent = {}, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, triggers = {} }) {
  const root = path.dirname(configPath);
  const { config, problem, warnings } = loadConfig(configPath);
  const discovered = discoverRepo(root, { env });
  discovered.reportsIgnored = gitIgnored(root, `${(config?.report?.outDir || 'qa-reports').replace(/\/+$/, '')}/report.json`);

  const doctor = await import('../doctor.mjs');
  const tools = await doctor.check({ launchBrowser: !quick });
  const browserOk = tools.checks.find((c) => c.name === 'chromium')?.ok === true;

  let probe = null;
  let probeSkipped = null;
  let session = null;
  try {
    // The session pointer only matters for auth type storageState.
    session = config && !problem && config.app?.auth?.type === 'storageState' ? storageStateFromConfig(config, { env, configDir: root }) : null;
  } catch (err) {
    probeSkipped = oneLine(err.message);
  }
  // A first run probes the address discovery assumed (the dev server port), so the person
  // hears now whether it answers; ci mode never assumes.
  const assumedUrl = !url && !config?.app?.baseUrl && !ci ? discovered.appUrl : null;
  const target = url || config?.app?.baseUrl || assumedUrl || null;
  if (probeSkipped) {
    // the session pointer names a variable that is not set
  } else if (quick) probeSkipped = 'quick check (--quick)';
  else if (!target) probeSkipped = 'no app address yet';
  else if (problem) probeSkipped = 'the config is invalid';
  else if (!browserOk) probeSkipped = 'the browser does not launch (see tools:chromium)';
  else {
    const wantsSession = config?.app?.auth?.type === 'storageState';
    let sessionPath = null;
    let sessionUsed = null;
    if (wantsSession && session?.exists) {
      sessionPath = session.path;
      sessionUsed = session.source === 'env' ? session.envName : tildePath(session.path);
    }
    // storageState without a session file yet: load the app without one, to learn whether it needs one.
    const raw = await probeApp({ config, url: url || assumedUrl, surface, env, timeoutMs, sessionPath, authNone: wantsSession && !sessionPath });
    probe = mapProbe(raw, { sessionUsed });
  }
  const result = buildCheck({ root, configPath, config, configProblem: problem, configWarnings: warnings, discovered, tools, probe, probeSkipped, url, env, agent, display: hasDisplay({ env }), session, ci, triggers });
  return { configPath, ...result };
}

/**
 * The compact form `check --json` prints by default (a few KB, for small models): what
 * fails, what to ask, what was assumed, what waits, and the next commands. --full prints
 * everything (every check row, discovery).
 */
export function compactCheck(result) {
  return {
    ready: result.ready,
    checks: result.checks.filter((c) => c.ok === false).map(({ id, detail, fix, blocking }) => ({ id, detail, fix, blocking })),
    questions: result.questions,
    assumed: result.assumed,
    deferred: result.deferred,
    agentChecks: result.agentChecks.filter((a) => a.answered === null).map(({ id, question }) => ({ id, question })),
    next: result.next,
  };
}

function formatCheck(result, { full = false } = {}) {
  const lines = [];
  const required = result.questions.filter((q) => q.required).length;
  lines.push(
    result.ready
      ? `design-qa setup: ready${result.questions.length ? ` (${result.questions.length} optional question${result.questions.length === 1 ? '' : 's'})` : ''}`
      : `design-qa setup: not ready${required ? ` (${required} required question${required === 1 ? '' : 's'})` : ''}`,
  );
  for (const c of result.checks) {
    if (!full && c.ok !== false) continue;
    const mark = c.ok === true ? 'OK     ' : c.ok === false ? (c.blocking ? 'MISSING' : 'WARN   ') : 'SKIP   ';
    lines.push(`  ${mark} ${c.id.padEnd(16)} ${c.detail}`);
    if (c.ok === false && c.fix) lines.push(`          fix: ${c.fix}`);
  }
  const open = result.agentChecks.filter((a) => a.answered === null);
  if (open.length) {
    lines.push('', 'For the agent (look at your own tools; never ask the person):');
    for (const a of open) lines.push(`  - ${a.id}: ${a.question}`);
  }
  if (result.assumed.length) {
    lines.push('', 'I set these up from your project (tell me if any is wrong):');
    const shown = (a) =>
      a.id === 'reports' ? (a.value === 'no' ? 'kept out of git' : 'committed') : a.value === 'page' ? 'read from the page' : Array.isArray(a.value) ? a.value.join(', ') : a.value;
    for (const a of result.assumed) lines.push(`  - ${a.title}: ${shown(a)} (${a.why.replace(/\.$/, '')})`);
  }
  if (result.questions.length) {
    lines.push('', 'Questions (ask them in one round; the onboarding reference shows how):');
    result.questions.forEach((q, i) => {
      lines.push(`  ${i + 1}. ${q.title}: ${q.question}${q.required ? ' (required)' : ''}`);
      q.options.forEach((o, j) => lines.push(`     ${String.fromCharCode(97 + j)}) ${o.label}: ${o.description}`));
    });
  }
  if (result.deferred.length) {
    lines.push('', 'Not asked now (only when needed):');
    for (const d of result.deferred) lines.push(`  - ${QUESTION_TITLES[d.id] ?? d.id}: when ${d.when}`);
  }
  if (result.next.length) lines.push('', 'Next:', ...result.next.map((n) => `  ${n}`));
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// export-theme (runs the project's theme module: only on an explicit command)
// ---------------------------------------------------------------------------

/** The child that imports the theme and prints it as JSON: argv file, root, mode (plain | strip | esbuild). */
const THEME_CHILD = `
import { createRequire, register } from 'node:module';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [file, root, mode] = process.argv.slice(1);
const req = createRequire(path.join(root, 'package.json'));
register('data:text/javascript,' + encodeURIComponent(\`import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
export async function resolve(s, c, next) {
  try { return await next(s, c); } catch (e) {
    if (/^\\\\.\\\\.?\\\\//.test(s)) {
      for (const x of ['.ts', '.tsx', '.mts', '.js', '/index.ts', '/index.js']) { try { return await next(s + x, c); } catch {} }
    } else if (c.parentURL && !/^[a-z]+:/.test(s)) {
      try { return { url: pathToFileURL(createRequire(c.parentURL).resolve(s)).href, shortCircuit: true }; } catch {}
    }
    throw e;
  }
}\`));
let url = pathToFileURL(file).href;
let tmp = null;
if (mode === 'esbuild') {
  tmp = path.join(root, 'node_modules', '.cache', 'design-qa-theme-' + process.pid + '.mjs');
  req('esbuild').buildSync({ entryPoints: [file], bundle: true, format: 'esm', platform: 'node', packages: 'external', outfile: tmp, logLevel: 'silent' });
  url = pathToFileURL(tmp).href;
}
let mod;
try { mod = await import(url); } finally { if (tmp) rmSync(tmp, { force: true }); }
const objs = (m) => [m.default, ...Object.values(m)].filter((v) => v && typeof v === 'object');
const pick = (m) => objs(m).find((v) => v.palette && v.typography) ?? objs(m).find((v) => v.palette || v.typography || v.colors || v.theme || v.spacing) ?? objs(m)[0];
let theme = pick(mod);
if (theme && theme.default && !theme.palette && !theme.theme) theme = pick(theme);
if (!theme) throw new Error('the file exports no theme object');
if (/tailwind\\.config/.test(path.basename(file))) {
  try { theme = req('tailwindcss/resolveConfig')(theme).theme; } catch { theme = { ...(theme.theme ?? {}), ...(theme.theme?.extend ?? {}) }; }
} else if ((theme.palette || theme.typography) && !Array.isArray(theme.shadows)) {
  try { theme = req('@mui/material/styles').createTheme(theme); } catch {}
}
const out = JSON.parse(JSON.stringify(theme, (k, v) => (typeof v === 'function' || k === 'components' ? undefined : v)));
if (typeof theme.spacing === 'function') out.spacing = Object.fromEntries([0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12].map((f) => [f, theme.spacing(f)]));
process.stdout.write(JSON.stringify(out));
`;

/** How long one way of reading a theme module may take (a cold disk and a large dependency tree are slow). */
const THEME_TIMEOUT_MS = 120000;

const hasPackage = (root, name) => existsSync(path.join(root, 'node_modules', name, 'package.json'));

/**
 * Turn a JS or TS theme module (an MUI theme, a theme object, a Tailwind config) into a
 * token JSON file the audit reads. TypeScript: Node's own type stripping when it has it,
 * else the project's tsx, esbuild or ts-node; nothing is installed. → { ok, out, how } or
 * { ok: false, message } (one plain line with what to do instead).
 */
export function exportTheme({ root, from, out = null, env = process.env, timeoutMs = THEME_TIMEOUT_MS }) {
  const rel = repoRelative(from, 'export-theme --from');
  const abs = path.resolve(root, rel);
  if (!nonEmpty(abs)) return { ok: false, message: `${rel} does not exist or is empty` };
  const target = repoRelative(out ?? `design-qa/${path.basename(rel).replace(/\.[^.]+$/, '')}.tokens.json`, 'export-theme --out');
  const ts = /\.[cm]?tsx?$/i.test(rel);
  const [major, minor] = process.versions.node.split('.').map(Number);
  const strip = process.features?.typescript ? [] : major > 22 || (major === 22 && minor >= 6) ? ['--experimental-strip-types'] : null;
  const tries = [];
  if (!ts) tries.push({ how: 'Node', flags: [], mode: 'plain' });
  else {
    if (strip && !/x$/i.test(rel)) tries.push({ how: 'Node’s own TypeScript support', flags: strip, mode: 'strip' });
    if (hasPackage(root, 'tsx')) tries.push({ how: 'the project’s tsx', flags: ['--import', 'tsx'], mode: 'plain' });
    if (hasPackage(root, 'esbuild')) tries.push({ how: 'the project’s esbuild', flags: [], mode: 'esbuild' });
    if (hasPackage(root, 'ts-node')) tries.push({ how: 'the project’s ts-node', flags: ['--loader', 'ts-node/esm'], mode: 'plain' });
  }
  const errors = [];
  for (const t of tries) {
    const r = spawnSync(process.execPath, [...t.flags, '--input-type=module', '-e', THEME_CHILD, abs, root, t.mode], { cwd: root, env: { ...env, NODE_NO_WARNINGS: '1' }, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    if (r.error?.code === 'ETIMEDOUT') {
      errors.push(`${t.how}: stopped after ${Math.round(timeoutMs / 1000)} s (a first run on a cold disk can be that slow): run the same command again`);
      continue;
    }
    let json = null;
    try {
      json = r.status === 0 ? JSON.parse(r.stdout) : null;
    } catch {
      // not JSON: reported below
    }
    if (json && typeof json === 'object') {
      writeText(path.join(root, target), `${JSON.stringify({ $exportedFrom: rel, ...json }, null, 2)}\n`);
      return { ok: true, out: target, how: t.how };
    }
    const why = ((r.stderr || '').split('\n').map((l) => l.trim()).find((l) => /error|cannot|not /i.test(l)) ?? (r.error?.message || `exit ${r.status}`)).split(realpathSync(root)).join('.').split(root).join('.');
    errors.push(`${t.how}: ${oneLine(why).slice(0, 160)}`);
  }
  const tried = errors.length ? ` (${errors.join('; ')})` : ts ? ' (this Node cannot read TypeScript and the project has no tsx, esbuild or ts-node)' : '';
  return { ok: false, message: `could not read ${rel}${tried}. Instead: answer "Style values" with "page", or save the theme's values as JSON yourself (references/ds-audit.md) and answer with that file` };
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

class AnswerError extends Error {}

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const asList = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : [v]);
const word = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v);

function httpUrl(value, where) {
  const s = String(value ?? '').trim();
  if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(s)) return s;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new AnswerError(`${where}: "${oneLine(s)}" is not a web address (expected http:// or https://…)`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new AnswerError(`${where}: "${oneLine(s)}" must start with http:// or https://`);
  return s.replace(/\/+$/, '') || s;
}

/**
 * One ds-components answer → a designSystem.libraries entry { name, kind, classPrefix?,
 * selector?, package? }: an object as given (checked), a discovered or well-known library
 * by id, package or name, else a name the person typed (their own design system,
 * recognised by DS_DEFAULT_SELECTOR until the agent records better). `notes` collects
 * what the agent should refine.
 */
function libraryFrom(entry, discovered, notes) {
  if (isPlainObject(entry)) {
    const kinds = ['design-system', 'third-party', 'legacy'];
    if (typeof entry.name !== 'string' || !entry.name.trim()) throw new AnswerError('ds-components: each library needs a "name"');
    if (!kinds.includes(entry.kind)) throw new AnswerError(`ds-components: "${oneLine(entry.name)}" needs "kind": ${kinds.join(' | ')}`);
    const out = { name: entry.name.trim(), kind: entry.kind };
    for (const k of ['classPrefix', 'selector', 'wraps']) if (typeof entry[k] === 'string' && entry[k].trim()) out[k] = entry[k].trim();
    if (typeof entry.package === 'string' && entry.package.trim()) out.package = entry.package.trim();
    else if (Array.isArray(entry.package) && entry.package.every((p) => typeof p === 'string' && p.trim())) out.package = entry.package.map((p) => p.trim());
    if (!out.classPrefix && !out.selector) {
      throw new AnswerError(`ds-components: "${oneLine(out.name)}" needs a "classPrefix" (e.g. "Mui") or a "selector" (e.g. "[data-ds-component]") so its elements can be recognised`);
    }
    return out;
  }
  const s = String(entry ?? '').trim();
  if (!s) throw new AnswerError('ds-components: empty library name');
  const lower = s.toLowerCase();
  const strip = ({ id, importers, ...lib }) => lib;
  const found = discovered.libraries.find((l) => l.id === s || l.name.toLowerCase() === lower || [l.package].flat().includes(s));
  if (found) {
    if (found.wraps) notes.push(`ds-components: ${found.name} is built on ${found.wraps}, so on the page its components look like ${found.wraps}'s; the audit tells them apart by what the source imports`);
    else if (found.selector === DS_DEFAULT_SELECTOR) notes.push(`ds-components: ${found.name} is recognised by ${DS_DEFAULT_SELECTOR} for now; record its real class prefix or selector once you have seen the page`);
    return strip(found);
  }
  const known = KNOWN_LIBRARIES.find((l) => l.match === s || l.match.replace(/\/$/, '') === s || l.name.toLowerCase() === lower || (l.match.endsWith('/') && s.startsWith(l.match)));
  if (known) {
    return {
      name: known.name,
      kind: 'third-party',
      ...(known.classPrefix ? { classPrefix: known.classPrefix } : {}),
      ...(known.selector ? { selector: known.selector } : {}),
      package: known.match.endsWith('/') ? (s.startsWith(known.match) ? s : known.match.replace(/\/$/, '')) : known.match,
    };
  }
  // A name the person typed: their own design system; a package name is kept as package.
  const pkg = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(s) ? s : null;
  const name = pkg ? prettyPackageName(pkg) : s;
  notes.push(`ds-components: ${name} is recognised by ${DS_DEFAULT_SELECTOR} for now; record its real class prefix or selector once you have seen the page`);
  return { name, kind: 'design-system', selector: DS_DEFAULT_SELECTOR, ...(pkg ? { package: pkg } : {}) };
}

/**
 * One answer → { sets: [[pathSegments, value]], notes: [] }. AnswerError when it cannot
 * be written (wrong shape, secret-looking, an env: or action: question).
 */
function answerToWrites(id, value, { discovered, config, root }) {
  const writes = ANSWER_WRITES[id];
  if (!writes) throw new AnswerError(`unknown question id "${oneLine(id)}" (known: ${Object.keys(ANSWER_WRITES).join(', ')})`);
  if (writes.startsWith('env:')) {
    const names = id === 'ticket-token' ? 'JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN' : writes.slice(4);
    throw new AnswerError(`${id}: not saved. ${names} must be set by the person, in the terminal the agent runs in (or the agent's own environment settings); never pasted in chat or written to a file by the agent. Leave this answer out and run check again.`);
  }
  if (writes.startsWith('action:')) {
    throw new AnswerError(`${id}: not a config value. Run \`${scriptCommand('setup.mjs')} save-session\` (the person signs in in the window that opens), or for "other-address" answer app-url with the address to use. Leave this answer out.`);
  }
  const sets = [];
  const notes = [];
  const exports = [];
  const set = (p, v) => sets.push([p.split('.'), v]);
  const w = word(value);
  if (w === 'later' && id !== 'app-url') return { sets, notes: [`${id}: nothing saved; asked again next time`], exports };

  switch (id) {
    case 'app-url':
      set('app.baseUrl', httpUrl(value, id));
      break;
    case 'app-start':
      set('app.start', w === 'none' || value === null ? null : String(value).trim());
      break;
    case 'signed-in-element': {
      const s = String(value ?? '').trim();
      if (!s || /[{}]/.test(s)) throw new AnswerError(`${id}: expected a CSS selector such as [data-testid=app-nav]`);
      if (!isPlainObject(config?.app?.auth)) set('app.auth.type', 'none');
      set('app.auth.signedInSelector', s);
      break;
    }
    case 'hide': {
      if (w === 'none' || value === null) {
        set('app.preCapture', {});
        break;
      }
      if (!isPlainObject(value)) {
        throw new AnswerError(
          'hide: "find" or a description is not something I can save. Look at the page, then answer with what to do: ' +
            '{"hide": ["<selector>"], "remove": ["<selector>"], "click": ["<dismiss button selector>"], "localStorage": {"<flag>": "<value>"}} (any of them), or "none"',
        );
      }
      const allowed = ['localStorage', 'sessionStorage', 'hide', 'remove', 'click'];
      const unknown = Object.keys(value).filter((k) => !allowed.includes(k));
      if (unknown.length) throw new AnswerError(`hide: unknown key(s) ${unknown.join(', ')} (expected ${allowed.join(', ')})`);
      set('app.preCapture', value);
      break;
    }
    case 'ds-tokens': {
      const list = asList(value).filter((v) => v !== null && v !== undefined);
      const paths = [];
      for (const p of list.filter((v) => !['page', 'none'].includes(word(v))).map((v) => repoRelative(v, id))) {
        // A theme in code: the person chose "I run it once with Node", so apply exports it (exports, below).
        if (/\.[cm]?[jt]sx?$/i.test(p)) {
          const out = `design-qa/${path.basename(p).replace(/\.[^.]+$/, '')}.tokens.json`;
          exports.push({ from: p, out });
          paths.push(out);
          continue;
        }
        if (!nonEmpty(path.join(root, p))) notes.push(`ds-tokens: ${p} does not exist yet (or is empty)`);
        if (!/\.(json|css)$/i.test(p)) notes.push(`ds-tokens: ${p} is not JSON or CSS; save its values as a JSON file and point at that instead`);
        paths.push(p);
      }
      set('designSystem.tokens', paths);
      break;
    }
    case 'ds-components': {
      const list = asList(value).filter((v) => v !== null && v !== undefined && word(v) !== 'none');
      const libs = [];
      for (const entry of list) {
        const lib = libraryFrom(entry, discovered, notes);
        if (!libs.some((l) => l.name === lib.name)) libs.push(lib);
      }
      set('designSystem.libraries', libs);
      break;
    }
    case 'ds-name':
      if (typeof value !== 'string' || !value.trim()) throw new AnswerError('ds-name: expected the name as text');
      set('designSystem.name', w === 'none' ? 'none' : value.trim());
      break;
    case 'ds-files': {
      const offered = offeredDesignFiles(config, discovered);
      const chosen = asList(value).filter((v) => v !== null && word(v) !== 'none').map((v) => repoRelative(v, id));
      const roles = new Set();
      for (const p of chosen) {
        const role = offered.find((f) => f.path === p)?.role ?? roleOf(p);
        if (!role) throw new AnswerError(`ds-files: cannot tell what ${p} is (design rules, component list, known differences or token map); answer with one of the offered files`);
        if (roles.has(role)) throw new AnswerError(`ds-files: two files for ${ROLE_INFO[role].label.toLowerCase()}`);
        roles.add(role);
        set(`designSystem.${role}`, p);
      }
      for (const f of offered) if (!roles.has(f.role)) set(`designSystem.${f.role}`, null);
      break;
    }
    case 'ds-figma': {
      if (w === 'none' || value === null) {
        set('designSystem.figmaLibrary', null);
        break;
      }
      const s = httpUrl(value, id);
      if (!/^https:\/\/([\w-]+\.)?figma\.com\//.test(s)) throw new AnswerError(`ds-figma: "${oneLine(s)}" is not a figma.com link`);
      set('designSystem.figmaLibrary', s);
      break;
    }
    case 'figma-access': {
      const map = { token: ['mcp', 'rest', 'manual'], chat: ['mcp', 'devmode-mcp', 'manual'], manual: ['manual'] };
      const rungs = ['mcp', 'devmode-mcp', 'rest', 'manual'];
      let access = map[w];
      if (!access) {
        const list = asList(value).map(word);
        if (!list.length || !list.every((r) => rungs.includes(r))) throw new AnswerError(`figma-access: expected token, chat or manual (or a list of ${rungs.join(', ')})`);
        access = list;
      }
      set('figma.access', access);
      if (w === 'token') notes.push('figma-access: set FIGMA_TOKEN yourself in the terminal the agent runs in; never paste it in chat');
      break;
    }
    case 'ticket-tool': {
      if (!['jira', 'linear', 'github', 'none'].includes(w)) throw new AnswerError('ticket-tool: expected jira, linear, github or none');
      set('ticket.provider', w);
      break;
    }
    case 'ticket-site':
      set('ticket.baseUrl', w === 'none' || value === null ? null : httpUrl(value, id));
      break;
    case 'reports': {
      const yes = [true, 'yes', 'commit', 'true'].includes(w);
      const no = [false, 'no', 'keep-out', 'false'].includes(w);
      if (!yes && !no) throw new AnswerError('reports: expected yes (commit them) or no (keep them out of git)');
      set('report.commit', yes);
      if (config?.report?.outDir === undefined) set('report.outDir', 'qa-reports');
      break;
    }
    default:
      throw new AnswerError(`unknown question id "${oneLine(id)}"`);
  }
  for (const [p, v] of sets) {
    for (const s of stringsIn(v)) {
      const what = looksSecret(s);
      if (what) {
        throw new AnswerError(
          `${id}: refused, the answer for ${p.join('.')} looks like ${what}. Secrets never go into design-qa.config.json or chat: ` +
            'the person sets them as environment variables (a ${NAME} placeholder can stand in a value) or signs in with setup.mjs save-session.',
        );
      }
    }
  }
  return { sets, notes, exports };
}

/** A fresh config with the defaults onboarding assumes (app.baseUrl comes from the answers). */
function defaultConfig() {
  return {
    app: { baseUrl: null, start: null, readyUrl: '/', auth: { type: 'none', envPrefix: DEFAULT_ENV_PREFIX } },
    surfaces: {},
    designSystem: {},
    report: { outDir: 'qa-reports', topN: 5 },
    figma: { access: ['mcp', 'rest', 'manual'] },
    capture: { driver: 'script' },
  };
}

function setPath(obj, segs, value) {
  let cur = obj;
  for (const s of segs.slice(0, -1)) {
    if (!isPlainObject(cur[s])) cur[s] = {};
    cur = cur[s];
  }
  cur[segs[segs.length - 1]] = value;
}

function getPath(obj, segs) {
  let cur = obj;
  for (const s of segs) {
    if (!isPlainObject(cur) || !(s in cur)) return undefined;
    cur = cur[s];
  }
  return cur;
}

/** The indentation the file uses (spaces or a tab), default two spaces. */
function detectIndent(text) {
  const m = /^([ \t]+)"/m.exec(text ?? '');
  return m ? m[1] : '  ';
}

const show = (v) => (v === undefined ? '(not set)' : oneLine(JSON.stringify(v)));

/**
 * Write answers into the config: { configPath, created, changes: [{ path, from, to }],
 * notes, warnings }. Every answer is checked first; any refusal (unknown id, env: or
 * action: question, secret-looking value, wrong shape) or a config that would not
 * validate writes nothing (CliError exit 2 / 1). Atomic; a symbolic link is refused.
 */
export function applyAnswers({ configPath, answers, env = process.env, dryRun = false, extraSets = [], acceptAssumed = false, url = null }) {
  if (!isPlainObject(answers)) throw usageError('--answers must be a JSON object { "<question id>": <answer>, … }');
  const root = path.dirname(configPath);
  let st = null;
  try {
    st = lstatSync(configPath);
  } catch {
    // created below
  }
  if (st?.isSymbolicLink()) throw new CliError(`refusing to write ${path.basename(configPath)}: it is a symbolic link`, 1);
  const exists = Boolean(st);
  const text = exists ? readFileSync(configPath, 'utf8') : null;
  let before = null;
  if (exists) {
    try {
      before = JSON.parse(text.replace(/^﻿/, ''));
    } catch (err) {
      throw new CliError(`${path.basename(configPath)} is not valid JSON (${err.message}); fix it before applying answers`, 1);
    }
    if (!isPlainObject(before)) throw new CliError(`${path.basename(configPath)} must hold a JSON object`, 1);
  }
  const discovered = discoverRepo(root, { env });
  discovered.reportsIgnored = gitIgnored(root, `${(before?.report?.outDir || 'qa-reports').replace(/\/+$/, '')}/report.json`);
  const problems = [];
  const sets = [...extraSets];
  const notes = [];
  const exports = [];
  // --accept-assumed: what check assumed from the repository, unless the answers say otherwise.
  const all = {};
  if (acceptAssumed) {
    for (const a of buildQuestions({ config: before, discovered, url, probe: null, env }).assumed) if (!(a.id in answers)) all[a.id] = a.value;
  }
  Object.assign(all, answers);
  for (const [id, value] of Object.entries(all)) {
    try {
      const r = answerToWrites(id, value, { discovered, config: before, root });
      sets.push(...r.sets);
      notes.push(...r.notes);
      exports.push(...r.exports);
    } catch (err) {
      if (!(err instanceof AnswerError)) throw err;
      problems.push(err.message);
    }
  }
  if (problems.length) throw new CliError(`nothing was written:\n${problems.map((p) => `  - ${oneLine(p)}`).join('\n')}`, 2);

  const after = before ? JSON.parse(JSON.stringify(before)) : defaultConfig();
  for (const [segs, value] of sets) setPath(after, segs, value);
  if (!exists && !after.app.baseUrl) {
    throw new CliError(`${path.basename(configPath)} does not exist yet: answer app-url too, so it can be created`, 2);
  }
  const v = validateConfig(after);
  if (!v.valid) {
    throw new CliError(`nothing was written: the result would not validate:\n${v.errors.map((e) => `  ${oneLine(e.path)}: ${oneLine(e.message)}`).join('\n')}`, 1);
  }
  for (const x of exports) {
    if (dryRun) {
      notes.push(`ds-tokens: would run ${x.from} once with Node and save its values to ${x.out}`);
      continue;
    }
    const r = exportTheme({ root, from: x.from, out: x.out, env });
    if (!r.ok) throw new CliError(`nothing was written: ds-tokens: ${r.message}`, 2);
    notes.push(`ds-tokens: saved the values of ${x.from} to ${x.out} (${r.how}); when the theme changes, run ${scriptCommand('setup.mjs')} export-theme --from ${x.from} --out ${x.out}`);
  }
  const changes = [];
  const seen = new Set();
  for (const [segs] of sets) {
    const key = segs.join('.');
    if (seen.has(key)) continue;
    seen.add(key);
    const from = getPath(before ?? {}, segs);
    const to = getPath(after, segs);
    if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ path: key, from, to });
  }
  if (!dryRun && (changes.length || !exists)) {
    writeText(configPath, `${JSON.stringify(after, null, detectIndent(text))}\n`);
  }
  return { configPath, created: !exists, dryRun, changes, notes, warnings: v.warnings };
}

// ---------------------------------------------------------------------------
// save-session
// ---------------------------------------------------------------------------

/** Default session file: ~/.design-qa/sessions/<repository>-<host>.json. */
export function defaultSessionPath(root, appUrl, env = process.env) {
  let host = 'app';
  try {
    const u = new URL(appUrl);
    host = `${u.hostname}${u.port ? `-${u.port}` : ''}`;
  } catch {
    // keep "app"
  }
  const repo = path.basename(gitRoot(root) ?? root);
  const name = `${repo}-${host}`.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'session';
  return expandUserPath(`${SESSION_DIR}/${name}.json`, { env });
}

/**
 * Refuse a session path inside the repository unless git ignores it (a session is a
 * password: it must never be committed). → null when fine, else the reason.
 */
export function sessionPathProblem(file, root) {
  const repo = gitRoot(root);
  const inRepo = isInside(repo ?? root, file);
  if (!inRepo) return null;
  if (!repo) return `${file} is inside the project folder, and without git I cannot check it is kept out of version control; save it outside the project (the default ${SESSION_DIR}/ does that)`;
  const ignored = gitIgnored(repo, file);
  if (ignored === true) return null;
  return `${file} is inside the repository and git does not ignore it: a saved session is as good as a password and must never be committed. Use the default (${SESSION_DIR}/), or add the path to .gitignore first`;
}

/** Write `data` to a new file next to `file` (mode 600, folder 700, never through a symlink); returns the temp path. */
function writePrivateTemp(file, data) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let st = null;
  try {
    st = lstatSync(file);
  } catch {
    // new file
  }
  if (st?.isSymbolicLink()) throw new CliError(`refusing to write ${file}: it is a symbolic link`, 2);
  if (st && !st.isFile()) throw new CliError(`refusing to write ${file}: it is not a regular file`, 2);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (process.platform !== 'win32') chmodSync(tmp, 0o600);
  return tmp;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sameOrigin = (a, b) => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};

/** The alternative for a session without a screen; `record` is the command that checks the copied file and records it. */
function noDisplayHelp(url, file, record) {
  return [
    'No screen is available here (a remote, SSH, CI or cloud session), so no browser window was opened.',
    'On your own computer, run this, sign in in the window that opens, then close it:',
    `  npx playwright codegen --save-storage=session.json '${String(url).replace(/'/g, `'\\''`)}'`,
    `Then copy session.json to this machine as ${tildePath(file)} (only you should be able to read it: chmod 600), and run this, which checks it and records it in the config:`,
    `  ${record}`,
  ].join('\n');
}

/**
 * Open a headed browser at `url`, let the person sign in, save the session.
 *   - waits until the signed-in selector is visible on the app's origin (then closes the
 *     window itself), or until the person closes the window, or `timeoutMs` (nothing saved);
 *   - writes the storage state next to `out` (mode 600), verifies it with capture --probe,
 *     and only then puts it in place; a session that does not sign in is deleted;
 *   - records app.auth.storageState (the PATH) in the config when `configPath` exists.
 * Never prints the session. → { code, path, verified, changes, message }.
 */
export async function saveSession({ url, configPath = null, config = null, out = null, signedInSelector = null, timeoutMs = DEFAULT_SESSION_TIMEOUT_MIN * 60000, env = process.env, writeConfig = true, launch = null, display = null, log = (m) => process.stderr.write(`${m}\n`), probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS, existing = false }) {
  const root = configPath ? path.dirname(configPath) : process.cwd();
  const file = out ? expandUserPath(out, { env }) : defaultSessionPath(root, url, env);
  const problem = sessionPathProblem(file, root);
  if (problem) throw usageError(problem);
  const selector = signedInSelector ?? config?.app?.auth?.signedInSelector ?? null;

  // --existing: a session file copied into place by hand (no screen here): check it, then record it.
  if (existing) {
    let st = null;
    try {
      st = lstatSync(file);
    } catch {
      // not there
    }
    if (!st?.isFile()) return { code: 1, path: file, verified: false, changes: [], message: `no session file at ${tildePath(file)}${st ? ' (not a regular file)' : ''}: copy it there first, then run this again.` };
    if (process.platform !== 'win32') chmodSync(file, 0o600);
    return recordSession({ file, url, configPath, config, env, writeConfig, selector, probeTimeoutMs, copied: true });
  }

  if (!(display ?? hasDisplay({ env }))) {
    const record = [
      scriptCommand('setup.mjs'), 'save-session', '--existing', '--url', shellArg(url),
      ...(out ? ['--out', shellArg(out)] : []),
      ...(configPath && path.resolve(configPath) !== path.resolve(CONFIG_FILE) ? ['--config', shellArg(displayPath(configPath))] : []),
      ...(writeConfig ? [] : ['--no-config']),
    ].join(' ');
    return { code: 3, path: file, verified: false, changes: [], message: noDisplayHelp(url, file, record) };
  }

  const { importDependency } = await import('./deps.mjs');
  const { chromium } = await importDependency('playwright');
  const channel = env.DESIGN_QA_BROWSER_CHANNEL || undefined;
  let browser;
  try {
    browser = await (launch ? launch(chromium) : chromium.launch({ headless: false, ...(channel ? { channel } : {}) }));
  } catch (err) {
    const first = oneLine(String(err?.message ?? err).split('\n')[0]);
    return { code: 4, path: file, verified: false, changes: [], message: `the browser window did not open: ${first}. Install it with \`npx playwright install chromium\` in the skill folder (the full browser, not only the headless shell).` };
  }
  let state = null;
  let outcome = null;
  try {
    browser.on('disconnected', () => {
      outcome ??= 'quit';
    });
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    page.goto(url).catch(() => {});
    log(
      selector
        ? `A browser window is open at ${url}. Sign in there yourself; I notice when "${selector}" shows and close it. (Up to ${Math.round(timeoutMs / 60000)} min.)`
        : `A browser window is open at ${url}. Sign in there yourself, then close the window. (Up to ${Math.round(timeoutMs / 60000)} min.)`,
    );
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (!outcome) {
      if (Date.now() > deadline) {
        outcome = 'timeout';
        break;
      }
      const pages = context.pages();
      if (!pages.length) {
        outcome = 'closed';
        break;
      }
      try {
        last = await context.storageState();
      } catch {
        // the window is closing
      }
      if (selector) {
        for (const p of pages) {
          if (sameOrigin(p.url(), url) && (await p.locator(selector).first().isVisible().catch(() => false))) {
            outcome = 'signed-in';
            break;
          }
        }
      }
      if (!outcome) await sleep(500);
    }
    if (outcome === 'signed-in' || outcome === 'closed') state = (await context.storageState().catch(() => null)) ?? last;
    else if (outcome === 'quit') state = last;
  } finally {
    await browser.close().catch(() => {});
  }
  if (outcome === 'timeout') return { code: 1, path: file, verified: false, changes: [], message: `timed out after ${Math.round(timeoutMs / 60000)} min without a sign-in; nothing was saved. Run save-session again when you are ready.` };
  if (!state || (!(state.cookies ?? []).length && !(state.origins ?? []).length)) {
    return { code: 1, path: file, verified: false, changes: [], message: 'the window closed before anything was saved (no cookies or site storage); nothing was saved. Run save-session again and sign in before closing it.' };
  }

  const tmp = writePrivateTemp(file, `${JSON.stringify(state)}\n`);
  state = null;
  return recordSession({ file, tmp, url, configPath, config, env, writeConfig, selector, probeTimeoutMs });
}

/**
 * Check a session file with capture --probe (`tmp`: a new one, deleted when it does not
 * sign in, else moved to `file`; `copied`: one the person put at `file`, left as it is) and
 * record its PATH in the config. Never prints the session. → saveSession's result.
 */
async function recordSession({ file, tmp = null, url, configPath, config, env, writeConfig, selector, probeTimeoutMs, copied = false }) {
  let probe;
  try {
    probe = mapProbe(await probeApp({ config, url, env, timeoutMs: probeTimeoutMs, sessionPath: tmp ?? file, signedInSelector: selector }));
  } catch (err) {
    if (tmp) rmSync(tmp, { force: true });
    throw err;
  }
  if (probe.state !== 'ok') {
    if (tmp) rmSync(tmp, { force: true });
    const why = probe.state === 'sign-in' ? `the app still shows a sign-in page (${probe.detail ?? 'sign-in detected'})` : `the check failed (${probe.state}: ${probe.detail ?? `exit ${probe.code}`})`;
    if (copied) return { code: 1, path: file, verified: false, changes: [], message: `the session in ${tildePath(file)} does not work: ${why}; nothing was recorded. Save a fresh one on your own computer, copy it over this one, and run this again.` };
    return { code: 1, path: file, verified: false, changes: [], message: `the saved session does not work: ${why}; it was deleted. Run save-session again${selector ? '' : ' and close the window only once the app shows'}.` };
  }
  if (tmp) renameSync(tmp, file);

  let changes = [];
  const prefix = config?.app?.auth?.envPrefix || DEFAULT_ENV_PREFIX;
  const pointer = tildePath(file);
  if (writeConfig && configPath && existsSync(configPath)) {
    const type = config?.app?.auth?.type;
    const extraSets = [[['app', 'auth', 'storageState'], pointer]];
    if (!type || type === 'none' || type === 'storageState') extraSets.push([['app', 'auth', 'type'], 'storageState']);
    if (!config?.app?.auth?.envPrefix) extraSets.push([['app', 'auth', 'envPrefix'], prefix]);
    changes = applyAnswers({ configPath, answers: {}, env, extraSets }).changes;
  }
  const lines = [
    `${copied ? `Checked the session in ${pointer} (now only you can read it)` : `Saved the session to ${pointer} (only you can read it) and checked it`}: the app opens signed in${probe.signedIn ? ` ("${selector}" is visible)` : ''}.`,
    changes.length
      ? `${path.basename(configPath)} now points to it (app.auth.storageState), so later passes in any chat use it.${config?.app?.auth?.type && !['none', 'storageState'].includes(config.app.auth.type) ? ` app.auth.type is still "${config.app.auth.type}": capture uses the session only with type "storageState".` : ''}`
      : writeConfig && configPath && !existsSync(configPath)
        ? `There is no ${path.basename(configPath)} yet, so nothing points to it: create the config first (${scriptCommand('setup.mjs')} apply), then run save-session again.`
        : 'The config was left as it is (--no-config).',
    `In a shell where capture does not read app.auth.storageState: ${exportLine(`${prefix}_STORAGE_STATE`, file)}`,
    'Sessions expire: setup.mjs check says so and asks again.',
  ];
  return { code: 0, path: file, verified: true, changes, message: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `Set up design-qa for this repository: what is ready, what is missing, and the few questions to ask.

Usage:
  node scripts/setup.mjs check [--config <file>] [--surface <name>] [--url <app-url>]
                               [--agent figma-mcp=yes|no] [--agent ticket-mcp=yes|no]
                               [--ticket] [--figma] [--backfill] [--ask <id>]...
                               [--ci] [--quick] [--timeout <ms>] [--json] [--full]
  node scripts/setup.mjs apply [--accept-assumed] [--answers <file.json>] [--url <app-url>]
                               [--config <file>] [--dry-run] [--no-next] [--json]
  node scripts/setup.mjs save-session [--url <app-url>] [--config <file>] [--out <file>]
                               [--signed-in-selector <css>] [--timeout-min <n>] [--no-config] [--existing] [--json]
  node scripts/setup.mjs export-theme --from <theme file> [--out <file.json>] [--config <file>]

check (run first in every pass): the tools (doctor.mjs), the config, the app (address;
  reachable and signed in, through capture.mjs --probe: a sign-in page is "needs a signed-in
  session", never "unreachable"), the design system, design and ticket access, what to hide
  before capture and where reports go. A configured project gets no questions. A new one gets
  at most ${MAX_QUESTIONS}, only those that change what a pass finds (app address, sign-in, style
  values, component libraries):
  - assumed: what the repository answers on its own (one token file, one library, the dev
    command and port, the design-system name, design docs, a single Figma library link,
    reports kept out of git). Not asked: apply --accept-assumed writes them; the person
    corrects any of them by saying so (answer that id, or check --ask <id>).
  - deferred: asked only when a pass needs it, each with its trigger:
    --ticket    the pass was given a ticket key (where tickets live, Jira site and access)
    --figma     the design is in Figma (with --agent figma-mcp=no: Figma access, FIGMA_TOKEN)
    --backfill  design backfill is requested (the Figma library link)
    --ask <id>  ask this one now, e.g. --ask hide after a capture showed a banner; repeatable
    The start command is asked when the local app does not answer and none is known.
  --agent    what the agent found in its own tool list (a script cannot see MCP tools)
  --ci       never asks: exits 1 and names each missing required input
  --quick    no browser launch and no probe (config and repository only)
  --json     compact: { ready, checks (failing only), questions, assumed, deferred,
             agentChecks (unanswered), next }. --full: every check row and discovery.
             question: { id, title, question, why, kind: choice|multi|text, options: [{ value,
             label, description }], default, required, writes, unless?, dependsOn? }.
             assumed: { id, title, value, why, writes }. deferred: { id, when }.
             writes is a config path, env:<NAME> (the person sets the variable; never
             answered through apply), action:save-session or none.

apply: writes answers ({ "<question id>": <value>, … }, as collected in chat) and, with
  --accept-assumed, what check assumed (an answer for the same id wins) into
  design-qa.config.json, created with defaults when absent; unknown keys and key order are
  kept; atomic; a symbolic link is refused. The result is validated before anything is
  written. Refused (nothing written, exit 2): unknown ids, answers to env: or action:
  questions, and any value that looks like a password, token, cookie or session.
  "later" saves nothing. --dry-run prints the changes only. --no-next leaves out the
  closing "Next: … check" line (JSON: next is null), for an apply run inside a pass whose
  own next step is the one to follow.

export-theme: runs a JS or TS theme module of the project (an MUI theme, a theme object, a
  Tailwind config) once with Node and saves its values as JSON for the audit (default
  design-qa/<name>.tokens.json). It runs project code: only when the person agreed (apply
  does it for a "Style values" answer naming such a file). TypeScript: Node's own type
  stripping, else the project's tsx, esbuild or ts-node; nothing is installed.

save-session: for apps behind sign-in. Opens a browser window at the app (headed) so the
  person signs in themselves; the agent types nothing. Waits until --signed-in-selector (or
  app.auth.signedInSelector) is visible, or the person closes the window, or --timeout-min
  (default ${DEFAULT_SESSION_TIMEOUT_MIN}). Saves the session to ${SESSION_DIR}/<repo>-<host>.json by default
  (outside the repository, mode 600; a path inside the repository is refused unless git
  ignores it), verifies it with capture.mjs --probe, and records the PATH in the config as
  app.auth.storageState (--no-config: don't). Never prints the session. Without a screen
  (SSH, CI, cloud; DESIGN_QA_NO_DISPLAY=1 forces it) it opens nothing and prints the
  command to run on your own computer, then save-session --existing, which checks the
  copied file the same way and records it.

Exit codes:
  check         0 ready · 1 not ready (required questions or blocking checks) · 2 bad arguments
  export-theme  0 saved · 1 the module could not be read (what to do instead is printed)
  apply         0 written (or nothing to change) · 1 the result would not validate · 2 refused
  save-session  0 saved and verified · 1 not signed in, timed out or closed early (nothing
                kept) · 2 bad arguments or an unsafe path · 3 no screen (instructions printed)
                · 4 the browser does not open`;

function resolveConfigPath(value) {
  return path.resolve(value ?? CONFIG_FILE);
}

async function mainCheck(argv) {
  // --ticket takes no value; a ticket key after it ("--ticket ABC-123") is accepted and ignored.
  argv = argv.filter((a, i) => !(i > 0 && argv[i - 1] === '--ticket' && !a.startsWith('-')));
  const { values } = parseCli(argv, {
    config: { type: 'string' },
    surface: { type: 'string' },
    url: { type: 'string' },
    agent: { type: 'string', multiple: true },
    ticket: { type: 'boolean' },
    figma: { type: 'boolean' },
    backfill: { type: 'boolean' },
    ask: { type: 'string', multiple: true },
    ci: { type: 'boolean' },
    quick: { type: 'boolean' },
    timeout: { type: 'string' },
    json: { type: 'boolean' },
    full: { type: 'boolean' },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const agent = parseAgentFlags(values.agent ?? []);
  const ask = (values.ask ?? []).flatMap((a) => a.split(',')).map((a) => a.trim()).filter(Boolean);
  for (const id of ask) if (!ASKABLE_IDS.includes(id)) throw usageError(`--ask: unknown question "${oneLine(id)}" (one of: ${ASKABLE_IDS.join(', ')})`);
  if (values.url) httpUrlOrUsage(values.url);
  const timeoutMs = values.timeout ? Number(values.timeout) : DEFAULT_PROBE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) throw usageError('--timeout: expected milliseconds, at least 1000');
  const triggers = { ticket: Boolean(values.ticket), figma: Boolean(values.figma), backfill: Boolean(values.backfill), ask };
  const result = await runCheck({ configPath: resolveConfigPath(values.config), surface: values.surface ?? null, url: values.url ?? null, ci: Boolean(values.ci), quick: Boolean(values.quick), agent, timeoutMs, triggers });
  if (values.json) process.stdout.write(`${JSON.stringify(values.full ? result : compactCheck(result), null, 2)}\n`);
  else process.stdout.write(formatCheck(result, { full: Boolean(values.full) }));
  if (values.ci && !result.ready) {
    process.stderr.write(`setup.mjs: not ready for a ci run; missing:\n${result.missing.map((m) => `  - ${m}`).join('\n')}\n`);
  }
  return result.ready ? 0 : 1;
}

function httpUrlOrUsage(value) {
  try {
    return httpUrl(value, '--url');
  } catch (err) {
    throw usageError(err.message);
  }
}

async function mainApply(argv) {
  const { values } = parseCli(argv, {
    answers: { type: 'string' },
    'accept-assumed': { type: 'boolean' },
    url: { type: 'string' },
    config: { type: 'string' },
    'dry-run': { type: 'boolean' },
    'no-next': { type: 'boolean' },
    json: { type: 'boolean' },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (!values.answers && !values['accept-assumed']) throw usageError('--answers <file.json> or --accept-assumed is required');
  if (values.url) httpUrlOrUsage(values.url);
  const answers = values.answers ? readJsonFile(path.resolve(values.answers), 'answers file') : {};
  const result = applyAnswers({ configPath: resolveConfigPath(values.config), answers, dryRun: Boolean(values['dry-run']), acceptAssumed: Boolean(values['accept-assumed']), url: values.url ?? null });
  // --no-next: run from inside a pass (a pass.mjs "Do:" line), whose own next step is the one to follow.
  const next = values['no-next'] || result.dryRun ? null : `${scriptCommand('setup.mjs')} check`;
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ ...result, next }, null, 2)}\n`);
    return 0;
  }
  const name = path.basename(result.configPath);
  const verb = result.dryRun ? 'Would change' : result.created ? 'Created' : 'Changed';
  if (!result.changes.length && !result.created) process.stdout.write(`${name}: nothing to change.\n`);
  else {
    process.stdout.write(`${verb} ${name}${result.dryRun ? ' (dry run, nothing written)' : ''}:\n`);
    for (const c of result.changes) process.stdout.write(`  ${c.path}: ${show(c.from)} → ${show(c.to)}\n`);
  }
  for (const n of result.notes) process.stdout.write(`note: ${oneLine(n)}\n`);
  for (const w of result.warnings) {
    // No surfaces yet is normal: a pass names its pages with --url, or its screens in <dir>/states.json.
    if (w.path === 'surfaces' && /no surfaces configured/.test(w.message)) {
      process.stdout.write('note: no surfaces yet: fine; a pass takes the page from --url or its screens from <dir>/states.json (pass.mjs save-drivers can keep them). Nothing to do.\n');
      continue;
    }
    process.stdout.write(`warning: ${oneLine(w.path)}: ${oneLine(w.message)}\n`);
  }
  if (next) process.stdout.write(`Next: ${next}\n`);
  return 0;
}

async function mainSaveSession(argv) {
  const { values } = parseCli(argv, {
    url: { type: 'string' },
    config: { type: 'string' },
    out: { type: 'string' },
    'signed-in-selector': { type: 'string' },
    'timeout-min': { type: 'string' },
    'no-config': { type: 'boolean' },
    existing: { type: 'boolean' },
    json: { type: 'boolean' },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const configPath = resolveConfigPath(values.config);
  const { config, problem } = loadConfig(configPath);
  if (problem) throw usageError(problem);
  let url = values.url ?? config?.app?.baseUrl ?? null;
  if (!url) throw usageError('--url <app-url> is required (or app.baseUrl in the config)');
  // A ${PREVIEW_URL} base URL: expanded here (an address, not a secret).
  url = String(url).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => {
    if (!process.env[n]) throw usageError(`environment variable ${n} is not set (in the app address)`);
    return process.env[n];
  });
  httpUrlOrUsage(url);
  const minutes = values['timeout-min'] ? Number(values['timeout-min']) : DEFAULT_SESSION_TIMEOUT_MIN;
  if (!(minutes > 0 && minutes <= 60)) throw usageError('--timeout-min: expected minutes between 1 and 60');
  const result = await saveSession({
    url,
    configPath,
    config,
    out: values.out ?? null,
    signedInSelector: values['signed-in-selector'] ?? null,
    timeoutMs: minutes * 60000,
    writeConfig: !values['no-config'],
    existing: Boolean(values.existing),
  });
  if (values.json) process.stdout.write(`${JSON.stringify({ code: result.code, path: tildePath(result.path), verified: result.verified, changes: result.changes, message: result.message }, null, 2)}\n`);
  else (result.code === 0 ? process.stdout : process.stderr).write(`${result.message}\n`);
  // --existing runs on its own (the chain that asked for it stopped at "no screen"): say where to go on.
  if (!values.json && values.existing && result.code === 0) {
    const cfg = path.resolve(configPath) !== path.resolve(CONFIG_FILE) ? ` --config ${shellArg(displayPath(configPath))}` : '';
    process.stdout.write(`Next: ${scriptCommand('setup.mjs')} check${cfg}\n`);
  }
  return result.code;
}

async function mainExportTheme(argv) {
  const { values } = parseCli(argv, { from: { type: 'string' }, out: { type: 'string' }, config: { type: 'string' } });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (!values.from) throw usageError('--from <theme file> is required');
  const root = path.dirname(resolveConfigPath(values.config));
  let r;
  try {
    r = exportTheme({ root, from: values.from, out: values.out ?? null });
  } catch (err) {
    if (err instanceof AnswerError) throw usageError(err.message);
    throw err;
  }
  if (!r.ok) {
    process.stderr.write(`setup.mjs: ${oneLine(r.message)}\n`);
    return 1;
  }
  process.stdout.write(`Saved the values of ${oneLine(values.from)} to ${r.out} (${r.how}).\nIf the config does not list it yet, answer "Style values" with it: {"ds-tokens": ["${r.out}"]}.\nNext: ${scriptCommand('setup.mjs')} check\n`);
  return 0;
}

/** setup.mjs entry: check | apply | save-session | export-theme. */
export async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP);
    return command ? 0 : 2;
  }
  if (command === 'check') return mainCheck(rest);
  if (command === 'apply') return mainApply(rest);
  if (command === 'save-session') return mainSaveSession(rest);
  if (command === 'export-theme') return mainExportTheme(rest);
  throw usageError(`unknown command "${oneLine(command)}": expected check, apply, save-session or export-theme (see --help)`);
}
