// Shared CLI plumbing for the design-qa scripts: argument parsing, typed errors
// with exit codes, JSON file IO (atomic, never through a symlink), ledger locks and
// the "run main when executed directly" guard. Zero dependencies; Node >= 20.
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

/** An error that carries the process exit code the CLI should end with. */
export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/** Bad arguments / bad input files: exit code 2. */
export function usageError(message) {
  return new CliError(message, 2);
}

/**
 * Parse argv with node:util parseArgs in strict mode. `--help`/`-h` is always accepted.
 * Parse failures become usage errors (exit 2).
 */
export function parseCli(argv, options, { allowPositionals = false } = {}) {
  try {
    return parseArgs({
      args: argv,
      options: { help: { type: 'boolean', short: 'h' }, ...options },
      allowPositionals,
      strict: true,
    });
  } catch (err) {
    throw usageError(`${err.message}\nRun with --help for usage.`);
  }
}

/**
 * Fold untrusted text to one printable line: every run of whitespace, line breaks
 * (\r, \n, U+0085, U+2028, U+2029) and other control characters becomes one space.
 * Use it on every name, title, path or value interpolated into output an agent reads,
 * so data can never start a line of its own (a fake "Next:" command).
 */
export function oneLine(value) {
  return String(value ?? '')
    .replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .trim();
}

/** Validation issues as indented lines, each path and message folded to one line. */
export function formatIssues(issues, indent = '  ') {
  return issues.map((e) => `${indent}${oneLine(e.path)}: ${oneLine(e.message)}`).join('\n');
}

// Plain decimals only: no blanks, hex, binary, octal, exponents or Infinity.
const DECIMAL_RE = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/;

/** Convert a string flag to a number with range checks (usage error on failure). */
export function toNumber(value, flag, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  const n = DECIMAL_RE.test(text) ? Number(text) : NaN;
  const bad = !Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min || n > max;
  if (bad) {
    const kind = integer ? 'an integer' : 'a number';
    const range = [Number.isFinite(min) ? `>= ${min}` : null, Number.isFinite(max) ? `<= ${max}` : null]
      .filter(Boolean)
      .join(' and ');
    throw usageError(`--${flag}: expected ${kind}${range ? ` ${range}` : ''} (got "${oneLine(value)}")`);
  }
  return n;
}

/** Read and parse a JSON file; missing or malformed files become CliErrors. */
export function readJsonFile(file, label = 'file', exitCode = 2) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const why = err.code === 'ENOENT' ? 'file not found' : err.message;
    throw new CliError(`cannot read ${label} ${file}: ${why}`, exitCode);
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new CliError(`${label} ${file} is not valid JSON: ${err.message}`, exitCode);
  }
}

/** Parse an inline JSON flag value such as --driver '{"action":"hover"}'. */
export function parseJsonArg(text, flag) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw usageError(`--${flag}: not valid JSON (${err.message})`);
  }
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Replace `file` atomically: write a temp file in the same folder, fsync it, rename it
 * over the destination (a crash leaves the old or the new content, never a truncated
 * file). Refuses (CliError, exit 1) a destination that is a symbolic link (a committed
 * qa-reports/design-debt.md -> ~/.zshrc must not be followed) or a directory. An
 * existing file keeps its permission bits.
 */
function writeAtomic(file, data) {
  const dest = path.resolve(file);
  ensureDir(path.dirname(dest));
  let st = null;
  try {
    st = lstatSync(dest);
  } catch (err) {
    if (err.code !== 'ENOENT') throw new CliError(`cannot write ${oneLine(displayPath(dest))}: ${err.message}`, 1);
  }
  if (st?.isSymbolicLink()) {
    throw new CliError(`refusing to write ${oneLine(displayPath(dest))}: it is a symbolic link; replace it with a regular file or choose another path`, 1);
  }
  if (st && !st.isFile()) throw new CliError(`cannot write ${oneLine(displayPath(dest))}: it is ${st.isDirectory() ? 'a directory' : 'not a regular file'}`, 1);
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = openSync(tmp, 'wx', 0o666);
    writeFileSync(fd, data); // the whole string or Buffer (writeSync may write part of it)
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    if (st) chmodSync(tmp, st.mode & 0o7777);
    renameSync(tmp, dest);
  } catch (err) {
    if (fd !== null) closeSync(fd);
    rmSync(tmp, { force: true });
    throw err instanceof CliError ? err : new CliError(`cannot write ${oneLine(displayPath(dest))}: ${err.message}`, 1);
  }
}

export function writeJson(file, data) {
  writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function writeText(file, text) {
  writeAtomic(file, text);
}

/** writeText for any data (a Buffer, such as an encoded PNG): atomic, never through a symlink. */
export function writeFileAtomic(file, data) {
  writeAtomic(file, data);
}

/**
 * Where `file` really is: the nearest existing ancestor (the file itself when it exists)
 * with symbolic links resolved, and the missing rest appended. A symlinked folder on
 * the way is followed, so the result is where a write would land. Errors other than
 * "not there" are thrown when `strict`, else the resolved path is returned as is.
 */
function realPathOf(file, { strict = false } = {}) {
  const abs = path.resolve(file);
  const rest = [];
  for (let current = abs; ; ) {
    try {
      return path.join(realpathSync(current), ...rest);
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
        if (strict) throw err;
        return abs;
      }
      const parent = path.dirname(current);
      if (parent === current) return abs;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Refuse (usage error) an output path taken from a configuration file that does not
 * stay inside `rootDir` (the config file's folder, the repository) once symbolic links
 * are followed: a committed design-qa.config.json must never make a run write a file
 * such as ~/.claude/CLAUDE.md, directly ("../") or through a symlinked folder. Paths
 * the user passes as flags are not checked. `label` names the key, e.g.
 * "config report.debtLog".
 */
export function assertInsideDir(rootDir, file, label) {
  const show = (p) => oneLine(displayPath(p));
  let root;
  let real;
  try {
    root = realPathOf(rootDir, { strict: true });
    real = realPathOf(file, { strict: true });
  } catch (err) {
    throw usageError(`${label}: cannot check where ${show(file)} is: ${oneLine(err.message)}`);
  }
  const outside = (from, to) => {
    const rel = path.relative(from, to);
    return !rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  };
  if (outside(root, real)) {
    const via = outside(path.resolve(rootDir), path.resolve(file)) ? '' : ` (through a symbolic link: really ${show(real)})`;
    throw usageError(
      `${label} points outside the folder of the config file (${show(rootDir)}): ${show(file)}${via}. ` +
        'A path in design-qa.config.json must stay inside that folder; change it, or pass the path as a flag',
    );
  }
}

/**
 * A ledger's JSON and Markdown paths must be two different files, the Markdown one
 * not ending in .json and the JSON one not in .md; otherwise one write would clobber
 * the other (config report.debtLog "x.json", or --log x.md --md x.json). Usage error.
 */
export function checkLedgerPaths(jsonFile, mdFile, what = 'log') {
  const json = path.resolve(jsonFile);
  const md = path.resolve(mdFile);
  const show = (p) => oneLine(displayPath(p));
  if (json.toLowerCase() === md.toLowerCase()) {
    throw usageError(`the ${what}'s JSON and Markdown paths are the same file (${show(json)}): give the Markdown log a .md path`);
  }
  if (/\.json$/i.test(md)) throw usageError(`the ${what}'s Markdown path ${show(md)} ends in .json: give it a .md path (the JSON log sits next to it)`);
  if (/\.md$/i.test(json)) throw usageError(`the ${what}'s JSON path ${show(json)} ends in .md: give it a .json path`);
}

// ---------------------------------------------------------------------------
// Ledger locks

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(sleepCell, 0, 0, ms);

// A lock file that is empty or not JSON (its writer died between creating and filling
// it) is stale after this long, however long staleMs is: filling it takes microseconds.
const UNREADABLE_LOCK_STALE_MS = 2_000;

/** The lock as it is now: { text, info (null when not JSON), mtimeMs, ino }, one open file; null when there is none. */
function readLock(lockFile) {
  let fd;
  try {
    fd = openSync(lockFile, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const { mtimeMs, ino } = fstatSync(fd);
    const text = readFileSync(fd, 'utf8');
    let info = null;
    try {
      info = JSON.parse(text);
    } catch {
      // Empty or half written: judged by age only.
    }
    return { text, info: info && typeof info === 'object' ? info : null, mtimeMs, ino };
  } finally {
    closeSync(fd);
  }
}

/** The same lock file: the same inode, modification time and content (a token is unique). */
const sameLock = (a, b) => Boolean(a && b) && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.text === b.text;

/**
 * Remove `lockFile` only when it is still the lock `isOurs` accepts: it is renamed to a
 * unique name first (atomic: two runs can never both remove it), then checked; a lock
 * that turns out to be another one is put back (unless a new lock was taken in that
 * instant). True when it was removed.
 */
function removeLockIf(lockFile, isOurs) {
  const aside = `${lockFile}.${process.pid}.${randomBytes(4).toString('hex')}.stale`;
  try {
    renameSync(lockFile, aside);
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  let moved = null;
  try {
    moved = readLock(aside);
  } catch {
    // unreadable: treated as not ours
  }
  if (moved && isOurs(moved)) {
    rmSync(aside, { force: true });
    return true;
  }
  try {
    linkSync(aside, lockFile);
  } catch {
    // EEXIST: another run took the lock meanwhile; nothing to restore over it.
  }
  rmSync(aside, { force: true });
  return false;
}

/**
 * Take <lockFile>.break, held by one run while it removes a stale lock (a few system
 * calls). A breaker older than 2 s was left by a run that died meanwhile: it is removed
 * (that very file) and the caller tries again. Returns the token, or null when busy.
 */
function takeBreaker(breaker) {
  const token = randomBytes(8).toString('hex');
  try {
    const fd = openSync(breaker, 'wx', 0o644);
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), token }));
    } finally {
      closeSync(fd);
    }
    return token;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const seen = readLock(breaker);
  if (seen && Date.now() - seen.mtimeMs > UNREADABLE_LOCK_STALE_MS) removeLockIf(breaker, (moved) => sameLock(moved, seen));
  return null;
}

/**
 * Break the stale lock `seen` (as readLock returned it). One run at a time does it (it
 * holds <lockFile>.break meanwhile) and removes the lock only when it is still that very
 * lock (same inode, modification time and content): when several runs judge one lock
 * stale at once, the first removes it and the others find the lock taken since, which
 * they leave alone. True when it was removed; false when it was not that lock any more
 * or another run is breaking it (the caller waits and looks again).
 */
export function stealStaleLock(lockFile, seen) {
  const breaker = `${lockFile}.break`;
  const token = takeBreaker(breaker);
  if (!token) return false;
  try {
    if (!sameLock(readLock(lockFile), seen)) return false;
    return removeLockIf(lockFile, (moved) => sameLock(moved, seen));
  } finally {
    removeLockIf(breaker, (moved) => moved.info?.token === token);
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function acquireLock(file, { timeoutMs, staleMs }) {
  const lockFile = `${file}.lock`;
  ensureDir(path.dirname(lockFile));
  const token = randomBytes(8).toString('hex');
  const body = JSON.stringify({ pid: process.pid, host: os.hostname(), token, at: new Date().toISOString() });
  const deadline = Date.now() + timeoutMs;
  let wait = 10;
  for (;;) {
    try {
      const fd = openSync(lockFile, 'wx', 0o644);
      try {
        writeSync(fd, body);
      } finally {
        closeSync(fd);
      }
      return { lockFile, token };
    } catch (err) {
      if (err.code !== 'EEXIST') throw new CliError(`cannot lock ${oneLine(displayPath(file))}: ${err.message}`, 1);
    }
    let seen;
    try {
      seen = readLock(lockFile);
    } catch (err) {
      throw new CliError(`cannot lock ${oneLine(displayPath(file))}: ${err.message}`, 1);
    }
    if (!seen) continue; // released in between
    const age = Date.now() - seen.mtimeMs;
    const dead = seen.info && seen.info.host === os.hostname() && Number.isInteger(seen.info.pid) && seen.info.pid !== process.pid && !pidAlive(seen.info.pid);
    const unreadable = !seen.info && age > Math.min(staleMs, UNREADABLE_LOCK_STALE_MS);
    if (dead || unreadable || age > staleMs) {
      // Stale: its owner died or never released it. Only that very lock is removed, by one run at a time.
      let removed;
      try {
        removed = stealStaleLock(lockFile, seen);
      } catch (err) {
        throw new CliError(`cannot remove the stale lock ${oneLine(displayPath(lockFile))}: ${err.message}`, 1);
      }
      if (removed) continue; // take it now
      // Another run is breaking it, or took the lock since: wait and look again.
    }
    if (Date.now() >= deadline) {
      throw new CliError(
        `${oneLine(displayPath(file))} is being updated by another design-qa run (lock ${oneLine(displayPath(lockFile))}${seen.info?.pid ? `, pid ${seen.info.pid}` : ''}); try again, or delete the lock file if no other run is active`,
        1,
      );
    }
    sleep(Math.min(wait, Math.max(1, deadline - Date.now())));
    wait = Math.min(wait * 2, 250);
  }
}

function releaseLock({ lockFile, token }) {
  try {
    // Ours only: a run that took the lock over as stale (this run was too slow) keeps its own.
    if (readLock(lockFile)?.info?.token === token) removeLockIf(lockFile, (moved) => moved.info?.token === token);
  } catch {
    // Already gone, or taken over as stale: nothing to release.
  }
}

/**
 * Run fn() while holding an exclusive lock on each file (<file>.lock, created with
 * O_EXCL). Locks are taken in sorted path order (no deadlock between scripts that
 * lock overlapping sets), retried with backoff up to timeoutMs (CliError after), and
 * always released. A lock whose owner process is gone (same host), that is older than
 * staleMs, or that is empty or unreadable for more than 2 s (its writer died before
 * filling it) is stale and removed (stealStaleLock: by one run at a time, and only
 * that very lock, so two runs never both take it over). fn is synchronous; its result
 * is returned.
 */
export function withFileLocks(files, fn, { timeoutMs = 10_000, staleMs = 30_000 } = {}) {
  const unique = [...new Set(files.filter(Boolean).map((f) => path.resolve(f)))].sort();
  const held = [];
  try {
    for (const file of unique) held.push(acquireLock(file, { timeoutMs, staleMs }));
    return fn();
  } finally {
    for (const lock of held.reverse()) releaseLock(lock);
  }
}

/** True when the module at metaUrl is the script node was asked to run. */
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(path.resolve(process.argv[1]));
  } catch {
    return false;
  }
}

/**
 * Run `main(argv)` when the module is executed directly. main returns an exit
 * code (or undefined for 0); thrown CliErrors print "<script>: error: …" to stderr.
 */
export function runMain(metaUrl, main) {
  if (!isMain(metaUrl)) return;
  const name = path.basename(fileURLToPath(metaUrl));
  Promise.resolve()
    .then(() => main(process.argv.slice(2)))
    .then(
      (code) => {
        process.exitCode = typeof code === 'number' ? code : 0;
      },
      (err) => {
        if (err instanceof CliError) {
          console.error(`${name}: error: ${err.message}`);
          process.exitCode = err.exitCode;
        } else {
          console.error(`${name}: unexpected error: ${err && err.stack ? err.stack : err}`);
          process.exitCode = 1;
        }
      },
    );
}

/**
 * Pretty-print a path relative to the working directory when it is inside it (symlinked
 * folders resolved; the file's own name is kept even when it is a link, so a refused
 * link is named, not its target).
 */
export function displayPath(file) {
  const abs = path.resolve(file);
  const rel = path.relative(realPathOf(process.cwd()), path.join(realPathOf(path.dirname(abs)), path.basename(abs)));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
}
