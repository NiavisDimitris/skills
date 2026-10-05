// Printed commands run as printed: the agent works in the repository under test and the
// skill lives elsewhere (linked into the project, or a plugin cache), so every command a
// script prints must work verbatim from the working directory. Each family is run from a
// temp project with the skill (a) linked inside it and (b) outside it, and the printed
// command is executed through `sh -c`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { scriptShellPath } from '../skills/design-qa/scripts/lib/args.mjs';
import { SKILL, fixture, tmpDir } from './_helpers.mjs';

const ENV = { NO_COLOR: '1', DESIGN_QA_RUN_ID: '', FIGMA_TOKEN: '', DESIGN_QA_APP_STORAGE_STATE: '', DESIGN_QA_NO_DISPLAY: '1', DESIGN_QA_COMMIT: 'c', DESIGN_QA_BRANCH: 'b' };

/** Run argv (or a shell line with { shell: true }) in cwd. */
function exec(cwd, argv, { shell = false, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = shell ? spawn('sh', ['-c', argv], { cwd, env: { ...process.env, ...ENV } }) : spawn(process.execPath, argv, { cwd, env: { ...process.env, ...ENV } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out: ${argv}`));
    }, timeout);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, out: `${stdout}${stderr}` });
    });
  });
}

/** The printed command found it: no "command not found" (127), no missing module or script. */
async function runsAsPrinted(cwd, line, label) {
  assert.ok(line && line.startsWith('node '), `${label}: a command (${line})`);
  const r = await exec(cwd, line, { shell: true });
  assert.notEqual(r.code, 127, `${label}: ${line}\n${r.out}`);
  assert.doesNotMatch(r.out, /Cannot find module|MODULE_NOT_FOUND|No such file or directory|ERR_MODULE_NOT_FOUND/, `${label}: ${line}`);
  return r;
}

/** Two installs: the skill linked into the project, and the skill outside it. */
function installs(t) {
  const out = [];
  for (const kind of ['linked', 'outside']) {
    const project = tmpDir(`design-qa-cmd-${kind}-`);
    t.after(() => rmSync(project, { recursive: true, force: true }));
    let scripts = path.join(SKILL, 'scripts');
    if (kind === 'linked') {
      mkdirSync(path.join(project, '.claude', 'skills'), { recursive: true });
      symlinkSync(SKILL, path.join(project, '.claude', 'skills', 'design-qa'), 'dir');
      scripts = path.join('.claude', 'skills', 'design-qa', 'scripts');
    }
    out.push({ kind, project, script: (name) => path.join(scripts, name) });
  }
  return out;
}

const prefix = (kind, name) =>
  kind === 'linked' ? `node .claude/skills/design-qa/scripts/${name}` : `node ${scriptShellPath(name, { cwd: os.tmpdir() })}`;

test('scriptShellPath: relative inside the working directory, ~/ under home, absolute elsewhere, quoted when needed', () => {
  const opts = { home: '/home/acme', platform: 'linux' };
  assert.equal(scriptShellPath('pass.mjs', { ...opts, cwd: '/work/repo', scriptsDir: '/work/repo/.claude/skills/design-qa/scripts' }), '.claude/skills/design-qa/scripts/pass.mjs');
  assert.equal(scriptShellPath('lib/state-discovery.mjs', { ...opts, cwd: '/work/repo', scriptsDir: '/home/acme/.claude/plugins/cache/acme/design-qa/1.0.0/skills/design-qa/scripts' }), '~/.claude/plugins/cache/acme/design-qa/1.0.0/skills/design-qa/scripts/lib/state-discovery.mjs');
  assert.equal(scriptShellPath('pass.mjs', { ...opts, cwd: '/work/repo', scriptsDir: "/home/acme/My Skills/it's/scripts" }), "~/'My Skills/it'\\''s/scripts/pass.mjs'", 'the ~/ stays unquoted so the shell expands it');
  assert.equal(scriptShellPath('pass.mjs', { ...opts, cwd: '/work/repo', scriptsDir: '/opt/skills/design-qa/scripts' }), '/opt/skills/design-qa/scripts/pass.mjs');
  assert.equal(scriptShellPath('pass.mjs', { home: 'C:\\Users\\acme', platform: 'win32', cwd: 'C:\\repo', scriptsDir: 'C:\\skills\\scripts' }), `"${path.join('C:\\skills\\scripts', 'pass.mjs')}"`);
});

test('pass.mjs: start prints evidence, which runs as printed (linked and outside)', { timeout: 300000 }, async (t) => {
  for (const { kind, project, script } of installs(t)) {
    writeFileSync(
      path.join(project, 'design-qa.config.json'),
      JSON.stringify({ app: { baseUrl: 'http://127.0.0.1:9' }, surfaces: { profile: { route: '/profile', prototype: pathToFileURL(fixture('prototype.html')).href } }, designSystem: { name: 'Acme UI' }, report: { commit: false } }),
    );
    const s = await exec(project, [script('pass.mjs'), 'start', '--feature', 'abc-1', '--quick', '--agent', 'figma-mcp=no', '--agent', 'ticket-mcp=no']);
    assert.equal(s.code, 0, s.out);
    const next = s.stdout.trim().split('\n').pop().replace(/^Next: /, '');
    assert.ok(next.startsWith(`${prefix(kind, 'pass.mjs')} evidence --dir qa-reports/abc-1 --run `), `${kind}: ${next}`);
    await runsAsPrinted(project, next, `${kind} pass evidence`);
    // An error's Next: line too.
    const bad = await exec(project, [script('pass.mjs'), 'evidence', '--dir', 'qa-reports/abc-1']);
    const help = bad.stdout.trim().split('\n').pop().replace(/^Next: /, '');
    assert.equal(help, `${prefix(kind, 'pass.mjs')} --help`);
    await runsAsPrinted(project, help, `${kind} pass --help`);
    for (const out of [s.stdout, bad.stdout]) assert.doesNotMatch(out, /node scripts\//, 'start and errors print the runnable path');
  }
});

test('setup.mjs apply and check, capture.mjs sign-in hints: the printed commands run as printed', { timeout: 300000 }, async (t) => {
  for (const { kind, project, script } of installs(t)) {
    writeFileSync(path.join(project, 'answers.json'), JSON.stringify({ 'app-url': 'http://127.0.0.1:9' }));
    const a = await exec(project, [script('setup.mjs'), 'apply', '--answers', 'answers.json']);
    assert.equal(a.code, 0, a.out);
    const next = /^Next: (.+)$/m.exec(a.stdout)[1];
    assert.equal(next, `${prefix(kind, 'setup.mjs')} check`);
    await runsAsPrinted(project, `${next} --quick`, `${kind} setup check`);
    const j = await exec(project, [script('setup.mjs'), 'check', '--quick', '--json']);
    for (const n of JSON.parse(j.stdout).next ?? []) assert.ok(n.startsWith(prefix(kind, 'setup.mjs')) || n.startsWith('If '), n);
    // capture: a missing saved session names save-session, runnable as printed (no screen: exit 3, instructions).
    writeFileSync(
      path.join(project, 'design-qa.config.json'),
      JSON.stringify({ app: { baseUrl: 'http://127.0.0.1:9', auth: { type: 'storageState', storageState: '.auth/gone.json' } }, surfaces: { s: { route: '/' } } }),
    );
    const c = await exec(project, [script('capture.mjs'), '--config', 'design-qa.config.json', '--width', '320', '--height', '240', '--out', 'ev']);
    assert.equal(c.code, 2, c.out);
    const save = new RegExp(`${prefix(kind, 'setup.mjs').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} save-session`).exec(c.stderr);
    assert.ok(save, `${kind}: ${c.stderr}`);
    const r = await runsAsPrinted(project, save[0], `${kind} save-session`);
    assert.equal(r.code, 3, `${kind}: no screen, instructions printed\n${r.out}`);
  }
});

test('dismiss, triage (run refusal), review: the printed commands run as printed', { timeout: 300000 }, async (t) => {
  for (const { kind, project, script } of installs(t)) {
    const dir = path.join(project, 'qa-reports', 'abc-12');
    mkdirSync(dir, { recursive: true });
    copyFileSync(fixture('report-valid.json'), path.join(dir, 'report.json'));
    const report = 'qa-reports/abc-12/report.json';
    const d = await exec(project, [script('dismiss.mjs'), '--report', report, '--id', 'DQ-002', '--kind', 'not-an-issue', '--reason', '1px anti-aliasing', '--by', 'Maya']);
    assert.equal(d.code, 0, d.out);
    const render = /^Next: (.+)$/m.exec(d.stdout)[1];
    assert.ok(render.startsWith(prefix(kind, 'render-report.mjs')), render);
    const rr = await runsAsPrinted(project, render, `${kind} render`);
    assert.equal(rr.code, 0, rr.out);
    // review.mjs without report.html: "render it first: <command>".
    rmSync(path.join(dir, 'report.html'), { force: true });
    const rv = await exec(project, [script('review.mjs'), '--report', report, '--no-open', '--timeout-min', '1']);
    const first = /render it first: (node \S+ --in \S+ --out \S+)/.exec(rv.stderr);
    assert.ok(first, `${kind}: ${rv.stderr}`);
    assert.ok(first[1].startsWith(prefix(kind, 'render-report.mjs')));
    await runsAsPrinted(project, first[1], `${kind} review render`);
    // A folder locked by another run: "check with: <run.mjs status command>".
    writeFileSync(path.join(dir, '.design-qa-run.json'), JSON.stringify({ kind: 'design-qa-run', version: 1, runId: '20261004T113201Z-a1b2c3', status: 'active', startedAt: '2026-10-04T11:32:01Z', finishedAt: null }));
    const tr = await exec(project, [script('triage.mjs'), '--report', report, '--default', '--source', 'chat', '--run', '20261004T113202Z-bbbbbb']);
    assert.equal(tr.code, 5, tr.out);
    const status = /check with: (node \S+ status --dir \S+?)\)/.exec(tr.stderr);
    assert.ok(status && status[1].startsWith(prefix(kind, 'run.mjs')), `${kind}: ${tr.stderr}`);
    const st = await runsAsPrinted(project, status[1], `${kind} run status`);
    assert.equal(st.code, 0, st.out);
  }
});

test('figma-mcp-spec.mjs: the --spec … --state template names a script that runs', { timeout: 120000 }, async (t) => {
  for (const { kind, project, script } of installs(t)) {
    const r = await exec(project, [script('figma-mcp-spec.mjs'), '--metadata', fixture('mcp-metadata-section.xml'), '--url', 'https://www.figma.com/design/AbCdEf123/Acme?node-id=12-300', '--out', 'ev']);
    assert.equal(r.code, 0, r.out);
    const line = r.out.split('\n').find((l) => l.includes(' --spec ') && l.includes(' --state '));
    const cmd = /node \S+/.exec(line)[0];
    assert.equal(cmd, prefix(kind, 'figma-mcp-spec.mjs'));
    const help = await runsAsPrinted(project, `${cmd} --help`, `${kind} figma-mcp-spec`);
    assert.equal(help.code, 0);
  }
});
