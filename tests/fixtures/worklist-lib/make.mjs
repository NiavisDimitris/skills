// Test fixture builder for the worklist and inspect tests: one layout description (boxes
// with text, colours and sizes) rendered to a PNG with pngjs, flattened to figma-spec.json
// layers (REST shape, or MCP shape without values) and to collector audit elements
// (audit/<state>.json, the shape scripts/lib/audit-collect.mjs writes).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createPng, drawText, encodePng, fillRect } from '../../../skills/design-qa/scripts/lib/png.mjs';

export const FRAME_ORIGIN = { x: 1000, y: 2000 };

/** A box: { name, type, x, y, w, h, fill?, text?, color?, size?, weight?, tag?, cls?, control?, radius?, children? } */
export function box(name, type, x, y, w, h, extra = {}) {
  return { name, type, x, y, w, h, ...extra, children: extra.children ?? [] };
}

const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255];
const walk = (boxes, fn, parent = null, depth = 1) => {
  for (const b of boxes) {
    fn(b, parent, depth);
    walk(b.children, fn, b, depth + 1);
  }
};

/** Render boxes to a PNG of width × height on a background. */
export function render(boxes, width, height, background = '#ffffff') {
  const png = createPng(width, height, rgb(background));
  walk(boxes, (b) => {
    if (b.fill) fillRect(png, b, rgb(b.fill));
    if (b.text) {
      const scale = Math.max(1, Math.round((b.size ?? 14) / 7));
      drawText(png, b.x + 2, b.y + Math.max(0, Math.floor((b.h - 7 * scale) / 2)), b.text, rgb(b.color ?? '#111111'), scale);
    }
  });
  return png;
}

const figmaColor = (hex) => {
  const [r, g, b] = rgb(hex);
  return { r: r / 255, g: g / 255, b: b / 255, a: 1 };
};

/** figma-spec.json for a frame holding these boxes (rest: with values; mcp: geometry and names only). */
export function spec(boxes, width, height, { mode = 'rest', nodeId = '1:1', name = 'Page', states = [], exports = [] } = {}) {
  const layers = [{ id: nodeId, name, type: 'FRAME', path: name, depth: 0, visible: true, absoluteBoundingBox: { x: FRAME_ORIGIN.x, y: FRAME_ORIGIN.y, width, height } }];
  let n = 2;
  const paths = new Map();
  walk(boxes, (b, parent, depth) => {
    const id = b.id ?? `1:${n++}`;
    b.id = id;
    const p = `${parent ? paths.get(parent) : name}/${b.name}`;
    paths.set(b, p);
    const layer = { id, name: b.name, type: b.type, path: p, depth, visible: b.visible !== false, absoluteBoundingBox: { x: FRAME_ORIGIN.x + b.x, y: FRAME_ORIGIN.y + b.y, width: b.w, height: b.h } };
    if (mode === 'rest') {
      if (b.type === 'TEXT') {
        layer.characters = b.text ?? '';
        layer.fills = [{ type: 'SOLID', color: figmaColor(b.color ?? '#111111') }];
        layer.style = { fontFamily: 'Inter', fontSize: b.size ?? 14, fontWeight: b.weight ?? 400, lineHeightPx: b.h };
        if (b.colorVar) layer.boundVariables = { fills: [{ type: 'VARIABLE_ALIAS', id: b.colorVar }] };
      } else if (b.fill) {
        layer.fills = [{ type: 'SOLID', color: figmaColor(b.fill) }];
        if (b.radius) layer.cornerRadius = b.radius;
      }
      if (b.type === 'INSTANCE') layer.componentName = b.component ?? b.name;
    }
    layers.push(layer);
  });
  const out = {
    fileKey: 'AcmeFileKey',
    nodeId,
    name,
    type: 'FRAME',
    frame: { width, height },
    layers,
    siblings: [],
    states,
    exports,
    motion: [],
    variables: { variables: { 'VariableID:1': { name: 'color/text/primary' } } },
  };
  if (mode === 'mcp') {
    out.source = 'mcp';
    out.unavailable = ['fills', 'strokes', 'style', 'characters', 'componentName', 'boundVariables'];
  }
  return out;
}

/** Collector audit file (audit/<state>.json) for these boxes, as the app renders them. */
export function audit(boxes, width, height) {
  const elements = [];
  const index = new Map();
  const counts = new Map();
  walk(boxes, (b, parent) => {
    const tag = b.tag ?? (b.type === 'TEXT' ? 'span' : 'div');
    const cls = b.cls ?? b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const key = `${parent ? index.get(parent) : -1}|${tag}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  const seen = new Map();
  walk(boxes, (b, parent, depth) => {
    const tag = b.tag ?? (b.type === 'TEXT' ? 'span' : 'div');
    const cls = b.cls ?? b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const p = parent ? index.get(parent) : -1;
    const key = `${p}|${tag}`;
    const k = (seen.get(key) ?? 0) + 1;
    seen.set(key, k);
    const parentPath = parent ? elements[p].path : 'main';
    const seg = `${tag}.${cls}${counts.get(key) > 1 ? `:nth-of-type(${k})` : ''}`;
    const s = {};
    if (b.fill) s['background-color'] = `rgb(${rgb(b.fill).slice(0, 3).join(', ')})`;
    if (b.radius) s['border-top-left-radius'] = `${b.radius}px`;
    if (b.text) {
      s.color = `rgb(${rgb(b.color ?? '#111111').slice(0, 3).join(', ')})`;
      s['font-size'] = `${b.size ?? 14}px`;
      s['font-weight'] = String(b.weight ?? 400);
      s['font-family'] = 'Inter, sans-serif';
      s['line-height'] = `${b.h}px`;
    }
    const i = elements.length;
    index.set(b, i);
    elements.push({
      i,
      p,
      d: depth + 2,
      path: `${parentPath} > ${seg}`,
      tag,
      id: null,
      cls: [cls],
      role: null,
      type: null,
      attrs: b.testid ? { 'data-testid': b.testid } : {},
      text: b.text ?? null,
      control: b.control ?? null,
      own: Boolean(b.text),
      rect: { x: b.x, y: b.y, w: b.w, h: b.h },
      vis: { x: b.x, y: b.y, w: b.w, h: b.h },
      partial: false,
      clip: null,
      r: -1,
      sel: null,
      s,
      v: b.var ? { [b.varProp ?? 'color']: b.var } : null,
      inh: null,
    });
  });
  return { version: 1, fullPage: true, scroll: { x: 0, y: 0 }, viewport: { w: width, h: 1080 }, page: { w: width, h: height }, rootFontSize: 16, regions: [], selectors: [], stats: {}, truncated: null, elements };
}

const write = (file, data) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.isBuffer(data) ? data : `${JSON.stringify(data, null, 2)}\n`);
};

/**
 * Write a report folder. states: { <name>: { design: { boxes, width, height } | null,
 * app: { boxes, width, height } | null, clipped?, failure?, mask? } }. options: { mode
 * ('rest' | 'mcp' | 'none'), screen (multi-screen id), matrix (write state-matrix.json),
 * noAudit }.
 */
export function writeState(dir, name, st, { mode = 'rest', screen = null, noAudit = false } = {}) {
  const base = screen ? path.join(dir, 'evidence', 'screens', screen) : path.join(dir, 'evidence');
  if (st.design) write(path.join(base, 'figma', `${name}.png`), encodePng(render(st.design.boxes, st.design.width, st.design.height)));
  if (st.app) {
    write(path.join(base, 'app', `${name}.png`), encodePng(render(st.app.boxes, st.app.width, st.app.height)));
    if (!noAudit) write(path.join(base, 'audit', `${name}.json`), audit(st.app.boxes, st.app.width, st.app.height));
  }
  if (st.mask) write(path.join(base, 'masks', `${name}.json`), st.mask);
}

export function writePass(dir, states, { mode = 'rest', screen = null, noAudit = false, matrix = true, specBoxes = null, extraRows = [] } = {}) {
  const base = screen ? path.join(dir, 'evidence', 'screens', screen) : path.join(dir, 'evidence');
  const manifest = { side: 'app', states: {} };
  for (const [name, st] of Object.entries(states)) {
    writeState(dir, name, st, { mode, screen, noAudit });
    manifest.states[name] = st.app
      ? { screenshot: `app/${name}.png`, audit: noAudit ? undefined : `audit/${name}.json`, page: { width: st.app.width, height: st.app.height }, size: { width: st.app.width, height: st.app.height }, clipped: st.clipped ?? [] }
      : { screenshot: null, error: st.failure?.detail ?? 'failed', failure: st.failure ?? { kind: 'sign-in', detail: 'landed on the sign-in page' } };
  }
  write(path.join(base, 'capture.json'), manifest);
  if (mode !== 'none') {
    const first = Object.values(states).find((s) => s.design);
    const boxes = specBoxes ?? first.design.boxes;
    write(path.join(base, 'figma-spec.json'), spec(boxes, first.design.width, first.design.height, { mode }));
  }
  if (matrix) {
    const rows = [...Object.keys(states).map((name) => ({ state: screen ? `${screen}/${name}` : name, ...(screen ? { screen } : {}), label: name, result: 'CANNOT_VERIFY', findings: [], designed: { nodeId: '1:1', name: 'Page' } })), ...extraRows];
    return rows;
  }
  return [];
}

export function writeMatrix(dir, rows) {
  write(path.join(dir, 'state-matrix.json'), rows);
}

/** A realistic page: header, hero, a card grid, a table of rows and a footer; height grows with sections. */
export function page({ width = 1280, rows = 8, extraSections = 0, title = 'Orders', rowText = (i) => `Row ${i + 1}`, amount = (i) => `${(i + 1) * 120}.00` } = {}) {
  const boxes = [];
  boxes.push(box('Header', 'FRAME', 0, 0, width, 72, { fill: '#0f172a', tag: 'header', children: [box('Title', 'TEXT', 32, 20, 240, 32, { text: title, color: '#ffffff', size: 21, weight: 600, tag: 'h1' }), box('New order', 'INSTANCE', width - 200, 16, 160, 40, { fill: '#2563eb', radius: 6, tag: 'button', control: 'button', children: [box('Label', 'TEXT', width - 188, 24, 136, 24, { text: 'New order', color: '#ffffff', size: 14, tag: 'span' })] })] }));
  let y = 104;
  boxes.push(box('Filters', 'FRAME', 32, y, width - 64, 48, { fill: '#f1f5f9', radius: 8, children: [box('Filter label', 'TEXT', 48, y + 12, 200, 24, { text: 'Last 30 days', size: 14 })] }));
  y += 80;
  const cards = [];
  for (let c = 0; c < 3; c++) {
    const cx = 32 + c * Math.floor((width - 64) / 3);
    cards.push(box(`Card ${c + 1}`, 'FRAME', cx, y, Math.floor((width - 64) / 3) - 24, 140, { fill: '#e2e8f0', radius: 12, children: [box(`Card title ${c + 1}`, 'TEXT', cx + 16, y + 16, 200, 24, { text: `Metric ${c + 1}`, size: 14, weight: 600 }), box(`Card value ${c + 1}`, 'TEXT', cx + 16, y + 64, 200, 42, { text: `${(c + 1) * 1000}`, size: 28, weight: 700 })] }));
  }
  boxes.push(box('Cards', 'FRAME', 32, y, width - 64, 140, { children: cards }));
  y += 180;
  const rowsBoxes = [];
  for (let i = 0; i < rows; i++) {
    const ry = y + 48 + i * 56;
    rowsBoxes.push(box('Row', 'FRAME', 32, ry, width - 64, 56, { fill: i % 2 ? '#ffffff' : '#f8fafc', tag: 'tr', cls: 'row', children: [box('Name', 'TEXT', 48, ry + 16, 300, 24, { text: rowText(i), size: 14, tag: 'td', cls: 'name' }), box('Amount', 'TEXT', width - 260, ry + 16, 200, 24, { text: amount(i), size: 14, tag: 'td', cls: 'amount' })] }));
  }
  boxes.push(box('Table', 'FRAME', 32, y, width - 64, 48 + rows * 56, { tag: 'table', children: [box('Table header', 'FRAME', 32, y, width - 64, 48, { fill: '#cbd5e1', children: [box('Col name', 'TEXT', 48, y + 12, 200, 24, { text: 'Customer', size: 14, weight: 600, tag: 'th' })] }), ...rowsBoxes] }));
  y += 48 + rows * 56 + 40;
  for (let s = 0; s < extraSections; s++) {
    boxes.push(box(`Section ${s + 1}`, 'FRAME', 32, y, width - 64, 360, { fill: s % 2 ? '#fef3c7' : '#dcfce7', radius: 8, tag: 'section', children: [box(`Section title ${s + 1}`, 'TEXT', 56, y + 24, 400, 32, { text: `Section ${s + 1}`, size: 21, weight: 600, tag: 'h2' }), box(`Section body ${s + 1}`, 'TEXT', 56, y + 80, 600, 24, { text: 'Body copy for this part', size: 14 })] }));
    y += 400;
  }
  boxes.push(box('Footer', 'FRAME', 0, y, width, 80, { fill: '#1e293b', tag: 'footer', children: [box('Footer text', 'TEXT', 32, y + 28, 300, 24, { text: 'Acme Inc', color: '#e2e8f0', size: 14 })] }));
  y += 80;
  return { boxes, width, height: y };
}

/** Deep copy of a page description. */
export const clone = (p) => JSON.parse(JSON.stringify(p));

/** Find a box by name (depth first). */
export function find(boxes, name) {
  let hit = null;
  walk(boxes, (b) => {
    if (!hit && b.name === name) hit = b;
  });
  return hit;
}

/** Remove a box (by name) and move everything below it up by its height + gap. */
export function removeSection(p, name, gap = 40) {
  const b = find(p.boxes, name);
  const i = p.boxes.indexOf(b);
  p.boxes.splice(i, 1);
  const dy = b.h + gap;
  walk(p.boxes, (x) => {
    if (x.y >= b.y + b.h) x.y -= dy;
  });
  p.height -= dy;
  return dy;
}

/** The longhands capture.mjs records per element for motion/<state>.json. */
export function motionSample(selector, { property = 'all', durationMs = 0, easing = 'ease', delayMs = 0 } = {}) {
  return {
    'transition-property': property,
    'transition-duration': `${durationMs / 1000}s`,
    'transition-timing-function': easing,
    'transition-delay': `${delayMs / 1000}s`,
    'animation-name': 'none',
    'animation-duration': '0s',
    'animation-timing-function': 'ease',
    'animation-delay': '0s',
    'animation-iteration-count': '1',
    __selector: selector,
  };
}

/**
 * A coded-prototype pass: app/ + audit/ + capture.json on the app side, design/ +
 * design-audit/ (at `designAuditPath`, listed as states.<s>.audit in design-capture.json)
 * on the design side. states: { <name>: { design, app, appExtra?, designExtra? } } where
 * appExtra / designExtra are merged into the state's manifest entry (sameAs, motion…).
 */
export function writePrototypePass(dir, states, { designAuditPath = (s) => `design-audit/${s}.json`, matrix = true } = {}) {
  const ev = path.join(dir, 'evidence');
  const app = { side: 'app', states: {} };
  const des = { side: 'design', source: { kind: 'prototype' }, states: {} };
  for (const [name, st] of Object.entries(states)) {
    write(path.join(ev, 'app', `${name}.png`), encodePng(render(st.app.boxes, st.app.width, st.app.height)));
    write(path.join(ev, 'audit', `${name}.json`), audit(st.app.boxes, st.app.width, st.app.height));
    app.states[name] = { screenshot: `app/${name}.png`, audit: `audit/${name}.json`, size: { width: st.app.width, height: st.app.height }, clipped: [], sameAs: null, ...(st.appExtra ?? {}) };
    write(path.join(ev, 'design', `${name}.png`), encodePng(render(st.design.boxes, st.design.width, st.design.height)));
    const rel = designAuditPath(name);
    write(path.join(ev, rel), audit(st.design.boxes, st.design.width, st.design.height));
    des.states[name] = { screenshot: `design/${name}.png`, audit: rel, sameAs: null, ...(st.designExtra ?? {}) };
  }
  write(path.join(ev, 'capture.json'), app);
  write(path.join(ev, 'design-capture.json'), des);
  if (matrix) write(path.join(dir, 'state-matrix.json'), Object.keys(states).map((s) => ({ state: s, label: s, result: 'CANNOT_VERIFY', findings: [] })));
}
