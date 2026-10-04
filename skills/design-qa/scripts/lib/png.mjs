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

/** Width/height from the IHDR chunk without decoding the image. */
export function pngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new CliError('not a PNG buffer', 3);
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
