// PNG helpers on top of pngjs: read/write, synthetic images, rectangle fills and
// a header-only size reader. Unreadable PNGs raise CliError with exit code 3, and so do
// PNGs whose header declares more pixels than the decode limit (checked before decoding:
// a few KB of compressed data can declare 40000×40000, gigabytes once decoded).
import { readFileSync } from 'node:fs';
import { CliError, writeFileAtomic } from './args.mjs';
import { importDependency } from './deps.mjs';

const { PNG } = await importDependency('pngjs');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Default decode limit: 64 Mi pixels, 67108864 (a 2880×22000 full-page capture fits). */
export const DEFAULT_MAX_PNG_PIXELS = 64 * 1024 * 1024;

/** The decode limit in pixels: DESIGN_QA_MAX_PNG_PIXELS (a positive integer) or the default. */
export function maxPngPixels(env = process.env) {
  const raw = env.DESIGN_QA_MAX_PNG_PIXELS;
  if (raw === undefined || raw === '') return DEFAULT_MAX_PNG_PIXELS;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new CliError(`DESIGN_QA_MAX_PNG_PIXELS must be a positive integer (got "${raw}")`, 2);
  return n;
}

/**
 * Refuse a PNG whose IHDR declares more than maxPixels (width × height) before it is
 * decoded. Buffers that are not PNGs are left to the decoder's own error.
 */
export function checkPngSize(buffer, label = 'image', maxPixels = maxPngPixels()) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || !buffer.subarray(0, 8).equals(SIGNATURE)) return;
  const { width, height } = pngSize(buffer);
  if (width * height > maxPixels) {
    throw new CliError(
      `${label} declares ${width}×${height} = ${width * height} pixels, above the decode limit of ${maxPixels} pixels; ` +
        'set DESIGN_QA_MAX_PNG_PIXELS to a larger pixel count if the image is genuine',
      3,
    );
  }
}

export function decodePng(buffer, label = 'image') {
  checkPngSize(buffer, label);
  try {
    return PNG.sync.read(buffer);
  } catch (err) {
    throw new CliError(`${label} is not a readable PNG (${err.message})`, 3);
  }
}

export function readPng(file) {
  let buffer;
  try {
    buffer = readFileSync(file);
  } catch (err) {
    const why = err.code === 'ENOENT' ? 'file not found' : err.message;
    throw new CliError(`cannot read PNG ${file}: ${why}`, 3);
  }
  return decodePng(buffer, file);
}

export function encodePng(png) {
  return PNG.sync.write(png);
}

/** Encode and write atomically; a destination that is a symbolic link or a directory is refused (CliError, exit 1). */
export function writePng(file, png) {
  writeFileAtomic(file, encodePng(png));
}

/** A solid-colour RGBA image (used by tests and fixtures). */
export function createPng(width, height, rgba = [255, 255, 255, 255]) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgba[0];
    png.data[i + 1] = rgba[1];
    png.data[i + 2] = rgba[2];
    png.data[i + 3] = rgba[3] ?? 255;
  }
  return png;
}

/** Clip a {x,y,w,h} rectangle to the image; returns null when nothing is left. */
export function clipRect(rect, width, height) {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.h));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1 };
}

/** Paint a rectangle in place. */
export function fillRect(png, rect, rgba) {
  const c = clipRect(rect, png.width, png.height);
  if (!c) return;
  for (let y = c.y0; y < c.y1; y++) {
    for (let x = c.x0; x < c.x1; x++) {
      const i = (y * png.width + x) * 4;
      png.data[i] = rgba[0];
      png.data[i + 1] = rgba[1];
      png.data[i + 2] = rgba[2];
      png.data[i + 3] = rgba[3] ?? 255;
    }
  }
}

// ---------------------------------------------------------------------------
// Small-image helpers for worklist and inspect crops: crop (with a hatch where the
// rectangle leaves the image), area-average downscale (never upscale), outlines, a
// built-in 5×7 bitmap font for labels and side-by-side / stacked composition.

/** Hatch drawn where a crop leaves the image: there is nothing on that side. */
const HATCH = [[236, 236, 236], [214, 214, 214]];

/**
 * A new PNG of exactly rect (integer x, y, w, h) cut from png. Pixels outside the image are
 * a light diagonal hatch, so "nothing here" is visible. w and h must be at least 1.
 */
export function cropPng(png, rect) {
  const x = Math.floor(rect.x);
  const y = Math.floor(rect.y);
  const w = Math.max(1, Math.round(rect.w));
  const h = Math.max(1, Math.round(rect.h));
  const out = new PNG({ width: w, height: h });
  for (let row = 0; row < h; row++) {
    const sy = y + row;
    for (let col = 0; col < w; col++) {
      const sx = x + col;
      const o = (row * w + col) * 4;
      if (sx >= 0 && sy >= 0 && sx < png.width && sy < png.height) {
        const i = (sy * png.width + sx) * 4;
        out.data[o] = png.data[i];
        out.data[o + 1] = png.data[i + 1];
        out.data[o + 2] = png.data[i + 2];
        out.data[o + 3] = 255;
      } else {
        const c = HATCH[Math.floor((sx + sy) / 6) & 1];
        out.data[o] = c[0];
        out.data[o + 1] = c[1];
        out.data[o + 2] = c[2];
        out.data[o + 3] = 255;
      }
    }
  }
  return out;
}

/**
 * Downscale by factor (0 < factor ≤ 1) with area averaging; factor ≥ 1 returns the image
 * unchanged (never upscales).
 */
export function scalePng(png, factor) {
  if (!(factor > 0) || factor >= 1) return png;
  const w = Math.max(1, Math.round(png.width * factor));
  const h = Math.max(1, Math.round(png.height * factor));
  const out = new PNG({ width: w, height: h });
  const fx = png.width / w;
  const fy = png.height / h;
  for (let oy = 0; oy < h; oy++) {
    const y0 = Math.floor(oy * fy);
    const y1 = Math.max(y0 + 1, Math.min(png.height, Math.floor((oy + 1) * fy)));
    for (let ox = 0; ox < w; ox++) {
      const x0 = Math.floor(ox * fx);
      const x1 = Math.max(x0 + 1, Math.min(png.width, Math.floor((ox + 1) * fx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        let i = (sy * png.width + x0) * 4;
        for (let sx = x0; sx < x1; sx++, i += 4) {
          r += png.data[i];
          g += png.data[i + 1];
          b += png.data[i + 2];
          n++;
        }
      }
      const o = (oy * w + ox) * 4;
      out.data[o] = Math.round(r / n);
      out.data[o + 1] = Math.round(g / n);
      out.data[o + 2] = Math.round(b / n);
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** Outline a rectangle (in place), `width` pixels thick, clipped to the image. */
export function strokeRect(png, rect, rgba, width = 1) {
  const x0 = Math.round(rect.x);
  const y0 = Math.round(rect.y);
  const x1 = Math.round(rect.x + rect.w);
  const y1 = Math.round(rect.y + rect.h);
  fillRect(png, { x: x0, y: y0, w: x1 - x0, h: width }, rgba);
  fillRect(png, { x: x0, y: y1 - width, w: x1 - x0, h: width }, rgba);
  fillRect(png, { x: x0, y: y0, w: width, h: y1 - y0 }, rgba);
  fillRect(png, { x: x1 - width, y: y0, w: width, h: y1 - y0 }, rgba);
}

// 5×7 glyphs, one string of 35 bits per character (rows top to bottom).
const GLYPHS = (() => {
  const g = {
    A: '01110100011000111111100011000110001', B: '11110100011000111110100011000111110', C: '01110100011000010000100001000101110',
    D: '11110100011000110001100011000111110', E: '11111100001000011110100001000011111', F: '11111100001000011110100001000010000',
    G: '01110100011000010111100011000101111', H: '10001100011000111111100011000110001', I: '01110001000010000100001000010001110',
    J: '00111000100001000010000101001001100', K: '10001100101010011000101001001010001', L: '10000100001000010000100001000011111',
    M: '10001110111010110101100011000110001', N: '10001100011100110101100111000110001', O: '01110100011000110001100011000101110',
    P: '11110100011000111110100001000010000', Q: '01110100011000110001101011001001101', R: '11110100011000111110101001001010001',
    S: '01111100001000001110000010000111110', T: '11111001000010000100001000010000100', U: '10001100011000110001100011000101110',
    V: '10001100011000110001100010101000100', W: '10001100011000110101101011010101010', X: '10001100010101000100010101000110001',
    Y: '10001100010101000100001000010000100', Z: '11111000010001000100010001000011111',
    0: '01110100011001110101110011000101110', 1: '00100011000010000100001000010001110', 2: '01110100010000100010001000100011111',
    3: '11111000100010000010000011000101110', 4: '00010001100101010010111110001000010', 5: '11111100001111000001000011000101110',
    6: '00110010001000011110100011000101110', 7: '11111000010001000100010000100001000', 8: '01110100011000101110100011000101110',
    9: '01110100011000101111000010001001100',
    ' ': '00000000000000000000000000000000000', '.': '00000000000000000000000000110001100', ',': '00000000000000000000011000010001000',
    ':': '00000011000110000000011000110000000', '-': '00000000000000011111000000000000000', '/': '00001000100001000100010000100010000',
    '(': '00010001000100001000010000010000010', ')': '01000001000001000010000100010001000', '#': '01010010101111101010111110101001010',
    '%': '11000110010001000100010001001100011', '+': '00000001000010011111001000010000000', '=': '00000000001111100000111110000000000',
    _: '00000000000000000000000000000011111', '|': '00100001000010000100001000010000100', '?': '01110100010000100010001000000000100',
    '@': '01110100011011110101101111000001110', '>': '01000001000001000001000100010001000', '<': '00010001000100010000010000010000010',
    '&': '01100100101010001000101011001001101', "'": '00100001000100000000000000000000000', '"': '01010010100000000000000000000000000',
  };
  g['×'] = g.X;
  g['–'] = g['-'];
  g['—'] = g['-'];
  g['…'] = '00000000000000000000000001010110101';
  return g;
})();

/** Pixel width of `text` drawn with drawText at `scale`. */
export function textWidth(text, scale = 1) {
  const n = [...String(text ?? '')].length;
  return n ? (n * 6 - 1) * scale : 0;
}

/** Draw `text` (upper-cased; unknown characters as "?") at x, y with the 5×7 font, in place. */
export function drawText(png, x, y, text, rgba, scale = 1) {
  let cx = Math.round(x);
  for (const ch of String(text ?? '')) {
    const bits = GLYPHS[ch.toUpperCase()] ?? GLYPHS['?'];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (bits[row * 5 + col] === '1') fillRect(png, { x: cx + col * scale, y: Math.round(y) + row * scale, w: scale, h: scale }, rgba);
      }
    }
    cx += 6 * scale;
  }
}

/** Height of the label bar composePanels puts above each panel. */
export const LABEL_HEIGHT = 18;

/**
 * Compose panels into one image: { png, label } each, side by side (direction "row") or
 * stacked ("column"), each under a thin label bar, separated by a `gap`-pixel divider.
 * Labels longer than the panel are cut with "…".
 */
export function composePanels(panels, { direction = 'row', gap = 4, background = [255, 255, 255, 255], divider = [60, 60, 60, 255], labelBar = [40, 40, 40, 255], labelColor = [255, 255, 255, 255] } = {}) {
  const row = direction === 'row';
  const cellW = panels.map((p) => p.png.width);
  const cellH = panels.map((p) => p.png.height + LABEL_HEIGHT);
  const width = row ? cellW.reduce((a, b) => a + b, 0) + gap * (panels.length - 1) : Math.max(...cellW);
  const height = row ? Math.max(...cellH) : cellH.reduce((a, b) => a + b, 0) + gap * (panels.length - 1);
  const out = createPng(width, height, background);
  let offset = 0;
  panels.forEach((p, i) => {
    const x0 = row ? offset : 0;
    const y0 = row ? 0 : offset;
    const barW = row ? cellW[i] : width;
    fillRect(out, { x: x0, y: y0, w: barW, h: LABEL_HEIGHT }, labelBar);
    let label = String(p.label ?? '');
    const room = barW - 8;
    if (textWidth(label, 2) > room) {
      // Shorten to the longest prefix that fits with "…"; no label when not even "…" fits.
      const chars = [...label];
      let n = chars.length - 1;
      while (n > 0 && textWidth(`${chars.slice(0, n).join('')}…`, 2) > room) n--;
      label = n > 0 ? `${chars.slice(0, n).join('')}…` : textWidth('…', 2) <= room ? '…' : '';
    }
    drawText(out, x0 + 4, y0 + 2, label, labelColor, 2);
    for (let y = 0; y < p.png.height; y++) {
      p.png.data.copy(out.data, ((y0 + LABEL_HEIGHT + y) * width + x0) * 4, y * p.png.width * 4, (y + 1) * p.png.width * 4);
    }
    offset += (row ? cellW[i] : cellH[i]) + gap;
    if (i < panels.length - 1) {
      fillRect(out, row ? { x: offset - gap, y: 0, w: gap, h: height } : { x: 0, y: offset - gap, w: width, h: gap }, divider);
    }
  });
  return out;
}

/** Width/height from the IHDR chunk without decoding the image. */
export function pngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new CliError('not a PNG buffer', 3);
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
