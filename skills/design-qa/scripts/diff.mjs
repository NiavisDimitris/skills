#!/usr/bin/env node
// Pixel diff between the design image (Figma export or prototype capture) and an app screenshot (pixelmatch).
// Never resizes or rescales (Figma export scale 1 ↔ deviceScaleFactor 1). Images of
// different sizes (a whole-page capture is rarely exactly the frame's size) are padded on
// the right and at the bottom to the larger size; the padded band is listed apart, never
// counted as differing pixels; padding adds pixels, it never stretches one. A design width
// that is not the frame's at a whole scale is an export-scale error (exit 2), as is a width
// that is an integer multiple (≥ 2) of the frame's (or the other image's), whatever the
// heights; --strict-size refuses any size difference.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CliError, displayPath, oneLine, parseCli, readJsonFile, runMain, toNumber, usageError, writeJson } from './lib/args.mjs';
import { importDependency } from './lib/deps.mjs';
import { clipRect, fillRect, readPng, writePng } from './lib/png.mjs';
import { band } from './lib/ranking.mjs';
import { assertRunOwnsOutput, lockedReportDir } from './lib/pass.mjs';

const { default: pixelmatch } = await importDependency('pixelmatch');
const { PNG } = await importDependency('pngjs');

const HELP = `Pixel-diff the design image (a Figma export or a prototype capture) against an app screenshot.

Usage:
  node scripts/diff.mjs <a.png> <b.png> [--out diff.png] [--state <name>] [options]
  node scripts/diff.mjs --pairs pairs.json [--out-dir dir] [options]

Options:
  --out <file>        write the diff image (single mode)
  --out-dir <dir>     write <dir>/<state>.png for every pair (batch mode)
  --state <name>      label the result (single mode)
  --threshold <0..1>  pixelmatch colour threshold (default 0.1; anti-aliasing is ignored)
  --structural-threshold <0..1>
                      colour threshold of the structural check (default 0.015): finds large
                      contiguous areas that differ too faintly for --threshold (a light-grey
                      panel missing on a white page) and raises a pass band to "review"
  --structural-min-area <pct>
                      smallest structural region, % of width × height (default 0.5;
                      100 turns the check off)
  --mask <file>       JSON array of { "x", "y", "w", "h", "label"? } rectangles painted the
                      same neutral grey on both images before comparing (dynamic data,
                      avatars, timestamps). Applies to every pair in batch mode.
  --pass <pct>        percent below which the band is "pass" (default 1); 0% always passes,
                      so --pass 0 passes only images that do not differ
  --review <pct>      percent up to which the band is "review" (default 5); above is "fail"
  --strict-size       refuse images of different sizes (exit 2) instead of padding the
                      smaller one
  --frame-width <px>  the design frame's width (meta.source.frame): an image whose width is
                      2×, 3×… of it is a scale error (exit 2), whatever the other image's
                      width, and so is a design image narrower than it or 1.25× wider or
                      more at a scale that is not whole (a 0.75x or 1.5x export); per pair
                      in pairs.json as "frameWidth"
  --allow-width-multiple
                      without a frame width, an image exactly 2×, 3×… as wide as the other is
                      a scale error (exit 2); this flag pads it instead (a page that really
                      overflows to exactly that width). A multiple in both dimensions stays
                      an error
  --run <id>          this pass's run id (default: DESIGN_QA_RUN_ID); refused (exit 5)
                      when the report folder's run lock names another run (only checked
                      when --out or --out-dir writes something)
  --json              JSON only on stdout, indented (no human summary on stderr); without it
                      the same JSON is one compact line on stdout and the summary is on stderr
  --json-out <file>   also write the JSON result to <file> (atomic; with or without
                      --json, stdout is unchanged). Its "out" paths are relative to the
                      report folder (the run-locked folder above <file>, else the parent
                      of the evidence folder it is in), forward slashes; outside it they
                      stay as they are
  -h, --help          show this help

pairs.json: { "<state>": { "a": "figma/empty.png", "b": "app/empty.png", "mask"?: "mask.json",
            "frameWidth"?: 1440 } } or [ { "state", "a", "b", "mask"?, "frameWidth"? } ]. Relative paths resolve against the
            pairs.json directory, then the working directory.

Output (stdout, JSON): { state?, width, height, designWidth, appWidth, designHeight,
appHeight, padded, paddedRight, diffPixels, totalPixels, percent, band, pixelBand,
structuralPercent, structuralBand, structuralRegions, paddedRegions, maskedPercent, masks,
out } — totalPixels is the area both images have (the compared area); percent and
structuralPercent are % of it, maskedPercent % of width × height, 2 decimals. The first
image is the design, the second the app. width and height are the larger of each; an image
that is shorter is padded at the bottom (padded: { side: "design" | "app", rows }), one that
is narrower on the right (paddedRight: { side, cols }); null when not padded. The padded
band is not compared: paddedRegions lists it ([ { x, y, w, h, pixels, padded: true, side,
sizeDiff: { axis: "height" | "width", px } } ], right band first; pixels not under a mask;
blue in the diff image). masks: [ { label, x, y, w, h, pixels } ], the --mask / pair mask
rectangles and the pixels each covers. Masks, structuralRegions and paddedRegions use the
padded image's coordinates (both images top-left aligned).
pixelBand is the band of percent alone; structuralBand is "review" when a structural region
was found, else "pass"; band is the worst of the two and "review" when a padded band has
unmasked pixels (structural and padding never make "fail" on their own).
structuralRegions: [ { x, y, w, h, pixels, percent } ], largest first (max 10): boxes of
contiguous areas that differ below --threshold, painted magenta in the diff image.
Batch: { results: { "<state>": {…} }, worst: { state, percent, band, structuralPercent } }
(worst = most serious band, then highest percent); a pair that cannot be compared gets
{ error, exitCode } instead. With --out-dir, two states whose file names collide
(cart/empty and cart-empty both write cart-empty.png; names compare case-insensitively)
are a usage error (exit 2) before anything is compared.

Exit codes: 0 pass (or review, with a warning on stderr) · 1 fail · 2 a scale error (an
image whose width is an integer multiple ≥ 2 of the design frame width, or without one of
the other image's width; a design exported at another scale), any size difference with --strict-size, or bad arguments · 3 unreadable PNG · 4 a missing npm package (pngjs,
pixelmatch) · 5 another run owns the report folder (nothing compared or written). In batch
mode the most serious outcome wins (3, 2, 1, 0).
Images are never resized: capture with deviceScaleFactor 1 and export Figma at scale 1.`;

const NEUTRAL = [128, 128, 128, 255];
const round2 = (n) => Math.round(n * 100) / 100;
const BAND_ORDER = { pass: 0, review: 1, fail: 2 };

/** Structural check defaults (see structuralRegions). */
export const STRUCTURAL_DEFAULTS = Object.freeze({ threshold: 0.015, minAreaPercent: 0.5, block: 8, solidRatio: 0.75 });
const STRUCTURAL_COLOR = [255, 0, 255];
const MAX_REGIONS = 10;

/** k when `big` is exactly k× `small` (k ≥ 2, an integer) in both dimensions: a device or export scale error. */
export function scaleOf(big, small) {
  const k = big.width / small.width;
  return Number.isInteger(k) && k >= 2 && big.height === k * small.height ? k : null;
}

/**
 * The scale error between design `a` and app `b`, judged on widths: heights of whole-page
 * captures rarely match, but a page legitimately wider than its frame is essentially never
 * exactly 2× or 3× as wide. With the design frame's width known (frameWidth), each image is
 * checked against it; otherwise an image whose width is an integer multiple (≥ 2) of the
 * other's is the error, unless allowWidthMultiple (then only a multiple in both dimensions is).
 * → null | { k, side: "design" | "app" (the scaled image), base: "frame" | "image" }.
 */
export function scaleError(a, b, { frameWidth = null, allowWidthMultiple = false } = {}) {
  const multiple = (big, small) => {
    const k = big / small;
    return Number.isInteger(k) && k >= 2 ? k : null;
  };
  if (frameWidth) {
    for (const [img, side] of [[a, 'design'], [b, 'app']]) {
      const k = multiple(img.width, frameWidth);
      if (k) return { k, side, base: 'frame' };
    }
    return null;
  }
  const both = scaleOf(a, b) || scaleOf(b, a);
  if (both) return { k: both, side: a.width > b.width ? 'design' : 'app', base: 'image' };
  if (allowWidthMultiple || a.width === b.width) return null;
  const k = multiple(Math.max(a.width, b.width), Math.min(a.width, b.width));
  return k ? { k, side: a.width > b.width ? 'design' : 'app', base: 'image' } : null;
}

/**
 * A design image whose width is the frame's at a scale that is not a whole number (a 1.5x or
 * 0.75x export; ±1 px of rounding allowed): → the scale, rounded to 2 decimals, or null.
 * Whole multiples are scaleError's. A page a little wider than its frame (under 1.25×) is
 * not a scale: a coded prototype can overflow.
 */
export function oddExportScale(design, frameWidth) {
  if (!frameWidth) return null;
  const k = design.width / frameWidth;
  if (Math.abs(design.width - Math.round(k) * frameWidth) <= 1 && Math.round(k) >= 1) return null;
  return k < 1 || k >= 1.25 ? Math.round(k * 100) / 100 : null;
}

export function mismatchMessage(a, b, labelA = 'a', labelB = 'b', { strictSize = false, scale = null, frameWidth = null } = {}) {
  const sizes = `${labelA} is ${a.width}×${a.height} but ${labelB} is ${b.width}×${b.height}`;
  const k = scale?.k ?? (scaleOf(a, b) || scaleOf(b, a));
  if (!k && strictSize) {
    return (
      `dimension mismatch: ${sizes} (--strict-size). ` +
      'Without --strict-size the smaller image is padded on the right and at the bottom; the padded band is listed in paddedRegions, not compared.'
    );
  }
  const which = scale?.base === 'frame'
    ? `The ${scale.side} image is ${k}× the design frame width (${frameWidth} px)`
    : `One image is ${k}× the other${scale && !(scaleOf(a, b) || scaleOf(b, a)) ? ' in width' : ''}`;
  return (
    `dimension mismatch: ${sizes}. ${which}: a device scale factor / export scale mismatch. ` +
    'Never compare screenshots at different scales — capture with deviceScaleFactor 1 and export Figma at scale 1. ' +
    'diff.mjs never resizes images (it pads a smaller image, but not a scaled one). ' +
    'If the page really is exactly that much wider than the frame, pass --allow-width-multiple.'
  );
}

/** Colour of the padded band in the diff image: not compared, unlike pixelmatch's red. */
const PAD_COLOR = [0, 140, 255];

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
 * Large contiguous areas that differ too faintly for the main threshold. pixelmatch at
 * 0.1 treats near-white greys as equal, so a whole light panel missing on a white page
 * scores well under 1%. This pass re-runs pixelmatch at a finer threshold (anti-aliasing
 * still ignored), tiles the image into block × block cells, keeps the cells where at least
 * solidRatio of the pixels differ, joins neighbouring cells (4-connected) and keeps the
 * regions whose faint pixels (different at `threshold`, equal at `mainThreshold`) cover at
 * least minAreaPercent of the image. Text, icons and anti-aliased edges never fill a cell,
 * so they do not count; high-contrast changes are already in the main percent.
 * opts.areaPixels: the pixel count percentages (and minAreaPercent) refer to, when the
 * compared rows are part of a larger, padded image (default width × height).
 * → { percent, regions: [{ x, y, w, h, pixels, percent }], pixelMask: Uint8Array | null }.
 */
export function structuralRegions(dataA, dataB, width, height, opts = {}) {
  const { threshold, minAreaPercent, block, solidRatio } = { ...STRUCTURAL_DEFAULTS, ...opts };
  const mainThreshold = opts.mainThreshold ?? 0.1;
  const total = width * height;
  const area = opts.areaPixels ?? total;
  const none = { percent: 0, regions: [], pixelMask: null };
  if (minAreaPercent >= 100 || threshold >= mainThreshold) return none;
  const fine = new Uint8Array(total * 4);
  if (!pixelmatch(dataA, dataB, fine, width, height, { threshold, includeAA: false, diffMask: true })) return none;
  const coarse = new Uint8Array(total * 4);
  pixelmatch(dataA, dataB, coarse, width, height, { threshold: mainThreshold, includeAA: false, diffMask: true });

  const bw = Math.ceil(width / block);
  const bh = Math.ceil(height / block);
  const solid = new Uint8Array(bw * bh);
  const faint = new Uint32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let differ = 0;
      let low = 0;
      let cells = 0;
      for (let y = by * block; y < Math.min(height, (by + 1) * block); y++) {
        for (let x = bx * block; x < Math.min(width, (bx + 1) * block); x++) {
          const q = (y * width + x) * 4 + 3;
          cells++;
          if (fine[q] === 255) {
            differ++;
            if (coarse[q] !== 255) low++;
          }
        }
      }
      const i = by * bw + bx;
      faint[i] = low;
      solid[i] = differ / cells >= solidRatio ? 1 : 0;
    }
  }

  const label = new Int32Array(bw * bh).fill(-1);
  const minPixels = (minAreaPercent / 100) * area;
  const regions = [];
  for (let i = 0; i < bw * bh; i++) {
    if (!solid[i] || label[i] !== -1) continue;
    const id = regions.length;
    const stack = [i];
    label[i] = id;
    let pixels = 0;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -1;
    let y1 = -1;
    while (stack.length) {
      const j = stack.pop();
      const bx = j % bw;
      const by = (j - bx) / bw;
      pixels += faint[j];
      x0 = Math.min(x0, bx);
      y0 = Math.min(y0, by);
      x1 = Math.max(x1, bx);
      y1 = Math.max(y1, by);
      for (const [nx, ny] of [[bx + 1, by], [bx - 1, by], [bx, by + 1], [bx, by - 1]]) {
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
        const k = ny * bw + nx;
        if (solid[k] && label[k] === -1) {
          label[k] = id;
          stack.push(k);
        }
      }
    }
    const x = x0 * block;
    const y = y0 * block;
    regions.push({ id, keep: pixels > 0 && pixels >= minPixels, x, y, w: Math.min(width, (x1 + 1) * block) - x, h: Math.min(height, (y1 + 1) * block) - y, pixels });
  }
  const kept = regions.filter((r) => r.keep);
  if (!kept.length) return none;
  const keepIds = new Set(kept.map((r) => r.id));
  const pixelMask = new Uint8Array(total);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (fine[p * 4 + 3] === 255 && coarse[p * 4 + 3] !== 255 && keepIds.has(label[Math.floor(y / block) * bw + Math.floor(x / block)])) pixelMask[p] = 1;
    }
  }
  const sum = kept.reduce((n, r) => n + r.pixels, 0);
  return {
    percent: round2((sum / area) * 100),
    regions: kept
      .sort((p, q) => q.pixels - p.pixels)
      .slice(0, MAX_REGIONS)
      .map(({ x, y, w, h, pixels }) => ({ x, y, w, h, pixels, percent: round2((pixels / area) * 100) })),
    pixelMask,
  };
}

/**
 * Band of a diff percent (2 decimals): "pass" below `pass`, "review" up to `review`,
 * else "fail". 0% is always "pass": with --pass 0 nothing is "below 0", but an image that
 * does not differ cannot need review.
 */
export function pixelBand(percent, tolerances) {
  return percent === 0 ? 'pass' : band(percent, tolerances);
}

/** The more serious of two bands. */
export function worseBand(x, y) {
  return (BAND_ORDER[y] ?? 0) > (BAND_ORDER[x] ?? 0) ? y : x;
}

/**
 * Compare two decoded PNGs ({ width, height, data }). Masks are painted on
 * copies. Returns the result object plus `diffPng` (a PNG instance or null).
 * structural: { threshold, minAreaPercent } for structuralRegions, or false to skip it.
 * `a` is the design, `b` the app. Different sizes are padded on the right and at the
 * bottom (the padded band goes to paddedRegions, never diffPixels); a width that is an
 * integer multiple (≥ 2) of the other width, or of frameWidth when given, is the scale
 * error (exit 2; see scaleError), and strictSize refuses any size difference.
 */
export function diffImages(
  a,
  b,
  { threshold = 0.1, mask = [], tolerances, withDiffImage = true, labels = ['a', 'b'], structural = {}, strictSize = false, frameWidth = null, allowWidthMultiple = false, state = null } = {},
) {
  const sameSize = a.width === b.width && a.height === b.height;
  const scale = scaleError(a, b, { frameWidth, allowWidthMultiple });
  if (scale || (!sameSize && strictSize)) throw new CliError(mismatchMessage(a, b, labels[0], labels[1], { strictSize, scale, frameWidth }), 2);
  const odd = oddExportScale(a, frameWidth);
  if (odd) {
    throw new CliError(
      `${state ? `state "${state}": ` : ''}the design image is ${a.width}×${a.height} px for a frame ${frameWidth} px wide: it was exported at ${odd}x, not 1x. ` +
        `Do: export the frame at 1x (scale 1, ${frameWidth} px wide) over ${labels[0]}, then diff again.`,
      2,
    );
  }
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  // The area both images have (top-left aligned) is compared by pixelmatch; the rest
  // exists in one image only.
  const ow = Math.min(a.width, b.width);
  const oh = Math.min(a.height, b.height);
  const padded = a.height === b.height ? null : { side: a.height < b.height ? 'design' : 'app', rows: height - oh };
  const paddedRight = a.width === b.width ? null : { side: a.width < b.width ? 'design' : 'app', cols: width - ow };
  const bytes = ow * oh * 4;
  // Copies are Buffer.alloc'ed (never pooled), so pixelmatch's Uint32Array views stay aligned.
  const overlapOf = (png) => {
    if (!mask.length && png.width === ow) return png.data.length === bytes ? png.data : png.data.subarray(0, bytes);
    const copy = { width: ow, height: oh, data: Buffer.alloc(bytes) };
    for (let y = 0; y < oh; y++) png.data.copy(copy.data, y * ow * 4, y * png.width * 4, y * png.width * 4 + ow * 4);
    for (const r of mask) fillRect(copy, r, NEUTRAL);
    return copy.data;
  };
  const dataA = overlapOf(a);
  const dataB = overlapOf(b);
  const diffPng = withDiffImage ? new PNG({ width, height }) : null;
  const overlapOut = diffPng ? (ow === width ? diffPng.data.subarray(0, bytes) : Buffer.alloc(bytes)) : null;
  const diffPixels = pixelmatch(dataA, dataB, overlapOut, ow, oh, { threshold, includeAA: false });
  if (diffPng && ow !== width) {
    for (let y = 0; y < oh; y++) overlapOut.copy(diffPng.data, y * width * 4, y * ow * 4, (y + 1) * ow * 4);
  }
  // Only the area both images have is compared. The band one image lacks (below or right
  // of it) is not a pixel difference: it is listed in paddedRegions (unmasked pixels,
  // painted blue in the diff image) and puts the band at "review" at least.
  const totalPixels = ow * oh;
  const paddedRegions = [];
  if (!sameSize) {
    const covered = new Uint8Array(width * height);
    for (const r of mask) {
      const c = clipRect(r, width, height);
      if (!c) continue;
      for (let y = c.y0; y < c.y1; y++) covered.fill(1, y * width + c.x0, y * width + c.x1);
    }
    const padBand = (x, y, w, h, side, axis, px) => {
      let pixels = 0;
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const i = yy * width + xx;
          if (!covered[i]) pixels += 1;
          if (!diffPng) continue;
          const [r, g, bl] = covered[i] ? [230, 230, 230] : PAD_COLOR;
          diffPng.data[i * 4] = r;
          diffPng.data[i * 4 + 1] = g;
          diffPng.data[i * 4 + 2] = bl;
          diffPng.data[i * 4 + 3] = 255;
        }
      }
      if (w && h) paddedRegions.push({ x, y, w, h, pixels, padded: true, side, sizeDiff: { axis, px } });
    };
    if (paddedRight) padBand(ow, 0, width - ow, oh, paddedRight.side, 'width', paddedRight.cols);
    if (padded) padBand(0, oh, width, height - oh, padded.side, 'height', padded.rows);
  }
  const percent = round2((diffPixels / totalPixels) * 100);
  const percentBand = pixelBand(percent, tolerances);
  const s = structural === false
    ? { percent: 0, regions: [], pixelMask: null }
    : structuralRegions(dataA, dataB, ow, oh, { ...structural, mainThreshold: threshold });
  if (diffPng && s.pixelMask) {
    for (let p = 0; p < ow * oh; p++) {
      if (!s.pixelMask[p]) continue;
      const o = (Math.floor(p / ow) * width + (p % ow)) * 4;
      diffPng.data[o] = STRUCTURAL_COLOR[0];
      diffPng.data[o + 1] = STRUCTURAL_COLOR[1];
      diffPng.data[o + 2] = STRUCTURAL_COLOR[2];
      diffPng.data[o + 3] = 255;
    }
  }
  const structuralBand = s.regions.length ? 'review' : 'pass';
  const paddedBand = paddedRegions.some((r) => r.pixels) ? 'review' : 'pass';
  return {
    width,
    height,
    designWidth: a.width,
    appWidth: b.width,
    designHeight: a.height,
    appHeight: b.height,
    padded,
    paddedRight,
    diffPixels,
    totalPixels,
    percent,
    band: worseBand(worseBand(percentBand, structuralBand), paddedBand),
    pixelBand: percentBand,
    structuralPercent: s.percent,
    structuralBand,
    structuralRegions: s.regions,
    paddedRegions,
    maskedPercent: round2((maskedPixelCount(mask, width, height) / (width * height)) * 100),
    masks: mask.map((r) => ({ label: r.label, x: r.x, y: r.y, w: r.w, h: r.h, pixels: maskedPixelCount([r], width, height) })),
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
    if (seen.has(p.state)) throw usageError(`pairs.json: duplicate state "${oneLine(p.state)}"`);
    seen.add(p.state);
    const frameWidth = p.frameWidth ?? p.frame?.width ?? null;
    if (frameWidth !== null && !(Number.isInteger(frameWidth) && frameWidth > 0)) throw usageError(`pairs.json entry "${oneLine(p.state)}": frameWidth must be a positive integer`);
    return { state: p.state, a: p.a, b: p.b, mask: typeof p.mask === 'string' ? p.mask : null, frameWidth };
  });
}

function fileSafe(name) {
  return String(name).replace(/[^A-Za-z0-9._-]+/g, '-');
}

/**
 * Batch output names: <state>.png per pair. Throws a usage error when two states map to
 * the same file (cart/empty and cart-empty → cart-empty.png; compared case-insensitively,
 * as on macOS and Windows file systems), so no diff image silently overwrites another.
 */
export function outputNames(pairs) {
  const byName = new Map();
  for (const p of pairs) {
    const file = `${fileSafe(p.state)}.png`;
    const key = file.toLowerCase();
    if (byName.has(key)) {
      throw usageError(`pairs.json: states "${oneLine(byName.get(key))}" and "${oneLine(p.state)}" would both write ${file} in --out-dir; rename one of them`);
    }
    byName.set(key, p.state);
  }
  return Object.fromEntries(pairs.map((p) => [p.state, `${fileSafe(p.state)}.png`]));
}

function summary(r) {
  const label = r.state ? `${oneLine(r.state)}: ` : '';
  const masked = r.maskedPercent ? `, ${r.maskedPercent}% masked` : '';
  const n = r.structuralRegions?.length ?? 0;
  const structural = n ? `; structural: ${r.structuralPercent}% in ${n} low-contrast region(s), largest ${regionText(r.structuralRegions[0])}` : '';
  const padded =
    (r.paddedRight
      ? `; widths differ (design ${r.designWidth} px, app ${r.appWidth} px): the ${r.paddedRight.side} image was padded with ${r.paddedRight.cols} columns, not compared`
      : '') +
    (r.padded
      ? `; heights differ (design ${r.designHeight} px, app ${r.appHeight} px): the ${r.padded.side} image was padded with ${r.padded.rows} rows, not compared`
      : '');
  return `${label}${r.percent}% different (${r.band}) — ${r.diffPixels}/${r.totalPixels} px${masked}${structural}${padded}${r.out ? ` → ${oneLine(displayPath(r.out))}` : ''}`;
}

/**
 * For --json-out: a function turning an absolute path into one relative to the report
 * folder of `file` (forward slashes) when it lies inside it, else returning it as is.
 * The report folder is the run-locked folder above `file`, else the parent of the
 * nearest "evidence" folder it is in; with neither, paths stay as they are.
 */
export function reportRelative(file) {
  let root = lockedReportDir(file);
  if (!root) {
    for (let dir = path.dirname(path.resolve(file)); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
      if (path.basename(dir) === 'evidence') {
        root = path.dirname(dir);
        break;
      }
    }
  }
  return (p) => {
    if (!root || typeof p !== 'string') return p;
    const rel = path.relative(root, path.resolve(p));
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : p;
  };
}

function regionText(r) {
  return `${r.w}×${r.h} at ${r.x},${r.y}`;
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
      'structural-threshold': { type: 'string' },
      'structural-min-area': { type: 'string' },
      mask: { type: 'string' },
      pass: { type: 'string' },
      review: { type: 'string' },
      'strict-size': { type: 'boolean' },
      'frame-width': { type: 'string' },
      'allow-width-multiple': { type: 'boolean' },
      run: { type: 'string' },
      json: { type: 'boolean' },
      'json-out': { type: 'string' },
    },
    { allowPositionals: true },
  );
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const threshold = toNumber(values.threshold ?? '0.1', 'threshold', { min: 0, max: 1 });
  const structural = {
    threshold: toNumber(values['structural-threshold'] ?? String(STRUCTURAL_DEFAULTS.threshold), 'structural-threshold', { min: 0, max: 1 }),
    minAreaPercent: toNumber(values['structural-min-area'] ?? String(STRUCTURAL_DEFAULTS.minAreaPercent), 'structural-min-area', { min: 0, max: 100 }),
  };
  const pass = toNumber(values.pass ?? '1', 'pass', { min: 0, max: 100 });
  const review = toNumber(values.review ?? '5', 'review', { min: 0, max: 100 });
  if (pass > review) throw usageError(`--pass (${pass}) must be <= --review (${review})`);
  const tolerances = { pass, review };
  const frameWidth = values['frame-width'] !== undefined ? toNumber(values['frame-width'], 'frame-width', { min: 1, max: 20000, integer: true }) : null;
  const globalMask = values.mask ? loadMask(path.resolve(values.mask), '--mask') : [];
  const say = values.json ? () => {} : (msg) => console.error(msg);
  const jsonOut = values['json-out'] ? path.resolve(values['json-out']) : null;
  if (jsonOut) assertRunOwnsOutput(jsonOut, values.run);

  if (values.pairs) {
    if (positionals.length) throw usageError('use either <a.png> <b.png> or --pairs, not both');
    if (values.out) throw usageError('--out is for single mode; use --out-dir with --pairs');
    const pairsFile = path.resolve(values.pairs);
    const baseDir = path.dirname(pairsFile);
    const pairs = normalisePairs(readJsonFile(pairsFile, 'pairs', 2));
    const outNames = values['out-dir'] ? outputNames(pairs) : null;
    if (values['out-dir']) assertRunOwnsOutput(path.resolve(values['out-dir']), values.run);
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
          state: p.state,
          structural,
          strictSize: Boolean(values['strict-size']),
          frameWidth: p.frameWidth ?? frameWidth,
          allowWidthMultiple: Boolean(values['allow-width-multiple']),
        });
        let out = null;
        if (values['out-dir'] && r.diffPng) {
          out = path.resolve(values['out-dir'], outNames[p.state]);
          writePng(out, r.diffPng);
        }
        const { diffPng, ...rest } = r;
        results[p.state] = { state: p.state, ...rest, out };
        say(summary(results[p.state]));
        exitCode = Math.max(exitCode, r.band === 'fail' ? 1 : 0);
        const rank = (x) => BAND_ORDER[x.band] * 1000 + x.percent;
        if (!worst || rank(r) > rank(worst)) worst = { state: p.state, percent: r.percent, band: r.band, structuralPercent: r.structuralPercent };
      } catch (err) {
        if (!(err instanceof CliError)) throw err;
        results[p.state] = { state: p.state, error: err.message, exitCode: err.exitCode };
        console.error(`${oneLine(p.state)}: ${oneLine(err.message)}`);
        exitCode = Math.max(exitCode, err.exitCode);
      }
    }
    // The human summary is on stderr: without --json the JSON is one compact line (same shape).
    console.log(JSON.stringify({ results, worst }, null, values.json ? 2 : 0));
    if (jsonOut) {
      const toFile = reportRelative(jsonOut);
      writeJson(jsonOut, { results: Object.fromEntries(Object.entries(results).map(([k, r]) => [k, r.out ? { ...r, out: toFile(r.out) } : r])), worst });
    }
    if (exitCode === 0 && worst && worst.band === 'review') {
      const w = results[worst.state];
      const why = w?.pixelBand === 'review' ? `${worst.percent}%` : w?.structuralBand === 'review' ? `structural difference, ${worst.structuralPercent}% faint regions` : 'the images differ in size';
      console.error(`warning: worst state "${oneLine(worst.state)}" is in the review band (${why})`);
    }
    return exitCode;
  }

  if (positionals.length !== 2) throw usageError('expected two PNG files (or --pairs pairs.json); see --help');
  if (values['out-dir']) throw usageError('--out-dir is for --pairs mode; use --out <diff.png>');
  if (values.out) assertRunOwnsOutput(path.resolve(values.out), values.run);
  const [fileA, fileB] = positionals.map((p) => path.resolve(p));
  const r = diffImages(readPng(fileA), readPng(fileB), {
    threshold,
    mask: globalMask,
    tolerances,
    withDiffImage: Boolean(values.out),
    labels: positionals,
    state: values.state ?? null,
    structural,
    strictSize: Boolean(values['strict-size']),
    frameWidth,
    allowWidthMultiple: Boolean(values['allow-width-multiple']),
  });
  let out = null;
  if (values.out && r.diffPng) {
    out = path.resolve(values.out);
    writePng(out, r.diffPng);
  }
  const { diffPng, ...rest } = r;
  const result = { ...(values.state ? { state: values.state } : {}), ...rest, out };
  console.log(JSON.stringify(result, null, values.json ? 2 : 0));
  if (jsonOut) writeJson(jsonOut, result.out ? { ...result, out: reportRelative(jsonOut)(result.out) } : result);
  say(summary(result));
  if (result.pixelBand === 'review') console.error(`warning: ${result.percent}% is in the review band (pass < ${pass}%, review <= ${review}%)`);
  else if (result.structuralBand === 'review') console.error(`warning: review band from a structural difference: ${result.structuralPercent}% of the image differs faintly in contiguous regions (largest ${regionText(result.structuralRegions[0])})`);
  else if (result.band === 'review') console.error('warning: review band: the images differ in size; the part only one of them has was not compared (paddedRegions)');
  return result.band === 'fail' ? 1 : 0;
}

runMain(import.meta.url, main);
