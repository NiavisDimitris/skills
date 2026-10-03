#!/usr/bin/env node
// Setup check: Node version, the npm packages the scripts need, and Playwright's
// Chromium. Prints what is missing and the exact commands that fix it.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseCli, runMain } from './lib/args.mjs';
import { DEPENDENCIES, SKILL_DIR, isMissingModule } from './lib/deps.mjs';

const HELP = `Check that design-qa's scripts can run here.

Usage:
  node scripts/doctor.mjs [--json] [--quiet]

Checks Node (>= 20), the packages in the skill's package.json (${Object.keys(DEPENDENCIES).join(', ')})
and Playwright's Chromium, then prints the commands that fix anything missing. Validation,
rendering, triage, dismiss and backfill need Node only; capture needs Playwright and Chromium;
diff and figma-fetch need pngjs (and pixelmatch for diff).

Options:
  --json    print the result as JSON
  --quiet   print only problems
  -h, --help

Exit codes: 0 ready · 1 something is missing (the fix is printed)`;

const MIN_NODE = 20;

async function check() {
  const checks = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({ name: 'node', ok: major >= MIN_NODE, detail: `v${process.versions.node}`, fix: major >= MIN_NODE ? null : `Install Node ${MIN_NODE} or newer.` });

  let playwright = null;
  for (const [name, use] of Object.entries(DEPENDENCIES)) {
    try {
      const mod = await import(name);
      if (name === 'playwright') playwright = mod;
      checks.push({ name, ok: true, detail: use, fix: null });
    } catch (err) {
      if (!isMissingModule(err, name)) throw err;
      checks.push({ name, ok: false, detail: `missing — ${use}`, fix: `cd "${SKILL_DIR}" && npm install` });
    }
  }

  if (playwright) {
    let exe = null;
    try {
      exe = playwright.chromium.executablePath();
    } catch {
      exe = null;
    }
    const ok = Boolean(exe && existsSync(exe));
    checks.push({
      name: 'chromium',
      ok,
      detail: ok ? exe : 'Playwright Chromium is not downloaded (about 100 MB, one time)',
      fix: ok ? null : `cd "${SKILL_DIR}" && npx playwright install chromium`,
    });
  } else {
    checks.push({ name: 'chromium', ok: false, detail: 'needs playwright first', fix: `cd "${SKILL_DIR}" && npm install && npx playwright install chromium` });
  }
  return { skillDir: SKILL_DIR, ready: checks.every((c) => c.ok), checks };
}

async function main(argv) {
  const { values } = parseCli(argv, { json: { type: 'boolean' }, quiet: { type: 'boolean' } });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const result = await check();
  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ready ? 0 : 1;
  }
  for (const c of result.checks) {
    if (values.quiet && c.ok) continue;
    process.stdout.write(`${c.ok ? 'OK     ' : 'MISSING'} ${c.name.padEnd(10)} ${c.detail}\n`);
  }
  const fixes = [...new Set(result.checks.filter((c) => !c.ok && c.fix).map((c) => c.fix))];
  if (fixes.length) {
    process.stdout.write(`\nFix (skill folder: ${path.relative(process.cwd(), SKILL_DIR) || '.'}):\n${fixes.map((f) => `  ${f}`).join('\n')}\n`);
  } else if (!values.quiet) {
    process.stdout.write('\nReady.\n');
  }
  return result.ready ? 0 : 1;
}

runMain(import.meta.url, main);
