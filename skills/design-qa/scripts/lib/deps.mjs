// Third-party packages the scripts need (pngjs, pixelmatch, playwright), loaded with a
// message that names the folder to run `npm install` in when one is missing.
// The skill folder holds its own package.json and package-lock.json, so the same
// command works for a plugin install, a plain copy of the folder and this repo.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The skill folder (where package.json lives), resolved from this file. */
export const SKILL_DIR = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** Packages the scripts import, and what they are for. */
export const DEPENDENCIES = Object.freeze({
  pngjs: 'read and write PNGs (capture, diff, figma-fetch)',
  pixelmatch: 'pixel diff (diff.mjs)',
  playwright: 'browser capture (capture.mjs)',
});

function firstLine(text) {
  return String(text ?? '').split('\n')[0].trim();
}

export function isMissingModule(err, name) {
  const code = err?.code;
  return (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') && String(err?.message ?? '').includes(name);
}

/** The install hint for a missing package. */
export function missingDependencyMessage(name, err) {
  const why = err ? ` (${firstLine(err.message)})` : '';
  const browser = name === 'playwright' ? ', then `npx playwright install chromium` in the same folder' : '';
  return `${name} is not installed${why}. Run \`npm install\` in ${SKILL_DIR}${browser}. \`node ${path.join(SKILL_DIR, 'scripts', 'doctor.mjs')}\` checks everything.`;
}

/**
 * Import a package. When it is missing, print the install hint and exit 4 — this runs at
 * module load in CLI scripts, before any error handler exists. Other errors are rethrown.
 */
export async function importDependency(name) {
  try {
    return await import(name);
  } catch (err) {
    if (!isMissingModule(err, name)) throw err;
    process.stderr.write(`design-qa: ${missingDependencyMessage(name, err)}\n`);
    process.exit(4);
  }
}
