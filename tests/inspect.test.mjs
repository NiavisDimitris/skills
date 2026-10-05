import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readPng } from '../skills/design-qa/scripts/lib/png.mjs';
import { buildWorklist } from '../skills/design-qa/scripts/lib/worklist.mjs';
import { clone, find, motionSample, page, removeSection, writeMatrix, writePass, writePrototypePass } from './fixtures/worklist-lib/make.mjs';
import { run, script, tmpDir } from './_helpers.mjs';

const INSPECT = script('inspect.mjs');

let shared = null;
/** One report folder for the read-only queries (built once). */
function fixture() {
  if (shared) return shared;
  const d = page({ width: 1280, rows: 40, extraSections: 3 });
  const a = clone(d);
  find(a.boxes, 'Title').text = 'Order list';
  find(a.boxes, 'Card 2').fill = '#94a3b8';
  find(a.boxes, 'Title').var = '--text-inverse';
  removeSection(a, 'Section 2');
  const dir = tmpDir('design-qa-inspect-');
  writeMatrix(dir, writePass(dir, { 'with-data': { design: d, app: a } }));
  writeFileSync(
    path.join(dir, 'evidence', 'ds-audit.json'),
    JSON.stringify({ groups: { tokens: [{ key: 'style:color:#94a3b8', category: 'color', status: 'off', value: 'rgb(148, 163, 184)', properties: ['background-color'], nearest: { name: '--surface-muted', value: '#cbd5e1' }, distance: 9.1, unit: 'ΔE' }] } }),
  );
  const { data } = buildWorklist(dir);
  shared = { dir, data, d, a };
  return shared;
}

test('--selector: the short selector from the worklist, values, the authored var() and the design layer at the same place', async () => {
  const { dir } = fixture();
  const r = await run(INSPECT, ['--dir', dir, '--state', 'with-data', '--selector', 'h1.title']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /app \(1\):/);
  assert.match(r.stdout, /header\.header > h1\.title · "Order list" · 240×32 at 32,20/);
  assert.match(r.stdout, /color rgb\(255, 255, 255\) \(var --text-inverse\)/);
  assert.match(r.stdout, /design \(1\):\n  TEXT "Title" · text "Orders" · \[1:3\] · 240×32 at 32,20 · 21px\/32px 600 #ffffff/);
  // Descendant and child combinators, attribute and nth-of-type.
  const c = await run(INSPECT, ['--dir', dir, '--state', 'with-data', '--selector', 'table tr.row > td.amount', '--side', 'app', '--limit', '3']);
  assert.match(c.stdout, /app \(40\):/);
  assert.match(c.stdout, /… 37 more/);
  const full = await run(INSPECT, ['--dir', dir, '--state', 'with-data', '--selector', 'main > header.header > h1.title', '--side', 'app']);
  assert.match(full.stdout, /app \(1\):/);
  const bad = await run(INSPECT, ['--dir', dir, '--state', 'with-data', '--selector', 'div:has(>p)']);
  assert.equal(bad.code, 2);
});

test('--text, --at and --rect, with the nearest token from ds-audit.json and --props', async () => {
  const { dir } = fixture();
  const t = await run(INSPECT, ['--dir', dir, '--state', 'with-data', '--text', 'metric 2']);
  assert.match(t.stdout, /app \(1\):\n  div\.card-2 > span\.card-title-2 · "Metric 2"/);
  assert.match(t.stdout, /design \(1\):\n  TEXT "Card title 2" · text "Metric 2"/);
  const card = find(fixture().a.boxes, 'Card 2');
  const at = await run(INSPECT, ['--dir', dir, '--state', 'with-data', '--at', `${card.x + 4},${card.y + card.h - 6}`, '--props', 'background-color,border-radius']);
  assert.match(at.stdout, /div\.card-2 · \d+×140 at \d+,184 · background-color rgb\(148, 163, 184\) \(off-token, nearest --surface-muted ΔE 9\.1\) · border-radius 12px/);
  assert.match(at.stdout, /FRAME "Card 2" · \[1:\d+\]/);
  const rect = await run(INSPECT, ['--dir', dir, '--state', 'with-data', '--rect', '0,0,1280,72', '--side', 'app']);
  assert.match(rect.stdout, /h1\.title/);
  assert.match(rect.stdout, /button\.new-order/);
  const props = await run(INSPECT, ['--dir', dir, '--state', 'with-data', '--selector', 'h1.title', '--props', 'color,margin-top', '--side', 'app']);
  assert.match(props.stdout, /color rgb\(255, 255, 255\)/);
  assert.match(props.stdout, /margin-top \(not recorded\)/);
});

test('--item: a worklist item, its state and box; a missing-in-app item shows the design layers through the alignment', async () => {
  const { dir, data } = fixture();
  const missing = [...data.items, ...data.unlisted].find((it) => it.kind === 'missing-in-app');
  assert.ok(missing);
  const r = await run(INSPECT, ['--dir', dir, '--item', missing.key]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`item ${missing.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · missing-in-app`));
  assert.match(r.stdout, /FRAME "Section 2"/);
  assert.match(r.stdout, /design shifted \+\d+ px below app y \d+/);
  // A region item below the gap: design layers are found at their own (shifted) place.
  const below = await run(INSPECT, ['--dir', dir, '--state', 'with-data', '--text', 'Section 3', '--json']);
  const j = JSON.parse(below.stdout);
  assert.equal(j.app.length, 1);
  assert.equal(j.design.length, 1);
  assert.equal(j.design[0].rect.y - j.app[0].rect.y, missing.designRect.h);
  const none = await run(INSPECT, ['--dir', dir, '--item', 'wl:with-data:nope']);
  assert.equal(none.code, 2);
});

test('output is bounded: --limit and "… n more"', async () => {
  const { dir } = fixture();
  const r = await run(INSPECT, ['--dir', dir, '--state', 'with-data', '--rect', '0,0,1280,4000', '--limit', '5']);
  const lines = r.stdout.trim().split('\n');
  assert.ok(lines.length <= 2 + 2 * 6 + 1, `${lines.length} lines`);
  assert.match(r.stdout, /… \d+ more \(narrow the query or raise --limit\)/);
  const def = await run(INSPECT, ['--dir', dir, '--state', 'with-data', '--rect', '0,0,1280,4000']);
  assert.ok(def.stdout.trim().split('\n').length <= 2 + 2 * 13 + 1);
});

test('--crop: a small design | app image inside evidence/; any path outside it is refused', async () => {
  const { dir } = fixture();
  const out = path.join(dir, 'evidence', 'inspect', 'card.png');
  const r = await run(INSPECT, ['--dir', dir, '--state', 'with-data', '--selector', 'div.card-2', '--side', 'app', '--crop', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /crop: evidence\/inspect\/card\.png \(\d+×\d+\)/);
  const png = readPng(out);
  assert.ok(png.width <= 1100 && png.height <= 1100);
  for (const bad of [path.join(dir, 'card.png'), path.join(dir, 'evidence', '..', 'x.png'), path.join(tmpDir(), 'x.png'), path.join(dir, 'evidence', 'x.txt')]) {
    const b = await run(INSPECT, ['--dir', dir, '--state', 'with-data', '--selector', 'div.card-2', '--crop', bad]);
    assert.equal(b.code, 2, `${bad}: ${b.stderr}`);
    assert.match(b.stderr, /--crop must be a \.png path inside/);
    assert.equal(existsSync(bad), false);
  }
});

test('--crop on a tiny --rect (4×4) writes a small image and returns', async () => {
  const { dir } = fixture();
  const out = path.join(dir, 'evidence', 'inspect', 'tiny.png');
  const r = await run(INSPECT, ['--dir', dir, '--state', 'with-data', '--rect', '40,30,4,4', '--crop', out], { timeout: 15000 });
  assert.equal(r.code, 0, r.stderr);
  const png = readPng(out);
  assert.ok(png.width > 0 && png.width <= 1100 && png.height <= 1100);
});

test('read-only: a query leaves the folder as it was; bad arguments exit 2', async () => {
  const { dir } = fixture();
  const before = readFileSync(path.join(dir, 'evidence', 'worklist.json'), 'utf8');
  await run(INSPECT, ['--dir', dir, '--state', 'with-data', '--text', 'Orders']);
  assert.equal(readFileSync(path.join(dir, 'evidence', 'worklist.json'), 'utf8'), before);
  for (const args of [[], ['--dir', dir], ['--dir', dir, '--state', 'with-data'], ['--dir', dir, '--state', 'with-data', '--text', 'a', '--at', '1,1'], ['--dir', dir, '--state', 'nope', '--text', 'a'], ['--dir', dir, '--state', 'with-data', '--at', '1'], ['--dir', dir, '--state', 'with-data', '--text', 'a', '--side', 'x']]) {
    const r = await run(INSPECT, args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}`);
  }
  const help = await run(INSPECT, ['--help']);
  assert.equal(help.code, 0);
});

test('a grab-only capture (computed/<state>.json, no audit) still answers', async () => {
  const d = page({ width: 640, rows: 2 });
  const dir = tmpDir('design-qa-inspect-');
  writeMatrix(dir, writePass(dir, { 'with-data': { design: d, app: clone(d) } }, { noAudit: true }));
  mkdirSync(path.join(dir, 'evidence', 'computed'), { recursive: true });
  writeFileSync(
    path.join(dir, 'evidence', 'computed', 'with-data.json'),
    JSON.stringify({ title: { selector: 'h1', count: 1, samples: [{ color: 'rgb(255, 255, 255)', 'font-size': '21px', __rect: { x: 32, y: 20, w: 240, h: 32 }, __visible: true, __el: { tag: 'h1', text: 'Orders', selector: 'header > h1' }, __vars: { color: ['--text-inverse'] } }] }, rootTokens: {} }),
  );
  const r = await run(INSPECT, ['--dir', dir, '--state', 'with-data', '--text', 'Orders']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /app \(1, grabbed elements only\):\n  header > h1 · "Orders" · 240×32 at 32,20 · font-size 21px · color rgb\(255, 255, 255\) \(var --text-inverse\)/);
});

/** A coded-prototype folder with a hover state: design-audit, both motion files and both grabs. */
function prototypeFixture() {
  const d = page({ width: 1024, rows: 2 });
  find(d.boxes, 'Card value 1').var = '--metric-value';
  find(d.boxes, 'Card value 1').varProp = 'font-size';
  const a = clone(d);
  find(a.boxes, 'Card value 1').size = 35;
  find(a.boxes, 'Card value 1').var = null;
  const dir = tmpDir('design-qa-inspect-');
  writePrototypePass(dir, { hover: { design: d, app: a, appExtra: { motion: 'motion/hover.json', computed: 'computed/hover.json' }, designExtra: { motion: 'design-motion/hover.json', computed: 'design-computed/hover.json' } } });
  const btn = find(a.boxes, 'New order');
  const grab = { button: { selector: 'button', count: 1, samples: [{ __rect: { x: btn.x, y: btn.y, w: btn.w, h: btn.h }, __visible: true, __el: { tag: 'button', text: 'New order', selector: 'button.new-order' } }] } };
  const ev = path.join(dir, 'evidence');
  for (const sub of ['computed', 'design-computed']) {
    mkdirSync(path.join(ev, sub), { recursive: true });
    writeFileSync(path.join(ev, sub, 'hover.json'), JSON.stringify(grab));
  }
  mkdirSync(path.join(ev, 'motion'), { recursive: true });
  mkdirSync(path.join(ev, 'design-motion'), { recursive: true });
  writeFileSync(path.join(ev, 'motion', 'hover.json'), JSON.stringify({ state: 'hover', side: 'app', trigger: 'hover', reducedMotion: false, elements: { button: { selector: 'button', count: 1, samples: [motionSample('button.new-order')] } }, actionTarget: null, animations: [], keyframes: {} }));
  writeFileSync(path.join(ev, 'design-motion', 'hover.json'), JSON.stringify({ state: 'hover', side: 'design', trigger: 'hover', reducedMotion: false, elements: { button: { selector: 'button', count: 1, samples: [{ ...motionSample('button.new-order'), 'transition-property': 'background-color, border-color', 'transition-duration': '0.16s, 0.16s', 'transition-timing-function': 'cubic-bezier(0, 0, 0.58, 1), cubic-bezier(0, 0, 0.58, 1)', 'transition-delay': '0s, 0s' }] } }, actionTarget: null, animations: [{ type: 'CSSTransition', element: { elementClass: 'button', index: 0 }, transitionProperty: 'background-color', durationMs: 160, delayMs: 0, easing: 'cubic-bezier(0, 0, 0.58, 1)' }], keyframes: {} }));
  return dir;
}

test('coded prototype: --side design and --item read the design-audit elements with their values and var()', async () => {
  const dir = prototypeFixture();
  const r = await run(INSPECT, ['--dir', dir, '--state', 'hover', '--selector', 'span.card-value-1', '--side', 'design']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /design \(1\):\n  div\.card-1 > span\.card-value-1 · "1000" · .*font-size 28px \(var --metric-value\)/);
  const app = await run(INSPECT, ['--dir', dir, '--state', 'hover', '--selector', 'span.card-value-1', '--side', 'app']);
  assert.match(app.stdout, /font-size 35px/);
  buildWorklist(dir);
  const wl = JSON.parse(readFileSync(path.join(dir, 'evidence', 'worklist.json'), 'utf8'));
  const it = wl.items.find((x) => x.hints.some((h) => h.kind === 'value'));
  const item = await run(INSPECT, ['--dir', dir, '--item', it.key, '--side', 'design', '--json']);
  const j = JSON.parse(item.stdout);
  assert.ok(j.design.length > 0);
  assert.ok(j.design.some((x) => x.values['font-size'] === '28px'));
});

test('--motion and --props transition-*: both sides\' transition facts for the element', async () => {
  const dir = prototypeFixture();
  const r = await run(INSPECT, ['--dir', dir, '--state', 'hover', '--selector', 'button.new-order', '--motion']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /motion \(app, evidence\/motion\/hover\.json; trigger hover\):\n  .*button\.new-order \[button #1\]: transition none · animation none/);
  assert.match(r.stdout, /motion \(design, evidence\/design-motion\/hover\.json; trigger hover\):\n  .*\[button #1\]: transition background-color 160ms cubic-bezier\(0, 0, 0\.58, 1\); border-color 160ms cubic-bezier\(0, 0, 0\.58, 1\) · animation none · ran: CSSTransition background-color 160ms/);
  const p = await run(INSPECT, ['--dir', dir, '--state', 'hover', '--selector', 'button.new-order', '--props', 'transition-property', '--side', 'design', '--json']);
  const j = JSON.parse(p.stdout);
  assert.equal(j.motion.design.rows[0].transition.startsWith('background-color 160ms'), true);
  assert.equal(j.motion.app, undefined);
});

test('--selector takes a comma-separated list; --crop with a bare name writes under evidence/inspect/', async () => {
  const { dir } = fixture();
  const r = await run(INSPECT, ['--dir', dir, '--state', 'with-data', '--selector', 'h1.title, button.new-order', '--side', 'app']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /app \(2\):/);
  assert.match(r.stdout, /h1\.title/);
  assert.match(r.stdout, /button\.new-order/);
  const c = await run(INSPECT, ['--dir', dir, '--state', 'with-data', '--selector', 'h1.title', '--crop', 'title-crop']);
  assert.equal(c.code, 0, c.stderr);
  assert.match(c.stdout, /crop: evidence\/inspect\/title-crop\.png/);
  assert.ok(existsSync(path.join(dir, 'evidence', 'inspect', 'title-crop.png')));
});

test('--state <s> --motion alone lists every transition and animation of the state on each side; an animation on an element that was not grabbed is found by its box', async () => {
  const dir = prototypeFixture();
  const card = find(page({ width: 1024, rows: 2 }).boxes, 'Card 1');
  const rect = { x: card.x, y: card.y, w: card.w, h: card.h };
  const file = path.join(dir, 'evidence', 'motion', 'hover.json');
  const m = JSON.parse(readFileSync(file, 'utf8'));
  m.animations = [{ type: 'CSSAnimation', target: 'div.card-1', selector: 'main > div.cards:nth-of-type(2) > div.card-1', rect, element: null, animationName: 'pop', durationMs: 600, delayMs: 0, easing: 'linear', iterations: 1, playState: 'running' }];
  writeFileSync(file, JSON.stringify(m));
  const r = await run(INSPECT, ['--dir', dir, '--state', 'hover', '--motion']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`motion \\(app, evidence/motion/hover\\.json; trigger hover\\):\\n  main > div\\.cards:nth-of-type\\(2\\) > div\\.card-1 ${rect.w}×${rect.h} at ${rect.x},${rect.y}: ran CSSAnimation pop 600ms linear \\(running\\)\\n`));
  assert.match(r.stdout, /motion \(design, evidence\/design-motion\/hover\.json; trigger hover\):\n  button\.new-order \[button #1\]: ran CSSTransition background-color 160ms cubic-bezier\(0, 0, 0\.58, 1\)\n  button\.new-order \[button #1\]: transition background-color 160ms/);
  assert.doesNotMatch(r.stdout, /^app \(|^design \(/m, 'no element query: only the motion lists');
  const limited = await run(INSPECT, ['--dir', dir, '--state', 'hover', '--motion', '--side', 'design', '--limit', '1']);
  assert.match(limited.stdout, /\n  … 1 more\n?$/);
  // The same animation from the element's side: matched by its recorded box.
  const el = await run(INSPECT, ['--dir', dir, '--state', 'hover', '--selector', 'div.card-1', '--motion', '--side', 'app']);
  assert.match(el.stdout, /div\.card-1 \[ran, not grabbed\]: CSSAnimation pop 600ms linear \(running\)/);
  const none = await run(INSPECT, ['--dir', dir, '--motion']);
  assert.equal(none.code, 2, 'without --state a question is still needed');
});

test('--item <audit candidate key>: the candidate\'s sample elements and what is at them on both sides', async () => {
  const dir = prototypeFixture();
  const v = find(page({ width: 1024, rows: 2 }).boxes, 'Card value 1');
  const rect = { x: v.x, y: v.y, w: v.w, h: v.h };
  writeFileSync(path.join(dir, 'evidence', 'ds-audit.json'), JSON.stringify({ candidates: [{ key: 'style:font-size:35px', title: 'Font size 35px; the design has 28px (--metric-value)', state: 'hover', element: { selector: 'span.card-value-1' }, _audit: { samples: [{ state: 'hover', selector: 'div.card-1 > span.card-value-1', text: '1000', rect }] } }] }));
  const r = await run(INSPECT, ['--dir', dir, '--item', 'style:font-size:35px']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^audit candidate style:font-size:35px · Font size 35px; the design has 28px \(--metric-value\)$/m);
  assert.match(r.stdout, new RegExp(`^samples \\(1\\):\\n  hover · div\\.card-1 > span\\.card-value-1 "1000" · ${rect.w}×${rect.h} at ${rect.x},${rect.y}$`, 'm'));
  assert.match(r.stdout, /^app \(1\):\n  div\.card-1 > span\.card-value-1 · "1000" · .*font-size 35px/m);
  assert.match(r.stdout, /^design \(1\):\n  div\.card-1 > span\.card-value-1 · "1000" · .*font-size 28px \(var --metric-value\)/m);
  const unknown = await run(INSPECT, ['--dir', dir, '--item', 'style:nothing']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /no audit candidate "style:nothing"/);
});

test('--item <source: candidate>: a raw import found in the source prints its file, line and snippet (it names no state)', async () => {
  const dir = prototypeFixture();
  const key = 'source:mui:src-features-detail:button';
  writeFileSync(path.join(dir, 'evidence', 'ds-audit.json'), JSON.stringify({ candidates: [{ key, title: 'src/features/Detail.tsx imports Button straight from @mui/material, not through ds (line 3)', state: null, element: { selector: null }, actual: { value: 'Button (third-party: MUI)', source: { file: 'src/features/Detail.tsx', line: 3, snippet: "import { Button } from '@mui/material';" } }, _audit: { origin: 'source-import', samples: [] } }] }));
  const r = await run(INSPECT, ['--dir', dir, '--item', key]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^source src\/features\/Detail\.tsx:3\n  import \{ Button \} from '@mui\/material';$/m);
  assert.match(r.stdout, /^Found in the source, not on a capture/m);
});
