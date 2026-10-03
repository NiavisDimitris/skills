#!/usr/bin/env node
// Mock design-qa pass: "Checkout v3" (Figma, 5 frames at 1440×900) against a drifting app.
//
//   node examples/mock-five-frames/build.mjs            capture + compare + diff + report + render
//   node examples/mock-five-frames/build.mjs --report   rebuild report.json and the HTML from the existing evidence
//
// The design side is src/design/*.html (stand-ins for the Figma exports, built with the Acme DS
// tokens and components); the app side is src/app/*.html. Both are served locally and captured
// with the skill's own scripts (capture.mjs, compare.mjs, diff.mjs, backfill.mjs,
// render-report.mjs, validate.mjs). The design screenshots are then filed as the Figma side
// (screens/<id>/figma/<state>.png), so the report reads as a Figma-sourced pass.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SCRIPTS = path.join(ROOT, 'skills/design-qa/scripts');
const SRC = path.join(HERE, 'src');
const EVIDENCE = path.join(HERE, 'evidence');
const PORT = 5179;
const BASE = `http://localhost:${PORT}`;
const W = 1440;
const H = 900;
const ENV = { ...process.env, DESIGN_QA_COMMIT: 'b7e41c9a20f3d58e6c1a4f07d92e3b18c5a6f2d4', DESIGN_QA_BRANCH: 'feat/checkout-v3' };

export const SCREENS = [
  { id: 'cart', name: 'Cart', node: '2140:120', design: ['with-data', 'empty'], app: ['with-data', 'empty'], backfill: ['item-removed'] },
  { id: 'shipping', name: 'Shipping', node: '2140:410', design: ['with-data', 'hover'], app: ['with-data', 'hover'] },
  { id: 'payment', name: 'Payment', node: '2140:690', design: ['with-data', 'error'], app: ['with-data', 'error'], backfill: ['processing'] },
  { id: 'review', name: 'Review', node: '2140:955', design: ['with-data', 'promo-applied'], app: ['with-data'] },
  { id: 'confirmation', name: 'Confirmation', node: '2140:1230', design: ['with-data'], app: ['with-data'] },
];

const rel = (p) => path.relative(ROOT, p);
const log = (msg) => console.log(`[mock] ${msg}`);

// Runs a skill script asynchronously (the local server lives in this process, so a
// blocking spawnSync would starve it). Resolves { status, stdout, stderr }.
function node(script, args, { allow = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS, script), ...args], { cwd: ROOT, env: ENV });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (status) => {
      if (!allow.includes(status)) {
        process.stderr.write(stdout + stderr);
        reject(new Error(`${script} exited ${status}`));
      } else resolve({ status, stdout, stderr });
    });
  });
}

// --- Local server: /checkout/<id> → app, /figma/<id> → design stand-in, shared assets at / ---
function serve() {
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, BASE);
    let file = null;
    const m = /^\/(checkout|figma)\/([a-z-]+)$/.exec(url.pathname);
    if (m) file = path.join(SRC, m[1] === 'checkout' ? 'app' : 'design', `${m[2]}.html`);
    else if (/^\/[a-z-]+\.(css|js)$/.test(url.pathname)) file = path.join(SRC, url.pathname.slice(1));
    if (!file || !existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

async function capture() {
  rmSync(EVIDENCE, { recursive: true, force: true });
  const server = await serve();
  try {
    const grab = path.join(SRC, 'capture/grab.json');
    for (const s of SCREENS) {
      const out = path.join(EVIDENCE, 'screens', s.id);
      const statesFor = (side) => {
        const own = path.join(SRC, `capture/states-${s.id}-${side}.json`);
        return existsSync(own) ? own : path.join(SRC, `capture/states-${s.id}.json`);
      };
      log(`capture ${s.id}: design side`);
      await node('capture.mjs', ['--side', 'design', '--url', `${BASE}/figma/${s.id}`, '--width', String(W), '--height', String(H), '--states', statesFor('design'), '--grab', grab, '--out', out, '--quiet']);
      log(`capture ${s.id}: app side`);
      await node('capture.mjs', ['--url', `${BASE}/checkout/${s.id}`, '--width', String(W), '--height', String(H), '--states', statesFor('app'), '--grab', grab, '--out', out, '--quiet']);
      // The design screenshots are the Figma side of this pass.
      mkdirSync(path.join(out, 'figma'), { recursive: true });
      for (const f of readdirSync(path.join(out, 'design'))) copyFileSync(path.join(out, 'design', f), path.join(out, 'figma', f));
      log(`compare ${s.id}`);
      await node('compare.mjs', ['--app', out, '--out', path.join(out, 'compare.json'), '--quiet']);
      if (s.backfill) {
        log(`backfill capture ${s.id}: ${s.backfill.join(', ')} (app only)`);
        await node('capture.mjs', ['--url', `${BASE}/checkout/${s.id}`, '--width', String(W), '--height', String(H), '--states', path.join(SRC, `capture/backfill-${s.id}.json`), '--grab', grab, '--out', path.join(EVIDENCE, 'backfill', s.id), '--quiet']);
      }
    }
  } finally {
    server.close();
  }
  // Pixel diffs, masking data regions only (the confirmation's order number).
  for (const s of SCREENS) {
    const out = path.join(EVIDENCE, 'screens', s.id);
    const pairs = {};
    for (const state of s.app) {
      const pair = { a: `figma/${state}.png`, b: `app/${state}.png` };
      const mask = masksFor(s.id, state);
      if (mask.length) {
        writeFileSync(path.join(out, `mask-${state}.json`), JSON.stringify(mask, null, 2) + '\n');
        pair.mask = `mask-${state}.json`;
      }
      pairs[state] = pair;
    }
    writeFileSync(path.join(out, 'pairs.json'), JSON.stringify(pairs, null, 2) + '\n');
    const res = await node('diff.mjs', ['--pairs', path.join(out, 'pairs.json'), '--out-dir', path.join(out, 'diff'), '--json'], { allow: [0, 1] });
    writeFileSync(path.join(out, 'diff.json'), res.stdout);
    log(`diff ${s.id}: ${Object.entries(JSON.parse(res.stdout).results).map(([k, v]) => `${k} ${v.percent}% ${v.band}`).join(' · ')}`);
  }
}

function masksFor(screen, state) {
  if (screen !== 'confirmation') return [];
  const computed = JSON.parse(readFileSync(path.join(EVIDENCE, 'screens', screen, 'computed', `${state}.json`), 'utf8'));
  const r = computed.orderNumber?.samples?.[0]?.__rect;
  return r ? [{ x: r.x - 4, y: r.y - 2, w: r.w + 8, h: r.h + 4, label: 'order number (data)' }] : [];
}

async function main() {
  const reportOnly = process.argv.includes('--report');
  if (!reportOnly) await capture();
  const { buildReport } = await import('./src/report.mjs');
  await buildReport({ HERE, ROOT, SCRIPTS, EVIDENCE, SCREENS, BASE, W, H, node, log });
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
