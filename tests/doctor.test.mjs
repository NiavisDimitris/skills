import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { browserCheck } from '../skills/design-qa/scripts/doctor.mjs';
import { run, script } from './_helpers.mjs';

const DOCTOR = script('doctor.mjs');
const SKILL_DIR = '/skill dir';

/** A stand-in for the playwright module: records launch options, resolves or rejects as told. */
function fakePlaywright({ launch }) {
  const calls = [];
  return {
    calls,
    chromium: {
      launch: (options) => {
        calls.push(options);
        return launch(options);
      },
    },
  };
}

function fakeBrowser() {
  const browser = { closed: 0, version: () => '131.0.6778.33', close: async () => void (browser.closed += 1) };
  return browser;
}

test('browserCheck launches headless as capture.mjs does, then closes the browser', async () => {
  const browser = fakeBrowser();
  const pw = fakePlaywright({ launch: async () => browser });
  const c = await browserCheck(pw, { skillDir: SKILL_DIR, env: {} });
  assert.deepEqual(c, { name: 'chromium', ok: true, detail: "Playwright's headless Chromium launches (131.0.6778.33)", fix: null });
  assert.equal(pw.calls.length, 1);
  assert.equal(pw.calls[0].headless, true);
  assert.equal('channel' in pw.calls[0], false);
  assert.equal(browser.closed, 1);

  const chrome = fakePlaywright({ launch: async () => fakeBrowser() });
  const viaChannel = await browserCheck(chrome, { skillDir: SKILL_DIR, env: { DESIGN_QA_BROWSER_CHANNEL: 'chrome' } });
  assert.equal(viaChannel.ok, true);
  assert.equal(chrome.calls[0].channel, 'chrome', 'DESIGN_QA_BROWSER_CHANNEL is honoured');
});

test('browserCheck: a missing headless shell is reported with the launch error and the install command', async () => {
  const pw = fakePlaywright({
    launch: async () => {
      throw new Error("browserType.launch: Executable doesn't exist at /cache/chromium_headless_shell-1155/chrome-headless-shell\n╔═══╗ run npx playwright install");
    },
  });
  const c = await browserCheck(pw, { skillDir: SKILL_DIR, env: {} });
  assert.equal(c.ok, false);
  assert.equal(c.detail, "Playwright's headless Chromium does not launch: browserType.launch: Executable doesn't exist at /cache/chromium_headless_shell-1155/chrome-headless-shell");
  assert.ok(c.fix.startsWith(`cd "${SKILL_DIR}" && npx playwright install chromium`), c.fix);
  assert.match(c.fix, /npx playwright install --only-shell chromium/);

  const channel = fakePlaywright({ launch: async () => Promise.reject(new Error('browserType.launch: Chromium distribution \'chrome\' is not found')) });
  const viaChannel = await browserCheck(channel, { skillDir: SKILL_DIR, env: { DESIGN_QA_BROWSER_CHANNEL: 'chrome' } });
  assert.equal(viaChannel.ok, false);
  assert.match(viaChannel.detail, /^the "chrome" browser \(DESIGN_QA_BROWSER_CHANNEL\) does not launch: /);
  assert.match(viaChannel.fix, /npx playwright install chrome .*unset DESIGN_QA_BROWSER_CHANNEL/);

  const deps = fakePlaywright({ launch: async () => Promise.reject(new Error('browserType.launch: Host system is missing dependencies to run browsers.')) });
  assert.match((await browserCheck(deps, { skillDir: SKILL_DIR, env: {} })).fix, /npx playwright install-deps chromium/);
});

test('browserCheck: a launch that hangs times out, and a late browser is closed', async () => {
  const browser = fakeBrowser();
  let resolveLate;
  const pw = fakePlaywright({ launch: () => new Promise((resolve) => (resolveLate = resolve)) });
  const c = await browserCheck(pw, { skillDir: SKILL_DIR, env: {}, timeoutMs: 20 });
  assert.equal(c.ok, false);
  assert.match(c.detail, /did not finish within/);
  assert.equal(pw.calls[0].timeout, 20, "Playwright's own launch timeout is set too");
  resolveLate(browser);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(browser.closed, 1);
});

test('doctor checks the Node version before loading anything that needs a newer Node', async () => {
  const src = readFileSync(DOCTOR, 'utf8');
  assert.doesNotMatch(src, /^import\s/m, 'no static imports: args.mjs needs util.parseArgs');
  const oldNode = '--import=data:text/javascript,Object.defineProperty(process,"versions",{value:{...process.versions,node:"16.20.2"}})';
  const res = await run(oldNode, [DOCTOR]);
  assert.equal(res.code, 1, res.stderr);
  assert.match(res.stdout, /MISSING node {7}v16\.20\.2 \(design-qa needs Node 20 or newer\)/);
  assert.match(res.stdout, /Install Node 20 or newer/);
  const json = await run(oldNode, [DOCTOR, '--json']);
  assert.equal(json.code, 1);
  assert.deepEqual(JSON.parse(json.stdout).checks.map((c) => [c.name, c.ok]), [['node', false]]);
});

test('doctor honours DESIGN_QA_BROWSER_CHANNEL: an unknown channel is reported, not a downloaded Chromium', async () => {
  const res = await run(DOCTOR, ['--json'], { env: { DESIGN_QA_BROWSER_CHANNEL: 'no-such-channel' } });
  const out = JSON.parse(res.stdout);
  const chromium = out.checks.find((c) => c.name === 'chromium');
  assert.equal(res.code, 1);
  assert.equal(chromium.ok, false);
  if (out.checks.find((c) => c.name === 'playwright').ok) {
    assert.match(chromium.detail, /"no-such-channel"/);
    assert.match(chromium.fix, /set DESIGN_QA_BROWSER_CHANNEL to a Playwright channel/);
  }
});
