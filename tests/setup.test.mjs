// scripts/setup.mjs: the onboarding preflight (check), answers into the config (apply)
// and the path safety and no-screen path of save-session. Browser-backed probes and a
// real save-session run are in setup-probe.test.mjs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ANSWER_WRITES,
  ASKABLE_IDS,
  DS_DEFAULT_SELECTOR,
  exportLine,
  MAX_QUESTIONS,
  KNOWN_LIBRARIES,
  buildQuestions,
  discoverRepo,
  expandUserPath,
  hasDisplay,
  looksSecret,
  storageStateFromConfig,
  tildePath,
} from '../skills/design-qa/scripts/lib/setup.mjs';
import { fixture, run, script, tmpDir } from './_helpers.mjs';

const SETUP = script('setup.mjs');
const VALIDATE = script('validate.mjs');
/** Variables from the developer's or CI's environment that would change the answers. */
const CLEAN_ENV = {
  FIGMA_TOKEN: '',
  JIRA_BASE_URL: '',
  JIRA_EMAIL: '',
  JIRA_API_TOKEN: '',
  DESIGN_QA_APP_STORAGE_STATE: '',
  CI: '',
  SSH_CONNECTION: '',
  SSH_CLIENT: '',
  SSH_TTY: '',
  DESIGN_QA_NO_DISPLAY: '',
};
const ENV_SECRET = 'figd_DoNotLeakThis1234567890abcdef';
const COOKIE_SECRET = 'sessionid=Zx81KqLmNop0987654321; csrftoken=abcdEFGH12345678';

const setup = (args, { cwd, env = {} } = {}) => run(SETUP, args, { cwd, env: { ...CLEAN_ENV, ...env } });
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** A copy of tests/fixtures/setup-repo, with .env files (git ignores .env* in this repo) and a node_modules trap. */
function fixtureRepo() {
  const dir = tmpDir('design-qa-setup-');
  cpSync(fixture('setup-repo'), dir, { recursive: true });
  writeFileSync(path.join(dir, '.env.local'), `FIGMA_TOKEN=${ENV_SECRET}\nJIRA_API_TOKEN="${COOKIE_SECRET}"\nexport PORT=4000\n# COMMENTED=1\n`);
  writeFileSync(path.join(dir, '.env.example'), 'FIGMA_TOKEN=\nAPP_URL=\n');
  mkdirSync(path.join(dir, 'node_modules', 'some-lib'), { recursive: true });
  writeFileSync(path.join(dir, 'node_modules', 'some-lib', 'tokens.json'), '{}');
  return dir;
}

const BANNED = /\b(surface|token map|storage state|storageState|preCapture|MCP)\b/i;

/** Every question is well-formed and in plain words. */
function assertWellFormed(questions) {
  const ids = new Set();
  for (const q of questions) {
    assert.ok(!ids.has(q.id), `duplicate id ${q.id}`);
    ids.add(q.id);
    assert.equal(q.writes, ANSWER_WRITES[q.id], `${q.id}: writes`);
    assert.ok(q.title.length >= 1 && q.title.length <= 12, `${q.id}: title "${q.title}" is ${q.title.length} chars`);
    assert.match(q.question, /^[A-Z][^?]*\?$/, `${q.id}: one question ending in "?"`);
    assert.doesNotMatch(q.question.slice(0, -1), /[.!?]\s/, `${q.id}: one sentence`);
    assert.match(q.why, /^[A-Z].*\.$/, `${q.id}: why is a sentence`);
    assert.doesNotMatch(q.why.slice(0, -1), /[.!?]\s+[A-Z]/, `${q.id}: why is one sentence`);
    assert.ok(['choice', 'multi', 'text'].includes(q.kind), q.id);
    assert.ok(q.options.length >= 2 && q.options.length <= 4, `${q.id}: ${q.options.length} options`);
    for (const o of q.options) {
      const words = o.label.trim().split(/\s+/).length;
      assert.ok(words >= 1 && words <= 5, `${q.id}: label "${o.label}" has ${words} words`);
      assert.ok(typeof o.description === 'string' && o.description.length > 3, `${q.id}: ${o.label} needs a description`);
      assert.ok(o.value !== undefined && o.value !== '', `${q.id}: ${o.label} needs a value`);
      assert.doesNotMatch(o.label, BANNED, `${q.id}: label in plain words`);
    }
    assert.equal(typeof q.required, 'boolean', q.id);
    for (const text of [q.title, q.question, q.why]) assert.doesNotMatch(text, BANNED, `${q.id}: "${text}" uses internal words`);
  }
}

test('check on an empty repository: few questions, the rest assumed or deferred; every question well-formed and in plain words', async () => {
  const dir = tmpDir('design-qa-setup-empty-');
  const res = await setup(['check', '--quick', '--json'], { cwd: dir });
  assert.equal(res.code, 1, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(Object.keys(out), ['ready', 'checks', 'questions', 'assumed', 'deferred', 'agentChecks', 'next'], 'the compact form by default');
  assert.equal(out.ready, false);
  assert.deepEqual(out.questions.map((q) => q.id), ['app-url', 'ds-components']);
  assertWellFormed(out.questions);
  assert.deepEqual(out.questions.filter((q) => q.required).map((q) => q.id), ['app-url'], 'only the app address blocks a pass here');
  assert.deepEqual(out.assumed.map((a) => [a.id, a.value]), [['ds-tokens', 'page'], ['reports', 'no']]);
  for (const a of out.assumed) assert.equal(a.writes, ANSWER_WRITES[a.id]);
  assert.deepEqual(out.deferred.map((d) => d.id), ['app-start', 'ds-figma', 'hide', 'figma-access', 'ticket-tool']);
  assert.match(out.deferred.find((d) => d.id === 'hide').when, /--ask hide/);
  assert.deepEqual(out.checks.map((c) => [c.id, c.blocking]), [['config', false], ['app-url', true]], 'failing rows only');
  assert.deepEqual(out.agentChecks.map((a) => a.id), ['figma-mcp', 'ticket-mcp']);
  assert.deepEqual(out.next.map((n) => n.replace(/^node \S*scripts\//, 'node scripts/')), ['node scripts/setup.mjs apply --accept-assumed --answers <answers.json>', 'node scripts/setup.mjs check (again, until ready)']);
  assert.ok(!existsSync(path.join(dir, 'design-qa.config.json')), 'check writes nothing');

  // --full: every row and the discovery.
  const full = JSON.parse((await setup(['check', '--quick', '--json', '--full'], { cwd: dir })).stdout);
  const ids = full.checks.map((c) => c.id);
  for (const id of ['tools:node', 'tools:playwright', 'config', 'app-url', 'app-reachable']) assert.ok(ids.includes(id), id);
  assert.equal(full.checks.find((c) => c.id === 'app-reachable').ok, null, '--quick does not probe');
  assert.ok(full.discovered);

  // Every question the script can emit, asked explicitly, is well-formed.
  const every = JSON.parse((await setup(['check', '--quick', '--json', ...ASKABLE_IDS.flatMap((id) => ['--ask', id])], { cwd: dir })).stdout);
  assert.deepEqual(every.questions.map((q) => q.id).sort(), ASKABLE_IDS.filter((id) => id !== 'ds-files').sort(), 'ds-files has nothing to offer here');
  assertWellFormed(every.questions);
  assert.equal(every.assumed.length, 0, 'an id asked explicitly is not assumed');
  const bad = await setup(['check', '--quick', '--ask', 'nope'], { cwd: dir });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--ask: unknown question "nope"/);
  const badAgent = await setup(['check', '--quick', '--agent', 'figma=maybe'], { cwd: dir });
  assert.equal(badAgent.code, 2);
  assert.match(badAgent.stderr, /--agent: expected figma-mcp=yes\|no/);

  // Human output: failing rows, what was assumed, the questions with lettered options, what waits.
  const human = await setup(['check', '--quick'], { cwd: dir });
  assert.match(human.stdout, /^design-qa setup: not ready \(1 required question\)/);
  assert.match(human.stdout, /I set these up from your project \(tell me if any is wrong\):\n {2}- Style values: read from the page/);
  assert.match(human.stdout, /1\. App address: Where does the app run that I should check\? \(required\)\n {5}a\) localhost:3000/);
  assert.match(human.stdout, /Not asked now \(only when needed\):\n {2}- Start app: when the app on this computer does not answer/);
  assert.doesNotMatch(human.stdout, /OK {5}tools:node/, 'passing rows only with --full');
});

test('first run on a real project: at most 4 questions, the rest assumed; after apply --accept-assumed a second check asks nothing', async () => {
  const dir = fixtureRepo();
  const res = await setup(['check', '--quick', '--json'], { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.ok(res.stdout.length < 6000, `compact JSON is ${res.stdout.length} bytes`);
  assert.ok(out.questions.length <= MAX_QUESTIONS);
  assert.deepEqual(out.questions.map((q) => q.id), ['ds-tokens', 'ds-components'], 'two token files and three libraries: real choices');
  assertWellFormed(out.questions);
  const q = Object.fromEntries(out.questions.map((x) => [x.id, x]));
  assert.deepEqual(q['ds-tokens'].default, ['src/styles/tokens.json', 'src/styles/global.css']);
  assert.deepEqual(q['ds-components'].default, ['@acme/ui', '@mui/material', '@radix-ui']);
  assert.equal(q['ds-components'].options[2].description, 'A third-party library (@radix-ui/react-dialog and 1 more)');
  assert.deepEqual(Object.fromEntries(out.assumed.map((a) => [a.id, a.value])), {
    'app-url': 'http://localhost:5173',
    'app-start': 'npm run dev',
    'ds-name': 'Acme UI',
    'ds-files': ['design.md', 'design-qa/components.json'],
    reports: 'no',
    'ds-figma': 'https://www.figma.com/design/AbCdEfGhIjKlMnOp/Acme-Library?node-id=0-1',
  });
  assert.equal(out.checks.find((c) => c.id === 'app-url').detail, 'not saved yet; assumed http://localhost:5173');

  // The questions answered, the assumptions accepted, in one call.
  const answers = writeAnswers(dir, { 'ds-tokens': ['src/styles/tokens.json'], 'ds-components': ['@acme/ui', '@mui/material'] });
  const applied = await setup(['apply', '--accept-assumed', '--answers', answers], { cwd: dir });
  assert.equal(applied.code, 0, applied.stderr);
  const config = readJson(path.join(dir, 'design-qa.config.json'));
  assert.equal(config.app.baseUrl, 'http://localhost:5173');
  assert.equal(config.app.start, 'npm run dev');
  assert.equal(config.designSystem.name, 'Acme UI');
  assert.equal(config.designSystem.designRules, 'design.md');
  assert.equal(config.designSystem.componentCatalog, 'design-qa/components.json');
  assert.equal(config.designSystem.figmaLibrary, 'https://www.figma.com/design/AbCdEfGhIjKlMnOp/Acme-Library?node-id=0-1');
  assert.deepEqual(config.designSystem.tokens, ['src/styles/tokens.json']);
  assert.equal(config.report.commit, false);

  const second = JSON.parse((await setup(['check', '--quick', '--json'], { cwd: dir })).stdout);
  assert.deepEqual(second.questions, []);
  assert.deepEqual(second.assumed, []);
  assert.equal(second.ready, true);
  assert.deepEqual(second.deferred.map((d) => d.id), ['hide', 'figma-access', 'ticket-tool'], 'deferred never blocks ready');

  // The person corrects an assumption: asked again on request, and the explicit answer wins.
  const ask = JSON.parse((await setup(['check', '--quick', '--json', '--ask', 'ds-name'], { cwd: dir })).stdout);
  assert.deepEqual(ask.questions.map((x) => x.id), ['ds-name']);
  const fix = await setup(['apply', '--accept-assumed', '--answers', writeAnswers(dir, { 'ds-name': 'Acme Design' })], { cwd: dir });
  assert.match(fix.stdout, /designSystem\.name: "Acme UI" → "Acme Design"/);
});

test('deferred questions appear only with their trigger', async () => {
  const dir = fixtureRepo();
  writeFileSync(path.join(dir, 'design-qa.config.json'), JSON.stringify({ app: { baseUrl: 'http://localhost:5173' }, surfaces: {}, designSystem: { tokens: [], libraries: [] }, report: { commit: false } }));
  const ids = async (...args) => JSON.parse((await setup(['check', '--quick', '--json', ...args], { cwd: dir })).stdout).questions.map((q) => q.id);
  assert.deepEqual(await ids(), []);
  // A ticket key: the provider is assumed from the JIRA_ name in .env.local; the site and access are asked.
  const ticket = JSON.parse((await setup(['check', '--quick', '--json', '--ticket'], { cwd: dir })).stdout);
  assert.deepEqual(ticket.assumed.map((a) => [a.id, a.value]).filter(([id]) => id.startsWith('ticket')), [['ticket-tool', 'jira']]);
  assert.deepEqual(ticket.questions.map((q) => q.id), ['ticket-site', 'ticket-token']);
  assert.equal(ticket.questions[1].unless, 'ticket-mcp');
  assert.deepEqual(await ids('--ticket', '--agent', 'ticket-mcp=yes'), ['ticket-site']);
  // A key after --ticket (as an agent may write it) is accepted and ignored.
  assert.deepEqual(await ids('--ticket', 'ABC-123', '--agent', 'ticket-mcp=yes'), ['ticket-site']);
  // Figma: only when the design is in Figma and the agent has no Figma tools.
  assert.deepEqual(await ids('--figma'), [], 'the agent has not said whether it has Figma tools');
  assert.deepEqual(await ids('--figma', '--agent', 'figma-mcp=yes'), []);
  const figma = JSON.parse((await setup(['check', '--quick', '--json', '--figma', '--agent', 'figma-mcp=no'], { cwd: dir })).stdout).questions;
  assert.deepEqual(figma.map((q) => q.id), ['figma-access', 'figma-token']);
  assert.deepEqual(figma[1].dependsOn, { id: 'figma-access', values: ['token'] });
  assert.deepEqual(await ids('--figma', '--agent', 'figma-mcp=no'), ['figma-access', 'figma-token'], JSON.stringify(figma));
  // Things to hide: only on request.
  assert.deepEqual(await ids('--ask', 'hide'), ['hide']);
  // The library link: the docs hold one, so it is assumed even for backfill.
  const backfill = JSON.parse((await setup(['check', '--quick', '--json', '--backfill'], { cwd: dir })).stdout);
  assert.ok(backfill.assumed.some((a) => a.id === 'ds-figma'));
  // None of them blocks a pass.
  const res = await setup(['check', '--quick', '--json', '--ticket', '--figma', '--agent', 'figma-mcp=no', '--ask', 'hide'], { cwd: dir });
  assert.equal(JSON.parse(res.stdout).ready, true);
  assert.equal(res.code, 0);
  // The start command is asked when a local app does not answer and none is known.
  const discovered = discoverRepo(tmpDir('design-qa-setup-down-'), { env: {} });
  const down = buildQuestions({ config: { app: { baseUrl: 'http://localhost:4321' } }, discovered, probe: { state: 'unreachable' }, env: {}, agent: {} });
  assert.deepEqual(down.questions.map((q) => q.id), ['app-start', 'ds-components']);
});

test('check on a fully configured repository: no questions, nothing assumed, ready (and --ci agrees)', async () => {
  const dir = fixtureRepo();
  const config = {
    app: { baseUrl: 'http://localhost:5173', start: 'npm run dev', auth: { type: 'none' }, preCapture: {} },
    surfaces: { home: { route: '/' } },
    designSystem: {
      name: 'Acme UI',
      figmaLibrary: null,
      tokens: ['src/styles/tokens.json'],
      libraries: [{ name: 'Acme UI', kind: 'design-system', selector: '[data-acme]', package: '@acme/ui' }],
      componentCatalog: 'design-qa/components.json',
      designRules: 'design.md',
      knownDrifts: null,
      tokenMap: null,
    },
    report: { outDir: 'qa-reports', commit: false },
    ticket: { provider: 'none' },
    figma: { access: ['mcp', 'rest'] },
  };
  writeFileSync(path.join(dir, 'design-qa.config.json'), JSON.stringify(config, null, 2));
  const res = await setup(['check', '--quick', '--json', '--full', '--agent', 'figma-mcp=yes', '--ticket', '--figma', '--backfill'], { cwd: dir });
  assert.equal(res.code, 0, res.stdout);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.questions, []);
  assert.deepEqual(out.assumed, []);
  assert.deepEqual(out.deferred, []);
  assert.equal(out.ready, true);
  const byId = Object.fromEntries(out.checks.map((c) => [c.id, c]));
  assert.equal(byId.config.ok, true);
  assert.equal(byId['ds-catalog'].ok, true);
  assert.equal(byId['ds-tokens:1'].ok, true);
  assert.equal(byId.hide.detail, 'nothing hidden before capture');
  assert.equal(byId.figma.ok, true);
  const compact = JSON.parse((await setup(['check', '--quick', '--json', '--agent', 'figma-mcp=yes'], { cwd: dir })).stdout);
  assert.deepEqual([compact.checks, compact.questions, compact.assumed, compact.next], [[], [], [], []]);

  const human = await setup(['check', '--quick', '--agent', 'figma-mcp=yes'], { cwd: dir });
  assert.match(human.stdout, /^design-qa setup: ready\n/);
  assert.doesNotMatch(human.stdout, /Questions|I set these up/);
  const ci = await setup(['check', '--quick', '--ci'], { cwd: dir });
  assert.equal(ci.code, 0, ci.stderr);

  // A file the config names that is missing is a warning with the fix, not a blocker.
  writeFileSync(path.join(dir, 'design-qa.config.json'), JSON.stringify({ ...config, designSystem: { ...config.designSystem, knownDrifts: 'design-qa/known-drifts.md' } }));
  const drifts = JSON.parse((await setup(['check', '--quick', '--json', '--agent', 'figma-mcp=yes'], { cwd: dir })).stdout);
  const row = drifts.checks.find((c) => c.id === 'ds-drifts');
  assert.equal(row.blocking, false);
  assert.match(row.fix, /known-drifts\.template\.md to design-qa\/known-drifts\.md/);
  assert.equal(drifts.ready, true);
});

test('discovery: package.json, token files, design docs and .env names; .env values never appear', async () => {
  const dir = fixtureRepo();
  const d = discoverRepo(dir, { env: {} });
  assert.equal(d.packageManager, 'npm');
  assert.equal(d.devCommand, 'npm run dev');
  assert.equal(d.port, 5173, 'vite');
  assert.equal(d.appUrl, 'http://localhost:5173');
  assert.deepEqual(d.libraries.map((l) => [l.id, l.name, l.kind, l.package, l.classPrefix ?? l.selector]), [
    ['@acme/ui', 'Acme UI', 'design-system', '@acme/ui', DS_DEFAULT_SELECTOR],
    ['@mui/material', 'MUI', 'third-party', '@mui/material', 'Mui'],
    ['@radix-ui', 'Radix UI', 'third-party', ['@radix-ui/react-dialog', '@radix-ui/react-popover'], KNOWN_LIBRARIES.find((l) => l.name === 'Radix UI').selector],
  ]);
  for (const lib of KNOWN_LIBRARIES) assert.ok(lib.classPrefix || lib.selector, `${lib.name}: the audit needs a classPrefix or a selector`);
  assert.equal(d.tailwind, true);
  assert.deepEqual(d.tokenFiles, [
    { path: 'src/styles/tokens.json', kind: 'tokens' },
    { path: 'src/styles/global.css', kind: 'css-variables' },
  ]);
  assert.deepEqual(d.themeSources, [{ path: 'tailwind.config.js', kind: 'tailwind' }], 'JS themes are exported to JSON first, not offered');
  assert.ok(!d.tokenFiles.some((t) => t.path.includes('node_modules')), 'never inside node_modules');
  assert.deepEqual(d.designDocs, ['design.md']);
  assert.deepEqual(d.overlay, { componentCatalog: 'design-qa/components.json', tokenMap: null, knownDrifts: null }, 'an empty file is not offered');
  assert.deepEqual(d.figmaLinks, ['https://www.figma.com/design/AbCdEfGhIjKlMnOp/Acme-Library?node-id=0-1']);
  assert.deepEqual(d.envFiles, ['.env.example', '.env.local']);
  assert.deepEqual(d.envNames, ['APP_URL', 'FIGMA_TOKEN', 'JIRA_API_TOKEN', 'PORT']);
  assert.equal(d.ticketProvider, 'jira', 'a JIRA_ variable name');

  const res = await setup(['check', '--quick', '--json', '--full'], { cwd: dir });
  const out = JSON.parse(res.stdout);
  const figma = out.checks.find((c) => c.id === 'figma');
  assert.match(figma.detail, /named in \.env\.example, \.env\.local, which the agent never reads/);
  const theme = out.checks.find((c) => c.id === 'ds-theme');
  assert.deepEqual([theme.ok, theme.blocking], [null, false]);
  assert.match(theme.detail, /tailwind\.config\.js/);

  const compact = await setup(['check', '--quick', '--json', '--ticket', '--figma', '--agent', 'figma-mcp=no'], { cwd: dir });
  const human = await setup(['check', '--quick', '--full'], { cwd: dir });
  for (const text of [res.stdout, res.stderr, compact.stdout, human.stdout, human.stderr]) {
    assert.ok(!text.includes(ENV_SECRET) && !text.includes('Zx81KqLmNop') && !text.includes('4000'), 'no .env value in any output');
  }
});

test('check --ci never asks: it exits 1 and names each missing required input', async () => {
  const empty = tmpDir('design-qa-setup-ci-');
  const res = await setup(['check', '--quick', '--ci', '--json', '--full'], { cwd: empty });
  assert.equal(res.code, 1);
  const out = JSON.parse(res.stdout);
  assert.deepEqual([out.questions, out.assumed], [[], []]);
  assert.deepEqual(out.missing.map((m) => m.split(':')[0]), ['app-url']);
  assert.match(res.stderr, /not ready for a ci run; missing:\n {2}- app-url: no app address yet/);

  // A project whose dev port is known still needs the address in ci: nothing is assumed there.
  const repo = fixtureRepo();
  const ciRepo = await setup(['check', '--quick', '--ci', '--json'], { cwd: repo });
  assert.equal(ciRepo.code, 1);
  assert.deepEqual(JSON.parse(ciRepo.stdout).assumed, []);

  // An invalid config blocks too, with the keys named.
  writeFileSync(path.join(empty, 'design-qa.config.json'), JSON.stringify({ app: { baseUrl: 'localhost:3000' }, surfaces: {} }));
  const invalid = await setup(['check', '--quick', '--ci'], { cwd: empty });
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /config: design-qa\.config\.json is invalid: app\.baseUrl/);

  // --url is enough for a ci pass without a config.
  rmConfig(empty);
  const withUrl = await setup(['check', '--quick', '--ci', '--url', 'https://preview.example.com'], { cwd: empty });
  assert.equal(withUrl.code, 0, withUrl.stderr);
});

function rmConfig(dir) {
  execFileSync('rm', ['-f', path.join(dir, 'design-qa.config.json')]);
}

function writeAnswers(dir, answers) {
  const file = path.join(dir, `answers-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(answers));
  return file;
}

test('apply creates the config from the answers, validates it and prints what changed', async () => {
  const dir = fixtureRepo();
  const answers = writeAnswers(dir, {
    'app-url': 'http://localhost:5173/',
    'app-start': 'npm run dev',
    'ds-tokens': ['src/styles/tokens.json', 'page'],
    'ds-components': ['@acme/ui', '@mui/material', 'Chakra UI', { name: 'Old kit', kind: 'legacy', classPrefix: 'ok-' }],
    hide: { localStorage: { 'acme:promo-dismissed': '1' }, remove: ['[data-testid=promo-banner]'] },
    'figma-access': 'token',
    'ds-name': 'Acme UI',
    'ds-files': ['design.md'],
    'ds-figma': 'none',
    'ticket-tool': 'jira',
    'ticket-site': 'https://acme.atlassian.net',
    reports: 'no',
  });
  const res = await setup(['apply', '--answers', answers], { cwd: dir });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^Created design-qa\.config\.json:\n/);
  assert.match(res.stdout, /app\.baseUrl: \(not set\) → "http:\/\/localhost:5173"/);
  assert.match(res.stdout, /note: figma-access: set FIGMA_TOKEN yourself/);
  assert.match(res.stdout, /Next: node \S*scripts\/setup\.mjs check/);
  const config = readJson(path.join(dir, 'design-qa.config.json'));
  assert.equal(config.app.baseUrl, 'http://localhost:5173');
  assert.deepEqual(config.app.preCapture, { localStorage: { 'acme:promo-dismissed': '1' }, remove: ['[data-testid=promo-banner]'] });
  assert.deepEqual(config.designSystem.tokens, ['src/styles/tokens.json']);
  assert.match(res.stdout, /note: ds-components: Acme UI is recognised by \[data-component\], \[data-ds-component\] for now/);
  assert.deepEqual(config.designSystem.libraries, [
    { name: 'Acme UI', kind: 'design-system', selector: DS_DEFAULT_SELECTOR, package: '@acme/ui' },
    { name: 'MUI', kind: 'third-party', classPrefix: 'Mui', package: '@mui/material' },
    { name: 'Chakra UI', kind: 'third-party', classPrefix: 'chakra-', package: '@chakra-ui/react' },
    { name: 'Old kit', kind: 'legacy', classPrefix: 'ok-' },
  ]);
  assert.equal(config.designSystem.designRules, 'design.md');
  assert.equal(config.designSystem.componentCatalog, null, 'an offered file left out is recorded as declined');
  assert.equal(config.designSystem.figmaLibrary, null);
  assert.deepEqual(config.figma.access, ['mcp', 'rest', 'manual']);
  assert.deepEqual(config.ticket, { provider: 'jira', baseUrl: 'https://acme.atlassian.net' });
  assert.equal(config.report.commit, false);
  const valid = await run(VALIDATE, [path.join(dir, 'design-qa.config.json'), '--type', 'config'], { cwd: dir });
  assert.equal(valid.code, 0, valid.stdout + valid.stderr);

  // Answered questions are not asked again.
  const after = JSON.parse((await setup(['check', '--quick', '--json', '--agent', 'figma-mcp=yes', '--agent', 'ticket-mcp=yes'], { cwd: dir })).stdout);
  assert.deepEqual(after.questions.map((q) => q.id), [], JSON.stringify(after.questions.map((q) => q.id)));
});

test('apply --no-next leaves out the closing Next line (inside a pass); JSON next is null', async () => {
  const dir = tmpDir('design-qa-setup-nonext-');
  writeFileSync(path.join(dir, 'design-qa.config.json'), JSON.stringify({ app: { baseUrl: 'http://localhost:3000' }, surfaces: {} }, null, 2));
  const plain = await setup(['apply', '--answers', writeAnswers(dir, { 'ds-name': 'One' })], { cwd: dir });
  assert.match(plain.stdout, /\nNext: .*setup\.mjs check\n$/);
  const quiet = await setup(['apply', '--no-next', '--answers', writeAnswers(dir, { 'ds-name': 'Two' })], { cwd: dir });
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.match(quiet.stdout, /designSystem\.name: "One" → "Two"/, 'everything else is printed');
  assert.doesNotMatch(quiet.stdout, /Next:/);
  const json = JSON.parse((await setup(['apply', '--json', '--answers', writeAnswers(dir, { 'ds-name': 'Three' })], { cwd: dir })).stdout);
  assert.match(json.next, /setup\.mjs check$/);
  const jsonQuiet = JSON.parse((await setup(['apply', '--json', '--no-next', '--answers', writeAnswers(dir, { 'ds-name': 'Four' })], { cwd: dir })).stdout);
  assert.equal(jsonQuiet.next, null);
  assert.equal(jsonQuiet.changes[0].to, 'Four');
  assert.match((await setup(['--help'])).stdout, /--no-next leaves out the\n\s+closing "Next: … check" line/);
});

test('apply keeps unknown keys, key order and indentation; --dry-run writes nothing; "later" saves nothing', async () => {
  const dir = tmpDir('design-qa-setup-apply-');
  const file = path.join(dir, 'design-qa.config.json');
  const original = { 'x-team-note': 'keep me', app: { baseUrl: 'http://localhost:3000', 'x-extra': [1, 2] }, surfaces: { home: { route: '/' } }, designSystem: { name: 'Old' } };
  writeFileSync(file, JSON.stringify(original, null, 4) + '\n');
  const answers = writeAnswers(dir, { 'ds-name': 'Acme UI', reports: 'yes', 'ds-figma': 'later' });

  const dry = await setup(['apply', '--answers', answers, '--dry-run'], { cwd: dir });
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /Would change design-qa\.config\.json \(dry run, nothing written\):\n {2}designSystem\.name: "Old" → "Acme UI"\n {2}report\.commit: \(not set\) → true/);
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify(original, null, 4) + '\n', 'dry run: unchanged');

  const res = await setup(['apply', '--answers', answers], { cwd: dir });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /note: ds-figma: nothing saved; asked again next time/);
  const text = readFileSync(file, 'utf8');
  assert.match(text, /^\{\n {4}"x-team-note": "keep me",\n {4}"app": \{/, 'indentation and order kept');
  const config = JSON.parse(text);
  assert.deepEqual(Object.keys(config), ['x-team-note', 'app', 'surfaces', 'designSystem', 'report']);
  assert.deepEqual(config.app['x-extra'], [1, 2]);
  assert.equal(config.designSystem.name, 'Acme UI');
  assert.equal('figmaLibrary' in config.designSystem, false);
  assert.deepEqual(config.report, { commit: true, outDir: 'qa-reports' });

  const again = await setup(['apply', '--answers', answers], { cwd: dir });
  assert.match(again.stdout, /nothing to change/);
});

test('apply refuses secrets, env and action answers, unknown ids, a symlink and an invalid result, writing nothing', async () => {
  const dir = tmpDir('design-qa-setup-refuse-');
  const file = path.join(dir, 'design-qa.config.json');
  writeFileSync(file, JSON.stringify({ app: { baseUrl: 'http://localhost:3000' }, surfaces: {} }, null, 2));
  const before = readFileSync(file, 'utf8');
  const refused = async (answers, pattern) => {
    const res = await setup(['apply', '--answers', writeAnswers(dir, answers)], { cwd: dir });
    assert.equal(res.code, 2, `${JSON.stringify(answers)}\n${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /nothing was written/);
    assert.match(res.stderr, pattern);
    assert.equal(readFileSync(file, 'utf8'), before, 'unchanged');
    for (const s of [ENV_SECRET, 'Zx81KqLmNop', 'hunter2-Secret']) assert.ok(!res.stderr.includes(s) && !res.stdout.includes(s), 'the secret is not echoed');
    return res;
  };
  await refused({ 'ds-name': 'Acme', 'app-start': `FIGMA_TOKEN=${ENV_SECRET} npm run dev` }, /app-start: refused, the answer for app\.start looks like a Figma token/);
  await refused({ 'app-url': 'https://qa:hunter2-Secret@staging.example.com' }, /looks like a password inside a link/);
  await refused({ hide: { localStorage: { session: COOKIE_SECRET } } }, /looks like cookies/);
  await refused({ 'figma-token': ENV_SECRET }, /figma-token: not saved\. FIGMA_TOKEN must be set by the person/);
  await refused({ 'figma-token': 'done' }, /FIGMA_TOKEN must be set by the person/);
  await refused({ 'ticket-token': 'done' }, /JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN must be set by the person/);
  await refused({ 'sign-in': 'now' }, /sign-in: not a config value\. Run `node \S*scripts\/setup\.mjs save-session`/);
  await refused({ 'what-is-this': 1 }, /unknown question id "what-is-this"/);
  await refused({ hide: 'find' }, /hide: "find" or a description is not something I can save/);
  await refused({ 'ds-tokens': ['../outside/tokens.json'] }, /must be a path inside the repository/);
  await refused({ 'ds-figma': 'https://example.com/lib' }, /is not a figma\.com link/);
  await refused({ 'ds-components': [{ name: 'Kit', kind: 'legacy' }] }, /"Kit" needs a "classPrefix" .* or a "selector"/);

  // A result that would not validate: exit 1, nothing written.
  const invalid = await setup(['apply', '--answers', writeAnswers(dir, { hide: { hide: ['.a { color: red }'] } })], { cwd: dir });
  assert.equal(invalid.code, 1, invalid.stderr);
  assert.match(invalid.stderr, /the result would not validate:\n {2}app\.preCapture\.hide\[0\]/);
  assert.equal(readFileSync(file, 'utf8'), before);

  // A config that is a symbolic link is never written through.
  const linked = tmpDir('design-qa-setup-link-');
  writeFileSync(path.join(linked, 'real.json'), before);
  symlinkSync(path.join(linked, 'real.json'), path.join(linked, 'design-qa.config.json'));
  const link = await setup(['apply', '--answers', writeAnswers(linked, { 'ds-name': 'X' })], { cwd: linked });
  assert.equal(link.code, 1);
  assert.match(link.stderr, /symbolic link/);
  assert.equal(readFileSync(path.join(linked, 'real.json'), 'utf8'), before);

  // No config and no app address: nothing to create it from.
  const empty = tmpDir('design-qa-setup-noapp-');
  const none = await setup(['apply', '--answers', writeAnswers(empty, { 'ds-name': 'X' })], { cwd: empty });
  assert.equal(none.code, 2);
  assert.match(none.stderr, /does not exist yet: answer app-url too/);
  assert.ok(!existsSync(path.join(empty, 'design-qa.config.json')));
});

test('looksSecret: tokens, cookies, sessions and passwords in links; never plain settings', () => {
  for (const s of [
    ENV_SECRET,
    'ghp_0123456789abcdefghijABCDEFGHIJ012345',
    'ATATT3xFfGF0abcdefghijklmnopqrstuvwxyz',
    'xoxb-1234567890-abcdefghij',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc',
    'Bearer abcdefghijklmnopqrstuvwxyz',
    'https://user:pw12345@host.example.com',
    'https://app.example.com/?token=abcdef123456',
    COOKIE_SECRET,
    '{"cookies":[],"origins":[]}',
    'password=letmein123',
    'Q2hhbmdlTWVQbGVhc2UxMjM0NTY3ODkwYWJjZGVm',
  ]) assert.ok(looksSecret(s), s);
  for (const s of [
    'http://localhost:3000',
    '${PREVIEW_URL}',
    'npm run dev',
    'cd apps/web && pnpm dev',
    '[data-testid=app-nav]',
    'input[type=password]',
    'https://www.figma.com/design/AbCdEfGhIjKlMnOp/Acme-Library?node-id=0-1',
    'src/styles/tokens.json',
    '~/.design-qa/sessions/acme-web-localhost-3000.json',
    'acme:promo-banner-dismissed',
    'Acme UI',
  ]) assert.equal(looksSecret(s), null, s);
});

test('a session path in the variable may start with ~ (as capture resolves it), and the printed export line works when pasted', async () => {
  const home = tmpDir('design-qa-setup-tilde-');
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    const file = path.join(home, '.design-qa', 'sessions', 'x.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{}');
    // What capture does: storageStateFromConfig(config, { env, configDir }) with the variable set.
    const fromEnv = storageStateFromConfig({ app: { auth: { type: 'storageState' } } }, { env: { DESIGN_QA_APP_STORAGE_STATE: '~/.design-qa/sessions/x.json' }, configDir: '/repo' });
    assert.deepEqual([fromEnv.source, fromEnv.path, fromEnv.exists], ['env', file, true]);
    assert.equal(storageStateFromConfig({}, { env: { DESIGN_QA_APP_STORAGE_STATE: 'rel/x.json' } }).path, path.resolve('rel/x.json'), 'other values as before');

    // Pasted into a shell, the line sets the variable to the absolute path, spaces and quotes included.
    const paste = (line) => execFileSync('sh', ['-c', `${line}; printf %s "$X"`], { env: { HOME: home, PATH: process.env.PATH }, encoding: 'utf8' });
    const odd = path.join(home, '.design-qa', 'sessions', 'my "odd" $name `x` \\ it.json');
    assert.equal(exportLine('X', file), 'export X="$HOME/.design-qa/sessions/x.json"');
    assert.equal(paste(exportLine('X', file)), file);
    assert.equal(paste(exportLine('X', odd)), odd);
    const outside = path.join(tmpDir('design-qa-setup-out-'), "it's here.json");
    assert.match(exportLine('X', outside), /^export X='/);
    assert.equal(paste(exportLine('X', outside)), outside);
  } finally {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
  }
});

test('session paths: env wins over app.auth.storageState; ~ and ${ENV} expand; tildePath folds the home folder', () => {
  const home = os.homedir();
  assert.equal(expandUserPath('~/.design-qa/s.json'), path.join(home, '.design-qa', 's.json'));
  assert.equal(expandUserPath('${SESS_DIR}/s.json', { env: { SESS_DIR: '/tmp/x' } }), '/tmp/x/s.json');
  assert.throws(() => expandUserPath('${NOPE}/s.json', { env: {}, where: 'app.auth.storageState' }), (err) => err.exitCode === 2 && /NOPE is not set .*app\.auth\.storageState/.test(err.message));
  assert.equal(tildePath(path.join(home, 'a', 'b.json')), '~/a/b.json');
  assert.equal(tildePath('/elsewhere/b.json'), '/elsewhere/b.json');

  const config = { app: { auth: { type: 'storageState', envPrefix: 'SHOP', storageState: '~/.design-qa/sessions/shop.json' } } };
  const fromConfig = storageStateFromConfig(config, { env: {}, configDir: '/repo' });
  assert.deepEqual([fromConfig.source, fromConfig.path, fromConfig.envName], ['config', path.join(home, '.design-qa', 'sessions', 'shop.json'), 'SHOP_STORAGE_STATE']);
  const fromEnv = storageStateFromConfig(config, { env: { SHOP_STORAGE_STATE: '/tmp/other.json' }, configDir: '/repo' });
  assert.deepEqual([fromEnv.source, fromEnv.path], ['env', '/tmp/other.json'], 'the variable wins');
  assert.equal(storageStateFromConfig({ app: { auth: { type: 'storageState', storageState: 'sessions/s.json' } } }, { env: {}, configDir: '/repo' }).path, '/repo/sessions/s.json', 'relative to the config');
  assert.deepEqual(storageStateFromConfig({ app: {} }, { env: {} }).source, null);
});

test('hasDisplay: remote, CI and headless Linux sessions have no screen', () => {
  assert.equal(hasDisplay({ env: {}, platform: 'darwin' }), true);
  assert.equal(hasDisplay({ env: {}, platform: 'win32' }), true);
  assert.equal(hasDisplay({ env: {}, platform: 'linux' }), false);
  assert.equal(hasDisplay({ env: { DISPLAY: ':0' }, platform: 'linux' }), true);
  assert.equal(hasDisplay({ env: { WAYLAND_DISPLAY: 'wayland-0' }, platform: 'linux' }), true);
  for (const env of [{ SSH_CONNECTION: '1.2.3.4 22 5.6.7.8 22' }, { CI: 'true' }, { CODESPACES: 'true' }, { DESIGN_QA_NO_DISPLAY: '1' }]) {
    assert.equal(hasDisplay({ env: { DISPLAY: ':0', ...env }, platform: 'darwin' }), false, JSON.stringify(env));
  }
});

test('buildQuestions: a session that stopped working asks to sign in again; without a screen the default is "on my own computer"', () => {
  const discovered = discoverRepo(tmpDir('design-qa-setup-q-'), { env: {} });
  const config = { app: { baseUrl: 'https://staging.example.com', auth: { type: 'storageState' }, preCapture: {} }, surfaces: {} };
  const fresh = buildQuestions({ config, discovered, probe: { signInNeeded: true, sessionUsed: null }, env: {}, agent: { 'figma-mcp': true }, display: false }).questions;
  const signIn = fresh.find((q) => q.id === 'sign-in');
  assert.equal(signIn.required, true);
  assert.equal(signIn.default, 'own-machine');
  assert.match(signIn.question, /shows a sign-in page first/);
  assert.match(signIn.why, /never in this chat/);
  assert.ok(!fresh.some((q) => q.id === 'app-start'), 'a remote app needs no start command');
  const expired = buildQuestions({ config, discovered, probe: { signInNeeded: true, sessionUsed: '~/.design-qa/sessions/x.json' }, env: {}, agent: {}, display: true }).questions;
  assert.match(expired.find((q) => q.id === 'sign-in').question, /has expired/);
  assert.equal(expired.find((q) => q.id === 'sign-in').default, 'now');
  assertWellFormed(expired);
});

test('save-session: a path inside the repository is refused unless git ignores it; no screen prints the one-line alternative', async () => {
  const repo = tmpDir('design-qa-setup-repo-');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(path.join(repo, '.gitignore'), 'secrets/\n');
  writeFileSync(path.join(repo, 'design-qa.config.json'), JSON.stringify({ app: { baseUrl: 'https://staging.example.com' }, surfaces: {} }));
  const home = tmpDir('design-qa-setup-home-');
  const env = { HOME: home, USERPROFILE: home };

  const inside = await setup(['save-session', '--out', 'sessions/s.json'], { cwd: repo, env });
  assert.equal(inside.code, 2, inside.stderr);
  assert.match(inside.stderr, /inside the repository and git does not ignore it: a saved session is as good as a password and must never be committed/);

  const ignored = await setup(['save-session', '--out', 'secrets/s.json'], { cwd: repo, env: { ...env, SSH_CONNECTION: '10.0.0.1 1 10.0.0.2 22' } });
  assert.equal(ignored.code, 3, ignored.stderr);
  assert.match(ignored.stderr, /No screen is available here/);
  assert.match(ignored.stderr, /npx playwright codegen --save-storage=session\.json 'https:\/\/staging\.example\.com'/);
  assert.match(ignored.stderr, /secrets\/s\.json/);

  const remote = await setup(['save-session', '--json'], { cwd: repo, env: { ...env, DESIGN_QA_NO_DISPLAY: '1' } });
  assert.equal(remote.code, 3, remote.stderr);
  const out = JSON.parse(remote.stdout);
  assert.equal(out.verified, false);
  assert.match(out.path, /^~\/\.design-qa\/sessions\/design-qa-setup-repo-.*-staging\.example\.com\.json$/, 'default: per user, outside the repository');
  assert.match(out.message, /chmod 600/);
  assert.ok(!existsSync(path.join(home, '.design-qa')), 'nothing was created');
  assert.deepEqual(readdirSync(repo).sort(), ['.git', '.gitignore', 'design-qa.config.json']);

  const noUrl = await setup(['save-session'], { cwd: tmpDir('design-qa-setup-nourl-'), env });
  assert.equal(noUrl.code, 2);
  assert.match(noUrl.stderr, /--url <app-url> is required/);
});

test('setup.mjs: unknown commands and --help', async () => {
  const help = await setup(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /node \S*scripts\/setup\.mjs check/);
  assert.match(help.stdout, /save-session {2}0 saved and verified/);
  const bad = await setup(['frobnicate']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /unknown command "frobnicate"/);
  const src = readFileSync(SETUP, 'utf8');
  assert.doesNotMatch(src, /^import\s/m, 'no static imports: the Node version is checked first');
});
