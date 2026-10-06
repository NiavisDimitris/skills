#!/usr/bin/env node
// The local review server: serves report.html on 127.0.0.1 with a one-time token,
// and waits for the reviewer to click "Send to agent". The decisions document is
// validated against report.json, saved as <report dir>/decisions.json, and the
// process exits 0 with the command that applies it. Works with any coding agent:
// run it, wait for the exit, run the printed "Next:" command. node:http only.
// It registers itself in the report folder (.design-qa-review.json: pid, port, a
// public registration id, never the token) so `--status` and `--stop` find exactly
// this server, and reads report.html and report.json from disk on every request.
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, displayPath, formatIssues, oneLine, parseCli, readJsonFile, runMain, scriptCommand, shellArg, toNumber, usageError, writeText } from './lib/args.mjs';
import { DecisionsError, applyDecisions, checkDecisionsTarget, parseDecisions, summaryLine } from './lib/decisions.mjs';
import { findBodyOpen, findScriptElement, reportFreshness, resolveReviewConfig } from './lib/review-context.mjs';
import {
  EXIT_CONFLICT,
  REVIEW_FILE,
  assertRunOwnsDir,
  callerRunId,
  checkRegistration,
  idleMinutes,
  pidAlive,
  probeReviewServer,
  readReviewRegistration,
  removeReviewRegistration,
  writeReviewRegistration,
} from './lib/run-lock.mjs';
import { isGateIssue, validateConfig, validateReport, verifyBuiltFile } from './lib/schema-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 1024 * 1024;
const CONTEXT_ID = 'design-qa-context';
const STALE_ID = 'design-qa-stale';
const STOP_WAIT_MS = 5000;
const STATIC_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};
const NO_DECISIONS = 'No decisions were sent. The reviewer can still use "Copy for your agent" in the report.';
// setTimeout overflows above 2^31-1 ms (~35791 minutes) and would fire at once.
const MAX_TIMEOUT_MIN = 35000;
// The served page: its own inline script and styles, images and fonts from this
// origin or data:/blob: URLs, and fetch() back to this server only (POST /decisions).
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data: blob:",
  'font-src data:',
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const HELP = `Open report.html for review and wait for the reviewer to click "Send to agent".

Usage:
  node scripts/review.mjs --report <dir>/report.json [--html <file>] [--port <n>] [--no-open]
      [--timeout-min <n>] [--run <id>] [--replace] [--quiet]
  node scripts/review.mjs --status --report <dir>/report.json [--json]
  node scripts/review.mjs --stop --report <dir>/report.json [--run <id>] [--json]

Options:
  --report <file>        report.json the review is about (required)
  --html <file>          the rendered report (default: report.html next to --report; render it
                         first with render-report.mjs)
  --port <n>             port on 127.0.0.1 (default 0: any free port)
  --no-open              do not open the browser (also when the CI environment variable is set)
  --config <file>        configuration used to render the report (otherwise recovered from
                         report.html, or design-qa.config.json in a report ancestor)
  --timeout-min <n>      stop waiting after n minutes (default 240, at most 35000; 0 waits
                         until Ctrl+C)
  --run <id>             this pass's run id (default: DESIGN_QA_RUN_ID; see run.mjs). When the
                         folder is locked by another run, or by an unfinished run and no id is
                         given, nothing is started (exit 5)
  --replace              a review server is already open for this folder: stop it (the
                         --stop checks apply) and start a new one
  --status               is a review server open for this folder? Exit 0 open, 3 none
  --stop                 stop the review server registered for this folder, and nothing else;
                         a run's server only with that run's --run
  --json                 with --status or --stop: print JSON
  --quiet                print only the URL and the result
  -h, --help             show this help

Starting: the server answers a health check on its own URL before it prints
"Review open: http://127.0.0.1:<port>/?t=<token>" (the first line), then opens the
browser; when it cannot, it says so and the URL above stays valid. It registers itself
in <dir>/${REVIEW_FILE} (kind, id, pid, port, host, startedAt, runId; never the token)
and removes that file on every exit: Send, timeout, Ctrl+C, SIGTERM, SIGHUP, an error.
A second server for the same folder is refused (exit 5) while the first one answers:
its link carries a token only the first output shows. Give the person that link again
after --status says it is open, stop it with --stop, or pass --replace.

--status prints whether the registered server is open (it answers its health check as
that very registration), its pid, port and start time, and whether report.html is up to
date. JSON: { open, dir, server: { pid, port, startedAt, runId, url } | null,
staleRegistration, report: { stale, reason, reportGeneratedAt, htmlGeneratedAt } }.
Check it before repeating a review link to the person: a link to a closed server is dead.

--stop signals (SIGTERM) only the pid registered for this folder, and only after the
server on the registered port of 127.0.0.1 answers with the same registration id and
pid (whatever host name it registered under). Otherwise nothing is signalled: a
registration whose process is gone, whose port answers as something else, or that is
older than the idle window (DESIGN_QA_RUN_IDLE_MIN, default 60 min) and does not
answer, is removed as stale; a younger one from another host name is left alone (exit
5). Never stop a review server any other way (no pkill or kill by pattern): another
run may own it.

The page: report.html and report.json are read from disk on every request, so a
re-rendered report shows on reload. When report.json was re-generated after
report.html was rendered (meta.generatedAt differs), or its content changed after it
(it differs from the report embedded in the page and was written more than 2 s later; a
render's own --write-back never counts), the page gets
a banner saying it is out of date and this prints a warning with the render command;
re-render, then ask the reviewer to reload. Send is refused while the page shows a
report generated at another time than report.json (finding ids may differ): the
reviewer gets "these decisions were made on the report generated …" and this prints a
warning with the render command.

The page gets { live: true, token, reportPath } in its <script id="design-qa-context">
element, so its "Send to agent" button can POST the decisions document
(schemas/decisions.schema.json) to /decisions. The document is checked against
report.json on disk (slug, reportGeneratedAt, known ids); a rejected one is answered
with the reason and the server keeps waiting. An accepted one is saved atomically as
<dir>/decisions.json, then this prints:
  Decisions received from <name>: <summary>
  Saved: <dir>/decisions.json
  Next: node <scripts>/apply-decisions.mjs --report <dir>/report.json
and exits 0. Run that command next.

Security: binds 127.0.0.1 only; a random 128-bit token is required for the page and
for POST /decisions (header X-Design-QA-Token); opening the page with it sets an
HttpOnly, SameSite=Strict cookie that the images and .json files inside the report
folder require (or the header); dot-files (the run lock, the registration) are never
served; requests with another Host header, or a POST from another Origin, are refused;
no CORS headers; the page is served with a Content-Security-Policy (inline script and
styles, same-origin images and requests only); nothing in the payload is ever executed.
/health answers { ok: true } with the token, and the registration details with the
registration id (header X-Design-QA-Registration), which --status and --stop use.

Exit codes: 0 decisions received and saved (--status: open; --stop: stopped, or nothing
was running) · 1 server error (e.g. the port is taken; --stop: it did not stop), or the
report fails the evidence gates of validate.mjs (an open FIX_CODE finding without a pin,
a crop outside its image, a finding on a deployed target with no app-side evidence, a
truncated comparison): fix it, re-render, then open the review ·
2 bad arguments · 3 timed out or interrupted with nothing received (--status: no server
open) · 5 the folder belongs to another run, a review server is already open for it, or
--stop refused a pid that is not this folder's review server`;

/**
 * JSON for a <script type="application/json"> element: every <, > and & is a \\u
 * escape, so no value can close the element, open a comment or spell a tag.
 */
export function serializeForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * The page with the live context: the design-qa-context element's JSON becomes
 * { live: true, token, reportPath, ...the object that was there (minus those keys) };
 * without the element (an older report) one is inserted before the first <script>.
 * Only a real element counts: text inside another script's JSON is skipped.
 */
export function injectContext(html, { token, reportPath, configPath, reportStale }) {
  const live = { live: true, token, reportPath, ...(configPath !== undefined ? { configPath } : {}), ...(reportStale ? { reportStale } : {}) };
  const m = findScriptElement(html, CONTEXT_ID);
  if (m) {
    let existing = {};
    try {
      const parsed = JSON.parse(m.body.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
    } catch {
      // A placeholder or empty element: nothing to keep.
    }
    const rest = Object.fromEntries(Object.entries(existing).filter(([k]) => !(k in live) && k !== 'reportStale'));
    const json = serializeForScript({ ...live, ...rest });
    return html.slice(0, m.index) + m.open + json + m.close + html.slice(m.index + m.length);
  }
  const element = `<script id="${CONTEXT_ID}" type="application/json">${serializeForScript(live)}</script>\n`;
  const at = html.search(/<script\b/i);
  if (at >= 0) return html.slice(0, at) + element + html.slice(at);
  const body = html.search(/<\/body\s*>/i);
  if (body >= 0) return html.slice(0, body) + element + html.slice(body);
  return html + element;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The banner text for a stale page (null when the page is up to date). */
export function staleNotice(freshness) {
  if (!freshness?.stale) return null;
  if (freshness.reason === 'regenerated') {
    return (
      `This page is out of date: report.json was re-generated (generated ${oneLine(freshness.reportGeneratedAt)}) after this page was rendered ` +
      `(from the report generated ${oneLine(freshness.htmlGeneratedAt)}). Ask your agent to re-render report.html, then reload this page. ` +
      'Sending is blocked until then: the finding ids may point at other findings.'
    );
  }
  return (
    `report.json changed after this page was rendered (report.json ${oneLine(freshness.reportModifiedAt)}, report.html ${oneLine(freshness.htmlModifiedAt)}). ` +
    'The page may not show the latest findings: ask your agent to re-render report.html, then reload this page.'
  );
}

/**
 * The page with a notice banner as the first element of <body> (inline styles only:
 * the page's CSP allows no new script). Without a <body> it goes at the end.
 */
export function injectNotice(html, text, id = STALE_ID) {
  const banner =
    `<div id="${id}" role="alert" style="position:sticky;top:0;z-index:2147483647;margin:0;padding:12px 16px;` +
    'background:#fef3c7;color:#78350f;border-bottom:2px solid #d97706;font:600 14px/1.45 system-ui,-apple-system,sans-serif">' +
    `${escapeHtml(text)}</div>`;
  const body = findBodyOpen(html);
  if (body) return html.slice(0, body.end) + banner + html.slice(body.end);
  return html + banner;
}

/** name → value of a Cookie header. */
function cookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function sameToken(given, token) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Open the URL in the default browser; `failed(why)` is called once when that does not work. */
function openBrowser(url, failed) {
  const [cmd, args, extra] =
    process.platform === 'darwin'
      ? ['open', [url], {}]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url], { windowsVerbatimArguments: true }]
        : ['xdg-open', [url], {}];
  let told = false;
  const fail = (why) => {
    if (told) return;
    told = true;
    failed(why);
  };
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', ...extra });
    child.on('error', (err) => fail(err.code === 'ENOENT' ? `${cmd} is not available` : err.message));
    child.on('exit', (code) => {
      if (code) fail(`${cmd} exited ${code}`);
    });
    child.unref();
  } catch (err) {
    fail(err.message);
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** What --status and --stop print, as text or JSON. */
function emit(json, data, text) {
  console.log(json ? JSON.stringify(data, null, 2) : text);
}

/**
 * Stop the server registered in reportDir: only a live pid on this host whose port
 * answers with the same registration id and pid gets SIGTERM. Returns
 * { code, stopped, message, registration }.
 */
async function stopRegistered(reportDir, runId) {
  const dir = oneLine(displayPath(reportDir));
  const reg = readReviewRegistration(reportDir);
  if (!reg) return { code: 0, stopped: false, message: `No review server is registered for ${dir}; nothing was stopped.` };
  // A run's review server is stopped only by that run.
  if (!reg.invalid && reg.runId && reg.runId !== runId) {
    return { code: EXIT_CONFLICT, stopped: false, message: `The review server for ${dir} belongs to ${runId ? 'another run' : 'a run'}: nothing was stopped. Stop only your own, with --run <your run id>.` };
  }
  if (reg.invalid) {
    removeReviewRegistration(reportDir);
    return { code: 0, stopped: false, message: `${dir}/${REVIEW_FILE} was not a review registration; removed it. Nothing was stopped.` };
  }
  const who = `pid ${reg.pid}, port ${reg.port}`;
  // Asked whatever host it registered from (a host name can change under a running server);
  // only a server answering on 127.0.0.1 with this registration id and pid is ever signalled.
  const check = await checkRegistration(reg, { maxAgeMs: idleMinutes(undefined) * 60_000 });
  const sameHost = !reg.host || reg.host === os.hostname();
  if (!check.answering && check.stale) {
    removeReviewRegistration(reportDir, reg.id);
    return { code: 0, stopped: false, registration: reg, message: `The review server for ${dir} was not running (${who}: ${oneLine(check.reason)}); removed its stale registration. Nothing was stopped.` };
  }
  if (!check.answering && !sameHost) {
    return {
      code: EXIT_CONFLICT,
      stopped: false,
      registration: reg,
      message: `The review server for ${dir} registered on host ${oneLine(reg.host)} (${who}) and does not answer here; if it runs there, stop it there. Nothing was stopped. Its registration counts as stale once it is older than the idle window.`,
    };
  }
  const probe = check.answering ? { ok: true } : { ok: false, error: check.reason };
  if (!probe.ok) {
    const timedOut = /within \d+ ms/.test(probe.error ?? '');
    if (!timedOut) removeReviewRegistration(reportDir, reg.id);
    return {
      code: EXIT_CONFLICT,
      stopped: false,
      registration: reg,
      message:
        `Refusing to stop pid ${reg.pid}: it does not answer as the review server for ${dir} (${oneLine(probe.error)}); it may be another process. Nothing was signalled` +
        (timedOut ? '.' : '; the stale registration was removed.'),
    };
  }
  try {
    process.kill(reg.pid, 'SIGTERM');
  } catch (err) {
    return { code: 1, stopped: false, registration: reg, message: `Could not signal the review server for ${dir} (${who}): ${err.message}` };
  }
  const deadline = Date.now() + STOP_WAIT_MS;
  while (pidAlive(reg.pid) && Date.now() < deadline) await sleep(50);
  if (pidAlive(reg.pid)) return { code: 1, stopped: false, registration: reg, message: `The review server for ${dir} (${who}) did not stop within ${STOP_WAIT_MS / 1000} s.` };
  removeReviewRegistration(reportDir, reg.id);
  return { code: 0, stopped: true, registration: reg, message: `Stopped the review server for ${dir} (${who}). Its review link no longer works.` };
}

async function statusOf(reportFile, htmlFile) {
  const reportDir = path.dirname(reportFile);
  const reg = readReviewRegistration(reportDir);
  let server = null;
  let staleRegistration = false;
  let error = null;
  if (reg && !reg.invalid) {
    const check = await checkRegistration(reg, { maxAgeMs: idleMinutes(undefined) * 60_000 });
    if (check.answering) server = { pid: reg.pid, port: reg.port, startedAt: reg.startedAt ?? null, runId: reg.runId ?? null, url: `http://127.0.0.1:${reg.port}/` };
    else {
      staleRegistration = true;
      error = check.reason;
    }
  } else if (reg?.invalid) {
    staleRegistration = true;
  }
  const f = reportFreshness(reportFile, htmlFile);
  return {
    open: Boolean(server),
    dir: displayPath(reportDir),
    server,
    staleRegistration,
    error,
    report: { stale: f.stale, reason: f.reason, reportGeneratedAt: f.reportGeneratedAt, htmlGeneratedAt: f.htmlGeneratedAt },
  };
}

async function main(argv) {
  const { values } = parseCli(argv, {
    report: { type: 'string' },
    html: { type: 'string' },
    config: { type: 'string' },
    port: { type: 'string' },
    'no-open': { type: 'boolean' },
    'timeout-min': { type: 'string' },
    run: { type: 'string' },
    replace: { type: 'boolean' },
    status: { type: 'boolean' },
    stop: { type: 'boolean' },
    json: { type: 'boolean' },
    quiet: { type: 'boolean' },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const log = values.quiet ? () => {} : (msg) => console.log(msg);
  if (!values.report) throw usageError('--report <dir>/report.json is required (see --help)');
  if (values.status && values.stop) throw usageError('choose one of --status and --stop');
  const reportFile = path.resolve(values.report);
  const reportDir = path.dirname(reportFile);
  const htmlFile = path.resolve(values.html ?? path.join(reportDir, 'report.html'));
  const reportPath = displayPath(reportFile);
  const caller = callerRunId(values.run);
  const stopCommand = `${scriptCommand('review.mjs')} --stop --report ${shellArg(reportPath)}${caller ? ` --run ${caller}` : ''}`;

  if (values.stop) {
    const r = await stopRegistered(reportDir, caller);
    const reg = r.registration;
    emit(values.json, { ok: r.code === 0, stopped: r.stopped, dir: displayPath(reportDir), server: reg ? { pid: reg.pid, port: reg.port, startedAt: reg.startedAt ?? null } : null, message: r.message }, r.message);
    return r.code;
  }
  if (values.status) {
    const s = await statusOf(reportFile, htmlFile);
    // A run's id is shown to that run only (whoever runs a printed command acts as it).
    const ownServer = s.server && (!s.server.runId || s.server.runId === caller);
    if (s.server && !ownServer) s.server.runId = null;
    const lines = [];
    if (s.open) {
      lines.push(`Review server for ${oneLine(s.dir)}: open, pid ${s.server.pid}, port ${s.server.port}, since ${oneLine(s.server.startedAt)}${s.server.runId ? `, run ${oneLine(s.server.runId)}` : ownServer ? '' : ', another run\'s'}.`);
      lines.push(`  Its link is http://127.0.0.1:${s.server.port}/?t=<token>; the token is only in the output of the review.mjs that started it.`);
      if (ownServer) lines.push(`  Stop it: ${stopCommand}`);
    } else {
      lines.push(`No review server is open for ${oneLine(s.dir)}${s.staleRegistration ? ` (a stale registration: ${oneLine(s.error ?? 'unreadable')})` : ''}. Any earlier review link is dead.`);
    }
    if (s.report.stale) lines.push(`  report.html is out of date (${s.report.reason === 'regenerated' ? 'report.json was re-generated after it was rendered' : 'report.json changed after it was rendered'}): re-render it before the review.`);
    emit(values.json, s, lines.join('\n'));
    return s.open ? 0 : 3;
  }

  const initialReport = readJsonFile(reportFile, 'report', 2);
  if (!existsSync(htmlFile)) {
    throw usageError(
      `${oneLine(displayPath(htmlFile))} not found: render it first: ${scriptCommand('render-report.mjs')} --in ${shellArg(displayPath(reportFile))} --out ${shellArg(displayPath(htmlFile))}${caller ? ` --run ${caller}` : ''}`,
    );
  }
  const port = toNumber(values.port, 'port', { min: 0, max: 65535, integer: true }) ?? 0;
  const configFile = resolveReviewConfig(reportFile, { explicit: values.config, htmlFile, generatedAt: initialReport.meta?.generatedAt });
  const config = configFile ? readJsonFile(configFile, 'config', 2) : {};
  const cv = validateConfig(config);
  if (configFile && !cv.valid) throw usageError(`--config is invalid:\n${formatIssues(cv.errors)}`);
  // Never put a report in front of a person that fails the evidence gates (pins, crops, grounding on a
  // deployed target, full-length comparison): the same check as validate.mjs, also for an agent that skipped it.
  const built = await verifyBuiltFile(reportFile, initialReport);
  const gates = [
    ...validateReport(initialReport, { config, evidenceGates: 'error', skipScorecard: true, skipRanks: true, skipTriage: true }).errors.filter(isGateIssue),
    ...built.errors,
  ];
  // The test-only skip (unit-test fixtures) shows on the page the person reviews, never silently.
  const unverified = built.skipped ? 'Build verification skipped (test mode): this report was not checked against the findings and evidence it was built from.' : null;
  if (gates.length) {
    throw new CliError(
      `${oneLine(displayPath(reportFile))} fails the evidence gates, so it is not ready for a person to review:\n${formatIssues(gates)}\nFix the report, re-render, then open the review (node ${shellArg(displayPath(path.join(HERE, 'validate.mjs')))} ${shellArg(displayPath(reportFile))} lists every problem).`,
      1,
    );
  }
  const timeoutMin = toNumber(values['timeout-min'], 'timeout-min', { min: 0, max: MAX_TIMEOUT_MIN }) ?? 240;

  // Whose folder is it? A run that is not finished holds it: its run id (flag or env) is required.
  const runId = caller;
  assertRunOwnsDir(reportDir, { runId });
  const regRunId = runId;

  // One review server per folder.
  const existing = readReviewRegistration(reportDir);
  if (existing && !existing.invalid) {
    // Asked whatever host it registered from: only a server that answers here is "already open".
    const check = await checkRegistration(existing, { maxAgeMs: idleMinutes(undefined) * 60_000 });
    const probe = check.answering ? { ok: true } : { ok: false, error: check.reason };
    if (probe.ok) {
      if (!values.replace) {
        throw new CliError(
          `a review server is already open for ${oneLine(displayPath(reportDir))} (pid ${existing.pid}, port ${existing.port}, since ${oneLine(existing.startedAt)}${existing.runId ? `, run ${oneLine(existing.runId)}` : ''}). ` +
            `Give the person the link it printed (its token is not stored), stop it with: ${stopCommand}, or start again with --replace`,
          EXIT_CONFLICT,
        );
      }
      const stopped = await stopRegistered(reportDir, runId);
      if (!stopped.stopped) throw new CliError(`--replace: ${stopped.message}`, stopped.code || 1);
      log(stopped.message);
    } else {
      log(`Replacing a stale registration (pid ${existing.pid}, port ${existing.port}: ${oneLine(probe.error)}).`);
    }
  }

  const token = randomBytes(16).toString('hex');
  const regId = randomBytes(16).toString('hex');
  const startedAt = new Date().toISOString();
  const decisionsFile = path.join(reportDir, 'decisions.json');
  const realDir = realpathSync(reportDir);
  const renderCommand = `${scriptCommand('render-report.mjs')} --in ${shellArg(reportPath)} --out ${shellArg(displayPath(htmlFile))}${configFile ? ` --config ${shellArg(displayPath(configFile))}` : ''} --embed-images --recompute --write-back${runId ? ` --run ${runId}` : ''}`;

  let registered = false;
  const unregister = () => {
    if (!registered) return;
    registered = false;
    removeReviewRegistration(reportDir, regId);
  };
  process.on('exit', unregister);

  return new Promise((resolve, reject) => {
    let actualPort = port;
    let received = false;
    let finished = false;
    let timer = null;
    let lastStale = null;
    const allowedHosts = () => new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
    const allowedOrigins = () => new Set([`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`]);
    // Per port: two review servers on 127.0.0.1 share one cookie jar.
    const cookieName = () => `design-qa-${actualPort}`;

    const send = (res, status, body, headers = {}) => {
      if (res.headersSent) return;
      res.writeHead(status, {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
        ...headers,
      });
      res.end(body);
    };
    // Errors quote request values and paths: < > & leave as \u escapes (the same JSON), so no response body carries markup.
    const sendJson = (res, status, data, headers = {}) =>
      send(res, status, JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026'), {
        'Content-Type': 'application/json; charset=utf-8',
        ...headers,
      });
    const fail = (res, status, error, headers) => sendJson(res, status, { ok: false, error }, headers);

    /** Compare report.html with report.json; warn once each time that changes. */
    const freshness = (html) => {
      const f = reportFreshness(reportFile, htmlFile, { html });
      // One warning per state: "regenerated" is keyed on the two generatedAt values only, so an
      // mtime wobble never repeats it; "modified" warns again only when report.json changes again.
      const key = !f.stale ? null : f.reason === 'regenerated' ? `regenerated|${f.reportGeneratedAt}|${f.htmlGeneratedAt}` : `modified|${f.reportModifiedAt}`;
      if (key !== lastStale) {
        if (f.stale) {
          console.error(
            `review.mjs: warning: ${oneLine(displayPath(htmlFile))} is out of date (${f.reason === 'regenerated' ? `report.json was re-generated: ${oneLine(f.reportGeneratedAt)}, the page shows ${oneLine(f.htmlGeneratedAt)}` : 'report.json changed after it was rendered'}); ` +
              `the reviewer sees a banner. Re-render: ${renderCommand} — then ask them to reload.`,
          );
        } else if (lastStale) {
          console.error(`review.mjs: ${oneLine(displayPath(htmlFile))} is up to date again; the reviewer gets it on reload.`);
        }
        lastStale = key;
      }
      return f;
    };

    const server = http.createServer((req, res) => {
      try {
        route(req, res);
      } catch (err) {
        fail(res, 500, `server error: ${err.message}`);
      }
    });

    const onSignal = () => shutdown(3, NO_DECISIONS);
    const signals = process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
    function shutdown(code, message) {
      if (finished) return;
      finished = true;
      unregister();
      if (timer) clearTimeout(timer);
      for (const s of signals) process.off(s, onSignal);
      if (message) console.log(message);
      server.close(() => resolve(code));
      server.closeIdleConnections?.();
      if (code !== 0) server.closeAllConnections?.();
      else setTimeout(() => server.closeAllConnections?.(), 1000).unref();
    }

    function route(req, res) {
      if (!allowedHosts().has(String(req.headers.host ?? '').toLowerCase())) return fail(res, 403, 'forbidden: unexpected Host header');
      const raw = String(req.url ?? '/');
      const q = raw.indexOf('?');
      const rawPath = q >= 0 ? raw.slice(0, q) : raw;
      const query = new URLSearchParams(q >= 0 ? raw.slice(q + 1) : '');
      let pathname;
      try {
        pathname = decodeURIComponent(rawPath);
      } catch {
        return fail(res, 400, 'bad request path');
      }
      if (!pathname.startsWith('/') || pathname.includes('\0')) return fail(res, 400, 'bad request path');

      if (pathname === '/decisions') {
        if (req.method !== 'POST') return fail(res, 405, 'use POST', { Allow: 'POST' });
        return postDecisions(req, res);
      }
      if (req.method !== 'GET') return fail(res, 405, 'method not allowed', { Allow: 'GET' });
      if (pathname === '/') {
        if (!sameToken(query.get('t'), token)) return send(res, 403, 'Forbidden: open the exact URL review.mjs printed.', { 'Content-Type': 'text/plain; charset=utf-8' });
        // From disk on every request: a re-rendered report shows on reload.
        let html = readFileSync(htmlFile, 'utf8');
        const f = freshness(html);
        const notice = staleNotice(f);
        const reportStale = f.stale ? { reason: f.reason, reportGeneratedAt: f.reportGeneratedAt, htmlGeneratedAt: f.htmlGeneratedAt } : undefined;
        html = injectContext(html, { token, reportPath, configPath: configFile ? displayPath(configFile) : null, reportStale });
        if (unverified) html = injectNotice(html, unverified, 'design-qa-test-mode');
        if (notice) html = injectNotice(html, notice); // the stale banner stays the first element of <body>
        return send(res, 200, html, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': PAGE_CSP,
          'Set-Cookie': `${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        });
      }
      if (pathname === '/health') {
        // The registration id (from the folder's registration file) identifies this very server to --status and --stop.
        if (sameToken(req.headers['x-design-qa-registration'], regId)) {
          const f = freshness();
          return sendJson(res, 200, {
            ok: true,
            kind: 'design-qa-review',
            id: regId,
            pid: process.pid,
            port: actualPort,
            startedAt,
            runId: regRunId,
            reportPath,
            report: { stale: f.stale, reason: f.reason },
          });
        }
        if (!sameToken(query.get('t') ?? req.headers['x-design-qa-token'], token)) return fail(res, 403, 'forbidden: missing or wrong token');
        return sendJson(res, 200, { ok: true });
      }
      return serveStatic(pathname, req, res);
    }

    function serveStatic(pathname, req, res) {
      // Images and .json need the page's cookie (set by GET /?t=<token>) or the token header.
      if (!sameToken(cookies(req.headers.cookie)[cookieName()], token) && !sameToken(req.headers['x-design-qa-token'], token)) {
        return fail(res, 403, 'forbidden: open the exact URL review.mjs printed first');
      }
      const notFound = () => fail(res, 404, 'not found');
      const rel = pathname.replace(/^\/+/, '');
      const type = STATIC_TYPES[path.extname(rel).toLowerCase()];
      if (!rel || !type) return notFound();
      // Dot-files (the run lock, the review registration, temp files) are never served.
      if (rel.split(/[/\\]/).some((part) => part.startsWith('.'))) return notFound();
      const full = path.resolve(reportDir, rel);
      const lexical = path.relative(reportDir, full);
      if (!lexical || lexical.startsWith('..') || path.isAbsolute(lexical)) return notFound();
      let real;
      try {
        real = realpathSync(full);
      } catch {
        return notFound();
      }
      const inside = path.relative(realDir, real);
      if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return notFound();
      if (!statSync(real).isFile()) return notFound();
      const headers = { 'Content-Type': type };
      if (type.startsWith('image/svg')) headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'";
      return send(res, 200, readFileSync(real), headers);
    }

    function postDecisions(req, res) {
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigins().has(String(origin).toLowerCase())) return fail(res, 403, 'forbidden: cross-origin request');
      if (!sameToken(req.headers['x-design-qa-token'], token)) return fail(res, 403, 'forbidden: missing or wrong token');
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) return fail(res, 415, 'Content-Type must be application/json');
      const tooLarge = () => {
        fail(res, 413, `the decisions document is larger than ${MAX_BODY} bytes`, { Connection: 'close' });
        req.resume();
      };
      if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) return tooLarge();
      const chunks = [];
      let size = 0;
      let over = false;
      req.on('data', (chunk) => {
        if (over) return;
        size += chunk.length;
        if (size > MAX_BODY) {
          over = true;
          tooLarge();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (over || res.headersSent) return;
        try {
          receive(Buffer.concat(chunks).toString('utf8'), res);
        } catch (err) {
          fail(res, 500, `server error: ${err.message}`);
        }
      });
    }

    function receive(body, res) {
      if (received) return fail(res, 409, 'decisions were already received; this review is closed');
      let doc;
      try {
        doc = parseDecisions(body);
      } catch (err) {
        return fail(res, 400, err.message);
      }
      let report;
      try {
        report = JSON.parse(readFileSync(reportFile, 'utf8').replace(/^﻿/, ''));
      } catch (err) {
        return fail(res, 500, `cannot read ${reportPath}: ${err.message}`);
      }
      try {
        checkDecisionsTarget(report, doc);
        applyDecisions(report, doc, { options: config });
      } catch (err) {
        if (err instanceof DecisionsError) {
          // A stale page (report.json re-generated, report.html not re-rendered): the banner tells the reviewer; tell the agent.
          if (err.code === 'stale' && freshness().reason === 'regenerated') {
            console.error(`review.mjs: warning: a Send was refused because report.html shows an older report than report.json. Re-render: ${renderCommand} — then ask the reviewer to reload and send again.`);
          }
          return fail(res, err.code === 'invalid' ? 400 : 409, err.message);
        }
        throw err;
      }
      received = true;
      try {
        writeText(decisionsFile, `${JSON.stringify(doc, null, 2)}\n`); // atomic; refuses a symlink
      } catch (err) {
        received = false;
        return fail(res, 500, err instanceof CliError ? err.message : `cannot save ${displayPath(decisionsFile)}: ${err.message}`);
      }
      const summary = summaryLine(doc);
      res.on('finish', () => {
        shutdown(
          0,
          [
            `Decisions received from ${oneLine(doc.decidedBy ?? 'the reviewer')}: ${summary}`,
            `Saved: ${oneLine(displayPath(decisionsFile))}`,
            `Next: ${scriptCommand('apply-decisions.mjs')} --report ${shellArg(reportPath)}${configFile ? ` --config ${shellArg(displayPath(configFile))}` : ''}${regRunId ? ` --run ${regRunId}` : ''}`,
          ].join('\n'),
        );
      });
      sendJson(res, 200, { ok: true, path: displayPath(decisionsFile), summary }, { Connection: 'close' });
    }

    server.on('error', (err) => {
      if (finished) return;
      finished = true;
      unregister();
      if (timer) clearTimeout(timer);
      for (const s of signals) process.off(s, onSignal);
      const why = err.code === 'EADDRINUSE' ? `port ${port} is already in use (use --port 0 for any free port)` : err.message;
      reject(new CliError(`cannot start the review server: ${why}`, 1));
    });

    server.listen(port, '127.0.0.1', async () => {
      actualPort = server.address().port;
      for (const s of signals) process.on(s, onSignal);
      const url = `http://127.0.0.1:${actualPort}/?t=${token}`;
      // The URL is printed only once the server answered on it, as this registration.
      const self = await probeReviewServer({ id: regId, pid: process.pid, port: actualPort }, { timeoutMs: 5000 });
      if (finished) return;
      if (!self.ok) {
        console.error(`review.mjs: error: the review server did not answer its own health check on port ${actualPort} (${oneLine(self.error)}); no review link was given`);
        shutdown(1);
        return;
      }
      try {
        writeReviewRegistration(reportDir, { kind: 'design-qa-review', version: 1, id: regId, pid: process.pid, port: actualPort, host: os.hostname(), startedAt, runId: regRunId, report: path.basename(reportFile) });
        registered = true;
      } catch (err) {
        console.error(`review.mjs: warning: cannot register the server in ${oneLine(displayPath(reportDir))} (${oneLine(err.message)}); --status and --stop will not find it`);
      }
      console.log(`Review open: ${url}`);
      log('Waiting for the reviewer to click Send (Ctrl+C to stop).');
      log(`Stop it with: ${stopCommand}`);
      freshness();
      if (timeoutMin > 0) timer = setTimeout(() => shutdown(3, NO_DECISIONS), Math.round(timeoutMin * 60_000));
      if (values['no-open'] || process.env.CI) {
        log(`Not opening a browser (${values['no-open'] ? '--no-open' : 'CI is set'}): open the URL above.`);
      } else {
        openBrowser(url, (why) => console.log(`Could not open a browser (${oneLine(why)}). Open this URL yourself: ${url}`));
      }
    });
  });
}

runMain(import.meta.url, main);
