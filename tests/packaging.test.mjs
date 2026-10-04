import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { run } from './_helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = (p) => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8'));
const marketplace = json('.claude-plugin/marketplace.json');
const entry = marketplace.plugins.find((p) => p.name === 'design-qa');
const PLUGIN = path.join(ROOT, entry?.source ?? '');

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.name === 'node_modules') return [];
    return d.isDirectory() ? files(p) : [p];
  });
}

test('the marketplace entry points at the skill folder, which is a complete plugin', () => {
  assert.ok(entry, 'marketplace lists design-qa');
  assert.equal(entry.source, './skills/design-qa', 'only the skill folder is installed, not the whole repo');
  assert.equal(marketplace.plugins.length, 1);
  const skill = readFileSync(path.join(PLUGIN, 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: design-qa\n/, 'SKILL.md at the plugin root, named, so it loads as the plugin skill');
  const manifest = JSON.parse(readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, entry.name, 'manifest and entry names match');
  for (const dir of ['commands', 'agents', 'hooks', 'skills']) {
    assert.throws(() => statSync(path.join(PLUGIN, dir)), `no ${dir}/ in the plugin root: the root SKILL.md is the only component`);
  }
});

test('one version everywhere', () => {
  const versions = {
    marketplace: entry.version,
    plugin: JSON.parse(readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).version,
    skillPackage: JSON.parse(readFileSync(path.join(PLUGIN, 'package.json'), 'utf8')).version,
    repoPackage: json('package.json').version,
  };
  assert.equal(new Set(Object.values(versions)).size, 1, JSON.stringify(versions));
  assert.match(readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), new RegExp(`## \\[${versions.plugin.replace(/\./g, '\\.')}\\]`), 'CHANGELOG has the version');
});

test('the skill folder declares and locks every package its scripts import', () => {
  const pkg = JSON.parse(readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(path.join(PLUGIN, 'package-lock.json'), 'utf8'));
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies, 'package-lock.json is in sync with package.json (run npm install --package-lock-only)');
  assert.deepEqual(json('package.json').dependencies, pkg.dependencies, 'the repo installs the same packages as the skill');

  const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
  const imported = new Set();
  for (const file of files(path.join(PLUGIN, 'scripts')).filter((f) => f.endsWith('.mjs'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:^|\n)\s*import\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|importDependency\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec.startsWith('.') || builtins.has(spec)) continue;
      imported.add(spec.split('/')[0]);
    }
    assert.doesNotMatch(src, /['"]\.\.\/\.\.\/\.\.\//, `${path.relative(ROOT, file)} reaches outside the skill folder`);
  }
  assert.deepEqual([...imported].sort(), Object.keys(pkg.dependencies).sort());
});

test('the plugin stays small: examples, tests and docs are not in it', () => {
  const tracked = execFileSync('git', ['ls-files', '-z', '--', entry.source], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  const bytes = tracked.reduce((n, f) => n + statSync(path.join(ROOT, f)).size, 0);
  assert.ok(bytes < 2 * 1024 * 1024, `plugin is ${(bytes / 1048576).toFixed(2)} MB`);
  assert.ok(!tracked.some((f) => /\.(png|woff2|jpg|mp4)$/.test(f)), 'no binary assets in the plugin');
});

// Tracked files may be at most 1 MB. Anything larger needs an entry here with
// the reason it has to live in git.
const LARGE_FILE_LIMIT = 1024 * 1024;
const LARGE_FILE_ALLOWLIST = new Map([
  // The five-screen sample report, every screenshot embedded so it opens as
  // one file; linked from the README.
  ['examples/mock-five-frames/report.html', 'rendered sample linked from the README'],
]);

test('no tracked file is over 1 MB unless allowlisted', (t) => {
  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0')
      .filter(Boolean);
  } catch {
    t.skip('git is not available, or this is not a git checkout');
    return;
  }
  const large = [];
  for (const f of tracked) {
    let size;
    try {
      size = statSync(path.join(ROOT, f)).size;
    } catch {
      continue; // tracked but deleted in the working tree
    }
    if (size > LARGE_FILE_LIMIT && !LARGE_FILE_ALLOWLIST.has(f)) large.push(`${f} (${(size / 1048576).toFixed(2)} MB)`);
  }
  assert.deepEqual(large, [], 'shrink these files, or allowlist them in tests/packaging.test.mjs with a reason');
});

test('the SKILL.md description fits the skill-listing cap', (t) => {
  const skill = readFileSync(path.join(PLUGIN, 'SKILL.md'), 'utf8');
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
  const field = (name) => (frontmatter.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'm'))?.[1] ?? '').replace(/^(['"])([\s\S]*)\1$/, '$2');
  const description = field('description');
  const whenToUse = field('when_to_use');
  // Claude Code truncates description + when_to_use at 1,536 characters in the
  // skill listing. The open Agent Skills spec caps description at 1,024: over
  // that, other agents may cut or reject it. Reported, not enforced, here.
  const length = description.length + whenToUse.length;
  t.diagnostic(`SKILL.md description: ${description.length} characters${whenToUse ? `, when_to_use: ${whenToUse.length}` : ''} (Claude Code cap 1536, open-spec cap 1024)`);
  assert.ok(description.length > 0, 'SKILL.md has a description');
  assert.ok(length <= 1536, `description + when_to_use is ${length} characters; Claude Code truncates at 1536`);
});

test('a missing package exits 4 with the folder to run npm install in', async () => {
  const deps = path.join(PLUGIN, 'scripts', 'lib', 'deps.mjs');
  const res = await run('--input-type=module', ['-e', `import(${JSON.stringify(deps)}).then((m) => m.importDependency('design-qa-no-such-package'))`]);
  assert.equal(res.code, 4, res.stderr);
  assert.match(res.stderr, /design-qa-no-such-package is not installed/);
  assert.ok(res.stderr.includes(`Run \`npm install\` in ${PLUGIN}`), res.stderr);
  assert.match(res.stderr, /doctor\.mjs/);
});

test('doctor reports every check and the skill folder', async () => {
  const res = await run(path.join(PLUGIN, 'scripts', 'doctor.mjs'), ['--json']);
  const out = JSON.parse(res.stdout);
  assert.equal(out.skillDir, PLUGIN);
  assert.deepEqual(out.checks.map((c) => c.name), ['node', 'pngjs', 'pixelmatch', 'playwright', 'chromium']);
  assert.equal(res.code, out.ready ? 0 : 1);
  for (const c of out.checks.filter((x) => !x.ok)) assert.ok(c.fix.includes(PLUGIN), `${c.name}: the fix names the skill folder`);
});
