#!/usr/bin/env node
// The local review server: serves report.html on 127.0.0.1 with a one-time token,
// and waits for the reviewer to click "Send to agent". The decisions document is
// validated against report.json, saved as <report dir>/decisions.json, and the
// process exits 0 with the command that applies it. Works with any coding agent:
// run it, wait for the exit, run the printed "Next:" command. node:http only.
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, displayPath, formatIssues, oneLine, parseCli, readJsonFile, runMain, toNumber, usageError, writeText } from './lib/args.mjs';
import { DecisionsError, applyDecisions, checkDecisionsTarget, parseDecisions, summaryLine } from './lib/decisions.mjs';
import { findScriptElement, resolveReviewConfig, shellArg } from './lib/review-context.mjs';
import { validateConfig } from './lib/schema-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 1024 * 1024;
const CONTEXT_ID = 'design-qa-context';
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
      [--timeout-min <n>] [--quiet]

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
  --quiet                print only the URL and the result
  -h, --help             show this help

Prints "Review open: http://127.0.0.1:<port>/?t=<token>" and opens it. The page gets
{ live: true, token, reportPath } in its <script id="design-qa-context"> element, so its
"Send to agent" button can POST the decisions document (schemas/decisions.schema.json)
to /decisions. The document is checked against report.json on disk (slug,
reportGeneratedAt, known ids); a rejected one is answered with the reason and the
server keeps waiting. An accepted one is saved atomically as <dir>/decisions.json, then
this prints:
  Decisions received from <name>: <summary>
  Saved: <dir>/decisions.json
  Next: node <scripts>/apply-decisions.mjs --report <dir>/report.json
and exits 0. Run that command next.

Security: binds 127.0.0.1 only; a random 128-bit token is required for the page and
for POST /decisions (header X-Design-QA-Token); opening the page with it sets an
HttpOnly, SameSite=Strict cookie that the images and .json files inside the report
folder require (or the header); requests with another Host header, or a POST from
another Origin, are refused; no CORS headers; the page is served with a
Content-Security-Policy (inline script and styles, same-origin images and requests
only); nothing in the payload is ever executed.

Exit codes: 0 decisions received and saved · 1 server error (e.g. the port is taken) ·
2 bad arguments · 3 timed out or interrupted with nothing received`;

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
export function injectContext(html, { token, reportPath, configPath }) {
  const live = { live: true, token, reportPath, ...(configPath !== undefined ? { configPath } : {}) };
  const m = findScriptElement(html, CONTEXT_ID);
  if (m) {
    let existing = {};
    try {
      const parsed = JSON.parse(m.body.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
    } catch {
      // A placeholder or empty element: nothing to keep.
    }
    const rest = Object.fromEntries(Object.entries(existing).filter(([k]) => !(k in live)));
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

function openBrowser(url, log) {
  const [cmd, args, extra] =
    process.platform === 'darwin'
      ? ['open', [url], {}]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url], { windowsVerbatimArguments: true }]
        : ['xdg-open', [url], {}];
  const failed = () => log('Could not open a browser; open the URL above.');
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', ...extra });
    child.on('error', failed);
    child.unref();
  } catch {
    failed();
  }
}

async function main(argv) {
  const { values } = parseCli(argv, {
    report: { type: 'string' },
    html: { type: 'string' },
    config: { type: 'string' },
    port: { type: 'string' },
    'no-open': { type: 'boolean' },
    'timeout-min': { type: 'string' },
    quiet: { type: 'boolean' },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const log = values.quiet ? () => {} : (msg) => console.log(msg);
  if (!values.report) throw usageError('--report <dir>/report.json is required (see --help)');
  const reportFile = path.resolve(values.report);
  const reportDir = path.dirname(reportFile);
  const initialReport = readJsonFile(reportFile, 'report', 2);
  const htmlFile = path.resolve(values.html ?? path.join(reportDir, 'report.html'));
  if (!existsSync(htmlFile)) {
    throw usageError(
      `${oneLine(displayPath(htmlFile))} not found: render it first: node ${shellArg(displayPath(path.join(HERE, 'render-report.mjs')))} --in ${shellArg(displayPath(reportFile))} --out ${shellArg(displayPath(htmlFile))}`,
    );
  }
  const port = toNumber(values.port, 'port', { min: 0, max: 65535, integer: true }) ?? 0;
  const configFile = resolveReviewConfig(reportFile, { explicit: values.config, htmlFile, generatedAt: initialReport.meta?.generatedAt });
  const config = configFile ? readJsonFile(configFile, 'config', 2) : {};
  const cv = validateConfig(config);
  if (configFile && !cv.valid) throw usageError(`--config is invalid:\n${formatIssues(cv.errors)}`);
  const timeoutMin = toNumber(values['timeout-min'], 'timeout-min', { min: 0, max: MAX_TIMEOUT_MIN }) ?? 240;
  const token = randomBytes(16).toString('hex');
  const reportPath = displayPath(reportFile);
  const decisionsFile = path.join(reportDir, 'decisions.json');
  const realDir = realpathSync(reportDir);

  return new Promise((resolve, reject) => {
    let actualPort = port;
    let received = false;
    let finished = false;
    let timer = null;
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
    const sendJson = (res, status, data, headers = {}) =>
      send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    const fail = (res, status, error, headers) => sendJson(res, status, { ok: false, error }, headers);

    const server = http.createServer((req, res) => {
      try {
        route(req, res);
      } catch (err) {
        fail(res, 500, `server error: ${err.message}`);
      }
    });

    const onSignal = () => shutdown(3, NO_DECISIONS);
    function shutdown(code, message) {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
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
        const html = readFileSync(htmlFile, 'utf8');
        return send(res, 200, injectContext(html, { token, reportPath, configPath: configFile ? displayPath(configFile) : null }), {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': PAGE_CSP,
          'Set-Cookie': `${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        });
      }
      if (pathname === '/health') {
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
        if (err instanceof DecisionsError) return fail(res, err.code === 'invalid' ? 400 : 409, err.message);
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
            `Next: node ${shellArg(displayPath(path.join(HERE, 'apply-decisions.mjs')))} --report ${shellArg(reportPath)}${configFile ? ` --config ${shellArg(displayPath(configFile))}` : ''}`,
          ].join('\n'),
        );
      });
      sendJson(res, 200, { ok: true, path: displayPath(decisionsFile), summary }, { Connection: 'close' });
    }

    server.on('error', (err) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      const why = err.code === 'EADDRINUSE' ? `port ${port} is already in use (use --port 0 for any free port)` : err.message;
      reject(new CliError(`cannot start the review server: ${why}`, 1));
    });

    server.listen(port, '127.0.0.1', () => {
      actualPort = server.address().port;
      const url = `http://127.0.0.1:${actualPort}/?t=${token}`;
      console.log(`Review open: ${url}`);
      log('Waiting for the reviewer to click Send (Ctrl+C to stop).');
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      if (timeoutMin > 0) timer = setTimeout(() => shutdown(3, NO_DECISIONS), Math.round(timeoutMin * 60_000));
      if (!values['no-open'] && !process.env.CI) openBrowser(url, (msg) => console.log(msg));
    });
  });
}

runMain(import.meta.url, main);
