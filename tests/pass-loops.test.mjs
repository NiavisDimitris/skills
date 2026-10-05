import { comparisonFixtureRecords } from './_helpers.mjs';
// Following pass.mjs never loses the pass or loops: status's start command keeps the folder and
// run; a review closed without Send ends at finish; following Next: repeatedly makes progress.
// Also: code changes seen in new folders and odd file names (and a note when they cannot be
// seen), the ticket converted from a saved getJiraIssue result, secrets kept out of logs,
// pass.json and output, and exactly one Next: line per output.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createPng, writePng } from '../skills/design-qa/scripts/lib/png.mjs';
import { fixture, run, script, startServer, tmpDir } from './_helpers.mjs';

const PASS = script('pass.mjs');
const ENV = { DESIGN_QA_COMMIT: '', DESIGN_QA_BRANCH: '', DESIGN_QA_RUN_ID: '', FIGMA_TOKEN: '', DESIGN_QA_APP_STORAGE_STATE: '', DESIGN_QA_NO_DISPLAY: '1', CI: '1' };
const OUTPUTS = [];
const pass = async (cwd, args) => {
  const r = await run(PASS, args, { cwd, env: ENV, timeout: 240000 });
  OUTPUTS.push({ args: args.join(' '), stdout: r.stdout });
  return r;
};
/** A printed command line, run as printed (sh -c). */
const sh = (cwd, line) =>
  new Promise((resolve) => {
    const child = spawn('sh', ['-c', line], { cwd, env: { ...process.env, NO_COLOR: '1', ...ENV } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      OUTPUTS.push({ args: line, stdout });
      resolve({ code, stdout, stderr });
    });
  });
const nextLine = (out) => out.trim().split('\n').filter((l) => l.startsWith('Next: ')).pop() ?? '';
const nextCmd = (out) => nextLine(out).replace(/^Next: /, '');
const doLines = (out) => out.trim().split('\n').filter((l) => l.startsWith('Do: ')).join('\n');
const runIdOf = (out) => /Run id: (\S+)/.exec(out)?.[1];
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));

async function chromiumLaunches() {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}
const CHROMIUM = await chromiumLaunches();
const SKIP = 'Chromium is not installed (run `npx playwright install chromium`)';

function appServer() {
  const html = readFileSync(fixture('app-drift.html'));
  const requests = [];
  return startServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
}

function project(t, server, { git = false } = {}) {
  const root = tmpDir('design-qa-loops-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    path.join(root, 'design-qa.config.json'),
    JSON.stringify({
      app: { baseUrl: server.url },
      surfaces: { profile: { route: '/profile', prototype: pathToFileURL(fixture('prototype.html')).href, states: { hover: { action: 'hover', selector: 'button', wait: 'h1' } } } },
      designSystem: { name: 'Acme UI' },
      report: { commit: false },
    }),
  );
  if (git) {
    const g = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    g('init', '-q');
    g('config', 'user.email', 'qa@example.com');
    g('config', 'user.name', 'QA');
    writeFileSync(path.join(root, '.gitignore'), 'qa-reports/\n');
    writeFileSync(path.join(root, 'app.js'), 'export const v = 1;\n');
    g('add', '.');
    g('commit', '-q', '-m', 'init');
  }
  return root;
}

/** Findings that reject everything (a fixture pass, not a review). */
function writeFindings(dir) {
  const ev = path.join(dir, 'evidence');
  const rd = (f) => (existsSync(f) ? read(f) : null);
  const rows = [];
  for (const [state, v] of Object.entries(rd(path.join(ev, 'compare.json'))?.states ?? {})) {
    for (const [kind, list] of Object.entries(v)) if (Array.isArray(list)) for (const r of list.filter((x) => x.result === 'FAIL')) rows.push({ kind, state, ...((r.elementClass ?? r._compare?.elementClass) ? { elementClass: r.elementClass ?? r._compare.elementClass } : {}), ...(r.property ? { property: r.property } : {}), ...(r.role ? { role: r.role, name: r.name } : {}) });
  }
  const audit = rd(path.join(ev, 'ds-audit.json'))?.candidates ?? [];
  const items = rd(path.join(ev, 'worklist.json'))?.items ?? [];
  writeFileSync(
    path.join(dir, 'findings.json'),
    JSON.stringify({
      kind: 'design-qa-findings',
      version: 1,
      comparisons: comparisonFixtureRecords(dir),
      findings: [],
      rejected: [
        ...(audit.length ? [{ auditKeys: audit.map((c) => c.key), reason: 'out-of-scope', detail: 'Test fixture: not what this test checks.' }] : []),
        ...rows.map((compare) => ({ compare, reason: 'false-positive', detail: 'Test fixture: not what this test checks.' })),
        ...(items.length ? [{ worklist: items.map((i) => i.key), reason: 'out-of-scope', detail: 'Test fixture: these regions are not what this test checks.' }] : []),
      ],
    }),
  );
}

/** pass.json without its clocks: what "no progress" compares. */
const passState = (dir) => {
  const f = path.join(dir, 'pass.json');
  if (!existsSync(f)) return null;
  return JSON.stringify(read(f), (k, v) => (['at', 'updatedAt', 'startedAt'].includes(k) ? undefined : v));
};

/**
 * Follow Next: from `out` up to `max` times. Stops at "nothing: the pass is finished", or when
 * a Do: line asks for something only the agent or the person can do. Fails when the same
 * command comes back twice in a row with pass.json unchanged (no progress).
 */
async function follow(root, dir, out, max = 8) {
  const seen = [];
  let prev = { cmd: null, state: passState(dir) };
  for (let i = 0; i < max; i += 1) {
    const cmd = nextCmd(out);
    if (!cmd || cmd.startsWith('nothing:')) return { seen, end: cmd };
    if (doLines(out) && i > 0) return { seen, end: 'do', out };
    const line = /pass\.mjs review /.test(cmd) ? `${cmd} --no-open --timeout-min 0.02` : cmd;
    const r = await sh(root, line);
    seen.push(cmd);
    const state = passState(dir);
    assert.ok(!(cmd === prev.cmd && state === prev.state), `no progress: "${cmd}" twice in a row with an unchanged pass.json`);
    prev = { cmd, state };
    out = r.stdout;
  }
  return { seen, end: 'max' };
}

test('a full fixture pass, then status: following Next: ends (review closed without Send → finish), never repeats without progress', { timeout: 600000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP);
  const server = await appServer();
  t.after(() => server.close());
  const root = project(t, server);
  const s = await pass(root, ['start', '--feature', 'abc-600', '--agent', 'figma-mcp=no', '--agent', 'ticket-mcp=no', '--quick']);
  assert.equal(s.code, 0, s.stdout + s.stderr);
  const dir = path.join(root, 'qa-reports', 'abc-600');
  // start → evidence → (Do: write findings) stops the follower
  const a = await follow(root, dir, s.stdout);
  assert.equal(a.end, 'do');
  writeFindings(dir);
  // report --check → report → review (closed without Send) → finish
  const b = await follow(root, dir, a.out);
  assert.ok(b.seen.some((c) => /pass\.mjs review /.test(c)), `${b.seen.join('\n')}\n${b.out}`);
  assert.equal(b.end, 'do', 'the closed review asks the person; its Next is finish');
  assert.match(doLines(b.out), /The person closed the review without sending decisions\. Ask whether to open it again/);
  assert.match(b.out, /^To open the review again instead: node \S+pass\.mjs review --dir qa-reports\/abc-600 --run \S+$/m);
  assert.match(nextCmd(b.out), /pass\.mjs finish --dir qa-reports\/abc-600 --run \S+$/);
  assert.equal(read(path.join(dir, 'pass.json')).stages.review.outcome, 'closed');
  // status agrees, and following it finishes.
  const st = await pass(root, ['status', '--dir', 'qa-reports/abc-600', '--run', runIdOf(s.stdout)]);
  assert.match(nextCmd(st.stdout), /pass\.mjs finish /);
  const end = await sh(root, nextCmd(st.stdout));
  assert.equal(nextLine(end.stdout), 'Next: nothing: the pass is finished');
});

test('status keeps the folder and run: the start command carries --dir and every recorded input; a sibling folder name is never a feature', { timeout: 300000 }, async (t) => {
  const root = tmpDir('design-qa-loops-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // A pass whose start is not ready yet (questions open): pass.json records the inputs.
  const s = await pass(root, ['start', '--feature', 'abc-601', '--url', 'http://127.0.0.1:9/checkout/cart', '--prototype', 'http://127.0.0.1:9/figma/cart', '--ticket', 'ABC-601', '--agent', 'figma-mcp=no', '--agent', 'ticket-mcp=no', '--quick']);
  const id = runIdOf(s.stdout);
  const dir = path.join(root, 'qa-reports', 'abc-601');
  const pj = read(path.join(dir, 'pass.json'));
  pj.stages.start.ready = false;
  writeFileSync(path.join(dir, 'pass.json'), JSON.stringify(pj));
  const st = await pass(root, ['status', '--dir', 'qa-reports/abc-601', '--run', id]);
  const cmd = nextCmd(st.stdout);
  for (const part of ['--feature abc-601', '--dir qa-reports/abc-601', '--url http://127.0.0.1:9/checkout/cart', '--prototype http://127.0.0.1:9/figma/cart', '--ticket ABC-601', '--agent figma-mcp=no', '--quick', `--run ${id}`]) assert.ok(cmd.includes(part), `${part} in ${cmd}`);
  await sh(root, cmd);
  assert.equal(read(path.join(dir, 'pass.json')).runId, id, 'the same run');
  assert.deepEqual(readdirSync(path.join(root, 'qa-reports')).filter((n) => !n.startsWith('.')), ['abc-601'], 'no sibling folder');

  // A sibling folder (abc-602--<run id>) locked by its run, without pass.json.
  const sib = '20261004T120000Z-abcdef';
  const sdir = path.join(root, 'qa-reports', `abc-602--${sib}`);
  mkdirSync(sdir, { recursive: true });
  writeFileSync(path.join(sdir, '.design-qa-run.json'), JSON.stringify({ kind: 'design-qa-run', version: 1, runId: sib, label: null, status: 'active', startedAt: new Date().toISOString(), finishedAt: null }));
  const st2 = await pass(root, ['status', '--dir', `qa-reports/abc-602--${sib}`, '--run', sib]);
  const cmd2 = nextCmd(st2.stdout);
  assert.match(cmd2, new RegExp(`pass\\.mjs start --feature abc-602 --dir qa-reports/abc-602--${sib} --run ${sib}$`));
  await sh(root, `${cmd2} --quick`);
  assert.equal(read(path.join(sdir, 'pass.json')).runId, sib, 'the sibling run continues in its own folder');
  assert.deepEqual(readdirSync(path.join(root, 'qa-reports')).filter((n) => n.startsWith('abc-602')), [`abc-602--${sib}`], 'no third folder');
});

test('code changes: a file in a new folder and a name with spaces make captures stale; outside git the summary and status say it cannot tell', { timeout: 600000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP);
  const server = await appServer();
  t.after(() => server.close());
  const root = project(t, server, { git: true });
  const s = await pass(root, ['start', '--feature', 'abc-603', '--agent', 'figma-mcp=no', '--agent', 'ticket-mcp=no', '--quick']);
  const id = runIdOf(s.stdout);
  const rel = 'qa-reports/abc-603';
  const ev = (args = []) => pass(root, ['evidence', '--dir', rel, '--run', id, '--only', 'capture', ...args]);
  assert.equal((await pass(root, ['evidence', '--dir', rel, '--run', id])).code, 0);
  const capturedAgain = async () => /capture\s+main 2\/2 captured$/m.test((await ev()).stdout);
  mkdirSync(path.join(root, 'src', 'Banner'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'Banner', 'Banner.js'), 'export const b = 1;\n');
  assert.ok(await capturedAgain(), 'a new untracked folder');
  writeFileSync(path.join(root, 'src', 'Banner', 'Banner.js'), 'export const b = 22;\n');
  assert.ok(await capturedAgain(), 'an edit inside the new folder');
  assert.ok(!(await capturedAgain()), 'nothing changed: up to date');
  writeFileSync(path.join(root, 'src', 'my file.js'), 'x\n');
  assert.ok(await capturedAgain(), 'a new file with a space in its name');
  writeFileSync(path.join(root, 'src', 'my file.js'), 'xy\n');
  assert.ok(await capturedAgain(), 'an edit of that file');

  // Outside a git checkout: said once in evidence and in status.
  const plain = project(t, server);
  const p = await pass(plain, ['start', '--feature', 'abc-604', '--agent', 'figma-mcp=no', '--agent', 'ticket-mcp=no', '--quick']);
  const pid = runIdOf(p.stdout);
  const e = await pass(plain, ['evidence', '--dir', 'qa-reports/abc-604', '--run', pid, '--only', 'discover']);
  assert.equal(e.stdout.match(/Cannot tell whether the code changed \(not a git checkout with a commit\)/g)?.length, 1, e.stdout);
  assert.match(e.stdout, /use --recapture after changing code\. Build output the app serves from a gitignored folder is never seen/);
  const st = await pass(plain, ['status', '--dir', 'qa-reports/abc-604', '--run', pid]);
  assert.match(st.stdout, /Cannot tell whether the code changed/);
});

test('ticket: a saved getJiraIssue result is converted; a raw ticket.json stops with a clear message', { timeout: 300000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP);
  const server = await appServer();
  t.after(() => server.close());
  const root = project(t, server);
  const s = await pass(root, ['start', '--feature', 'abc-605', '--ticket', 'ABC-12', '--agent', 'figma-mcp=no', '--agent', 'ticket-mcp=yes', '--quick']);
  assert.match(doLines(s.stdout), /save the result exactly as returned to qa-reports\/abc-605\/evidence\/jira-issue\.json \(the evidence stage converts it\)/);
  const id = runIdOf(s.stdout);
  const ev = path.join(root, 'qa-reports', 'abc-605', 'evidence');
  mkdirSync(ev, { recursive: true });
  // A raw issue saved as ticket.json: discovery would ignore it, so evidence stops.
  copyFileSync(fixture('jira-issue.json'), path.join(ev, 'ticket.json'));
  const bad = await pass(root, ['evidence', '--dir', 'qa-reports/abc-605', '--run', id]);
  assert.equal(bad.code, 3, bad.stdout);
  assert.match(bad.stdout, /ticket\.json is not a converted ticket \(no acceptanceCriteria \/ figmaUrls\)/);
  assert.match(doLines(bad.stdout), /Move that file to qa-reports\/abc-605\/evidence\/jira-issue\.json/);
  rmSync(path.join(ev, 'ticket.json'));
  copyFileSync(fixture('jira-issue.json'), path.join(ev, 'jira-issue.json'));
  const ok = await pass(root, ['evidence', '--dir', 'qa-reports/abc-605', '--run', id, '--only', 'discover']);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  const ticket = read(path.join(ev, 'ticket.json'));
  assert.equal(ticket.key, 'ABC-12');
  assert.ok(ticket.acceptanceCriteria.length > 0);
});

test('secrets: a token in --url reaches the app but never the logs, pass.json or the output; it is kept in the private file only', { timeout: 300000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP);
  const server = await appServer();
  t.after(() => server.close());
  const root = project(t, server);
  const TOKEN = 'zz9SecretShareToken7781';
  const s = await pass(root, ['start', '--feature', 'abc-606', '--url', `${server.url}/profile?share=${TOKEN}&tab=1`, '--agent', 'figma-mcp=no', '--agent', 'ticket-mcp=no', '--quick']);
  assert.equal(s.code, 0, s.stdout + s.stderr);
  const id = runIdOf(s.stdout);
  const rel = 'qa-reports/abc-606';
  const dir = path.join(root, rel);
  const e = await pass(root, ['evidence', '--dir', rel, '--run', id]);
  assert.equal(e.code, 0, e.stdout + e.stderr);
  assert.ok(server.requests.some((r) => r.url.includes(TOKEN)), 'the capture used the full URL');
  const st = await pass(root, ['status', '--dir', rel, '--run', id]);
  for (const out of [s.stdout, e.stdout, st.stdout]) assert.doesNotMatch(out, new RegExp(TOKEN));
  const check = (f) => assert.doesNotMatch(readFileSync(f, 'utf8'), new RegExp(TOKEN), f);
  check(path.join(dir, 'pass.json'));
  for (const f of readdirSync(path.join(dir, 'logs'))) check(path.join(dir, 'logs', f));
  assert.match(read(path.join(dir, 'pass.json')).url, /share=\*\*\*&tab=1$/);
  const priv = path.join(dir, '.design-qa-pass-private.json');
  assert.equal(read(priv).url, `${server.url}/profile?share=${TOKEN}&tab=1`);
  assert.equal(statSync(priv).mode & 0o777, 0o600);
  assert.doesNotMatch(nextCmd(st.stdout), /--url/, 'printed commands leave the secret URL out; the pass remembers it');
});

test('optional questions: the printed setup.mjs apply carries --no-next', { timeout: 120000 }, async (t) => {
  const root = tmpDir('design-qa-loops-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'acme', dependencies: { '@mui/material': '5.0.0' } }));
  const s = await pass(root, ['start', '--feature', 'abc-607', '--url', 'http://127.0.0.1:9/', '--prototype', 'http://127.0.0.1:9/p', '--agent', 'figma-mcp=no', '--agent', 'ticket-mcp=no', '--quick']);
  const applies = `${doLines(s.stdout)}\n${nextLine(s.stdout)}`.match(/setup\.mjs apply[^&]*/g) ?? [];
  for (const a of applies) assert.match(a, /--no-next/, a);
});

test('diff: pairs carry the frame width; a design image 2× its frame is its own stop with "export it at 1x"', { timeout: 300000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP);
  const server = await appServer();
  t.after(() => server.close());
  const root = tmpDir('design-qa-loops-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'design-qa.config.json'), JSON.stringify({ app: { baseUrl: server.url }, surfaces: { items: { route: '/items' } }, designSystem: { name: 'Acme UI' }, report: { commit: false } }));
  const figmaUrl = 'https://www.figma.com/design/AbCdEf123/Acme?node-id=1-2';
  const s = await pass(root, ['start', '--feature', 'abc-608', '--design', figmaUrl, '--agent', 'figma-mcp=yes', '--agent', 'ticket-mcp=no', '--quick']);
  const id = runIdOf(s.stdout);
  const rel = 'qa-reports/abc-608';
  const ev = path.join(root, rel, 'evidence');
  mkdirSync(ev, { recursive: true });
  const spec = await run(script('figma-mcp-spec.mjs'), ['--metadata', fixture('mcp-metadata-frame.xml'), '--url', figmaUrl, '--out', ev], { cwd: root });
  assert.equal(spec.code, 0, spec.stderr);
  mkdirSync(path.join(ev, 'figma'), { recursive: true });
  writePng(path.join(ev, 'figma', 'with-data.png'), createPng(1600, 1200, [255, 255, 255, 255]));
  const e = await pass(root, ['evidence', '--dir', rel, '--run', id]);
  assert.equal(e.code, 3, e.stdout + e.stderr);
  assert.match(e.stdout, /STOPPED at diff:main: 1 design image at the wrong scale/);
  assert.match(doLines(e.stdout), /^Do: The design image for with-data is 2× its frame: export it at 1x \(scale 1, never resized\) over qa-reports\/abc-608\/evidence\/figma\/with-data\.png\.$/m);
  assert.equal(read(path.join(ev, 'pairs.json'))['with-data'].frameWidth, 800);
  writePng(path.join(ev, 'figma', 'with-data.png'), createPng(800, 600, [255, 255, 255, 255]));
  const ok = await pass(root, ['evidence', '--dir', rel, '--run', id]);
  assert.equal(ok.code, 3, 'the diff runs; the undriven empty and hover states still stop the stage');
  assert.match(doLines(ok.stdout), /^Do: For each of empty, hover: write its driver/m);
  assert.equal(typeof read(path.join(ev, 'diff.json')).results['with-data'].percent, 'number');
});

test('every output printed above has exactly one Next: line, a command (or the finished literal), and relays no child Next:/Do: line', () => {
  assert.ok(OUTPUTS.length > 5);
  for (const { args, stdout } of OUTPUTS) {
    if (!/^(Report folder|Evidence|.*·|No |build-report|qa-reports|Finished|Refused|There is|findings\.json|Opening)/m.test(stdout) && !stdout.includes('Next:')) continue;
    const nexts = stdout.split('\n').filter((l) => l.startsWith('Next: '));
    assert.equal(nexts.length, 1, `${args}\n${stdout}`);
    const next = nexts[0].slice(6);
    if (next === 'nothing: the pass is finished') continue;
    for (const part of next.split(' && ')) assert.match(part, /^node \S+\.mjs( \S+)*$/, `${args}: ${nexts[0]}`);
  }
});

test('nobody to review: report names the finish command; finish records the review as skipped; status shows how to open it later', { timeout: 300000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP);
  const server = await appServer();
  t.after(() => server.close());
  const root = project(t, server);
  const s = await pass(root, ['start', '--feature', 'abc-609', '--agent', 'ticket-mcp=no', '--quick']);
  assert.doesNotMatch(s.stdout, /figma-mcp/, 'a coded prototype needs no Figma check');
  const id = runIdOf(s.stdout);
  const rel = 'qa-reports/abc-609';
  const dir = path.join(root, rel);
  assert.equal((await pass(root, ['evidence', '--dir', rel, '--run', id])).code, 0);
  writeFindings(dir);
  const r = await pass(root, ['report', '--dir', rel, '--run', id]);
  assert.equal(r.code, 0, r.stdout);
  const finish = /^If the person will not review now: (node \S+ finish --dir qa-reports\/abc-609 --run \S+) \(records the review as skipped/m.exec(r.stdout);
  assert.ok(finish, r.stdout);
  assert.match(nextCmd(r.stdout), /pass\.mjs review --dir qa-reports\/abc-609 --run \S+$/);
  const f = await sh(root, finish[1]);
  assert.match(f.stdout, /^Review skipped: the recommended split stands/m);
  assert.equal(read(path.join(dir, 'pass.json')).stages.review.outcome, 'skipped');
  const st = await pass(root, ['status', '--dir', rel, '--run', id]);
  assert.match(st.stdout, /^The pass is finished; the review was skipped: the recommended split stands\.$/m);
  assert.match(st.stdout, /^To open the review later: node \S+pass\.mjs review --dir qa-reports\/abc-609 --run \S+$/m);
  assert.equal(nextLine(st.stdout), 'Next: nothing: the pass is finished');
});

test('a backgrounded pass.mjs review stopped with review.mjs --stop: status says closed without Send', { timeout: 300000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP);
  const server = await appServer();
  t.after(() => server.close());
  const root = project(t, server);
  const s = await pass(root, ['start', '--feature', 'abc-610', '--agent', 'ticket-mcp=no', '--quick']);
  const id = runIdOf(s.stdout);
  const rel = 'qa-reports/abc-610';
  const dir = path.join(root, rel);
  await pass(root, ['evidence', '--dir', rel, '--run', id]);
  writeFindings(dir);
  assert.equal((await pass(root, ['report', '--dir', rel, '--run', id])).code, 0);
  const bg = spawn(process.execPath, [PASS, 'review', '--dir', rel, '--run', id, '--no-open'], { cwd: root, env: { ...process.env, ...ENV }, stdio: 'ignore' });
  const exited = new Promise((resolve) => bg.on('close', resolve));
  for (let i = 0; i < 100 && !existsSync(path.join(dir, '.design-qa-review.json')); i += 1) await new Promise((r) => setTimeout(r, 100));
  assert.ok(existsSync(path.join(dir, '.design-qa-review.json')), 'the review server registered');
  const stop = await run(script('review.mjs'), ['--stop', '--report', path.join(dir, 'report.json'), '--run', id], { cwd: root, env: ENV });
  assert.equal(stop.code, 0, stop.stdout + stop.stderr);
  await exited;
  assert.equal(read(path.join(dir, 'pass.json')).stages.review.outcome, 'closed');
  const st = await pass(root, ['status', '--dir', rel, '--run', id]);
  assert.match(doLines(st.stdout), /The person closed the review without sending decisions/);
  assert.match(nextCmd(st.stdout), /pass\.mjs finish /);
});

test('start --screen writes the screens; a first run shows what it assumed and the questions with their answers, writes no config; optional questions on a configured project', { timeout: 120000 }, async (t) => {
  const root = tmpDir('design-qa-loops-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'acme' }));
  const s = await pass(root, ['start', '--feature', 'abc-611', '--screen', 'cart=http://127.0.0.1:9/figma/cart,http://127.0.0.1:9/checkout/cart', '--screen', 'pay=http://127.0.0.1:9/figma/pay,http://127.0.0.1:9/checkout/pay', '--agent', 'ticket-mcp=no', '--quick']);
  assert.equal(s.code, 3, s.stdout + s.stderr);
  assert.ok(!existsSync(path.join(root, 'design-qa.config.json')), 'start writes no config before the person agrees');
  assert.match(s.stdout, /^Screens written to qa-reports\/abc-611\/states\.json: cart, pay$/m);
  assert.deepEqual(read(path.join(root, 'qa-reports', 'abc-611', 'states.json')).screens, {
    cart: { prototype: 'http://127.0.0.1:9/figma/cart', route: '/checkout/cart' },
    pay: { prototype: 'http://127.0.0.1:9/figma/pay', route: '/checkout/pay' },
  });
  assert.doesNotMatch(s.stdout, /skeleton/, 'screens declared: no skeleton');
  assert.match(s.stdout, /^Assumed \(not saved yet: show the person; design-qa\.config\.json gets them only through the apply below\):$/m);
  assert.match(s.stdout, /^ {2}Style values: read from the running page$/m);
  assert.match(s.stdout, /^Question \(ds-components\): Which component libraries does the app use\?$/m);
  assert.match(s.stdout, /^ {2}a\) .+ → \{"ds-components":\["[^"]+"\]\}$/m);
  assert.match(doLines(s.stdout), /^Do: Ask the person the questions above in one round, with the values under Assumed \(references\/onboarding\.md\); write their answers, as shown after the arrows, merged into one object, to qa-reports\/abc-611\/answers\.json\.$/);
  // Explanations, then the question block right above its Do: line, then Next: last.
  const out = s.stdout.trimEnd().split('\n');
  const q = out.findIndex((l) => l.startsWith('Question'));
  const firstDo = out.findIndex((l) => l.startsWith('Do: '));
  assert.ok(q > 0 && firstDo > q && out.slice(q + 1, firstDo).every((l) => l.startsWith('  ')), out.join('\n'));
  assert.equal(out.filter((l) => l.startsWith('Next: ')).length, 1);
  assert.match(out.at(-1), /^Next: node \S+setup\.mjs apply --accept-assumed --answers qa-reports\/abc-611\/answers\.json --url http:\/\/127\.0\.0\.1:9\/checkout\/cart --no-next && node \S+pass\.mjs start /);
  // The person answered nothing for the question but agreed: the printed command saves the config and restarts.
  writeFileSync(path.join(root, 'qa-reports', 'abc-611', 'answers.json'), '{}');
  const agreed = await sh(root, nextCmd(s.stdout));
  assert.equal(agreed.code, 0, agreed.stdout + agreed.stderr);
  assert.equal(read(path.join(root, 'design-qa.config.json')).app.baseUrl, 'http://127.0.0.1:9');
  // Configured now: the component question is still asked (its answer is a guess), printed with
  // its answers above its Do: line, which says what skipping it costs.
  assert.match(agreed.stdout, /^Question \(ds-components\): Which component libraries does the app use\?$/m);
  assert.doesNotMatch(agreed.stdout, /Optional question \(ds-|nothing changes/);
  assert.match(doLines(agreed.stdout), /write the answers, as shown after the arrows, merged into one object, to qa-reports\/abc-611\/answers\.json, then run node \S+setup\.mjs apply --answers qa-reports\/abc-611\/answers\.json --no-next \(skipped, the design-system check is weaker: the component check is off\)/);
  const bad = await pass(root, ['start', '--feature', 'abc-612', '--screen', 'Cart=x', '--quick']);
  assert.equal(bad.code, 2);
});

test('start: a component question answered "none" is not asked again: the check is off because the project has no library', { timeout: 120000 }, async (t) => {
  const root = tmpDir('design-qa-loops-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'acme' }));
  writeFileSync(path.join(root, 'design-qa.config.json'), JSON.stringify({ app: { baseUrl: 'http://127.0.0.1:9' }, surfaces: {}, designSystem: { tokens: [], libraries: [] }, report: { commit: false } }));
  const s = await pass(root, ['start', '--feature', 'abc-614', '--prototype', 'http://127.0.0.1:9/proto', '--agent', 'ticket-mcp=no', '--quick']);
  assert.equal(s.code, 0, s.stdout + s.stderr);
  assert.match(s.stdout, /^Component check is off: the project has no component library configured\.$/m);
  assert.doesNotMatch(s.stdout, /answer ds-components|Optional question/);
});

test('a state captured identical to with-data gets its own line and the decision as a Do:', { timeout: 300000 }, async (t) => {
  if (!CHROMIUM) return t.skip(SKIP);
  const server = await appServer();
  t.after(() => server.close());
  const root = project(t, server);
  const cfg = read(path.join(root, 'design-qa.config.json'));
  cfg.surfaces.profile.states['promo-applied'] = { query: '?promo=1' };
  // The prototype does show the state (its heading changes); the app ignores the query.
  const proto = path.join(root, 'prototype.html');
  writeFileSync(proto, readFileSync(fixture('prototype.html'), 'utf8').replace('</body>', "<script>if (location.search.includes('promo=1')) document.querySelector('h1').textContent += ' with promo';</script></body>"));
  cfg.surfaces.profile.prototype = pathToFileURL(proto).href;
  writeFileSync(path.join(root, 'design-qa.config.json'), JSON.stringify(cfg));
  const s = await pass(root, ['start', '--feature', 'abc-613', '--agent', 'ticket-mcp=no', '--quick']);
  const id = runIdOf(s.stdout);
  const e = await pass(root, ['evidence', '--dir', 'qa-reports/abc-613', '--run', id]);
  assert.equal(e.code, 0, e.stdout + e.stderr);
  // The app's capture is the default view; the coded prototype's capture of the state differs.
  assert.match(e.stdout, /^Same page: the app's capture of promo-applied is identical to the app's with-data view; the design does show a different page for it\.$/m);
  assert.match(doLines(e.stdout), /For each "Same page" state: the app may not implement it \(file a state finding, or set it MISSING_IN_CODE in qa-reports\/abc-613\/findings\.json "states" with a note\), or its driver is wrong/);
  assert.match(nextCmd(e.stdout), /pass\.mjs report --dir qa-reports\/abc-613 --run \S+ --check$/);
});
