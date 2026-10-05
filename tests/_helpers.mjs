// Shared test utilities (not a test file: the npm test glob is tests/*.test.mjs).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The unit-test fixtures (tests/fixtures/report-*.json, ui-report*.json) are assembled by hand, so they cannot
// pass build verification (meta.build against findings.json and the evidence). Every script a test runs
// skips it, announcing it on stderr; tests of the verification itself unset it (env: { DESIGN_QA_TEST_SKIP_BUILD_VERIFY: '' }).
process.env.DESIGN_QA_TEST_SKIP_BUILD_VERIFY = '1';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKILL = path.join(ROOT, 'skills', 'design-qa');
export const SCRIPTS = path.join(SKILL, 'scripts');
export const FIXTURES = path.join(ROOT, 'tests', 'fixtures');

export const script = (name) => path.join(SCRIPTS, name);
export const fixture = (name) => path.join(FIXTURES, name);

/** Fresh parsed copy of a JSON fixture. */
export function loadFixture(name) {
  return JSON.parse(readFileSync(fixture(name), 'utf8'));
}

/** A unique temp directory (safe under --test-concurrency). */
export function tmpDir(prefix = 'design-qa-test-') {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Run a script asynchronously (never spawnSync: tests serve HTTP from this process).
 * Resolves { code, stdout, stderr }.
 */
export function run(scriptPath, args = [], { env = {}, cwd = ROOT, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${path.basename(scriptPath)} timed out after ${timeout} ms\n${stderr}`));
    }, timeout);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Start an HTTP server on an ephemeral port. handler(req, res, body) may be async.
 * Resolves { url, port, requests, close }; requests records { method, url, headers, body }.
 */
export function startServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      try {
        await handler(req, res, body);
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(String(err));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

export function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(data));
}
