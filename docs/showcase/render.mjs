#!/usr/bin/env node
/* Render the design-qa showcase to MP4.
 *   node docs/showcase/render.mjs --frames 1,3.5,12        stills  -> out/preview/
 *   node docs/showcase/render.mjs --sheet 0:60:2.5          contact sheet -> out/sheet.png
 *   node docs/showcase/render.mjs --video [--workers 4] [--fps 60] [--from 0 --to 80] [--out file.mp4]   (video seconds)
 * Frames are piped straight into ffmpeg (libx264); nothing is written to disk per frame. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, '../../package.json'));
const { chromium } = require('playwright');
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.svg': 'image/svg+xml' };
function serve() {
  const srv = http.createServer((req, res) => {
    const p = path.join(HERE, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(HERE) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
async function openPage(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 60000 });
  const err = await page.evaluate(() => window.__error);
  if (err) throw new Error('page failed: ' + err);
  const cdp = await page.context().newCDPSession(page);
  const shot = async (t) => {
    await page.evaluate((x) => window.renderFrame(x), t);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, captureBeyondViewport: false });
    return Buffer.from(data, 'base64');
  };
  const meta = await page.evaluate(() => window.__meta);
  return { page, shot, errors, meta };
}
const ff = (argv) => new Promise((res, rej) => {
  const p = spawn('ffmpeg', argv, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; p.stderr.on('data', (d) => (err += d));
  p.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg failed: ' + err.slice(-1500)))));
});

const srv = await serve();
const url = `http://127.0.0.1:${srv.address().port}/index.html`;
const t0 = Date.now();
try {
  if (arg('frames')) {
    const browser = await chromium.launch();
    const { shot, errors } = await openPage(browser, url);
    const dir = path.join(OUT, 'preview'); fs.mkdirSync(dir, { recursive: true });
    for (const t of String(arg('frames')).split(',').map(Number)) {
      const f = path.join(dir, `t-${t.toFixed(2)}.png`);
      fs.writeFileSync(f, await shot(t));
      console.log(f);
    }
    if (errors.length) console.log('page errors:', errors);
    await browser.close();
  } else if (arg('sheet')) {
    const [a, b, step] = String(arg('sheet')).split(':').map(Number);
    const cols = Number(arg('cols', 4)), tw = Number(arg('tw', 480));
    const browser = await chromium.launch();
    const { shot, errors, meta } = await openPage(browser, url);
    const dir = path.join(OUT, 'sheet'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    let n = 0;
    for (let t = a; t <= b + 1e-9; t += step) fs.writeFileSync(path.join(dir, String(n++).padStart(3, '0') + '.png'), await shot(Math.min(t, meta.duration - 0.01)));
    const rows = Math.ceil(n / cols);
    const outFile = path.join(OUT, arg('name', 'sheet') + '.png');
    await ff(['-y', '-i', path.join(dir, '%03d.png'), '-vf', `scale=${tw}:-1,drawtext=text='%{n}':x=8:y=8:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.55,tile=${cols}x${rows}:padding=6:color=white`, '-frames:v', '1', outFile]).catch(async () => {
      await ff(['-y', '-i', path.join(dir, '%03d.png'), '-vf', `scale=${tw}:-1,tile=${cols}x${rows}:padding=6:color=white`, '-frames:v', '1', outFile]);
    });
    console.log(outFile, `(${n} frames, index = (t - ${a}) / ${step})`);
    if (errors.length) console.log('page errors:', errors);
    await browser.close();
  } else if (arg('video')) {
    const probe = await chromium.launch();
    const { meta } = await openPage(probe, url);
    await probe.close();
    const fps = Number(arg('fps', meta.fps)), from = Number(arg('from', 0)), to = Number(arg('to', meta.duration));
    const workers = Number(arg('workers', Math.max(2, Math.min(6, os.cpus().length - 2))));
    const total = Math.round((to - from) * fps);
    const segDir = path.join(OUT, 'seg'); fs.rmSync(segDir, { recursive: true, force: true }); fs.mkdirSync(segDir, { recursive: true });
    let done = 0; const tick = setInterval(() => process.stdout.write(`\r  frames ${done}/${total} · ${((Date.now() - t0) / 1000).toFixed(0)}s   `), 2000);
    const job = async (k) => {
      const a = Math.floor((k * total) / workers), b = Math.floor(((k + 1) * total) / workers);
      const browser = await chromium.launch();
      const { shot, errors } = await openPage(browser, url);
      const seg = path.join(segDir, `seg-${k}.mp4`);
      const enc = spawn('ffmpeg', ['-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-tune', 'animation', '-crf', '15', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(fps), '-threads', '2', seg], { stdio: ['pipe', 'ignore', 'pipe'] });
      let eerr = ''; enc.stderr.on('data', (d) => (eerr += d));
      const closed = new Promise((res, rej) => enc.on('close', (c) => (c === 0 ? res() : rej(new Error('encoder: ' + eerr.slice(-800))))));
      for (let i = a; i < b; i++) {
        const buf = await shot(from + i / fps);
        if (!enc.stdin.write(buf)) await new Promise((r) => enc.stdin.once('drain', r));
        done++;
      }
      enc.stdin.end();
      await closed;
      await browser.close();
      if (errors.length) console.log(`\n  worker ${k} page errors:`, errors.slice(0, 5));
      return seg;
    };
    const segs = await Promise.all(Array.from({ length: workers }, (_, k) => job(k)));
    clearInterval(tick);
    const list = path.join(segDir, 'list.txt');
    fs.writeFileSync(list, segs.map((s) => `file '${s}'`).join('\n'));
    const silent = path.join(OUT, 'video-silent.mp4');
    await ff(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', silent]);
    const audio = arg('audio', path.join(HERE, 'audio', 'soundtrack.wav'));
    const outFile = arg('out', path.join(OUT, 'design-qa-showcase.mp4'));
    if (audio !== 'none' && fs.existsSync(audio) && from === 0 && Math.abs(to - meta.duration) < 1e-6) {
      await ff(['-y', '-i', silent, '-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', outFile]);
    } else {
      await ff(['-y', '-i', silent, '-c', 'copy', '-movflags', '+faststart', outFile]);
    }
    fs.rmSync(segDir, { recursive: true, force: true });
    console.log(`\n${outFile} · ${total} frames · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } else {
    console.log('usage: --frames t1,t2 | --sheet from:to:step | --video [--workers n] [--fps 60] [--out file]');
  }
} finally {
  srv.close();
}
