#!/usr/bin/env node
// Setup check: Node version, the npm packages the scripts need, and a real headless
// browser launch as capture.mjs does it. Prints what is missing and the exact commands
// that fix it.
//
// The Node check runs before anything else is loaded: the shared CLI helpers need a
// newer Node (util.parseArgs), so on an old Node a static import would fail before the
// check could say why. Keep this file free of static imports and of newer syntax.

const MIN_NODE = 20;
/** How long a browser launch (and close) may take before the check gives up. */
const LAUNCH_TIMEOUT_MS = 30000;

function nodeMajor() {
  return Number(String(process.versions.node).split('.')[0]);
}

function nodeCheck() {
  const ok = nodeMajor() >= MIN_NODE;
  return { name: 'node', ok, detail: 'v' + process.versions.node, fix: ok ? null : 'Install Node ' + MIN_NODE + ' or newer (https://nodejs.org).' };
}

function help(dependencies) {
  return `Check that design-qa's scripts can run here.

Usage:
  node scripts/doctor.mjs [--json] [--quiet]

Checks Node (>= ${MIN_NODE}), the packages in the skill's package.json (${Object.keys(dependencies).join(', ')})
and that the browser launches the way capture.mjs launches it (headless; Playwright's headless
Chromium shell, or the installed browser named by DESIGN_QA_BROWSER_CHANNEL, e.g. chrome),
then prints the commands that fix anything missing. Validation, rendering, triage, dismiss and
backfill need Node only; capture needs Playwright and a browser; diff and figma-fetch need
pngjs (and pixelmatch for diff).

Options:
  --json    print the result as JSON
  --quiet   print only problems
  -h, --help

Environment: DESIGN_QA_BROWSER_CHANNEL (as capture.mjs).

Exit codes: 0 ready · 1 something is missing (the fix is printed)`;
}

function firstLine(text) {
  return String(text == null ? '' : text).split('\n')[0].trim();
}

/** Resolve with the promise, or reject after ms (onLate cleans up what resolves too late). */
function withTimeout(promise, ms, what, onLate) {
  let timer;
  let timedOut = false;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`${what} did not finish within ${ms / 1000} s`));
    }, ms);
  });
  return Promise.race([
    promise.then((value) => {
      if (timedOut && onLate) onLate(value);
      return value;
    }),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

/**
 * Launch the browser exactly as capture.mjs does (headless: true, the channel from
 * DESIGN_QA_BROWSER_CHANNEL), then close it. Since Playwright 1.49, headless Chromium
 * is the separate chromium-headless-shell download, so checking the full Chromium's
 * executable is not enough.
 */
export async function browserCheck(playwright, { skillDir, env = process.env, timeoutMs = LAUNCH_TIMEOUT_MS } = {}) {
  const channel = env.DESIGN_QA_BROWSER_CHANNEL || undefined;
  const what = channel ? `the "${channel}" browser (DESIGN_QA_BROWSER_CHANNEL)` : "Playwright's headless Chromium";
  const inSkill = (cmd) => `cd "${skillDir}" && ${cmd}`;
  let browser = null;
  try {
    const launching = playwright.chromium.launch({ headless: true, timeout: timeoutMs, ...(channel ? { channel } : {}) });
    // A backstop a little after Playwright's own launch timeout, whose error is clearer.
    browser = await withTimeout(launching, timeoutMs + Math.min(5000, timeoutMs), `launching ${what}`, (late) => late.close().catch(() => {}));
    const version = browser.version();
    await withTimeout(browser.close(), timeoutMs, `closing ${what}`);
    return { name: 'chromium', ok: true, detail: `${what} launches (${version})`, fix: null };
  } catch (err) {
    if (browser) browser.close().catch(() => {});
    const message = firstLine(err && err.message);
    let fix;
    if (/missing (system )?dependencies|install-deps/i.test(String(err && err.message))) {
      fix = inSkill(`npx playwright install-deps chromium${channel ? '' : ' && npx playwright install chromium'}`);
    } else if (channel && /unsupported .*channel/i.test(message)) {
      fix = `set DESIGN_QA_BROWSER_CHANNEL to a Playwright channel such as chrome or msedge, or unset it and use Playwright's Chromium: ${inSkill('npx playwright install chromium')}`;
    } else if (channel) {
      fix = inSkill(`npx playwright install ${channel}`) + ` (or install ${channel} yourself, or unset DESIGN_QA_BROWSER_CHANNEL to use Playwright's Chromium)`;
    } else {
      fix = inSkill('npx playwright install chromium') + ' (about 100 MB, one time; `npx playwright install --only-shell chromium` downloads only the headless shell capture uses)';
    }
    return { name: 'chromium', ok: false, detail: `${what} does not launch: ${message}`, fix };
  }
}

async function check() {
  const { DEPENDENCIES, SKILL_DIR, isMissingModule } = await import('./lib/deps.mjs');
  const checks = [nodeCheck()];
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
    checks.push(await browserCheck(playwright, { skillDir: SKILL_DIR }));
  } else {
    checks.push({ name: 'chromium', ok: false, detail: 'needs playwright first', fix: `cd "${SKILL_DIR}" && npm install && npx playwright install chromium` });
  }
  return { skillDir: SKILL_DIR, ready: checks.every((c) => c.ok), checks };
}

async function main(argv) {
  const { parseCli } = await import('./lib/args.mjs');
  const { DEPENDENCIES } = await import('./lib/deps.mjs');
  const { values } = parseCli(argv, { json: { type: 'boolean' }, quiet: { type: 'boolean' } });
  if (values.help) {
    console.log(help(DEPENDENCIES));
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
    process.stdout.write(`\nFix (skill folder: ${result.skillDir}):\n${fixes.map((f) => `  ${f}`).join('\n')}\n`);
  } else if (!values.quiet) {
    process.stdout.write('\nReady.\n');
  }
  return result.ready ? 0 : 1;
}

/** Too old a Node: say so (and how to fix it) without loading the helpers that need a newer one. */
function reportOldNode() {
  const c = nodeCheck();
  if (process.argv.indexOf('--json') !== -1) {
    process.stdout.write(JSON.stringify({ skillDir: null, ready: false, checks: [c] }, null, 2) + '\n');
  } else {
    process.stdout.write('MISSING node       ' + c.detail + ' (design-qa needs Node ' + MIN_NODE + ' or newer)\n\nFix:\n  ' + c.fix + '\n');
  }
  process.exitCode = 1;
}

if (nodeMajor() < MIN_NODE) {
  reportOldNode();
} else {
  import('./lib/args.mjs').then(
    (args) => args.runMain(import.meta.url, main),
    (err) => {
      process.stderr.write('doctor.mjs: cannot load its helpers: ' + (err && err.message) + '\n');
      process.exitCode = 1;
    },
  );
}
