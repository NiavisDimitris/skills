import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { diffImages, maskedPixelCount, normaliseMask, normalisePairs, structuralRegions, worseBand } from '../skills/design-qa/scripts/diff.mjs';
import { createPng, fillRect, readPng, writePng } from '../skills/design-qa/scripts/lib/png.mjs';
import { run, script, tmpDir } from './_helpers.mjs';

const DIFF = script('diff.mjs');
const WHITE = [255, 255, 255, 255];
const BLACK = [0, 0, 0, 255];

/** 100×100 white image with optional black rectangles. */
function image(rects = [], size = 100) {
  const png = createPng(size, size, WHITE);
  for (const r of rects) fillRect(png, r, BLACK);
  return png;
}

function save(dir, name, png) {
  const file = path.join(dir, name);
  writePng(file, png);
  return file;
}

test('identical images: 0% and the pass band (exit 0)', async () => {
  const dir = tmpDir();
  const a = save(dir, 'a.png', image());
  const b = save(dir, 'b.png', image());
  const res = await run(DIFF, [a, b, '--json']);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(
    { width: out.width, height: out.height, diffPixels: out.diffPixels, totalPixels: out.totalPixels, percent: out.percent, band: out.band, maskedPercent: out.maskedPercent, out: out.out },
    { width: 100, height: 100, diffPixels: 0, totalPixels: 10000, percent: 0, band: 'pass', maskedPercent: 0, out: null },
  );
  assert.equal(res.stderr, '', '--json keeps stderr quiet');
});

test('a small change lands in the review band (exit 0 with a warning)', async () => {
  const dir = tmpDir();
  const a = save(dir, 'a.png', image());
  const b = save(dir, 'b.png', image([{ x: 10, y: 10, w: 10, h: 20 }]));
  const diffOut = path.join(dir, 'diff', 'empty.png');
  const res = await run(DIFF, [a, b, '--out', diffOut, '--state', 'empty']);
  assert.equal(res.code, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.state, 'empty');
  assert.equal(out.diffPixels, 200);
  assert.equal(out.percent, 2);
  assert.equal(out.band, 'review');
  assert.equal(out.out, diffOut);
  assert.match(res.stderr, /warning: 2% is in the review band/);
  const written = readPng(diffOut);
  assert.equal(written.width, 100);
  assert.equal(written.height, 100);
});

test('a large change fails (exit 1); custom --pass/--review move the band', async () => {
  const dir = tmpDir();
  const a = save(dir, 'a.png', image());
  const b = save(dir, 'b.png', image([{ x: 0, y: 0, w: 100, h: 30 }]));
  const res = await run(DIFF, [a, b, '--json']);
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stdout).band, 'fail');
  assert.equal(JSON.parse(res.stdout).percent, 30);
  const lenient = await run(DIFF, [a, b, '--json', '--pass', '40', '--review', '50']);
  assert.equal(lenient.code, 0);
  assert.equal(JSON.parse(lenient.stdout).band, 'pass');
  assert.equal((await run(DIFF, [a, b, '--pass', '6', '--review', '5'])).code, 2, 'pass must be <= review');
});

test('different sizes are refused (exit 2) and never resized', async () => {
  const dir = tmpDir();
  const a = save(dir, 'a.png', image([], 100));
  const b = save(dir, 'b.png', image([], 200));
  const res = await run(DIFF, [a, b]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /dimension mismatch: .*100×100 .*200×200/);
  assert.match(res.stderr, /2× the other/);
  assert.match(res.stderr, /[Nn]ever compare screenshots at different scales/);
  assert.equal(res.stdout, '');
});

test('a mask hides a difference and reports the masked area', async () => {
  const dir = tmpDir();
  const a = save(dir, 'a.png', image());
  const b = save(dir, 'b.png', image([{ x: 50, y: 50, w: 20, h: 20 }]));
  const mask = path.join(dir, 'mask.json');
  writeFileSync(mask, JSON.stringify([{ x: 45, y: 45, w: 30, h: 30, label: 'avatar' }, { x: 90, y: 90, w: 50, h: 50 }]));
  const res = await run(DIFF, [a, b, '--mask', mask, '--json']);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.diffPixels, 0);
  assert.equal(out.band, 'pass');
  assert.equal(out.maskedPercent, 10, '30×30 + 10×10 (clipped) of 100×100');
  const badMask = path.join(dir, 'bad-mask.json');
  writeFileSync(badMask, JSON.stringify([{ x: 1, y: 1 }]));
  assert.equal((await run(DIFF, [a, b, '--mask', badMask])).code, 2);
});

test('an unreadable PNG exits 3', async () => {
  const dir = tmpDir();
  const a = save(dir, 'a.png', image());
  const bad = path.join(dir, 'bad.png');
  writeFileSync(bad, 'not a png');
  const res = await run(DIFF, [a, bad]);
  assert.equal(res.code, 3);
  assert.match(res.stderr, /not a readable PNG/);
  assert.equal((await run(DIFF, [a, path.join(dir, 'missing.png')])).code, 3);
});

test('batch mode: results per state, the worst state, and the most serious exit code', async () => {
  const dir = tmpDir();
  save(dir, 'figma-a.png', image());
  save(dir, 'app-a.png', image());
  save(dir, 'figma-b.png', image());
  save(dir, 'app-b.png', image([{ x: 0, y: 0, w: 100, h: 3 }]));
  save(dir, 'big.png', image([], 50));
  const pairs = path.join(dir, 'pairs.json');
  writeFileSync(pairs, JSON.stringify({ 'with-data': { a: 'figma-a.png', b: 'app-a.png' }, hover: { a: 'figma-b.png', b: 'app-b.png' } }));
  const outDir = path.join(dir, 'diff');
  const res = await run(DIFF, ['--pairs', pairs, '--out-dir', outDir, '--json']);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.results['with-data'].band, 'pass');
  assert.equal(out.results.hover.percent, 3);
  assert.equal(out.results.hover.out, path.join(outDir, 'hover.png'));
  assert.deepEqual(out.worst, { state: 'hover', percent: 3, band: 'review', structuralPercent: 0 });

  writeFileSync(pairs, JSON.stringify([
    { state: 'with-data', a: 'figma-a.png', b: 'app-a.png' },
    { state: 'empty', a: 'figma-a.png', b: 'big.png' },
  ]));
  const mixed = await run(DIFF, ['--pairs', pairs, '--json']);
  assert.equal(mixed.code, 2);
  const parsed = JSON.parse(mixed.stdout);
  assert.equal(parsed.results.empty.exitCode, 2);
  assert.match(parsed.results.empty.error, /dimension mismatch/);
  assert.equal(parsed.results['with-data'].band, 'pass');
});

// A white 200×200 page; `panel` paints a light-grey panel (the mock's #f6f7f9 page
// background against a white card: 9 grey levels, below pixelmatch's 0.1 threshold).
const LIGHT = [246, 247, 249, 255];
function page({ panel = null, text = [] } = {}) {
  const png = createPng(200, 200, WHITE);
  if (panel) fillRect(png, panel, LIGHT);
  for (const r of text) fillRect(png, r, BLACK);
  return png;
}

test('structural: a light panel missing on a white page is flagged (review) though pixelmatch sees ~0%', async () => {
  const design = page({ panel: { x: 20, y: 40, w: 160, h: 100 }, text: [{ x: 30, y: 50, w: 40, h: 4 }] });
  const app = page({ text: [{ x: 30, y: 50, w: 40, h: 4 }] });
  const r = diffImages(design, app);
  assert.equal(r.percent, 0, 'pixelmatch at 0.1 treats the panel as equal');
  assert.equal(r.pixelBand, 'pass');
  assert.equal(r.structuralBand, 'review');
  assert.equal(r.band, 'review', 'the band is the worse of the two');
  assert.equal(r.structuralRegions.length, 1);
  const [region] = r.structuralRegions;
  assert.deepEqual([region.x, region.y, region.w, region.h], [24, 40, 152, 96], 'the panel box, in whole 8px cells that are solidly different');
  assert.ok(r.structuralPercent > 35 && r.structuralPercent <= 40, `about the panel's 40% (got ${r.structuralPercent})`);
  const magenta = [];
  for (let i = 0; i < r.diffPng.data.length; i += 4) if (r.diffPng.data[i] === 255 && r.diffPng.data[i + 1] === 0 && r.diffPng.data[i + 2] === 255) magenta.push(i);
  assert.ok(magenta.length > 0, 'structural pixels are painted magenta in the diff image');

  const dir = tmpDir();
  const a = save(dir, 'a.png', design);
  const b = save(dir, 'b.png', app);
  const res = await run(DIFF, [a, b, '--state', 'with-data']);
  assert.equal(res.code, 0, 'structural differences raise the band to review, never to fail');
  const out = JSON.parse(res.stdout);
  assert.deepEqual([out.percent, out.band, out.pixelBand, out.structuralBand], [0, 'review', 'pass', 'review']);
  assert.match(res.stderr, /structural: [\d.]+% in 1 low-contrast region\(s\), largest 152×96 at 24,40/);
  assert.match(res.stderr, /warning: review band from a structural difference/);
  const off = JSON.parse((await run(DIFF, [a, b, '--structural-min-area', '100', '--json'])).stdout);
  assert.deepEqual([off.band, off.structuralPercent, off.structuralRegions], ['pass', 0, []], '--structural-min-area 100 turns the check off');
  const coarse = JSON.parse((await run(DIFF, [a, b, '--structural-threshold', '0.05', '--json'])).stdout);
  assert.equal(coarse.band, 'pass', 'a 9-level grey is below a 0.05 structural threshold');
  assert.equal((await run(DIFF, [a, b, '--structural-threshold', '2'])).code, 2);
});

test('structural: text changes, scattered faint noise, small areas and high-contrast changes do not count', () => {
  // New text (dense strokes, but each 8×8 cell is mostly background).
  const lines = Array.from({ length: 12 }, (_, i) => ({ x: 20 + (i % 4) * 40, y: 20 + Math.floor(i / 4) * 30, w: 30, h: 2 }));
  assert.equal(diffImages(page(), page({ text: lines })).structuralPercent, 0);
  // Faint noise on every other pixel across the whole page (colour-profile dither).
  const noisy = page();
  for (let y = 0; y < 200; y++) for (let x = (y % 2); x < 200; x += 2) fillRect(noisy, { x, y, w: 1, h: 1 }, LIGHT);
  const n = diffImages(page(), noisy);
  assert.deepEqual([n.structuralPercent, n.band], [0, 'pass'], 'no cell is solidly different');
  // A uniform shift of 2 grey levels (export rounding) stays under the structural threshold.
  const shifted = createPng(200, 200, [253, 253, 253, 255]);
  assert.equal(diffImages(page(), shifted).structuralPercent, 0);
  // A faint area smaller than 0.5% of the image.
  assert.equal(diffImages(page(), page({ panel: { x: 0, y: 0, w: 12, h: 12 } })).structuralPercent, 0);
  // A high-contrast block is already in percent; it is not counted twice.
  const black = diffImages(page(), page({ text: [{ x: 0, y: 0, w: 100, h: 100 }] }), { tolerances: { pass: 40, review: 50 } });
  assert.deepEqual([black.percent, black.structuralPercent, black.band], [25, 0, 'pass']);
});

test('structural: library helpers', () => {
  const a = page({ panel: { x: 0, y: 0, w: 200, h: 100 } });
  const b = page();
  const s = structuralRegions(a.data, b.data, 200, 200);
  assert.deepEqual(s.regions.map((r) => [r.x, r.y, r.w, r.h, r.pixels, r.percent]), [[0, 0, 200, 96, 19200, 48]], 'the half-covered last row of cells is not solid');
  assert.equal(s.percent, 48);
  assert.equal(structuralRegions(a.data, b.data, 200, 200, { minAreaPercent: 100 }).regions.length, 0);
  assert.equal(structuralRegions(a.data, a.data, 200, 200).percent, 0);
  assert.equal(diffImages(a, b, { structural: false }).structuralBand, 'pass', 'structural: false skips the check');
  assert.equal(worseBand('pass', 'review'), 'review');
  assert.equal(worseBand('fail', 'review'), 'fail');
});

test('batch mode: the worst state ranks by band first, so a structural review beats a larger pass', async () => {
  const dir = tmpDir();
  save(dir, 'd1.png', page({ text: [{ x: 0, y: 0, w: 20, h: 10 }] }));
  save(dir, 'a1.png', page());
  save(dir, 'd2.png', page({ panel: { x: 20, y: 40, w: 160, h: 100 } }));
  save(dir, 'a2.png', page());
  const pairs = path.join(dir, 'pairs.json');
  writeFileSync(pairs, JSON.stringify({ cart: { a: 'd1.png', b: 'a1.png' }, review: { a: 'd2.png', b: 'a2.png' } }));
  const res = await run(DIFF, ['--pairs', pairs, '--json']);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual([out.results.cart.percent, out.results.cart.band], [0.5, 'pass']);
  assert.deepEqual([out.results.review.percent, out.results.review.band], [0, 'review']);
  assert.equal(out.worst.state, 'review');
  assert.equal(out.worst.band, 'review');
  assert.ok(out.worst.structuralPercent > 0);
});

test('library: diffImages, normaliseMask, maskedPixelCount, normalisePairs', () => {
  const r = diffImages(image(), image([{ x: 0, y: 0, w: 10, h: 10 }]), { withDiffImage: false });
  assert.equal(r.diffPixels, 100);
  assert.equal(r.diffPng, null);
  assert.throws(() => diffImages(image([], 10), image([], 20)), (err) => err.exitCode === 2);
  assert.deepEqual(normaliseMask({ regions: [{ x: 0, y: 0, w: 1, h: 1 }] }), [{ x: 0, y: 0, w: 1, h: 1, label: null }]);
  assert.equal(maskedPixelCount([{ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }], 100, 100), 175, 'overlaps counted once');
  assert.throws(() => normalisePairs({ a: { a: 'x.png' } }), /expected \{ state, a, b \}/);
  assert.deepEqual(normalisePairs({ s: { a: 'x', b: 'y' } }), [{ state: 's', a: 'x', b: 'y', mask: null }]);
});

test('usage errors exit 2', async () => {
  assert.equal((await run(DIFF, [])).code, 2);
  assert.equal((await run(DIFF, ['a.png'])).code, 2);
  assert.equal((await run(DIFF, ['a.png', 'b.png', '--threshold', '2'])).code, 2);
  assert.equal((await run(DIFF, ['--bogus'])).code, 2);
  const help = await run(DIFF, ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--pairs pairs\.json/);
});
