// PNG helpers on top of pngjs: read/write, synthetic images, rectangle fills and
// a header-only size reader. Unreadable PNGs raise CliError with exit code 3.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { CliError, ensureDir } from './args.mjs';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePng(buffer, label = 'image') {
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

export function writePng(file, png) {
  ensureDir(path.dirname(file));
  writeFileSync(file, encodePng(png));
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
