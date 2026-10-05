// Run isolation for a report folder (qa-reports/<feature>/): one design-qa pass owns
// it at a time. The owner is recorded in a lock file (<dir>/.design-qa-run.json, with a
// generated run id); a review server registers itself next to it
// (<dir>/.design-qa-review.json: pid, port, a public registration id, never the token).
// A folder is "active" while its lock is not finished and something in it changed in the
// last idle minutes, or while a live review server is registered, so no script needs to
// send heartbeats. scripts/run.mjs is the CLI; other scripts call assertRunOwnsDir.
// node: built-ins only.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CliError, displayPath, oneLine, scriptCommand, usageError, writeJson } from './args.mjs';

export const RUN_LOCK_FILE = '.design-qa-run.json';
export const REVIEW_FILE = '.design-qa-review.json';
export const ARCHIVE_DIR = 'archive';
/** Minutes without a change after which an unfinished run counts as stale, and run.mjs start archives it (env DESIGN_QA_RUN_IDLE_MIN). */
export const DEFAULT_IDLE_MIN = 60;
/** run.mjs start: the folder is busy; a sibling folder was created and locked for this run. */
export const EXIT_BUSY = 3;
/** The folder (or its review server) belongs to another run: nothing was changed. */
export const EXIT_CONFLICT = 5;
/** A run id: UTC start time and 6 random hex digits, e.g. 20261004T113201Z-a1b2c3. Safe as a folder name. */
export const RUN_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;
// Files of the cumulative logs and of the repository: a folder holding one is never a report folder.
const PARENT_MARKERS = ['dismissed.json', 'dismissed.md', 'design-debt.json', 'design-debt.md', 'design-qa.config.json', '.git'];
const MAX_SCAN = 20_000;
// A modification time further than this in the future says nothing about activity (clock skew, a touch).
const FUTURE_SKEW_MS = 2 * 60_000;

/**
 * Everything design-qa writes at the top of a report folder. A folder holding anything
 * else is not a report folder, and run.mjs never archives or takes it.
 */
export const REPORT_OUTPUTS = Object.freeze([
  'report.json', 'report.html', 'report-fixplan.md', 'report-backfill.md', 'findings.json', 'pass.json', 'states.json',
  'state-matrix.json', 'backfill-candidates.json', 'frame-map.json', 'design-census.json', 'worklist.md', 'driver-suggestions.md',
  'decisions.json', 'decisions.applied.json', 'selection.json', 'dismissals.json', 'backfill.json', 'evidence', 'logs',
  ARCHIVE_DIR, RUN_LOCK_FILE, REVIEW_FILE,
]);
// Outputs that only a design-qa pass writes: one of them (or a run lock) makes a folder recognisably a report folder.
const REPORT_MARKERS = ['pass.json', 'report.json', 'state-matrix.json', 'findings.json', 'evidence', 'report.html'];
// Temp files of atomic writes, ledger locks and OS litter: neither outputs nor foreign content.
const TRANSIENT_RE = /^(?:\..+\.tmp|.+\.lock|.+\.lock\.break|.+\.stale|\.DS_Store|Thumbs\.db|desktop\.ini)$/;
// Extra top-level files a report folder may hold besides REPORT_OUTPUTS: the agent's working data
// (answers.json, backfill-details.json, a saved pasted message, notes). They move with the archive.
export const REPORT_DATA_EXT = Object.freeze(['.json', '.md', '.txt', '.log', '.xml', '.html', '.png', '.jpg', '.jpeg', '.csv']);
// File types a pass keeps inside evidence/, logs/ and archive/ (for the git check).
const NESTED_OUTPUT_EXT = new Set(['.json', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.svg', '.md', '.html', '.txt', '.log', '.xml']);

const show = (p) => oneLine(displayPath(p));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A new run id from the clock and 3 random bytes. */
export function newRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

/** The run id the caller says it is: --run, else DESIGN_QA_RUN_ID; null when neither; usage error when malformed. */
export function callerRunId(flag, env = process.env) {
  const value = flag ?? (env.DESIGN_QA_RUN_ID || undefined);
  if (value === undefined || value === null || value === '') return null;
  if (!RUN_ID_RE.test(String(value))) {
    throw usageError(`${flag !== undefined ? '--run' : 'DESIGN_QA_RUN_ID'}: not a run id (got "${oneLine(value)}"); use the id run.mjs start printed, like 20261004T113201Z-a1b2c3`);
  }
  return String(value);
}

/** Idle minutes: the flag, else DESIGN_QA_RUN_IDLE_MIN, else 60. */
export function idleMinutes(flag, env = process.env) {
  const raw = flag ?? env.DESIGN_QA_RUN_IDLE_MIN;
  if (raw === undefined || raw === '') return DEFAULT_IDLE_MIN;
  const n = /^\d+(?:\.\d+)?$/.test(String(raw).trim()) ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n > 10_080) throw usageError(`${flag !== undefined ? '--idle-min' : 'DESIGN_QA_RUN_IDLE_MIN'}: expected minutes between 0 and 10080 (got "${oneLine(raw)}")`);
  return n;
}

function readJsonOrNull(file) {
  let text;
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return { invalid: true };
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw new CliError(`cannot read ${show(file)}: ${err.message}`, 1);
  }
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    return isObj(value) ? value : { invalid: true };
  } catch {
    return { invalid: true };
  }
}

/** The run lock of `dir`, null when there is none; { invalid: true } when it is not a lock (a run that will be judged by age). */
export function readRunLock(dir) {
  const lock = readJsonOrNull(path.join(dir, RUN_LOCK_FILE));
  if (lock && !lock.invalid && (lock.kind !== 'design-qa-run' || !RUN_ID_RE.test(String(lock.runId)))) return { invalid: true };
  return lock;
}

/** Write the lock (atomic; refuses a symlinked lock file). */
export function writeRunLock(dir, lock) {
  writeJson(path.join(dir, RUN_LOCK_FILE), lock);
}

/** The review server registered in `dir`, or null. */
export function readReviewRegistration(dir) {
  const reg = readJsonOrNull(path.join(dir, REVIEW_FILE));
  if (!reg || reg.invalid || reg.kind !== 'design-qa-review' || !Number.isInteger(reg.pid) || !Number.isInteger(reg.port) || typeof reg.id !== 'string') return reg ? { invalid: true } : null;
  return reg;
}

export function writeReviewRegistration(dir, reg) {
  writeJson(path.join(dir, REVIEW_FILE), reg);
}

/** Remove the registration only when it is still the one with this id (a replacement server keeps its own). */
export function removeReviewRegistration(dir, id) {
  const file = path.join(dir, REVIEW_FILE);
  try {
    const reg = readJsonOrNull(file);
    if (reg && (id === undefined || reg.id === id || reg.invalid)) rmSync(file, { force: true });
  } catch {
    // Already gone or unreadable: nothing to remove.
  }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** How long ago the server registered (ms); Infinity when its start time is unreadable or in the future. */
export function registrationAgeMs(reg, now = Date.now()) {
  const at = Date.parse(reg?.startedAt);
  if (!Number.isFinite(at) || at > now + FUTURE_SKEW_MS) return Infinity;
  return Math.max(0, now - at);
}

/**
 * Could the registered server still be running (without asking it)? Its process is
 * alive on this host; a registration from another host name (a shared folder, or this
 * machine after its host name changed) counts only while it is younger than maxAgeMs
 * (default: the idle window), because its pid cannot be checked here. Use
 * checkRegistration to ask the server itself.
 */
export function registrationAlive(reg, { now = Date.now(), maxAgeMs = DEFAULT_IDLE_MIN * 60_000 } = {}) {
  if (!reg || reg.invalid) return false;
  if (reg.host && reg.host !== os.hostname()) return registrationAgeMs(reg, now) < maxAgeMs;
  return pidAlive(reg.pid);
}

/**
 * Is the registered review server alive? It is asked first, whatever host it was
 * registered on: a server on 127.0.0.1:<port> answering /health with the same
 * registration id and pid is alive. One that does not answer is stale when its process
 * is gone (same host) or the registration is older than maxAgeMs; a younger one counts
 * as alive (it may be busy), so a registration can never keep a folder busy for longer
 * than maxAgeMs. Resolves { alive, answering, stale, reason, info }.
 */
export async function checkRegistration(reg, { now = Date.now(), maxAgeMs = DEFAULT_IDLE_MIN * 60_000, timeoutMs = 2000 } = {}) {
  if (!reg || reg.invalid) return { alive: false, answering: false, stale: Boolean(reg), reason: reg ? 'not a review registration' : 'no registration', info: null };
  const probe = await probeReviewServer(reg, { timeoutMs });
  if (probe.ok) return { alive: true, answering: true, stale: false, reason: null, info: probe.info };
  const sameHost = !reg.host || reg.host === os.hostname();
  if (sameHost && !pidAlive(reg.pid)) return { alive: false, answering: false, stale: true, reason: `its process is gone (${probe.error})`, info: null };
  const age = registrationAgeMs(reg, now);
  if (age >= maxAgeMs) {
    const when = Number.isFinite(age) ? `registered ${Math.round(age / 60_000)} min ago` : 'registered at an unreadable time';
    return { alive: false, answering: false, stale: true, reason: `${when}${sameHost ? '' : ` on host ${oneLine(reg.host)}`} and not answering (${probe.error})`, info: null };
  }
  return { alive: true, answering: false, stale: false, reason: `not answering yet (${probe.error})`, info: null };
}

/**
 * Ask the registered server who it is: GET /health on 127.0.0.1:<port> with the
 * registration id. Resolves { ok: true, info } only when it answers as that very
 * registration (same id and pid), else { ok: false, error }.
 */
export function probeReviewServer(reg, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    if (!reg || reg.invalid) return resolve({ ok: false, error: 'no registration' });
    const req = http.get(
      { host: '127.0.0.1', port: reg.port, path: '/health', headers: { Host: `127.0.0.1:${reg.port}`, 'X-Design-QA-Registration': reg.id }, agent: false, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size < 64 * 1024) chunks.push(c);
        });
        res.on('end', () => {
          let info = null;
          try {
            info = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            // not JSON: not a review server
          }
          const same = res.statusCode === 200 && isObj(info) && info.ok === true && info.kind === 'design-qa-review' && info.id === reg.id && info.pid === reg.pid;
          resolve(same ? { ok: true, info } : { ok: false, error: `port ${reg.port} answered, but not as this folder's review server (HTTP ${res.statusCode})` });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`no answer on port ${reg.port} within ${timeoutMs} ms`)));
    req.on('error', (err) => resolve({ ok: false, error: err.code === 'ECONNREFUSED' ? `nothing listens on port ${reg.port}` : err.message }));
  });
}

/**
 * The newest modification time (ms) of anything inside `dir`: files and sub-folders,
 * found without following symbolic links, the archive folder and the run lock's own
 * mutex files left out. The folder's own mtime does not count. A time more than 2
 * minutes in the future (clock skew, a touch) is ignored, a nearer one counts as now,
 * so no file can keep a folder busy for ever. 0 when nothing is there.
 */
export function lastActivity(dir, { now = Date.now() } = {}) {
  let newest = 0;
  let seen = 0;
  const walk = (current, depth) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > MAX_SCAN) return;
      if (depth === 0 && (e.name === ARCHIVE_DIR || e.name.startsWith(`${RUN_LOCK_FILE}.`))) continue;
      const full = path.join(current, e.name);
      try {
        const mtime = lstatSync(full).mtimeMs;
        if (mtime <= now + FUTURE_SKEW_MS) newest = Math.max(newest, Math.min(mtime, now));
      } catch {
        continue;
      }
      if (e.isDirectory() && depth < 12) walk(full, depth + 1);
    }
  };
  walk(dir, 0);
  return newest;
}

/** Top-level entries that are outputs of a pass: everything but the lock, the review registration, the archive and lock mutexes. */
export function outputEntries(dir) {
  try {
    return readdirSync(dir)
      .filter((name) => name !== RUN_LOCK_FILE && name !== REVIEW_FILE && name !== ARCHIVE_DIR && !name.startsWith(`${RUN_LOCK_FILE}.`))
      .sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new CliError(`cannot list ${show(dir)}: ${err.message}`, 1);
  }
}

/**
 * Who holds `dir` and whether that run is still going:
 *   state "missing"  the folder does not exist
 *         "empty"    no lock and no outputs
 *         "active"   a live review server is registered, or the lock is not finished
 *                    and something changed in the last idleMin minutes, or there is no
 *                    lock but outputs changed that recently (a run that never locked)
 *         "stale"    the lock is not finished, nothing changed for idleMin minutes and
 *                    no server is alive (an abandoned pass)
 *         "finished" the lock says finished
 *         "unlocked" outputs without a lock, none changed recently (an older pass)
 * plus { lock, registration, serverAlive, lastActivityMs, idleMs, outputs }. Pass
 * serverAlive (from checkRegistration) when the server was asked; otherwise
 * registrationAlive judges it without asking.
 */
export function assessDir(dir, { idleMin = DEFAULT_IDLE_MIN, now = Date.now(), serverAlive: knownAlive } = {}) {
  let st = null;
  try {
    st = lstatSync(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw new CliError(`cannot read ${show(dir)}: ${err.message}`, 1);
  }
  if (!st) return { state: 'missing', lock: null, registration: null, serverAlive: false, lastActivityMs: 0, idleMs: null, outputs: [] };
  const lock = readRunLock(dir);
  const registration = readReviewRegistration(dir);
  // knownAlive: the caller asked the server (checkRegistration); otherwise judged without asking.
  const serverAlive = typeof knownAlive === 'boolean' ? Boolean(registration) && !registration.invalid && knownAlive : registrationAlive(registration, { now, maxAgeMs: idleMin * 60_000 });
  const outputs = outputEntries(dir);
  const lastActivityMs = lastActivity(dir, { now });
  const idleMs = lastActivityMs ? Math.max(0, now - lastActivityMs) : null;
  const recent = idleMs !== null && idleMs < idleMin * 60_000;
  let state;
  if (lock && !lock.invalid && lock.status === 'finished' && !serverAlive) state = 'finished';
  else if (serverAlive) state = 'active';
  else if (lock) state = recent ? 'active' : 'stale';
  else if (!outputs.length) state = 'empty';
  else state = recent ? 'active' : 'unlocked';
  return { state, lock, registration, serverAlive, lastActivityMs, idleMs, outputs };
}

/**
 * Is `dir` this run's folder? { ok, lock, reason }: ok when the folder has no lock (an
 * older pass) and `required` is false, when no run id is given, `required` is false and
 * the lock is finished, or when the lock names this run. A run that is not finished
 * holds its folder: writing into it needs its run id. reason explains a refusal in one line.
 */
export function checkRunOwnership(dir, { runId = null, required = false } = {}) {
  const lock = readRunLock(dir);
  if (!runId) {
    if (required) return { ok: false, lock, reason: 'no run id: pass --run <id> or set DESIGN_QA_RUN_ID to the id run.mjs start printed' };
    if (lock && !lock.invalid && lock.status !== 'finished') {
      return { ok: false, lock, reason: `${show(dir)} belongs to a run that is not finished: pass --run <id> with your own run id (pass.mjs start printed it); another run's folder is never written` };
    }
    return { ok: true, lock };
  }
  if (!lock) {
    return required ? { ok: false, lock, reason: `${show(dir)} has no run lock: start the pass with run.mjs start --dir ${show(dir)}` } : { ok: true, lock };
  }
  if (lock.invalid) return { ok: false, lock, reason: `${show(path.join(dir, RUN_LOCK_FILE))} is not a run lock` };
  if (lock.runId === runId) return { ok: true, lock };
  const who = `run ${lock.runId}${lock.label ? ` (${oneLine(lock.label)})` : ''}, started ${oneLine(lock.startedAt)}${lock.status === 'finished' ? `, finished ${oneLine(lock.finishedAt)}` : ''}`;
  return {
    ok: false,
    lock,
    reason: `${show(dir)} belongs to ${who}; you are run ${runId}. Do not write to it or delete it: use the folder run.mjs start printed for your run (check with: ${scriptCommand('run.mjs')} status --dir ${show(dir)})`,
  };
}

/**
 * For other scripts: throw CliError (exit 5) unless `dir` is this run's folder.
 * runId defaults to DESIGN_QA_RUN_ID; pass the script's --run value when it has one.
 * Returns the lock (or null for an unlocked folder).
 */
export function assertRunOwnsDir(dir, { runId = callerRunId(undefined), required = false } = {}) {
  const result = checkRunOwnership(path.resolve(dir), { runId, required });
  if (!result.ok) throw new CliError(result.reason, EXIT_CONFLICT);
  return result.lock;
}

const inside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};

/**
 * Refuse (usage error) a --dir a run must never own: a filesystem root, the home folder,
 * the working directory or one of its ancestors, a repository root, a symbolic link or
 * a file, the folder that holds the cumulative logs or the feature folders, or a folder
 * inside an archive; with `content`, also any existing folder that is not a report
 * folder (reportFolderProblem). Returns the absolute path.
 */
export function checkRunDir(dir, { cwd = process.cwd(), content = false } = {}) {
  if (typeof dir !== 'string' || !dir.trim()) throw usageError('--dir <report folder> is required (e.g. --dir qa-reports/abc-123)');
  const abs = path.resolve(dir);
  const refuse = (why) => usageError(`refusing --dir ${show(abs)}: ${why}`);
  if (path.parse(abs).root === abs) throw refuse('it is a filesystem root');
  if (abs === path.resolve(os.homedir())) throw refuse('it is the home folder');
  if (inside(abs, path.resolve(cwd))) throw refuse('it is the working directory or one of its parents; give the feature folder, e.g. qa-reports/<feature>');
  let st = null;
  try {
    st = lstatSync(abs);
  } catch (err) {
    if (err.code !== 'ENOENT') throw refuse(err.message);
  }
  if (st?.isSymbolicLink()) throw refuse('it is a symbolic link; give the real folder');
  if (st && !st.isDirectory()) throw refuse('it is not a folder');
  if (path.basename(path.dirname(abs)) === ARCHIVE_DIR && readRunLock(path.dirname(path.dirname(abs))) !== null) {
    throw refuse('it is inside the archive of an earlier pass; archived passes are kept as they are');
  }
  if (st) {
    const names = readdirSync(abs);
    const marker = PARENT_MARKERS.find((m) => names.includes(m));
    if (marker) throw refuse(`it holds ${marker}, so it is the repository or the folder of the cumulative logs, not a report folder`);
    for (const name of names) {
      if (name === ARCHIVE_DIR || name.startsWith('.')) continue;
      const sub = path.join(abs, name);
      try {
        if (!lstatSync(sub).isDirectory()) continue;
        const subNames = readdirSync(sub);
        if (subNames.includes('report.json') || subNames.includes(RUN_LOCK_FILE)) {
          throw refuse(`its sub-folder ${oneLine(name)} is a report folder, so this is the folder that holds the feature folders; give one feature folder`);
        }
      } catch (err) {
        if (err instanceof CliError) throw err;
      }
    }
    // Only a report folder may be archived or taken: never a source folder named like a feature.
    if (content) assertReportFolder(abs);
  }
  return abs;
}

/**
 * Why `dir` is not a report folder, or null when it is one (or is missing or empty).
 * A report folder holds a run lock or at least one output only a pass writes (pass.json,
 * report.json, state-matrix.json, findings.json, evidence/, report.html): a non-empty
 * folder with neither is refused (a source folder such as src/). Besides the known
 * outputs (REPORT_OUTPUTS), it may hold extra top-level files with a data extension
 * (REPORT_DATA_EXT: the agent's answers.json, a saved message, notes); it never holds an
 * unknown sub-folder or a file of another type (source code, binaries). Inside a git
 * repository it must not hold tracked files that are not report outputs. The git check
 * is skipped outside a repository or when git is not installed.
 */
export function reportFolderProblem(dir) {
  let names;
  try {
    names = readdirSync(dir).filter((n) => !TRANSIENT_RE.test(n));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return `cannot list it: ${err.message}`;
  }
  if (!names.length) return null;
  const list = (items) => items.slice(0, 6).map((n) => oneLine(n)).join(', ') + (items.length > 6 ? ` and ${items.length - 6} more` : '');
  const recognised = names.includes(RUN_LOCK_FILE) || names.some((n) => REPORT_MARKERS.includes(n));
  if (!recognised && names.some((n) => n !== ARCHIVE_DIR && n !== REVIEW_FILE)) {
    return `it is not a report folder: it holds ${list(names.sort())} but neither a run lock nor any pass output (${REPORT_MARKERS.join(', ')}). Give the report folder (e.g. qa-reports/<feature>)`;
  }
  const foreign = [];
  for (const name of names.filter((n) => !REPORT_OUTPUTS.includes(n)).sort()) {
    let st;
    try {
      st = lstatSync(path.join(dir, name));
    } catch {
      continue;
    }
    if (st.isDirectory()) foreign.push(`${name}/`);
    else if (!st.isFile() && !st.isSymbolicLink()) foreign.push(name);
    else if (!REPORT_DATA_EXT.includes(path.extname(name).toLowerCase())) foreign.push(name);
  }
  if (foreign.length) {
    return (
      `it is not a report folder: it holds ${list(foreign)}, which a report folder never holds (only design-qa outputs and data files: ${REPORT_DATA_EXT.join(' ')}). ` +
      'Give the report folder (e.g. qa-reports/<feature>), or move those entries out of it'
    );
  }
  const tracked = gitTrackedFiles(dir);
  if (tracked) {
    const foreignTracked = tracked.filter((rel) => {
      const parts = rel.split('/');
      if (parts.length === 1) return !REPORT_OUTPUTS.includes(parts[0]);
      return !REPORT_OUTPUTS.includes(parts[0]) || !NESTED_OUTPUT_EXT.has(path.extname(rel).toLowerCase());
    });
    if (foreignTracked.length) return `it holds files tracked by git that are not report outputs (${list(foreignTracked.sort())}); a run never archives source files`;
  }
  return null;
}

/** Files tracked by git under `dir` (paths relative to it, forward slashes), or null outside a repository or without git. */
function gitTrackedFiles(dir) {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', '.'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/** Refuse (usage error) a folder that is not a report folder (reportFolderProblem). */
export function assertReportFolder(dir) {
  const problem = reportFolderProblem(dir);
  if (problem) throw usageError(`refusing --dir ${show(dir)}: ${problem}. Nothing was moved`);
}

/** A sibling folder name for a run that cannot use `dir`: <feature>--<run id> (a feature name that is not a plain word becomes "run"). */
export function siblingName(dir, runId) {
  let base = path.basename(dir).replace(/(?:--\d{8}T\d{6}Z-[0-9a-f]{6})+$/i, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(base)) base = 'run';
  return `${base}--${runId}`;
}

/**
 * Move every output of an earlier pass (everything but the lock mutexes, the
 * registration and the archive) into <dir>/archive/<name>/, where name is the earlier
 * run id, else "pass-<time of its newest file>". Renames only: nothing is copied or
 * deleted, and a symbolic link is moved as the link, never followed. The earlier lock
 * goes along. Returns { archiveDir, name, moved }.
 */
export function archiveOutputs(dir, { previousLock = null, lastActivityMs = Date.now() } = {}) {
  assertReportFolder(dir); // nothing is moved out of a folder that is not a report folder
  const archiveRoot = path.join(dir, ARCHIVE_DIR);
  let st = null;
  try {
    st = lstatSync(archiveRoot);
  } catch (err) {
    if (err.code !== 'ENOENT') throw new CliError(`cannot read ${show(archiveRoot)}: ${err.message}`, 1);
  }
  if (st && !st.isDirectory()) throw new CliError(`${show(archiveRoot)} is not a folder (a symbolic link or a file); move it away, then start again`, 1);
  if (!st) mkdirSync(archiveRoot);
  const base =
    previousLock && !previousLock.invalid && RUN_ID_RE.test(String(previousLock.runId))
      ? previousLock.runId
      : `pass-${newRunId(new Date(lastActivityMs || Date.now())).slice(0, 16)}`;
  let name = base;
  let target;
  for (let i = 0; ; i++) {
    target = path.join(archiveRoot, name);
    try {
      mkdirSync(target);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST' || i > 20) throw new CliError(`cannot create ${show(target)}: ${err.message}`, 1);
      name = `${base}-${randomBytes(2).toString('hex')}`;
    }
  }
  const moved = [];
  const entries = [...outputEntries(dir), ...(previousLock ? [RUN_LOCK_FILE] : [])];
  for (const entry of entries) {
    try {
      renameSync(path.join(dir, entry), path.join(target, entry));
      moved.push(entry);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw new CliError(
        `cannot move ${show(path.join(dir, entry))} into ${show(target)}: ${err.message}. Moved so far: ${moved.length ? moved.map(oneLine).join(', ') : 'nothing'}; nothing was deleted`,
        1,
      );
    }
  }
  return { archiveDir: target, name, moved };
}

/** The archived passes of `dir`, oldest first: { name, path, runId, label, startedAt, status, finishedAt, archivedAt, hasReport, reportGeneratedAt, verdict, entries }. */
export function listArchives(dir) {
  const root = path.join(dir, ARCHIVE_DIR);
  let names = [];
  try {
    if (!lstatSync(root).isDirectory()) return [];
    names = readdirSync(root).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const full = path.join(root, name);
    try {
      if (!lstatSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    const lock = readRunLock(full);
    const report = readJsonOrNull(path.join(full, 'report.json'));
    out.push({
      name,
      path: full,
      runId: lock && !lock.invalid ? lock.runId : null,
      label: lock && !lock.invalid ? (lock.label ?? null) : null,
      startedAt: lock && !lock.invalid ? (lock.startedAt ?? null) : null,
      status: lock && !lock.invalid ? (lock.status ?? null) : null,
      finishedAt: lock && !lock.invalid ? (lock.finishedAt ?? null) : null,
      archivedAt: lock && !lock.invalid ? (lock.archivedAt ?? null) : null,
      hasReport: Boolean(report),
      reportGeneratedAt: report && !report.invalid ? (report.meta?.generatedAt ?? null) : null,
      verdict: report && !report.invalid ? (report.scorecard?.verdict ?? null) : null,
      entries: readdirSync(full).filter((n) => n !== RUN_LOCK_FILE).length,
    });
  }
  return out;
}
