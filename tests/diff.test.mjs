import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { diffImages, maskedPixelCount, normaliseMask, normalisePairs } from '../skills/design-qa/scripts/diff.mjs';
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
  assert.deepEqual(out.worst, { state: 'hover', percent: 3, band: 'review' });

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
