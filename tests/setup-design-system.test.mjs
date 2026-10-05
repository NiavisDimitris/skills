// Onboarding and the design system (setup.mjs, pass.mjs start): theme files found by what
// they contain, a wrapper component library found by what the app imports, both asked about
// when the repository does not answer them alone; a theme in code saved as JSON only on an
// explicit command; start never writes the config before the person has seen what it assumed.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parseJsonTokens } from '../skills/design-qa/scripts/lib/ds-audit.mjs';
import { exportTheme } from '../skills/design-qa/scripts/lib/setup.mjs';
import { run, script, tmpDir } from './_helpers.mjs';

const SETUP = script('setup.mjs');
const PASS = script('pass.mjs');
const CLEAN_ENV = { FIGMA_TOKEN: '', JIRA_BASE_URL: '', JIRA_EMAIL: '', JIRA_API_TOKEN: '', CI: '', SSH_CONNECTION: '', SSH_CLIENT: '', SSH_TTY: '', DESIGN_QA_NO_DISPLAY: '' };
const setup = (args, cwd) => run(SETUP, args, { cwd, env: CLEAN_ENV });
const write = (dir, files) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), typeof text === 'string' ? text : JSON.stringify(text));
  }
};

/** The retro's shape: MUI, a wrapper package most feature code imports, a TypeScript theme not named theme.*. */
function retroProject({ rawFiles = 1, wrapperFiles = 3 } = {}) {
  const dir = tmpDir('design-qa-ds-');
  write(dir, {
    'package.json': { name: 'acme-app', private: true, dependencies: { '@mui/material': '^6.0.0', '@acme/kit': '^1.0.0', react: '^18' } },
    'node_modules/@acme/kit/package.json': { name: '@acme/kit', peerDependencies: { '@mui/material': '^6.0.0' } },
    'src/theme/brand.ts': "import { createTheme } from '@mui/material';\nexport const brand = createTheme({ spacing: 8 });\n",
  });
  for (let i = 0; i < wrapperFiles; i += 1) write(dir, { [`src/features/W${i}.tsx`]: "import { Button, Card } from '@acme/kit';\nexport const W = 1;\n" });
  for (let i = 0; i < rawFiles; i += 1) write(dir, { [`src/features/R${i}.tsx`]: "import { Button } from '@mui/material';\nexport const R = 1;\n" });
  return dir;
}

test('the retro-shaped project: check asks where style values live and which component library, with the theme file and the wrapper among the options', async () => {
  const dir = retroProject();
  const res = await setup(['check', '--quick', '--json', '--url', 'http://localhost:5421/checkout/cart'], dir);
  const out = JSON.parse(res.stdout);
  const q = Object.fromEntries(out.questions.map((x) => [x.id, x]));
  assert.deepEqual(Object.keys(q), ['ds-tokens', 'ds-components'], res.stdout);
  assert.ok(q['ds-tokens'].options.some((o) => o.value === 'src/theme/brand.ts' && /theme in code: I run it once with Node and save its values/.test(o.description)));
  assert.deepEqual(q['ds-tokens'].default, ['src/theme/brand.ts']);
  assert.deepEqual(q['ds-components'].options.map((o) => o.value), ['@acme/kit', '@mui/material', 'none']);
  assert.equal(q['ds-components'].options[0].description, 'Your own components (@acme/kit; 3 files import it), built on MUI');
  assert.equal(q['ds-components'].options[1].description, 'A third-party library (@mui/material; 1 file imports it directly)');
  assert.deepEqual(q['ds-components'].default, ['@acme/kit', '@mui/material'], 'most feature code imports the wrapper');
  assert.ok(!out.assumed.some((a) => ['ds-tokens', 'ds-components'].includes(a.id)), 'nothing about the design system is assumed');
  assert.ok(!existsSync(path.join(dir, 'design-qa.config.json')), 'check writes nothing');

  // Feature code mostly imports MUI straight: the wrapper is offered, not chosen by default.
  const raw = JSON.parse((await setup(['check', '--quick', '--json'], retroProject({ rawFiles: 4, wrapperFiles: 1 }))).stdout);
  assert.deepEqual(raw.questions.find((x) => x.id === 'ds-components').default, ['@mui/material']);

  // Answered: the configured project gets no design-system questions.
  write(dir, { 'design-qa.config.json': { app: { baseUrl: 'http://localhost:5421' }, surfaces: {}, designSystem: { tokens: [], libraries: [] }, report: { commit: false } } });
  assert.deepEqual(JSON.parse((await setup(['check', '--quick', '--json'], dir)).stdout).questions, []);
});

test('a local folder that re-exports MUI is offered as your own components, built on MUI; its own files are not raw use', async () => {
  const dir = tmpDir('design-qa-ds-local-');
  write(dir, {
    'package.json': { name: 'shop', dependencies: { '@mui/material': '^6.0.0', react: '^18' } },
    'src/ui/index.ts': "export { Button } from './Button';\nexport { Card } from './Card';\n",
    'src/ui/Button.tsx': "import MuiButton from '@mui/material/Button';\nexport const Button = MuiButton;\n",
    'src/ui/Card.tsx': "import { Card as MuiCard } from '@mui/material';\nexport const Card = MuiCard;\n",
    'src/pages/Cart.tsx': "import { Button } from '../ui';\n",
    'src/pages/Home.tsx': "import { Card } from '@/ui';\n",
  });
  const out = JSON.parse((await setup(['check', '--quick', '--json'], dir)).stdout);
  const components = out.questions.find((x) => x.id === 'ds-components');
  assert.deepEqual(components.options.map((o) => [o.value, o.description]).slice(0, 2), [
    ['src/ui', 'Your own components (src/ui; 2 files import it), built on MUI'],
    ['@mui/material', 'A third-party library (@mui/material)'],
  ]);
  assert.deepEqual(components.default, ['src/ui', '@mui/material']);
  const applied = await setup(['apply', '--answers', writeAnswers(dir, { 'app-url': 'http://localhost:3000', 'ds-components': ['src/ui', '@mui/material'] })], dir);
  assert.equal(applied.code, 0, applied.stderr);
  const config = JSON.parse(readFileSync(path.join(dir, 'design-qa.config.json'), 'utf8'));
  assert.deepEqual(config.designSystem.libraries[0], { name: 'ui', kind: 'design-system', selector: '[data-component], [data-ds-component]', package: 'src/ui', wraps: 'MUI' });
  assert.match(applied.stdout, /ui is built on MUI, so on the page its components look like MUI's; the audit tells them apart by what the source imports/);
});

function writeAnswers(dir, answers) {
  const file = path.join(dir, 'answers.json');
  writeFileSync(file, JSON.stringify(answers));
  return file;
}

test('pass.mjs start never writes the config: what it assumed is shown, and saved only by the printed apply (ci assumes nothing)', async () => {
  const dir = retroProject();
  const url = 'http://localhost:5421/checkout/cart';
  const first = await run(PASS, ['start', '--feature', 'abc-1', '--url', url, '--quick', '--agent', 'figma-mcp=yes', '--agent', 'ticket-mcp=yes'], { cwd: dir, env: CLEAN_ENV });
  assert.equal(first.code, 3, first.stdout);
  assert.ok(!existsSync(path.join(dir, 'design-qa.config.json')), 'nothing written before the person has seen it');
  assert.match(first.stdout, /^Assumed \(not saved yet: show the person; design-qa\.config\.json gets them only through the apply below\):\n {2}App address: http:\/\/localhost:5421$/m);
  assert.doesNotMatch(first.stdout, /Setup: ready/);
  assert.match(first.stdout, /^Question \(ds-tokens\): Where are your colors, spacing and text sizes defined in the code\?\n {2}a\) brand\.ts: Your theme in code: .+ → \{"ds-tokens":\["src\/theme\/brand\.ts"\]\}$/m);
  assert.match(first.stdout, /^Do: Ask the person the questions above in one round, with the values under Assumed/m);
  const next = /^Next: (.+)$/m.exec(first.stdout)[1];
  assert.match(next, /setup\.mjs apply --accept-assumed --answers qa-reports\/abc-1\/answers\.json --url http:\/\/localhost:5421\/checkout\/cart --no-next && /);

  // The person answered (style values from the page here: nothing to run); the printed command runs as printed.
  writeFileSync(path.join(dir, 'qa-reports', 'abc-1', 'answers.json'), JSON.stringify({ 'ds-tokens': ['page'], 'ds-components': ['@acme/kit', '@mui/material'] }));
  const [cmd, ...args] = next.split(' && ')[0].replace(/^node \S+setup\.mjs/, SETUP).split(' ');
  const applied = await run(cmd, args, { cwd: dir, env: CLEAN_ENV });
  assert.equal(applied.code, 0, applied.stderr);
  const config = JSON.parse(readFileSync(path.join(dir, 'design-qa.config.json'), 'utf8'));
  assert.equal(config.app.baseUrl, 'http://localhost:5421');
  assert.deepEqual(config.designSystem.libraries.map((l) => [l.name, l.wraps ?? null]), [['Acme kit', 'MUI'], ['MUI', null]]);

  // ci: never asks, never writes.
  const ci = retroProject();
  const c = await run(PASS, ['start', '--feature', 'abc-2', '--url', url, '--quick', '--ci'], { cwd: ci, env: CLEAN_ENV });
  assert.doesNotMatch(c.stdout, /Assumed/);
  assert.ok(!existsSync(path.join(ci, 'design-qa.config.json')));
});

const canStripTypes = Boolean(process.features?.typescript) || Number(process.versions.node.split('.')[0]) >= 23 || (Number(process.versions.node.split('.')[0]) === 22 && Number(process.versions.node.split('.')[1]) >= 6);

test('export-theme: a TypeScript MUI theme becomes token JSON with its variants, shadows and spacing; check never runs it', { skip: !canStripTypes && 'this Node has no built-in TypeScript support' }, async () => {
  const dir = retroProject();
  write(dir, {
    // A stand-in for the project's own @mui/material: createTheme fills in variants, shadows and the spacing function.
    'node_modules/@mui/material/package.json': { name: '@mui/material', version: '0.0.0-test', main: 'index.js' },
    'node_modules/@mui/material/index.js': "exports.createTheme = require('./styles/index.js').createTheme;\n",
    'node_modules/@mui/material/styles/index.js':
      "exports.createTheme = (o = {}) => ({ palette: { primary: { main: '#1976d2' }, ...(o.palette || {}) }, typography: { fontFamily: 'Roboto, sans-serif', h6: { fontSize: '1.25rem', lineHeight: 1.6, fontWeight: 500, letterSpacing: '0.0075em' } }, shadows: ['none', '0px 2px 1px -1px rgba(0,0,0,0.2)'], spacing: (f) => `${f * (o.spacing || 8)}px`, shape: { borderRadius: 4 }, breakpoints: { values: { sm: 600 } } });\n",
    'src/theme/colors.ts': "export const colors = { brand: '#0b5cad' } as const;\n",
    'src/theme/brand.ts':
      "import { writeFileSync } from 'node:fs';\nimport { createTheme } from '@mui/material/styles';\nimport type { ThemeOptions } from '@mui/material/styles';\nimport { colors } from './colors';\nwriteFileSync('ran.txt', 'x');\nconst options: ThemeOptions = { palette: { primary: { main: colors.brand } }, spacing: 4 };\nexport const brand = createTheme(options);\n",
  });
  await setup(['check', '--quick', '--json'], dir);
  assert.ok(!existsSync(path.join(dir, 'ran.txt')), 'check never runs project code');

  const res = await setup(['export-theme', '--from', 'src/theme/brand.ts'], dir);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^Saved the values of src\/theme\/brand\.ts to design-qa\/brand\.tokens\.json \(Node’s own TypeScript support\)\./);
  const json = JSON.parse(readFileSync(path.join(dir, 'design-qa', 'brand.tokens.json'), 'utf8'));
  assert.equal(json.$exportedFrom, 'src/theme/brand.ts');
  assert.equal(json.palette.primary.main, '#0b5cad');
  assert.deepEqual([json.spacing['1'], json.spacing['3']], ['4px', '12px']);
  const parsed = parseJsonTokens(json);
  assert.equal(parsed.textStyles.find((s) => s.name === 'typography.h6').size, 20);
  assert.equal(parsed.tokens.find((t) => t.name === 'spacing(2)').px, 8);

  // apply with that answer exports it (the person chose it) and lists the JSON; --dry-run runs nothing.
  const answers = writeAnswers(dir, { 'app-url': 'http://localhost:5421', 'ds-tokens': ['src/theme/brand.ts'] });
  const dry = await setup(['apply', '--answers', answers, '--dry-run'], dir);
  assert.match(dry.stdout, /would run src\/theme\/brand\.ts once with Node and save its values to design-qa\/brand\.tokens\.json/);
  const applied = await setup(['apply', '--answers', answers], dir);
  assert.equal(applied.code, 0, applied.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'design-qa.config.json'), 'utf8')).designSystem.tokens, ['design-qa/brand.tokens.json']);

  // A theme that cannot be read: one plain line with what to do instead, nothing written.
  write(dir, { 'src/theme/broken.ts': "import { nothing } from '@acme/missing';\nexport default nothing;\n" });
  const bad = await setup(['export-theme', '--from', 'src/theme/broken.ts'], dir);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /^setup\.mjs: could not read src\/theme\/broken\.ts \(.+\)\. Instead: answer "Style values" with "page", or save the theme's values as JSON yourself/);
  assert.equal(bad.stderr.trim().split('\n').length, 1);
  assert.ok(!existsSync(path.join(dir, 'design-qa', 'broken.tokens.json')));
  const refused = await setup(['apply', '--answers', writeAnswers(dir, { 'ds-tokens': ['src/theme/broken.ts'] })], dir);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /nothing was written: ds-tokens: could not read src\/theme\/broken\.ts/);
});

test('export-theme: a theme that takes longer than the limit (a cold disk) says to run the same command again', () => {
  const dir = tmpDir('design-qa-ds-slow-');
  write(dir, { 'src/theme/slow.mjs': 'await new Promise((r) => setTimeout(r, 5000));\nexport default { palette: { primary: { main: "#123456" } } };\n' });
  const r = exportTheme({ root: dir, from: 'src/theme/slow.mjs', timeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.match(r.message, /could not read src\/theme\/slow\.mjs \(Node: stopped after 1 s \(a first run on a cold disk can be that slow\): run the same command again\)/);
  assert.ok(!existsSync(path.join(dir, 'design-qa', 'slow.tokens.json')), 'nothing written');
});
