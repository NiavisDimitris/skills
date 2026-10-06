import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, lutimesSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CliError } from '../skills/design-qa/scripts/lib/args.mjs';
import {
  EXIT_CONFLICT,
  RUN_ID_RE,
  RUN_LOCK_FILE,
  archiveOutputs,
  assertRunOwnsDir,
  assessDir,
  checkRegistration,
  registrationAlive,
  checkRunOwnership,
  newRunId,
  siblingName,
} from '../skills/design-qa/scripts/lib/run-lock.mjs';
import { escapeRegExp, run, script, tmpDir } from './_helpers.mjs';

const RUN = script('run.mjs');
const HOURS_AGO = (h) => new Date(Date.now() - h * 3_600_000);

/** <tmp>/qa-reports with the cumulative logs; runs start from <tmp>. */
function workspace(t) {
  const root = tmpDir('design-qa-run-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parent = path.join(root, 'qa-reports');
  mkdirSync(parent, { recursive: true });
  writeFileSync(path.join(parent, 'dismissed.json'), '{"version":1,"entries":[{"id":"DS-001"}]}\n');
  writeFileSync(path.join(parent, 'dismissed.md'), '# Dismissed\n');
  writeFileSync(path.join(parent, 'design-debt.json'), '{"entries":[]}\n');
  writeFileSync(path.join(parent, 'design-debt.md'), '# Debt\n');
  return { root, parent, dir: path.join(parent, 'acme-482'), rel: path.join('qa-reports', 'acme-482') };
}

/** An earlier pass's outputs in dir. */
function earlierPass(dir) {
  mkdirSync(path.join(dir, 'evidence', 'app'), { recursive: true });
  writeFileSync(path.join(dir, 'report.json'), '{"meta":{"generatedAt":"2026-10-01T10:00:00Z"},"findings":[{"id":"DQ-001","title":"wrong finding"}]}\n');
  writeFileSync(path.join(dir, 'report.html'), '<html>old</html>');
  writeFileSync(path.join(dir, 'report-fixplan.md'), '# Fix plan\n');
  writeFileSync(path.join(dir, 'state-matrix.json'), '{"states":[]}\n');
  writeFileSync(path.join(dir, 'decisions.applied.json'), '{}\n');
  writeFileSync(path.join(dir, 'evidence', 'app', 'default.png'), 'png');
}

/** Every file and link under dir (lstat, links not followed) with its content or target. */
function snapshot(dir) {
  const out = {};
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name);
      const rel = path.relative(dir, full);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) out[rel] = `-> ${readlinkSync(full)}`;
      else if (st.isDirectory()) {
        out[rel] = 'dir';
        walk(full);
      } else out[rel] = `${readFileSync(full, 'utf8')} @${st.mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}

/** Make everything under dir look untouched for `hours`. */
function age(dir, hours) {
  const when = HOURS_AGO(hours);
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        lutimesSync(full, when, when);
        continue;
      }
      if (st.isDirectory()) walk(full);
      utimesSync(full, when, when);
    }
  };
  walk(dir);
}

const start = (ws, args = [], opts = {}) => run(RUN, ['start', '--dir', ws.rel, '--json', ...args], { cwd: ws.root, ...opts });
const json = (r) => JSON.parse(r.stdout);
const lockOf = (dir) => JSON.parse(readFileSync(path.join(dir, RUN_LOCK_FILE), 'utf8'));
const logs = (ws) => ['dismissed.json', 'dismissed.md', 'design-debt.json', 'design-debt.md'].map((f) => readFileSync(path.join(ws.parent, f), 'utf8'));

test('run.mjs start: a new folder is created and locked; text output names the folder and the run id', async (t) => {
  const ws = workspace(t);
  const r = await run(RUN, ['start', '--dir', ws.rel, '--label', 'Opus 5.5'], { cwd: ws.root });
  assert.equal(r.code, 0, r.stderr);
  const lock = lockOf(ws.dir);
  assert.match(lock.runId, RUN_ID_RE);
  assert.equal(lock.kind, 'design-qa-run');
  assert.equal(lock.label, 'Opus 5.5');
  assert.equal(lock.status, 'active');
  assert.equal(lock.finishedAt, null);
  assert.ok(!Number.isNaN(Date.parse(lock.startedAt)));
  assert.match(r.stdout, new RegExp(`^Run ${lock.runId} \\(Opus 5\\.5\\) started in qa-reports/acme-482\\.\\nUse: qa-reports/acme-482\\nRun id: ${lock.runId}\\n$`));
  assert.deepEqual(readdirSync(ws.parent).filter((n) => n.startsWith('.')), [], 'the start mutex is gone');

  // The same run starting again (--run) continues; nothing is archived.
  writeFileSync(path.join(ws.dir, 'report.json'), '{}');
  const again = await start(ws, ['--run', lock.runId]);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(json(again).state, 'continued');
  assert.equal(json(again).runId, lock.runId);
  assert.ok(existsSync(path.join(ws.dir, 'report.json')));
  assert.ok(!existsSync(path.join(ws.dir, 'archive')));
});

test('run.mjs start: an earlier pass is moved to the archive, nothing is deleted, the parent logs are untouched', async (t) => {
  const ws = workspace(t);
  earlierPass(ws.dir);
  const outside = path.join(ws.root, 'outside.txt');
  writeFileSync(outside, 'outside');
  let linked = false;
  try {
    symlinkSync(outside, path.join(ws.dir, 'report-backfill.md'));
    linked = true;
  } catch {
    // no symlinks on this platform
  }
  age(ws.dir, 2);
  const before = snapshot(ws.dir);
  const logsBefore = logs(ws);

  const r = await start(ws, ['--label', 'Agent B']);
  assert.equal(r.code, 0, r.stderr);
  const out = json(r);
  assert.equal(out.state, 'archived');
  assert.equal(out.previous, null, 'the earlier pass had no lock');
  assert.match(out.archived.name, /^pass-\d{8}T\d{6}Z$/);
  const archive = path.join(ws.dir, 'archive', out.archived.name);
  assert.equal(out.archived.path, path.join(ws.rel, 'archive', out.archived.name).split(path.sep).join('/'));
  // Everything moved, byte for byte (mtimes kept by rename), and only the new lock and the archive remain.
  assert.deepEqual(snapshot(archive), before);
  assert.deepEqual(readdirSync(ws.dir).sort(), [RUN_LOCK_FILE, 'archive']);
  assert.deepEqual(logs(ws), logsBefore, 'dismissed and debt logs untouched');
  assert.equal(lockOf(ws.dir).runId, out.runId);
  assert.equal(lockOf(ws.dir).archive, `archive/${out.archived.name}`);
  if (linked) {
    assert.ok(lstatSync(path.join(archive, 'report-backfill.md')).isSymbolicLink(), 'a symlink is moved as a link');
    assert.equal(readFileSync(outside, 'utf8'), 'outside');
  }

  // A finished pass with a lock goes to archive/<its run id>, its lock marked archived.
  const finished = await run(RUN, ['finish', '--dir', ws.rel, '--run', out.runId], { cwd: ws.root });
  assert.equal(finished.code, 0, finished.stderr);
  assert.match(finished.stdout, new RegExp(`^Finished run ${out.runId} in qa-reports/acme-482\\.`));
  writeFileSync(path.join(ws.dir, 'report.json'), '{"meta":{"generatedAt":"2026-10-04T10:00:00Z"},"scorecard":{"verdict":"FAIL"}}');
  const third = await start(ws, ['--label', 'Third']);
  assert.equal(third.code, 0, third.stderr);
  const t3 = json(third);
  assert.equal(t3.state, 'archived');
  assert.equal(t3.archived.name, out.runId);
  assert.deepEqual(t3.previous, { runId: out.runId, label: 'Agent B', startedAt: out.startedAt, status: 'finished', finishedAt: lockOf(path.join(ws.dir, 'archive', out.runId)).finishedAt });
  const archivedLock = lockOf(path.join(ws.dir, 'archive', out.runId));
  assert.equal(archivedLock.status, 'finished');
  assert.equal(archivedLock.archivedBy, t3.runId);
  assert.deepEqual(readdirSync(path.join(ws.dir, 'archive')).sort(), [out.archived.name, out.runId].sort());
  assert.deepEqual(logs(ws), logsBefore);

  const list = await run(RUN, ['archives', '--dir', ws.rel, '--json'], { cwd: ws.root });
  assert.equal(list.code, 0, list.stderr);
  const archives = JSON.parse(list.stdout).archives;
  assert.equal(archives.length, 2);
  const byName = Object.fromEntries(archives.map((a) => [a.name, a]));
  assert.equal(byName[out.runId].reportGeneratedAt, '2026-10-04T10:00:00Z');
  assert.equal(byName[out.runId].verdict, 'FAIL');
  assert.equal(byName[out.archived.name].reportGeneratedAt, '2026-10-01T10:00:00Z');
  const text = await run(RUN, ['archives', '--dir', ws.rel], { cwd: ws.root });
  assert.match(text.stdout, /never reads findings from them/);
  assert.match(text.stdout, new RegExp(`${out.runId}: run ${out.runId} \\(Agent B\\), finished .* report generated 2026-10-04T10:00:00Z, FAIL`));
});

test('run.mjs start --resume keeps the earlier outputs and records the run it continues', async (t) => {
  const ws = workspace(t);
  const first = await start(ws, ['--label', 'A']);
  earlierPass(ws.dir);
  assert.equal((await run(RUN, ['finish', '--dir', ws.rel, '--run', json(first).runId], { cwd: ws.root })).code, 0);
  const before = snapshot(ws.dir);
  delete before[RUN_LOCK_FILE];
  const r = await start(ws, ['--resume', '--label', 'B']);
  assert.equal(r.code, 0, r.stderr);
  const out = json(r);
  assert.equal(out.state, 'resumed');
  assert.notEqual(out.runId, json(first).runId);
  assert.equal(out.previous.runId, json(first).runId);
  assert.equal(out.archived, null);
  const after = snapshot(ws.dir);
  delete after[RUN_LOCK_FILE];
  assert.deepEqual(after, before, 'outputs kept as they were');
  assert.equal(lockOf(ws.dir).previous.runId, json(first).runId);
  const text = await run(RUN, ['start', '--dir', ws.rel, '--run', out.runId], { cwd: ws.root });
  assert.match(text.stdout, new RegExp(`^Run ${out.runId} \\(B\\) continues in qa-reports/acme-482\\.`));
});

test('run.mjs start: a folder another run is using is never touched; this run gets a locked sibling folder (exit 3)', async (t) => {
  const ws = workspace(t);
  const a = json(await start(ws, ['--label', 'Agent A']));
  earlierPass(ws.dir);
  const before = snapshot(ws.dir);

  const b = await start(ws, ['--label', 'Agent B']);
  assert.equal(b.code, 3, b.stderr);
  const out = json(b);
  assert.equal(out.state, 'busy');
  assert.equal(out.ok, true);
  assert.equal(out.busyDir, ws.rel.split(path.sep).join('/'));
  assert.equal(out.dir, `qa-reports/acme-482--${out.runId}`);
  assert.equal(out.heldBy.runId, a.runId);
  assert.equal(out.heldBy.label, 'Agent A');
  assert.equal(out.heldBy.state, 'active');
  const sibling = path.join(ws.parent, `acme-482--${out.runId}`);
  assert.deepEqual(readdirSync(sibling), [RUN_LOCK_FILE]);
  assert.equal(lockOf(sibling).runId, out.runId);
  assert.equal(lockOf(sibling).siblingOf, 'acme-482');
  assert.deepEqual(snapshot(ws.dir), before, 'the busy folder is byte-for-byte untouched');

  // Text output; --resume and --take-over never act on an active run.
  const text = await run(RUN, ['start', '--dir', ws.rel, '--label', 'Opus'], { cwd: ws.root });
  assert.equal(text.code, 3);
  assert.match(text.stdout, new RegExp(`^Busy: qa-reports/acme-482 belongs to run ${a.runId} \\(Agent A\\), started .*It was not touched\\.\\n`));
  assert.match(text.stdout, /\nUse: qa-reports\/acme-482--\d{8}T\d{6}Z-[0-9a-f]{6}\nRun id: /);
  const resume = await start(ws, ['--resume']);
  assert.equal(resume.code, EXIT_CONFLICT);
  assert.equal(json(resume).state, 'refused');
  assert.match(json(resume).reason, /--resume continues only your own run/);
  const takeOver = await start(ws, ['--take-over']);
  assert.equal(takeOver.code, 3);
  assert.match(json(takeOver).notes[0], /--take-over refused: that run is active/);
  assert.deepEqual(snapshot(ws.dir), before, 'still untouched');

  // A sibling's sibling is named after the feature, not after the sibling.
  assert.equal(siblingName(sibling, '20261004T120000Z-abcdef'), 'acme-482--20261004T120000Z-abcdef');
  assert.equal(siblingName('/x/we ird', '20261004T120000Z-abcdef'), 'run--20261004T120000Z-abcdef');
});

test('run.mjs start: two starts at the same moment on a finished folder: one archives it, the other gets a sibling', async (t) => {
  const ws = workspace(t);
  const first = json(await start(ws));
  earlierPass(ws.dir);
  assert.equal((await run(RUN, ['finish', '--dir', ws.rel, '--run', first.runId], { cwd: ws.root })).code, 0);
  const both = await Promise.all([start(ws, ['--label', 'one']), start(ws, ['--label', 'two'])]);
  const codes = both.map((r) => r.code).sort();
  assert.deepEqual(codes, [0, 3], both.map((r) => r.stdout + r.stderr).join('\n'));
  const winner = json(both.find((r) => r.code === 0));
  const loser = json(both.find((r) => r.code === 3));
  assert.equal(winner.state, 'archived');
  assert.equal(loser.heldBy.runId, winner.runId);
  assert.equal(lockOf(ws.dir).runId, winner.runId);
});

test('run.mjs start: a stale (abandoned) run is archived by default and this pass starts fresh; nothing is deleted', async (t) => {
  const ws = workspace(t);
  const old = json(await start(ws, ['--label', 'Crashed']));
  earlierPass(ws.dir);
  age(ws.dir, 2);
  const before = snapshot(ws.dir);
  delete before[RUN_LOCK_FILE];
  const logsBefore = logs(ws);

  // Within the idle window (flag or env) the same lock is still active: a sibling, the folder untouched.
  const patient = await start(ws, ['--idle-min', '600']);
  assert.equal(patient.code, 3);
  assert.equal((await start(ws, [], { env: { DESIGN_QA_RUN_IDLE_MIN: 'abc' } })).code, 2);
  const patientEnv = await start(ws, [], { env: { DESIGN_QA_RUN_IDLE_MIN: '600' } });
  assert.equal(patientEnv.code, 3);
  for (const r of [patient, patientEnv]) rmSync(path.join(ws.parent, `acme-482--${json(r).runId}`), { recursive: true });
  assert.equal(assessDir(ws.dir).state, 'stale', 'two hours idle is past the 60-minute default');

  const r = await start(ws, ['--label', 'Next']);
  assert.equal(r.code, 0, r.stderr);
  const out = json(r);
  assert.equal(out.state, 'archived');
  assert.equal(out.ok, true);
  assert.equal(out.dir, ws.rel.split(path.sep).join('/'), 'the canonical folder, not a sibling');
  assert.equal(out.takenOverFrom, old.runId);
  assert.equal(out.previous.runId, old.runId);
  assert.equal(out.archived.name, old.runId);
  assert.match(out.notes[0], new RegExp(`^The earlier run ${old.runId} \\(Crashed\\), started \\S+, was never finished and nothing changed for 1\\d\\d(\\.\\d)? min: it looks abandoned, so this run took the folder over\\.$`));
  assert.equal(out.notes[1], `Its outputs were moved, not deleted, to qa-reports/acme-482/archive/${old.runId}.`);
  const archive = path.join(ws.dir, 'archive', old.runId);
  const archived = snapshot(archive);
  delete archived[RUN_LOCK_FILE];
  assert.deepEqual(archived, before, 'every output moved, byte for byte');
  const archivedLock = lockOf(archive);
  assert.equal(archivedLock.runId, old.runId);
  assert.equal(archivedLock.status, 'abandoned');
  assert.equal(archivedLock.archivedBy, out.runId);
  assert.deepEqual(readdirSync(ws.dir).sort(), [RUN_LOCK_FILE, 'archive']);
  assert.equal(lockOf(ws.dir).takenOverFrom, old.runId);
  assert.deepEqual(logs(ws), logsBefore, 'dismissed and debt logs untouched');
  assert.ok(!readdirSync(ws.parent).some((n) => n.startsWith('acme-482--')), 'no sibling folder');

  const text = await run(RUN, ['start', '--dir', ws.rel], { cwd: ws.root });
  assert.equal(text.code, 3, 'the new run is active now');
  rmSync(path.join(ws.parent, readdirSync(ws.parent).find((n) => n.startsWith('acme-482--'))), { recursive: true });
  writeFileSync(path.join(ws.dir, 'report.json'), '{}');
  age(ws.dir, 2);
  const again = await run(RUN, ['start', '--dir', ws.rel], { cwd: ws.root });
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, new RegExp(`^Run \\S+ started in qa-reports/acme-482\\.\\nThe earlier pass \\(run ${out.runId} \\(Next\\), started \\S+, abandoned\\) was moved, not deleted, to qa-reports/acme-482/archive/${out.runId} \\(2 item\\(s\\)\\)\\.\\n`));
  assert.match(again.stdout, /looks abandoned, so this run took the folder over\.\n.*moved, not deleted.*\nUse: qa-reports\/acme-482\n/s);
  assert.deepEqual(readdirSync(path.join(ws.dir, 'archive')).sort(), [old.runId, out.runId].sort(), 'both earlier passes kept');
});

test('run.mjs start --resume on a stale (abandoned) run continues its pass in place, without --take-over', async (t) => {
  const ws = workspace(t);
  const old = json(await start(ws, ['--label', 'Crashed']));
  earlierPass(ws.dir);
  age(ws.dir, 2);
  const before = snapshot(ws.dir);
  delete before[RUN_LOCK_FILE];
  const r = await start(ws, ['--resume', '--label', 'Rescue']);
  assert.equal(r.code, 0, r.stderr);
  const out = json(r);
  assert.equal(out.state, 'resumed');
  assert.notEqual(out.runId, old.runId);
  assert.equal(out.previous.runId, old.runId);
  assert.equal(out.takenOverFrom, old.runId);
  assert.equal(out.archived, null);
  assert.match(out.notes[0], /looks abandoned, so this run took the folder over\.$/);
  const after = snapshot(ws.dir);
  delete after[RUN_LOCK_FILE];
  assert.deepEqual(after, before, 'outputs kept as they were; nothing deleted or moved');
  assert.ok(!existsSync(path.join(ws.dir, 'archive')));
  assert.equal(lockOf(ws.dir).previous.runId, old.runId);
  assert.equal(lockOf(ws.dir).status, 'active');
});

test('run.mjs start: recent outputs without a lock count as a run in progress; --take-over overrides that one', async (t) => {
  const ws = workspace(t);
  earlierPass(ws.dir);
  const busy = await start(ws);
  assert.equal(busy.code, 3);
  assert.equal(json(busy).heldBy.runId, null);
  assert.match((await run(RUN, ['start', '--dir', ws.rel], { cwd: ws.root })).stdout, /^Busy: qa-reports\/acme-482 belongs to a pass without a run lock/);
  const took = await start(ws, ['--take-over']);
  assert.equal(took.code, 0, took.stderr);
  assert.equal(json(took).state, 'archived');
  assert.equal(json(took).takenOverFrom, 'unlocked');
});

test('run.mjs start: a live review server registered in the folder keeps it active, even when idle and finished', async (t) => {
  const ws = workspace(t);
  const a = json(await start(ws));
  earlierPass(ws.dir);
  writeFileSync(
    path.join(ws.dir, '.design-qa-review.json'),
    JSON.stringify({ kind: 'design-qa-review', version: 1, id: 'f'.repeat(32), pid: process.pid, port: 9, host: (await import('node:os')).hostname(), startedAt: new Date().toISOString(), runId: a.runId }),
  );
  assert.equal((await run(RUN, ['finish', '--dir', ws.rel, '--run', a.runId], { cwd: ws.root })).code, 0);
  age(ws.dir, 5);
  assert.equal(assessDir(ws.dir).state, 'active');
  const r = await start(ws, ['--take-over']);
  assert.equal(r.code, 3);
  assert.equal(json(r).heldBy.reviewServer.pid, process.pid);

  // A dead server's registration does not: the finished pass is archived and the registration dropped.
  writeFileSync(path.join(ws.dir, '.design-qa-review.json'), JSON.stringify({ kind: 'design-qa-review', version: 1, id: 'f'.repeat(32), pid: 2 ** 22 + 12345, port: 9, startedAt: '2026-10-04T00:00:00Z' }));
  age(ws.dir, 5);
  const fresh = await start(ws);
  assert.equal(fresh.code, 0, fresh.stderr);
  assert.equal(json(fresh).state, 'archived');
  assert.ok(!existsSync(path.join(ws.dir, '.design-qa-review.json')));
});

test('run.mjs status and finish', async (t) => {
  const ws = workspace(t);
  const none = await run(RUN, ['status', '--dir', ws.rel, '--json'], { cwd: ws.root });
  assert.equal(none.code, 0);
  assert.equal(JSON.parse(none.stdout).state, 'missing');
  const a = json(await start(ws, ['--label', 'Opus']));
  writeFileSync(path.join(ws.dir, '.design-qa-review.json'), JSON.stringify({ kind: 'design-qa-review', version: 1, id: 'a'.repeat(32), pid: 2 ** 22 + 12345, port: 9, startedAt: '2026-10-04T00:00:00Z' }));
  const s = JSON.parse((await run(RUN, ['status', '--dir', ws.rel, '--json'], { cwd: ws.root })).stdout);
  assert.equal(s.state, 'active');
  assert.equal(s.lock.runId, a.runId);
  assert.equal(s.lock.label, 'Opus');
  assert.equal(s.lock.status, 'active');
  assert.equal(s.reviewServer.answering, false);
  assert.equal(s.reviewServer.port, 9);
  assert.equal(s.archives, 0);
  const text = await run(RUN, ['status', '--dir', ws.rel], { cwd: ws.root });
  assert.match(text.stdout, new RegExp(`^qa-reports/acme-482 is in use: run ${a.runId} \\(Opus\\)`));
  assert.match(text.stdout, /Review server: a stale registration \(pid \d+, port 9\): its process is gone \(nothing listens on port 9\)\. Any link to it is dead; the next start removes it\./);

  // finish refuses another run's id, a missing or malformed id; nothing changes.
  const lockBefore = readFileSync(path.join(ws.dir, RUN_LOCK_FILE), 'utf8');
  const wrong = await run(RUN, ['finish', '--dir', ws.rel, '--run', '20260101T000000Z-abcdef'], { cwd: ws.root });
  assert.equal(wrong.code, EXIT_CONFLICT);
  assert.match(wrong.stderr, new RegExp(`held by run ${a.runId} \\(Opus\\), not by run 20260101T000000Z-abcdef\\. Nothing was changed`));
  assert.equal((await run(RUN, ['finish', '--dir', ws.rel], { cwd: ws.root, env: { DESIGN_QA_RUN_ID: '' } })).code, 2);
  assert.equal((await run(RUN, ['finish', '--dir', ws.rel, '--run', '../../etc'], { cwd: ws.root })).code, 2);
  assert.equal(readFileSync(path.join(ws.dir, RUN_LOCK_FILE), 'utf8'), lockBefore);
  const wrongJson = await run(RUN, ['finish', '--dir', ws.rel, '--json'], { cwd: ws.root, env: { DESIGN_QA_RUN_ID: '20260101T000000Z-abcdef' } });
  assert.equal(wrongJson.code, EXIT_CONFLICT);
  assert.equal(JSON.parse(wrongJson.stdout).ok, false);

  const ok = await run(RUN, ['finish', '--dir', ws.rel, '--json'], { cwd: ws.root, env: { DESIGN_QA_RUN_ID: a.runId } });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).state, 'finished');
  assert.equal(lockOf(ws.dir).status, 'finished');
  assert.equal(JSON.parse((await run(RUN, ['status', '--dir', ws.rel, '--json'], { cwd: ws.root })).stdout).state, 'finished');
  const noLock = await run(RUN, ['finish', '--dir', path.join('qa-reports', 'other'), '--run', a.runId], { cwd: ws.root });
  assert.equal(noLock.code, EXIT_CONFLICT);
});

test('run.mjs: unsafe --dir values are refused and nothing is created', async (t) => {
  const ws = workspace(t);
  const feature = path.join(ws.parent, 'feature-a');
  mkdirSync(feature);
  writeFileSync(path.join(feature, 'report.json'), '{}');
  const holder = path.join(ws.root, 'reports');
  mkdirSync(path.join(holder, 'f1'), { recursive: true });
  writeFileSync(path.join(holder, 'f1', RUN_LOCK_FILE), '{}');
  const repo = path.join(ws.root, 'repo');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  writeFileSync(path.join(ws.root, 'file.txt'), 'x');
  const archived = path.join(feature, 'archive', 'old');
  mkdirSync(archived, { recursive: true });
  writeFileSync(path.join(feature, RUN_LOCK_FILE), '{}');
  let link = null;
  try {
    symlinkSync(feature, path.join(ws.root, 'link'));
    link = 'link';
  } catch {
    // no symlinks
  }
  const before = snapshot(ws.root);
  const cases = [
    [path.parse(ws.root).root, /filesystem root/],
    ['.', /working directory or one of its parents/],
    ['..', /working directory or one of its parents/],
    ['qa-reports', /holds dismissed\.json/],
    ['repo', /holds \.git/],
    ['reports', /sub-folder f1 is a report folder/],
    ['file.txt', /not a folder/],
    [path.join('qa-reports', 'feature-a', 'archive', 'old'), /inside the archive of an earlier pass/],
    ...(link ? [[link, /symbolic link/]] : []),
  ];
  for (const [dir, why] of cases) {
    const r = await run(RUN, ['start', '--dir', dir], { cwd: ws.root });
    assert.equal(r.code, 2, `${dir}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, why, dir);
  }
  assert.deepEqual(snapshot(ws.root), before, 'nothing created or moved');
  assert.equal((await run(RUN, ['start'], { cwd: ws.root })).code, 2);
  assert.equal((await run(RUN, ['nope', '--dir', 'x'], { cwd: ws.root })).code, 2);
  assert.equal((await run(RUN, ['start', '--dir', 'x', '--label', '\n'], { cwd: ws.root })).code, 2);
  assert.equal((await run(RUN, ['--help'])).code, 0);
});

test('lib/run-lock: checkRunOwnership and assertRunOwnsDir for other scripts', async (t) => {
  const ws = workspace(t);
  assert.match(newRunId(new Date('2026-10-04T11:32:01.123Z')), /^20261004T113201Z-[0-9a-f]{6}$/);
  mkdirSync(ws.dir);
  assert.deepEqual(checkRunOwnership(ws.dir, { runId: null }), { ok: true, lock: null });
  assert.equal(checkRunOwnership(ws.dir, { runId: null, required: true }).ok, false);
  assert.equal(checkRunOwnership(ws.dir, { runId: '20261004T113201Z-aaaaaa' }).ok, true, 'an unlocked folder is fine unless required');
  assert.match(checkRunOwnership(ws.dir, { runId: '20261004T113201Z-aaaaaa', required: true }).reason, /has no run lock/);
  const a = json(await start(ws, ['--label', 'Opus']));
  assert.equal(checkRunOwnership(ws.dir, { runId: a.runId }).ok, true);
  assert.equal(assertRunOwnsDir(ws.dir, { runId: a.runId }).runId, a.runId);
  const other = checkRunOwnership(ws.dir, { runId: '20261004T113201Z-bbbbbb' });
  assert.equal(other.ok, false);
  assert.match(other.reason, new RegExp(`belongs to run ${a.runId} \\(Opus\\), started .*; you are run 20261004T113201Z-bbbbbb\\. Do not write to it or delete it`));
  assert.throws(
    () => assertRunOwnsDir(ws.dir, { runId: '20261004T113201Z-bbbbbb' }),
    (err) => err instanceof CliError && err.exitCode === EXIT_CONFLICT && /you are run 20261004T113201Z-bbbbbb/.test(err.message),
  );
});

test('run.mjs: concurrent starts from separate processes never share a folder', async (t) => {
  const ws = workspace(t);
  // Five agents starting on the same new feature at once: one owns it, four get siblings.
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [RUN, 'start', '--dir', ws.rel, '--json', '--label', `agent-${i}`], { cwd: ws.root, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.on('close', (code) => resolve({ code, out: JSON.parse(stdout) }));
      }),
    ),
  );
  assert.deepEqual(results.map((r) => r.code).sort(), [0, 3, 3, 3, 3]);
  const dirs = new Set(results.map((r) => r.out.dir));
  assert.equal(dirs.size, 5);
  for (const r of results) assert.equal(lockOf(path.join(ws.root, r.out.dir)).runId, r.out.runId);
});

/* ===== Only report folders are archived or taken; registrations and mtimes cannot keep a folder busy for ever ===== */

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' });

/** <tmp>/repo: a git repository with source under src/ (old, so it looks like an abandoned unlocked pass). */
function sourceRepo(t, { commit = false } = {}) {
  const root = tmpDir('design-qa-src-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'src', 'components'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};\n');
  writeFileSync(path.join(root, 'src', 'components', 'Button.tsx'), 'export const Button = () => null;\n');
  if (hasGit) {
    git(root, 'init', '-q');
    if (commit) {
      git(root, 'add', '.');
      git(root, 'commit', '-q', '-m', 'src');
    }
  }
  age(path.join(root, 'src'), 24);
  return root;
}

test('run.mjs start never archives a source folder: a folder holding anything design-qa never writes is refused (exit 2)', async (t) => {
  const root = sourceRepo(t);
  const before = snapshot(root);
  for (const args of [[], ['--take-over'], ['--resume']]) {
    const r = await run(RUN, ['start', '--dir', 'src', ...args], { cwd: root });
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /refusing --dir src: it is not a report folder: it holds components, index\.ts but neither a run lock nor any pass output \(pass\.json, report\.json, state-matrix\.json, findings\.json, evidence, report\.html\)\..*Nothing was moved/);
  }
  assert.deepEqual(snapshot(root), before, 'nothing moved, nothing created');

  // The folder a buggy earlier start left behind (a lock and an archive next to the source): still refused.
  writeFileSync(path.join(root, 'src', RUN_LOCK_FILE), JSON.stringify({ kind: 'design-qa-run', version: 1, runId: '20251231T220000Z-abcdef', status: 'active', startedAt: '2025-12-31T22:00:00Z' }));
  mkdirSync(path.join(root, 'src', 'archive'));
  age(path.join(root, 'src'), 24);
  const locked = snapshot(root);
  const again = await run(RUN, ['start', '--dir', 'src'], { cwd: root });
  assert.equal(again.code, 2);
  assert.match(again.stderr, /it is not a report folder: it holds components\/, index\.ts, which a report folder never holds/);
  assert.deepEqual(snapshot(root), locked);

  // The library refuses too, before it moves anything.
  assert.throws(() => archiveOutputs(path.join(root, 'src')), (err) => err instanceof CliError && err.exitCode === 2 && /not a report folder/.test(err.message));
  assert.deepEqual(snapshot(root), locked);
});

test('run.mjs start: a folder of known names but no pass output, or with git-tracked files that are not report outputs, is refused', async (t) => {
  const ws = workspace(t);
  mkdirSync(path.join(ws.dir, 'logs'), { recursive: true });
  writeFileSync(path.join(ws.dir, 'logs', 'capture.log'), 'x');
  const onlyLogs = await start(ws);
  assert.equal(onlyLogs.code, 2);
  assert.match(onlyLogs.stderr, /it holds logs but neither a run lock nor any pass output \(pass\.json, report\.json/);
  assert.ok(existsSync(path.join(ws.dir, 'logs', 'capture.log')));

  if (!hasGit) return t.skip('git is not installed');
  // Source code tracked by git inside an output-named folder (evidence/app.ts): refused.
  const root = sourceRepo(t);
  const dir = path.join(root, 'qa', 'feature');
  mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  writeFileSync(path.join(dir, 'evidence', 'app.ts'), 'export {};\n');
  git(root, 'add', 'qa');
  age(dir, 24);
  const before = snapshot(dir);
  const r = await run(RUN, ['start', '--dir', path.join('qa', 'feature')], { cwd: root });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /it holds files tracked by git that are not report outputs \(evidence\/app\.ts\); a run never archives source files/);
  assert.deepEqual(snapshot(dir), before);

  // A committed source folder is refused as well (tracked and unknown).
  const committed = sourceRepo(t, { commit: true });
  const c = await run(RUN, ['start', '--dir', 'src'], { cwd: committed });
  assert.equal(c.code, 2);
});

test('run.mjs start: a committed report folder (tracked report.json and evidence) is still archived normally', { skip: !hasGit && 'git is not installed' }, async (t) => {
  const ws = workspace(t);
  earlierPass(ws.dir);
  git(ws.root, 'init', '-q');
  git(ws.root, 'add', '.');
  git(ws.root, 'commit', '-q', '-m', 'reports');
  age(ws.dir, 2);
  const before = snapshot(ws.dir);
  const r = await start(ws);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(json(r).state, 'archived');
  assert.deepEqual(snapshot(path.join(ws.dir, 'archive', json(r).archived.name)), before);
});

test('lib/run-lock: a registration that never answers cannot keep a folder busy for ever, whatever its host name', async (t) => {
  const ws = workspace(t);
  const os = await import('node:os');
  const reg = (o) => ({ kind: 'design-qa-review', version: 1, id: 'b'.repeat(32), pid: process.pid, port: 9, host: os.hostname(), startedAt: new Date().toISOString(), ...o });
  const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
  // Without asking: another host name counts only while young.
  assert.equal(registrationAlive(reg({ host: 'other.local' })), true);
  assert.equal(registrationAlive(reg({ host: 'other.local', startedAt: hoursAgo(3) })), false);
  assert.equal(registrationAlive(reg({ host: 'other.local', startedAt: 'garbage' })), false);
  // Asking: a port that does not answer is stale once old, alive (maybe busy) while young; a dead pid is stale at once.
  assert.deepEqual(
    { ...(await checkRegistration(reg({ host: 'other.local', startedAt: hoursAgo(3) }))), reason: null },
    { alive: false, answering: false, stale: true, reason: null, info: null },
  );
  assert.equal((await checkRegistration(reg({ startedAt: hoursAgo(3) }))).stale, true, 'this host, live pid, never answers, old');
  assert.equal((await checkRegistration(reg({}))).alive, true, 'young: may still be starting');
  assert.equal((await checkRegistration(reg({ pid: 2 ** 22 + 12345 }))).stale, true);

  // start on a finished pass with a crashed server registered from another host name, three hours ago:
  // the folder is not busy any more; it is archived and the registration dropped (before: a sibling for ever).
  const a = json(await start(ws));
  earlierPass(ws.dir);
  assert.equal((await run(RUN, ['finish', '--dir', ws.rel, '--run', a.runId], { cwd: ws.root })).code, 0);
  writeFileSync(path.join(ws.dir, '.design-qa-review.json'), JSON.stringify(reg({ host: 'old-name.local', startedAt: hoursAgo(3) })));
  age(ws.dir, 2);
  const status = JSON.parse((await run(RUN, ['status', '--dir', ws.rel, '--json'], { cwd: ws.root })).stdout);
  assert.equal(status.state, 'finished');
  assert.equal(status.reviewServer.stale, true);
  const r = await start(ws);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(json(r).state, 'archived');
  assert.ok(!existsSync(path.join(ws.dir, '.design-qa-review.json')));
});

test('lib/run-lock: a modification time in the future (clock skew) does not keep a run active', async (t) => {
  const ws = workspace(t);
  const old = json(await start(ws, ['--label', 'Skewed']));
  earlierPass(ws.dir);
  age(ws.dir, 3);
  const tomorrow = new Date(Date.now() + 86_400_000);
  utimesSync(path.join(ws.dir, 'report.json'), tomorrow, tomorrow);
  const a = assessDir(ws.dir);
  assert.equal(a.state, 'stale', 'a file dated tomorrow says nothing about activity');
  assert.ok(a.idleMs > 2 * 3_600_000);
  // A time a little ahead (within 2 minutes) counts as now: that run is active.
  const soon = new Date(Date.now() + 60_000);
  utimesSync(path.join(ws.dir, 'report.json'), soon, soon);
  assert.equal(assessDir(ws.dir).state, 'active');
  assert.equal(assessDir(ws.dir).idleMs, 0);
  utimesSync(path.join(ws.dir, 'report.json'), tomorrow, tomorrow);
  const r = await start(ws);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(json(r).takenOverFrom, old.runId);
});

test('run.mjs start: a report folder may hold extra data files (answers, a saved message, notes); they are kept and archived with the pass', async (t) => {
  const ws = workspace(t);
  const a = json(await start(ws));
  earlierPass(ws.dir);
  const extras = { 'answers.json': '{"surface":"orders"}', 'backfill-details.json': '{}', 'review-message.txt': 'Apply my design QA review', 'notes.md': '# notes', 'data.csv': 'a,b', 'shot.jpg': 'jpg' };
  for (const [name, text] of Object.entries(extras)) writeFileSync(path.join(ws.dir, name), text);
  assert.equal((await run(RUN, ['finish', '--dir', ws.rel, '--run', a.runId], { cwd: ws.root })).code, 0);
  age(ws.dir, 2);
  const before = snapshot(ws.dir);
  delete before[RUN_LOCK_FILE];
  const r = await start(ws);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(json(r).state, 'archived');
  for (const name of Object.keys(extras)) assert.ok(json(r).archived.moved.includes(name), name);
  const archived = snapshot(path.join(ws.dir, 'archive', a.runId));
  delete archived[RUN_LOCK_FILE];
  assert.deepEqual(archived, before, 'outputs and extra data files moved together, byte for byte');

  // An older pass without a lock, with extras: the same.
  const ws2 = workspace(t);
  earlierPass(ws2.dir);
  writeFileSync(path.join(ws2.dir, 'answers.json'), '{}');
  age(ws2.dir, 2);
  const r2 = await start(ws2);
  assert.equal(r2.code, 0, r2.stderr);
  assert.ok(json(r2).archived.moved.includes('answers.json'));
});

test('run.mjs start: a report folder with an unknown sub-folder or a non-data file is refused, naming what was found', async (t) => {
  for (const [entry, make, shown] of [
    ['src', (p) => mkdirSync(p), 'src/'],
    ['node_modules', (p) => mkdirSync(p), 'node_modules/'],
    ['helper.mjs', (p) => writeFileSync(p, 'export {}'), 'helper.mjs'],
    ['tool', (p) => writeFileSync(p, Buffer.from([0x7f, 0x45, 0x4c, 0x46])), 'tool'],
  ]) {
    const ws = workspace(t);
    const a = json(await start(ws));
    earlierPass(ws.dir);
    make(path.join(ws.dir, entry));
    assert.equal((await run(RUN, ['finish', '--dir', ws.rel, '--run', a.runId], { cwd: ws.root })).code, 0);
    age(ws.dir, 2);
    const before = snapshot(ws.dir);
    const r = await start(ws);
    assert.equal(r.code, 2, `${entry}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, new RegExp(`it is not a report folder: it holds ${escapeRegExp(shown)}, which a report folder never holds \\(only design-qa outputs and data files: \\.json \\.md`));
    assert.match(r.stderr, /Nothing was moved/);
    assert.deepEqual(snapshot(ws.dir), before, `${entry}: nothing moved`);
  }
});

test('run.mjs start --run <own id>: a run continuing its own folder is never refused for files it or its agent wrote', async (t) => {
  const ws = workspace(t);
  const a = json(await start(ws, ['--label', 'Agent A']));
  writeFileSync(path.join(ws.dir, 'answers.json'), '{"answers":[]}');
  writeFileSync(path.join(ws.dir, 'notes.txt'), 'scratch');
  writeFileSync(path.join(ws.dir, 'build-findings.mjs'), 'export {}');
  mkdirSync(path.join(ws.dir, 'scratch'));
  const before = snapshot(ws.dir);
  delete before[RUN_LOCK_FILE];
  const r = await start(ws, ['--run', a.runId]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(json(r).state, 'continued');
  assert.equal(json(r).runId, a.runId);
  const after = snapshot(ws.dir);
  delete after[RUN_LOCK_FILE];
  assert.deepEqual(after, before, 'nothing moved');
  const env = await run(RUN, ['start', '--dir', ws.rel, '--json'], { cwd: ws.root, env: { DESIGN_QA_RUN_ID: a.runId } });
  assert.equal(env.code, 0, env.stderr);
  assert.equal(JSON.parse(env.stdout).state, 'continued');
  // Another run on that folder still gets the check (and a stray source file stops it).
  const other = await start(ws);
  assert.equal(other.code, 2);
  assert.match(other.stderr, /it holds build-findings\.mjs, scratch\//);
});
