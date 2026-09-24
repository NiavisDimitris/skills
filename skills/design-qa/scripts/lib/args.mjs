// Shared CLI plumbing for the design-qa scripts: argument parsing, typed errors
// with exit codes, JSON file IO and the "run main when executed directly" guard.
// Zero dependencies; Node >= 18.
import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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

/** Convert a string flag to a number with range checks (usage error on failure). */
export function toNumber(value, flag, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  const bad = value === '' || !Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min || n > max;
  if (bad) {
    const kind = integer ? 'an integer' : 'a number';
    const range = [Number.isFinite(min) ? `>= ${min}` : null, Number.isFinite(max) ? `<= ${max}` : null]
      .filter(Boolean)
      .join(' and ');
    throw usageError(`--${flag}: expected ${kind}${range ? ` ${range}` : ''} (got "${value}")`);
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

export function writeJson(file, data) {
  ensureDir(path.dirname(file));
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function writeText(file, text) {
  ensureDir(path.dirname(file));
  writeFileSync(file, text);
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

function realPath(p) {
  try {
    return realpathSync(p);
  } catch {
    try {
      return path.join(realpathSync(path.dirname(p)), path.basename(p));
    } catch {
      return p;
    }
  }
}

/** Pretty-print a path relative to the working directory when it is inside it (symlinks resolved). */
export function displayPath(file) {
  const rel = path.relative(realPath(process.cwd()), realPath(path.resolve(file)));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
}
