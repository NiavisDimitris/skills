#!/usr/bin/env node
// Pixel diff between a Figma export and an app screenshot (pixelmatch).
// Never resizes: images must share the same pixel dimensions (same viewport,
// Figma export scale 1 ↔ deviceScaleFactor 1).
import { existsSync } from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { CliError, displayPath, parseCli, readJsonFile, runMain, toNumber, usageError, writeJson } from './lib/args.mjs';
import { clipRect, fillRect, readPng, writePng } from './lib/png.mjs';
import { band } from './lib/ranking.mjs';

const HELP = `Pixel-diff a Figma export against an app screenshot.

Usage:
  node scripts/diff.mjs <a.png> <b.png> [--out diff.png] [--state <name>] [options]
  node scripts/diff.mjs --pairs pairs.json [--out-dir dir] [options]

Options:
  --out <file>        write the diff image (single mode)
  --out-dir <dir>     write <dir>/<state>.png for every pair (batch mode)
  --state <name>      label the result (single mode)
  --threshold <0..1>  pixelmatch colour threshold (default 0.1; anti-aliasing is ignored)
  --mask <file>       JSON array of { "x", "y", "w", "h", "label"? } rectangles painted the
                      same neutral grey on both images before comparing (dynamic data,
                      avatars, timestamps). Applies to every pair in batch mode.
  --pass <pct>        percent below which the band is "pass" (default 1)
  --review <pct>      percent up to which the band is "review" (default 5); above is "fail"
  --json              JSON only on stdout (no human summary on stderr)
  -h, --help          show this help

pairs.json: { "<state>": { "a": "figma/empty.png", "b": "app/empty.png", "mask"?: "mask.json" } }
            or [ { "state", "a", "b", "mask"? } ]. Relative paths resolve against the
            pairs.json directory, then the working directory.

Output (stdout, JSON): { state?, width, height, diffPixels, totalPixels, percent, band,
maskedPercent, out } — percent and maskedPercent are % of width × height, 2 decimals.
Batch: { results: { "<state>": {…} }, worst: { state, percent, band } }; a pair that
cannot be compared gets { error, exitCode } instead.

Exit codes: 0 pass (or review, with a warning on stderr) · 1 fail · 2 dimension mismatch
or bad arguments · 3 unreadable PNG. In batch mode the most serious outcome wins (3, 2, 1, 0).
Images of different sizes are never resized: never compare screenshots taken at different
scales — capture at the Figma frame size with deviceScaleFactor 1 and export Figma at scale 1.`;

const NEUTRAL = [128, 128, 128, 255];
const round2 = (n) => Math.round(n * 100) / 100;

export function mismatchMessage(a, b, labelA = 'a', labelB = 'b') {
  const ratio = a.width / b.width;
  let hint = '';
  if (Number.isInteger(ratio) || Number.isInteger(1 / ratio)) {
    hint = ` One image is ${Math.max(ratio, 1 / ratio)}× the other: a device scale factor / export scale mismatch.`;
  }
  return (
    `dimension mismatch: ${labelA} is ${a.width}×${a.height} but ${labelB} is ${b.width}×${b.height}.${hint} ` +
    'Never compare screenshots at different scales — capture at the Figma frame size with deviceScaleFactor 1 ' +
    'and export Figma at scale 1. diff.mjs does not resize images.'
  );
}

/** Validate and normalise a mask (array, or { regions: [...] }). */
export function normaliseMask(mask, label = 'mask') {
  const list = Array.isArray(mask) ? mask : Array.isArray(mask?.regions) ? mask.regions : null;
  if (!list) throw usageError(`${label}: expected a JSON array of { x, y, w, h } rectangles`);
  return list.map((r, i) => {
    const ok = r && ['x', 'y', 'w', 'h'].every((k) => typeof r[k] === 'number' && Number.isFinite(r[k])) && r.w > 0 && r.h > 0;
    if (!ok) throw usageError(`${label}[${i}]: expected { x, y, w, h } with numbers and positive w/h`);
    return { x: r.x, y: r.y, w: r.w, h: r.h, label: r.label ?? null };
  });
}

/** Number of pixels covered by the union of the rectangles (clipped to the image). */
export function maskedPixelCount(rects, width, height) {
  if (!rects.length) return 0;
  const covered = new Uint8Array(width * height);
  let count = 0;
  for (const r of rects) {
    const c = clipRect(r, width, height);
    if (!c) continue;
    for (let y = c.y0; y < c.y1; y++) {
      for (let x = c.x0; x < c.x1; x++) {
        const i = y * width + x;
        if (!covered[i]) {
          covered[i] = 1;
          count++;
        }
      }
    }
  }
  return count;
}

/**
 * Compare two decoded PNGs ({ width, height, data }). Masks are painted on
 * copies. Returns the result object plus `diffPng` (a PNG instance or null).
 */
export function diffImages(a, b, { threshold = 0.1, mask = [], tolerances, withDiffImage = true, labels = ['a', 'b'] } = {}) {
  if (a.width !== b.width || a.height !== b.height) throw new CliError(mismatchMessage(a, b, labels[0], labels[1]), 2);
  const { width, height } = a;
  let dataA = a.data;
  let dataB = b.data;
  if (mask.length) {
    const ca = { width, height, data: Buffer.from(a.data) };
    const cb = { width, height, data: Buffer.from(b.data) };
    for (const r of mask) {
      fillRect(ca, r, NEUTRAL);
      fillRect(cb, r, NEUTRAL);
    }
    dataA = ca.data;
    dataB = cb.data;
  }
  const diffPng = withDiffImage ? new PNG({ width, height }) : null;
  const diffPixels = pixelmatch(dataA, dataB, diffPng ? diffPng.data : null, width, height, { threshold, includeAA: false });
  const totalPixels = width * height;
  const percent = round2((diffPixels / totalPixels) * 100);
  return {
    width,
    height,
    diffPixels,
    totalPixels,
    percent,
    band: band(percent, tolerances),
    maskedPercent: round2((maskedPixelCount(mask, width, height) / totalPixels) * 100),
    diffPng,
  };
}

function resolveInput(p, baseDir) {
  if (path.isAbsolute(p)) return p;
  const fromBase = path.resolve(baseDir, p);
  return existsSync(fromBase) ? fromBase : path.resolve(p);
}

function loadMask(file, label) {
  return normaliseMask(readJsonFile(file, 'mask', 2), label);
}

/** Normalise pairs.json (object or array form) into [{ state, a, b, mask }]. */
export function normalisePairs(raw) {
  let list;
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === 'object') list = Object.entries(raw).map(([state, v]) => ({ state, ...(v || {}) }));
  else throw usageError('pairs.json: expected an object { "<state>": { "a", "b" } } or an array of { state, a, b }');
  const seen = new Set();
  return list.map((p, i) => {
    if (!p || typeof p.state !== 'string' || !p.state || typeof p.a !== 'string' || typeof p.b !== 'string') {
      throw usageError(`pairs.json entry ${i}: expected { state, a, b } with string values`);
    }
    if (seen.has(p.state)) throw usageError(`pairs.json: duplicate state "${p.state}"`);
    seen.add(p.state);
    return { state: p.state, a: p.a, b: p.b, mask: typeof p.mask === 'string' ? p.mask : null };
  });
}

function fileSafe(name) {
  return String(name).replace(/[^A-Za-z0-9._-]+/g, '-');
}

function summary(r) {
  const label = r.state ? `${r.state}: ` : '';
  const masked = r.maskedPercent ? `, ${r.maskedPercent}% masked` : '';
  return `${label}${r.percent}% different (${r.band}) — ${r.diffPixels}/${r.totalPixels} px${masked}${r.out ? ` → ${displayPath(r.out)}` : ''}`;
}

async function main(argv) {
  const { values, positionals } = parseCli(
    argv,
    {
      out: { type: 'string' },
      'out-dir': { type: 'string' },
      pairs: { type: 'string' },
      state: { type: 'string' },
      threshold: { type: 'string' },
      mask: { type: 'string' },
      pass: { type: 'string' },
      review: { type: 'string' },
      json: { type: 'boolean' },
    },
    { allowPositionals: true },
  );
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const threshold = toNumber(values.threshold ?? '0.1', 'threshold', { min: 0, max: 1 });
  const pass = toNumber(values.pass ?? '1', 'pass', { min: 0, max: 100 });
  const review = toNumber(values.review ?? '5', 'review', { min: 0, max: 100 });
  if (pass > review) throw usageError(`--pass (${pass}) must be <= --review (${review})`);
  const tolerances = { pass, review };
  const globalMask = values.mask ? loadMask(path.resolve(values.mask), '--mask') : [];
  const say = values.json ? () => {} : (msg) => console.error(msg);

  if (values.pairs) {
    if (positionals.length) throw usageError('use either <a.png> <b.png> or --pairs, not both');
    if (values.out) throw usageError('--out is for single mode; use --out-dir with --pairs');
    const pairsFile = path.resolve(values.pairs);
    const baseDir = path.dirname(pairsFile);
    const pairs = normalisePairs(readJsonFile(pairsFile, 'pairs', 2));
    const results = {};
    let worst = null;
    // Exit codes are ordered by seriousness: 3 unreadable > 2 mismatch > 1 fail > 0.
    let exitCode = 0;
    for (const p of pairs) {
      try {
        const mask = [...globalMask, ...(p.mask ? loadMask(resolveInput(p.mask, baseDir), `${p.state}.mask`) : [])];
        const fileA = resolveInput(p.a, baseDir);
        const fileB = resolveInput(p.b, baseDir);
        const r = diffImages(readPng(fileA), readPng(fileB), {
          threshold,
          mask,
          tolerances,
          withDiffImage: Boolean(values['out-dir']),
          labels: [p.a, p.b],
        });
        let out = null;
        if (values['out-dir'] && r.diffPng) {
          out = path.resolve(values['out-dir'], `${fileSafe(p.state)}.png`);
          writePng(out, r.diffPng);
        }
        const { diffPng, ...rest } = r;
        results[p.state] = { state: p.state, ...rest, out };
        say(summary(results[p.state]));
        exitCode = Math.max(exitCode, r.band === 'fail' ? 1 : 0);
        if (!worst || r.percent > worst.percent) worst = { state: p.state, percent: r.percent, band: r.band };
      } catch (err) {
        if (!(err instanceof CliError)) throw err;
        results[p.state] = { state: p.state, error: err.message, exitCode: err.exitCode };
        console.error(`${p.state}: ${err.message}`);
        exitCode = Math.max(exitCode, err.exitCode);
      }
    }
    console.log(JSON.stringify({ results, worst }, null, 2));
    if (exitCode === 0 && worst && worst.band === 'review') console.error(`warning: worst state "${worst.state}" is in the review band (${worst.percent}%)`);
    return exitCode;
  }

  if (positionals.length !== 2) throw usageError('expected two PNG files (or --pairs pairs.json); see --help');
  if (values['out-dir']) throw usageError('--out-dir is for --pairs mode; use --out <diff.png>');
  const [fileA, fileB] = positionals.map((p) => path.resolve(p));
  const r = diffImages(readPng(fileA), readPng(fileB), {
    threshold,
    mask: globalMask,
    tolerances,
    withDiffImage: Boolean(values.out),
    labels: positionals,
  });
  let out = null;
  if (values.out && r.diffPng) {
    out = path.resolve(values.out);
    writePng(out, r.diffPng);
  }
  const { diffPng, ...rest } = r;
  const result = { ...(values.state ? { state: values.state } : {}), ...rest, out };
  console.log(JSON.stringify(result, null, 2));
  say(summary(result));
  if (result.band === 'review') console.error(`warning: ${result.percent}% is in the review band (pass < ${pass}%, review <= ${review}%)`);
  return result.band === 'fail' ? 1 : 0;
}

runMain(import.meta.url, main);
