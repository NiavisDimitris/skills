#!/usr/bin/env node
// One pass owns its report folder. Every pass runs `run.mjs start` first (Phase 0): it
// locks qa-reports/<feature>/ for this run (a generated run id), moves the outputs of
// an earlier pass that finished or was abandoned (never finished, idle) into
// <dir>/archive/<run id>/ so nothing is read from them by accident and nothing is lost, and never touches a folder another run is still using:
// that run keeps it and this one gets a sibling folder of its own. The cumulative logs
// in the parent folder (dismissed.*, design-debt.*) are never touched. node: only.
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError, displayPath, oneLine, parseCli, runMain, scriptCommand, usageError, withFileLocks } from './lib/args.mjs';
import {
  ARCHIVE_DIR,
  EXIT_BUSY,
  EXIT_CONFLICT,
  REVIEW_FILE,
  RUN_LOCK_FILE,
  archiveOutputs,
  assertReportFolder,
  assessDir,
  callerRunId,
  checkRunDir,
  idleMinutes,
  listArchives,
  newRunId,
  checkRegistration,
  readReviewRegistration,
  readRunLock,
  removeReviewRegistration,
  siblingName,
  writeRunLock,
} from './lib/run-lock.mjs';

const HELP = `Give this pass its own report folder: lock it, archive an earlier pass, never touch another run's folder.

Usage:
  node scripts/run.mjs start    --dir <report dir> [--label '<agent or model>'] [--resume] [--take-over]
                                [--run <id>] [--idle-min <n>] [--json]
  node scripts/run.mjs status   --dir <report dir> [--idle-min <n>] [--json]
  node scripts/run.mjs finish   --dir <report dir> --run <id> [--json]
  node scripts/run.mjs archives --dir <report dir> [--json]

start (Phase 0, before anything is written to the folder):
  Writes <dir>/${RUN_LOCK_FILE} with a new run id and prints the folder to use for the
  rest of the pass ("Use: <dir>") and the run id ("Run id: <id>"). Then:
  - empty or new folder: the run starts there.
  - outputs of an earlier pass that is finished, or older than any lock: they are MOVED
    (never deleted) into <dir>/${ARCHIVE_DIR}/<earlier run id>/ and this pass starts fresh.
    A fresh pass inherits nothing from them: only dismissals carry over, through
    dismiss.mjs --apply-log and the dismissed log in the parent folder. Never read
    findings from the archive.
  - --resume: keep the outputs and continue that same pass in place (after a fix loop
    or a crashed session); the new lock records the run it continues.
  - --run <id> (or DESIGN_QA_RUN_ID) naming the run that holds the lock: that run
    continues; nothing is archived.
  - held by another run that is still ACTIVE: the folder is not touched. A sibling
    folder <dir>--<run id> is created and locked for this run; continue there (exit 3).
  - held by a STALE run (never finished, idle, no live review server: a session that
    ended without run.mjs finish): treated as abandoned. Its outputs are MOVED (never
    deleted) into <dir>/${ARCHIVE_DIR}/<its run id>/ (its lock marked "abandoned") and this
    pass starts fresh here; the output says so. With --resume this run continues that
    pass in place instead (new run id, the earlier run recorded as "previous").

  A run is ACTIVE while its lock is not finished and something in the folder changed in
  the last --idle-min minutes (default 60, or DESIGN_QA_RUN_IDLE_MIN), or while a review
  server registered in the folder (${REVIEW_FILE}) is alive: it answers its health
  check on 127.0.0.1, or it does not answer yet but registered less than --idle-min
  minutes ago (and its process is alive, when it registered on this host). A crashed
  server's registration is removed. A modification time more than 2 minutes in the
  future is ignored (clock skew). Outputs WITHOUT a lock that
  changed that recently count as an active run too (a run that never called start):
  exit 3 with a sibling, unless --take-over. --take-over never applies to a locked
  active run or a live review server: those always get a sibling folder.

status: who holds the folder, since when, active or stale, the review server (pid,
  port, whether it answers) and the number of archived passes.
finish: marks the run finished (the folder may then be archived by the next pass).
  Refuses when --run is not the run that holds the lock.
archives: the earlier passes kept in <dir>/${ARCHIVE_DIR}/.

Options:
  --dir <dir>          the report folder, qa-reports/<feature> (required). Refused: a
                       filesystem root, the home folder, the working directory or a parent
                       of it, a repository root, a symbolic link, the folder holding the
                       cumulative logs or the feature folders, a folder inside an archive.
                       start also refuses an existing folder that is not a report folder:
                       a non-empty one with neither a run lock nor a pass output
                       (pass.json, report.json, state-matrix.json, findings.json,
                       evidence/, report.html), e.g. src/; one holding an unknown
                       sub-folder or a top-level file that is not data (.json .md .txt
                       .log .xml .html .png .jpg .jpeg .csv: such extra files, like
                       answers.json or a saved message, are kept and archived with the
                       pass); or one with git-tracked files that are not report outputs.
                       Never applied to the caller's own folder (--run names its lock).
                       Nothing is moved before these checks pass
  --label <text>       who runs the pass (agent or model name), stored in the lock
  --resume             continue the pass already in the folder instead of archiving it
  --take-over          take over recent outputs that have no run lock (see above): archive
                       them (or with --resume continue in place) instead of a sibling
  --run <id>           this run's id (default: DESIGN_QA_RUN_ID)
  --idle-min <n>       minutes without a change before an unfinished run is stale
  --json               print JSON instead of text
  -h, --help           show this help

Never delete a report folder or its archive, and never stop another run's review server:
use review.mjs --stop --report <dir>/report.json for your own.

Exit codes: 0 ok · 1 cannot read or write the folder · 2 bad arguments or a refused --dir ·
3 the folder is busy: a sibling folder was created and locked for this run, use it ·
5 refused, nothing was changed: start --resume on a folder another run is actively
using, or finish with another run's id (or on a folder without a lock)`;

const show = (p) => oneLine(displayPath(p));
const minutes = (ms) => (ms === null ? null : Math.round(ms / 6000) / 10);

function holder(a, dir) {
  const lock = a.lock && !a.lock.invalid ? a.lock : null;
  return {
    dir: displayPath(dir),
    runId: lock?.runId ?? null,
    label: lock?.label ?? null,
    startedAt: lock?.startedAt ?? null,
    status: lock?.status ?? (a.lock?.invalid ? 'unreadable' : null),
    state: a.state,
    lastActivityAt: a.lastActivityMs ? new Date(a.lastActivityMs).toISOString() : null,
    idleMinutes: minutes(a.idleMs),
    reviewServer: a.registration && !a.registration.invalid ? { pid: a.registration.pid, port: a.registration.port, startedAt: a.registration.startedAt ?? null, alive: a.serverAlive } : null,
  };
}

function describeHolder(h) {
  const who = h.runId ? `run ${h.runId}${h.label ? ` (${oneLine(h.label)})` : ''}, started ${oneLine(h.startedAt)}` : h.status === 'unreadable' ? `an unreadable lock` : 'a pass without a run lock';
  const idle = h.idleMinutes === null ? '' : `, last change ${h.idleMinutes} min ago`;
  const server = h.reviewServer?.alive ? `, review server pid ${h.reviewServer.pid} on port ${h.reviewServer.port}` : '';
  return `${who}${idle}${server}`;
}

function newLock({ runId, label, now, previous = null, takenOverFrom = null, archive = null, siblingOf = null }) {
  return {
    kind: 'design-qa-run',
    version: 1,
    runId,
    label: label ?? null,
    status: 'active',
    startedAt: now.toISOString(),
    finishedAt: null,
    host: os.hostname(),
    previous,
    takenOverFrom,
    archive,
    siblingOf,
  };
}

const summaryOf = (lock) => (lock && !lock.invalid ? { runId: lock.runId, label: lock.label ?? null, startedAt: lock.startedAt ?? null, status: lock.status ?? null, finishedAt: lock.finishedAt ?? null } : null);

function start(dir, { runId, label, resume, takeOver, idleMin, serverAlive }) {
  const now = new Date();
  const a = assessDir(dir, { idleMin, now: now.getTime(), serverAlive });
  const lock = a.lock && !a.lock.invalid ? a.lock : null;
  const base = { label, previous: null, archived: null, takenOverFrom: null, heldBy: null, notes: [] };

  // This run's own folder: continue, whatever its state.
  if (lock && runId && lock.runId === runId) {
    writeRunLock(dir, { ...lock, status: 'active', finishedAt: null, continuedAt: now.toISOString() });
    return { ...base, code: 0, state: 'continued', runId, dir, label: lock.label ?? null, startedAt: lock.startedAt };
  }

  const fresh = () => newRunId(now);
  const unlockedRecent = a.state === 'active' && !a.lock && !a.serverAlive;
  if (a.state === 'active' && !(unlockedRecent && takeOver)) {
    const heldBy = holder(a, dir);
    if (resume) {
      return { ...base, code: EXIT_CONFLICT, state: 'refused', dir, heldBy, reason: `${show(dir)} is in use by ${describeHolder(heldBy)}. --resume continues only your own run: pass --run <your id>. Nothing was changed.` };
    }
    const id = fresh();
    const sibling = path.join(path.dirname(dir), siblingName(dir, id));
    try {
      mkdirSync(sibling);
    } catch (err) {
      throw new CliError(`cannot create ${show(sibling)}: ${err.message}`, 1);
    }
    writeRunLock(sibling, newLock({ runId: id, label, now, siblingOf: path.basename(dir) }));
    const notes = takeOver ? ['--take-over refused: that run is active (it changed recently or its review server is alive).'] : [];
    return { ...base, code: EXIT_BUSY, state: 'busy', runId: id, dir: sibling, startedAt: now.toISOString(), heldBy, busyDir: dir, notes };
  }

  // missing · empty · finished · unlocked · stale (abandoned) · recent unlocked outputs with --take-over.
  const id = fresh();
  const previous = summaryOf(lock);
  const notes = [];
  let takenOverFrom = null;
  if (a.state === 'stale') {
    takenOverFrom = lock?.runId ?? 'unreadable-lock';
    const idle = a.idleMs === null ? '' : ` for ${minutes(a.idleMs)} min`;
    const who = lock ? `run ${lock.runId}${lock.label ? ` (${oneLine(lock.label)})` : ''}, started ${oneLine(lock.startedAt)},` : 'run (its lock is unreadable)';
    notes.push(`The earlier ${who} was never finished and nothing changed${idle}: it looks abandoned, so this run took the folder over.`);
  } else if (unlockedRecent) {
    takenOverFrom = 'unlocked';
    notes.push(`--take-over: the outputs without a run lock (last change ${minutes(a.idleMs)} min ago) were taken over.`);
  }
  // A dead server's registration is not an output: drop it.
  if (a.registration && !a.serverAlive) removeReviewRegistration(dir);
  if (resume || !a.outputs.length) {
    mkdirSync(dir, { recursive: true });
    writeRunLock(dir, newLock({ runId: id, label, now, previous, takenOverFrom }));
    const state = resume && (a.outputs.length || previous) ? 'resumed' : 'fresh';
    return { ...base, code: 0, state, runId: id, dir, startedAt: now.toISOString(), previous, takenOverFrom, notes };
  }
  const archived = archiveOutputs(dir, { previousLock: a.lock, lastActivityMs: a.lastActivityMs });
  if (previous) {
    writeRunLock(archived.archiveDir, { ...lock, archivedAt: now.toISOString(), archivedBy: id, ...(lock.status === 'finished' ? {} : { status: 'abandoned' }) });
  }
  const archive = path.relative(dir, archived.archiveDir).split(path.sep).join('/');
  writeRunLock(dir, newLock({ runId: id, label, now, previous, takenOverFrom, archive }));
  if (takenOverFrom) notes.push(`Its outputs were moved, not deleted, to ${show(archived.archiveDir)}.`);
  return { ...base, code: 0, state: 'archived', runId: id, dir, startedAt: now.toISOString(), previous, takenOverFrom, notes, archived: { path: archived.archiveDir, name: archived.name, moved: archived.moved } };
}

function printStart(r, json) {
  if (json) {
    const out = {
      ok: r.code === 0 || r.code === EXIT_BUSY,
      state: r.state,
      runId: r.runId ?? null,
      label: r.label ?? null,
      dir: displayPath(r.dir),
      absDir: path.resolve(r.dir),
      lockFile: r.runId ? displayPath(path.join(r.dir, RUN_LOCK_FILE)) : null,
      startedAt: r.startedAt ?? null,
      previous: r.previous ?? null,
      takenOverFrom: r.takenOverFrom ?? null,
      archived: r.archived ? { path: displayPath(r.archived.path), name: r.archived.name, moved: r.archived.moved } : null,
      busyDir: r.busyDir ? displayPath(r.busyDir) : null,
      heldBy: r.heldBy ?? null,
      reason: r.reason ?? null,
      notes: r.notes ?? [],
    };
    console.log(JSON.stringify(out, null, 2));
    return r.code;
  }
  if (r.state === 'refused') {
    console.error(`run.mjs: ${r.reason}`);
    return r.code;
  }
  const who = r.label ? ` (${oneLine(r.label)})` : '';
  const prev = r.previous ? `run ${r.previous.runId}${r.previous.label ? ` (${oneLine(r.previous.label)})` : ''}, ${r.previous.status === 'finished' ? `finished ${oneLine(r.previous.finishedAt)}` : `started ${oneLine(r.previous.startedAt)}`}` : 'a pass without a run lock';
  const lines = [];
  if (r.state === 'busy') {
    lines.push(`Busy: ${show(r.busyDir)} belongs to ${describeHolder(r.heldBy)}. It was not touched.`);
    lines.push(`Run ${r.runId}${who} got a folder of its own: ${show(r.dir)}. Write every output of this pass there.`);
    lines.push('If the busy folder is your own run, start again with --run <your id> instead.');
  } else if (r.state === 'continued') {
    lines.push(`Run ${r.runId}${who} continues in ${show(r.dir)}.`);
  } else if (r.state === 'resumed') {
    lines.push(`Run ${r.runId}${who} resumes the pass in ${show(r.dir)} (earlier: ${prev}${r.takenOverFrom ? ', taken over' : ''}). Its outputs are kept.`);
  } else if (r.state === 'archived') {
    lines.push(`Run ${r.runId}${who} started in ${show(r.dir)}.`);
    lines.push(`The earlier pass (${prev}${r.takenOverFrom ? ', abandoned' : ''}) was moved, not deleted, to ${show(r.archived.path)} (${r.archived.moved.length} item(s)).`);
    lines.push('This pass starts fresh: never read findings from the archive. Only dismissals carry over, through dismiss.mjs --apply-log.');
  } else {
    lines.push(`Run ${r.runId}${who} started in ${show(r.dir)}.`);
  }
  for (const n of r.notes ?? []) lines.push(n);
  lines.push(`Use: ${show(r.dir)}`);
  lines.push(`Run id: ${r.runId}`);
  console.log(lines.join('\n'));
  return r.code;
}

/** Ask the review server registered in dir (whatever host it registered from); null without a registration. */
async function askServer(dir, idleMin) {
  const reg = readReviewRegistration(dir);
  return reg && !reg.invalid ? checkRegistration(reg, { maxAgeMs: idleMin * 60_000 }) : null;
}

async function status(dir, { idleMin, json }) {
  const check = await askServer(dir, idleMin);
  const a = assessDir(dir, { idleMin, serverAlive: check ? check.alive : undefined });
  const h = holder(a, dir);
  let server = null;
  if (a.registration && !a.registration.invalid) {
    server = {
      pid: a.registration.pid,
      port: a.registration.port,
      startedAt: a.registration.startedAt ?? null,
      runId: a.registration.runId ?? null,
      url: `http://127.0.0.1:${a.registration.port}/`,
      answering: Boolean(check?.answering),
      stale: Boolean(check?.stale),
      error: check?.answering ? null : (check?.reason ?? null),
    };
  }
  const archives = listArchives(dir);
  if (json) {
    const lock = a.lock && !a.lock.invalid ? a.lock : null;
    console.log(
      JSON.stringify(
        {
          dir: displayPath(dir),
          absDir: dir,
          state: a.state,
          idleMin,
          lastActivityAt: h.lastActivityAt,
          idleMinutes: h.idleMinutes,
          lock: lock ? { runId: lock.runId, label: lock.label ?? null, status: lock.status, startedAt: lock.startedAt ?? null, finishedAt: lock.finishedAt ?? null, previous: lock.previous ?? null, archive: lock.archive ?? null } : a.lock ? { invalid: true } : null,
          reviewServer: server,
          archives: archives.length,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const lines = [];
  const what = {
    missing: 'does not exist',
    empty: 'is empty and not locked',
    active: 'is in use',
    stale: 'is held by a run that looks abandoned',
    finished: 'holds a finished pass',
    unlocked: 'holds outputs without a run lock (an older pass)',
  }[a.state];
  lines.push(`${show(dir)} ${what}${a.state === 'missing' || a.state === 'empty' ? '.' : `: ${describeHolder(h)}.`}`);
  if (a.lock && !a.lock.invalid && a.lock.status === 'finished') lines.push(`  Finished ${oneLine(a.lock.finishedAt)}.`);
  if (server) {
    lines.push(
      server.answering
        ? `  Review server: open, pid ${server.pid}, port ${server.port}, since ${oneLine(server.startedAt)}. Its link carries a token only the review.mjs output shows.`
        : server.stale
          ? `  Review server: a stale registration (pid ${server.pid}, port ${server.port}): ${oneLine(server.error)}. Any link to it is dead; the next start removes it.`
          : `  Review server: registered (pid ${server.pid}, port ${server.port}) but ${oneLine(server.error)}; it counts as alive until it is ${idleMin} min old.`,
    );
  } else {
    lines.push('  Review server: none.');
  }
  lines.push(`  Archived passes: ${archives.length}${archives.length ? ` (${scriptCommand('run.mjs')} archives --dir ${show(dir)})` : ''}.`);
  console.log(lines.join('\n'));
  return 0;
}

function finish(dir, { runId, json }) {
  if (!runId) throw usageError('finish needs --run <id> (or DESIGN_QA_RUN_ID): the id run.mjs start printed');
  const lock = readRunLock(dir);
  const refuse = (reason) => {
    if (json) console.log(JSON.stringify({ ok: false, state: 'refused', reason }, null, 2));
    else console.error(`run.mjs: ${reason}`);
    return EXIT_CONFLICT;
  };
  if (!lock) return refuse(`${show(dir)} has no run lock; nothing to finish`);
  if (lock.invalid) return refuse(`${show(path.join(dir, RUN_LOCK_FILE))} is not a run lock; nothing was changed`);
  if (lock.runId !== runId) {
    return refuse(`${show(dir)} is held by run ${lock.runId}${lock.label ? ` (${oneLine(lock.label)})` : ''}, not by run ${runId}. Nothing was changed: finish only your own run.`);
  }
  const finishedAt = lock.status === 'finished' && lock.finishedAt ? lock.finishedAt : new Date().toISOString();
  writeRunLock(dir, { ...lock, status: 'finished', finishedAt });
  const a = assessDir(dir);
  const note = a.serverAlive ? `A review server is still registered (pid ${a.registration.pid}, port ${a.registration.port}); stop it with ${scriptCommand('review.mjs')} --stop --report ${show(path.join(dir, 'report.json'))} once the review is over.` : null;
  if (json) console.log(JSON.stringify({ ok: true, state: 'finished', runId, dir: displayPath(dir), finishedAt, notes: note ? [note] : [] }, null, 2));
  else console.log([`Finished run ${runId} in ${show(dir)}.`, note].filter(Boolean).join('\n'));
  return 0;
}

function archives(dir, { json }) {
  const list = listArchives(dir);
  if (json) {
    console.log(JSON.stringify({ dir: displayPath(dir), archives: list.map((e) => ({ ...e, path: displayPath(e.path) })) }, null, 2));
    return 0;
  }
  if (!list.length) {
    console.log(`No archived passes in ${show(dir)}.`);
    return 0;
  }
  console.log(`Archived passes in ${show(path.join(dir, ARCHIVE_DIR))} (kept for reference; a new pass never reads findings from them):`);
  for (const e of list) {
    const who = e.runId ? `run ${e.runId}${e.label ? ` (${oneLine(e.label)})` : ''}` : 'no run lock';
    const when = e.finishedAt ? `finished ${oneLine(e.finishedAt)}` : e.startedAt ? `started ${oneLine(e.startedAt)}, ${oneLine(e.status ?? 'unfinished')}` : '';
    const rep = !e.hasReport ? 'no report.json' : e.reportGeneratedAt ? `report generated ${oneLine(e.reportGeneratedAt)}${e.verdict ? `, ${oneLine(e.verdict)}` : ''}` : 'report.json';
    console.log(`  ${oneLine(e.name)}: ${who}${when ? `, ${when}` : ''} · ${rep} · ${e.entries} item(s)`);
  }
  return 0;
}

async function main(argv) {
  const { values, positionals } = parseCli(
    argv,
    {
      dir: { type: 'string' },
      label: { type: 'string' },
      resume: { type: 'boolean' },
      'take-over': { type: 'boolean' },
      run: { type: 'string' },
      'idle-min': { type: 'string' },
      json: { type: 'boolean' },
    },
    { allowPositionals: true },
  );
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const [command, ...extra] = positionals;
  if (!command) throw usageError('a command is required: start, status, finish or archives (see --help)');
  if (extra.length) throw usageError(`unexpected argument "${oneLine(extra[0])}" (see --help)`);
  if (!['start', 'status', 'finish', 'archives'].includes(command)) throw usageError(`unknown command "${oneLine(command)}": use start, status, finish or archives`);
  if (!values.dir) throw usageError('--dir <report folder> is required (e.g. --dir qa-reports/abc-123)');
  const runId = callerRunId(values.run);
  const idleMin = idleMinutes(values['idle-min']);

  if (command === 'status') return status(path.resolve(values.dir), { idleMin, json: values.json });
  if (command === 'archives') return archives(path.resolve(values.dir), { json: values.json });
  if (command === 'finish') return finish(checkRunDir(values.dir), { runId, json: values.json });
  // start: only an empty folder or a report folder; nothing is moved before this passes.
  // A run continuing its own folder (--run names its lock) is never refused for what it wrote there.
  const dir = checkRunDir(values.dir);
  const held = readRunLock(dir);
  if (!(runId && held && !held.invalid && held.runId === runId)) assertReportFolder(dir);

  if (values.label !== undefined && !oneLine(values.label)) throw usageError('--label: give a name (the agent or model), or leave it out');
  const label = values.label === undefined ? null : oneLine(values.label).slice(0, 120);
  const parent = path.dirname(dir);
  mkdirSync(parent, { recursive: true });
  // One start at a time per folder; the mutex lives in the parent so a busy folder is never written.
  const mutex = path.join(parent, `.${path.basename(dir)}.design-qa-start`);
  // Ask a registered review server before judging the folder (a crashed one must not keep it busy).
  const check = await askServer(dir, idleMin);
  const result = withFileLocks([mutex], () => start(dir, { runId, label, resume: values.resume, takeOver: values['take-over'], idleMin, serverAlive: check ? check.alive : undefined }));
  return printStart(result, values.json);
}

runMain(import.meta.url, main);
