#!/usr/bin/env node
// examples/sample/make-fixtures.mjs
//
// Regenerates the synthetic evidence behind the design-qa sample report, then builds
// sample-report.json the way a pass does: worklist.mjs walks the pages region by region
// and build-report.mjs assembles the report from that evidence and findings.json (the
// judgment, committed next to this file), so the report carries a real meta.build and
// validate.mjs verifies it. The evidence:
//   evidence/figma/<state>.png   "design" mock-ups (flat wireframes, 1440×900; the report's `design` key)
//   evidence/app/<state>.png     "implementation" mock-ups with deliberate deltas
//   evidence/diff/<state>.png    pixelmatch output for states that have both
//   evidence/{computed,dom,motion}/<state>.json, figma-spec.json, ticket.json, capture.json
//   evidence/backfill/…          app-only capture of the undesigned "bulk-selected" state (step 2; the report's `backfill` block)
//   evidence/diff.json           what diff.mjs --json prints for those pairs
//   evidence/worklist.json, worklist.md, evidence/worklist/…   written by worklist.mjs
// Build inputs committed here: findings.json, state-matrix.json, design-qa.config.json,
// design-qa/known-drifts.md and the run lock .design-qa-run.json. The existing
// sample-report.json belongs to the same run, so the build keeps its triage, fix loop,
// design backfill and the recorded dismissal (DQ-022).
//
// Deterministic evidence (no randomness); worklist.json and meta.generatedAt carry the
// time of the run. Run: node examples/sample/make-fixtures.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';
import pixelmatch from 'pixelmatch';

const { PNG } = pngjs;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EV = path.join(HERE, 'evidence');
const REPORT_FILE = path.join(HERE, 'sample-report.json');
const W = 1440;
const H = 900;
const DIFF_OPTS = { threshold: 0.1, includeAA: false }; // same defaults as scripts/diff.mjs
const round2 = (n) => Math.round(n * 100) / 100;
const APP_URL = 'https://acme-console-git-feat-orders-acme.vercel.app/orders';

// ---------------------------------------------------------------------------
// 1. Tiny raster canvas: flat (optionally rounded) rectangles, no anti-aliasing
// ---------------------------------------------------------------------------
const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

function insideRounded(i, j, w, h, r) {
  const px = i + 0.5;
  const py = j + 0.5;
  const cx = Math.min(Math.max(px, r), w - r);
  const cy = Math.min(Math.max(py, r), h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

class Canvas {
  constructor(w, h, bg) {
    this.w = w;
    this.h = h;
    this.png = new PNG({ width: w, height: h });
    this.fill(0, 0, w, h, bg);
  }
  fill(x, y, w, h, color, r = 0) {
    const [cr, cg, cb] = rgb(color);
    const d = this.png.data;
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    r = Math.min(r, Math.floor(w / 2), Math.floor(h / 2));
    for (let j = 0; j < h; j++) {
      const yy = y + j;
      if (yy < 0 || yy >= this.h) continue;
      for (let i = 0; i < w; i++) {
        const xx = x + i;
        if (xx < 0 || xx >= this.w) continue;
        if (r > 0 && !insideRounded(i, j, w, h, r)) continue;
        const k = (yy * this.w + xx) * 4;
        d[k] = cr; d[k + 1] = cg; d[k + 2] = cb; d[k + 3] = 255;
      }
    }
  }
  box(x, y, w, h, { fill = null, border = null, r = 0, t = 1 } = {}) {
    if (border) {
      this.fill(x, y, w, h, border, r);
      if (fill) this.fill(x + t, y + t, w - 2 * t, h - 2 * t, fill, Math.max(0, r - t));
    } else if (fill) {
      this.fill(x, y, w, h, fill, r);
    }
  }
  ring(x, y, w, h, color, t = 2) {
    this.fill(x, y, w, t, color);
    this.fill(x, y + h - t, w, t, color);
    this.fill(x, y, t, h, color);
    this.fill(x + w - t, y, t, h, color);
  }
}

function savePng(png, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png, { colorType: 2 }));
}

// "Text" is drawn as one bar per word: width follows the characters, height
// and advance follow size and weight. Enough to make layout deltas visible.
function text(cv, x, y, str, o = {}) {
  const { size = 14, color = T.text, weight = 400, mono = false, align = 'left', caps = false, measure = false } = o;
  const s = caps ? str.toUpperCase() : str;
  const cw = size * (mono ? 0.6 : caps ? 0.66 : 0.52) + (weight >= 600 ? 0.4 : 0);
  const gap = Math.round(size * 0.32);
  const bh = Math.max(2, Math.round(size * 0.46) + (weight >= 700 ? 2 : weight >= 600 ? 1 : 0));
  const words = s.split(/\s+/).filter(Boolean).map((wd) => Math.max(2, Math.round(wd.length * cw)));
  const total = words.reduce((a, b) => a + b, 0) + gap * Math.max(0, words.length - 1);
  if (measure) return total;
  let cx = align === 'right' ? x - total : align === 'center' ? Math.round(x - total / 2) : x;
  const top = y + Math.round((size * 1.4 - bh) / 2); // y = top of a 1.4 line box
  for (const ww of words) {
    cv.fill(cx, top, ww, bh, color);
    cx += ww + gap;
  }
  return total;
}

// ---------------------------------------------------------------------------
// 2. Acme DS values and sample data (fictional)
// ---------------------------------------------------------------------------
const T = {
  canvas: '#F7F8FA', surface: '#FFFFFF', border: '#E5E7EB', subtle: '#F9FAFB', control: '#D1D5DB',
  text: '#111827', text2: '#4B5563', muted: '#6B7280', placeholder: '#9CA3AF',
  brand: '#4F46E5', brandSoft: '#EEF2FF', brandText: '#4338CA',
  hover: '#F0F4FA', selected: '#E6EEFF', focus: '#2563EB', skeleton: '#D1D5DB',
  danger: '#DC2626', dangerSoft: '#FEF2F2',
};
const BADGE = {
  Shipped: ['#DCFCE7', '#166534'], Processing: ['#DBEAFE', '#1E40AF'],
  Pending: ['#FEF3C7', '#92400E'], Cancelled: ['#F3F4F6', '#374151'],
};
const NAV = ['Dashboard', 'Orders', 'Customers', 'Products', 'Invoices', 'Reports', 'Settings'];

// Design sample rows (Figma) — 8 rows.
const ROWS = [
  ['ORD-10482', 'Bluefin Bakery', 'Shipped', '$1,240.00', 'Sep 21, 2026'],
  ['ORD-10481', 'Kestrel Labs', 'Processing', '$86.40', 'Sep 21, 2026'],
  ['ORD-10480', 'Harbor & Pine', 'Pending', '$412.75', 'Sep 20, 2026'],
  ['ORD-10479', 'Quartz Studio', 'Shipped', '$2,015.10', 'Sep 20, 2026'],
  ['ORD-10478', 'Fernway Books', 'Cancelled', '$58.00', 'Sep 19, 2026'],
  ['ORD-10477', 'Summit Gear Co.', 'Shipped', '$930.20', 'Sep 19, 2026'],
  ['ORD-10476', 'Lumen Dental', 'Processing', '$147.35', 'Sep 18, 2026'],
  ['ORD-10475', 'Otter Creek Farm', 'Pending', '$64.90', 'Sep 18, 2026'],
];
// Preview fixture (fixtures/orders/with-data.json): same orders, 3 different totals, 12 rows (DATA).
const APP_ROWS = ROWS.map((r) => [...r]);
APP_ROWS[0][3] = '$1,204.00';
APP_ROWS[3][3] = '$215.10';
APP_ROWS[5][3] = '$9,302.00';
APP_ROWS.push(
  ['ORD-10474', 'Pinecone Toys', 'Shipped', '$318.00', 'Sep 17, 2026'],
  ['ORD-10473', 'Marlow Print Shop', 'Processing', '$1,075.60', 'Sep 17, 2026'],
  ['ORD-10472', 'Tidewater Tea', 'Shipped', '$42.15', 'Sep 16, 2026'],
  ['ORD-10471', 'Copperleaf Goods', 'Cancelled', '$689.99', 'Sep 16, 2026'],
);
const UPDATED = ['Sep 22, 09:14', 'Sep 22, 08:51', 'Sep 21, 17:02', 'Sep 21, 16:40', 'Sep 21, 11:05', 'Sep 20, 18:22',
  'Sep 20, 10:37', 'Sep 19, 15:48', 'Sep 19, 09:30', 'Sep 18, 14:12', 'Sep 18, 08:05', 'Sep 17, 16:59'];

const COLS = [
  { key: 'id', label: 'Order', w: 150 },
  { key: 'customer', label: 'Customer', w: 300 },
  { key: 'status', label: 'Status', w: 170 },
  { key: 'total', label: 'Total', w: 150, align: 'right', sort: true },
  { key: 'created', label: 'Created', w: 190, sort: true },
];
const CELL = { id: 0, customer: 1, status: 2, total: 3, created: 4 };

// The two renderings. Every app-side difference maps to a finding in sample-report.json.
const VARIANTS = {
  figma: { pad: 24, titleWeight: 600, header: 'ds', cols: COLS, rows: ROWS, pager: 'bottom', hoverBg: T.hover, skelR: 6, search: 'Search orders' },
  app: {
    pad: 20, // DQ-004 card padding 20px vs --ads-space-6
    titleWeight: 500, // DQ-006
    header: 'native', // DQ-002 native <th> styling
    cols: [...COLS, { key: 'updated', label: 'Updated', w: 136 }], // DQ-010 (extra column the design does not have)
    rows: APP_ROWS, // DQ-012 / DQ-013
    pager: 'toolbar', // DQ-011 (signed off)
    hoverBg: '#CFD8E6', // DQ-003 hardcoded hex
    skelR: 2, // DQ-007
    search: 'Search by order ID or customer', // DQ-018
  },
};

// ---------------------------------------------------------------------------
// 3. Scene drawing (layout constants are mirrored by the crops in sample-report.json)
// ---------------------------------------------------------------------------
const CARD = { x: 264, y: 204, w: 1144 };
const ROW_H = 48;
const HEAD_H = 40;

function chrome(cv) {
  cv.fill(0, 0, W, 56, T.surface);
  cv.fill(0, 56, W, 1, T.border);
  cv.fill(20, 16, 24, 24, T.brand, 6);
  cv.fill(27, 23, 10, 10, T.surface, 2);
  text(cv, 56, 18, 'Acme Console', { size: 15, weight: 600 });
  cv.box(1336, 16, 24, 24, { fill: T.surface, border: T.control, r: 12 });
  cv.fill(1380, 14, 28, 28, '#C7D2FE', 14);
  text(cv, 1394, 19, 'AC', { size: 11, weight: 600, color: T.brandText, align: 'center' });
  cv.fill(0, 57, 232, H - 57, T.surface);
  cv.fill(232, 57, 1, H - 57, T.border);
  NAV.forEach((label, k) => {
    const y = 76 + k * 40;
    const active = label === 'Orders';
    if (active) cv.fill(12, y, 208, 32, T.brandSoft, 6);
    cv.fill(26, y + 9, 14, 14, active ? T.brand : T.placeholder, 3);
    text(cv, 50, y + 6, label, { size: 14, weight: active ? 600 : 400, color: active ? T.brandText : T.text2 });
  });
}

function iconButton(cv, x, y) {
  cv.box(x, y, 36, 36, { fill: T.surface, border: T.control, r: 6 });
  cv.fill(x + 16, y + 13, 4, 10, T.text2);
}

function toolbar(cv, v) {
  cv.box(264, 152, 320, 36, { fill: T.surface, border: T.control, r: 6 });
  cv.box(278, 163, 14, 14, { fill: T.surface, border: T.muted, r: 7, t: 2 });
  text(cv, 300, 160, v.search, { size: 14, color: T.placeholder });
  cv.box(596, 152, 168, 36, { fill: T.surface, border: T.control, r: 6 });
  text(cv, 610, 160, 'All statuses', { size: 14 });
  cv.fill(742, 168, 10, 4, T.muted);
  if (v.pager === 'toolbar') {
    text(cv, 1160, 160, `1–${v.rows.length} of 124`, { size: 13, color: T.muted, align: 'right' });
    iconButton(cv, 1170, 152);
    iconButton(cv, 1214, 152);
  }
  cv.box(1288, 152, 120, 36, { fill: T.brand, r: 6 });
  text(cv, 1348, 160, 'New order', { size: 14, weight: 600, color: T.surface, align: 'center' });
}

function tableHeader(cv, v, x, y, w) {
  if (v.header === 'ds') {
    cv.fill(x, y, w, HEAD_H, T.subtle, 6);
    cv.fill(x, y + HEAD_H - 1, w, 1, T.border);
  } else {
    cv.fill(x, y + HEAD_H - 2, w, 2, T.control);
  }
  let cx = x;
  for (const c of v.cols) {
    const o = v.header === 'ds'
      ? { size: 12, weight: 600, color: T.muted }
      : { size: 12, weight: 700, color: T.text, caps: true };
    const right = c.align === 'right';
    const tx = right ? cx + c.w - 16 : cx + 16;
    const tw = text(cv, tx, y + 12, c.label, { ...o, align: right ? 'right' : 'left' });
    if (v.header === 'ds' && c.sort) {
      const sx = right ? tx - tw - 13 : tx + tw + 6;
      cv.fill(sx, y + 15, 7, 3, T.placeholder);
      cv.fill(sx, y + 21, 7, 3, T.placeholder);
    }
    cx += c.w;
  }
}

function badge(cv, x, y, label) {
  const [bg, fg] = BADGE[label];
  const tw = text(cv, 0, 0, label, { size: 12, weight: 600, measure: true });
  cv.box(x, y, tw + 20, 22, { fill: bg, r: 11 });
  text(cv, x + 10, y + 3, label, { size: 12, weight: 600, color: fg });
}

function row(cv, v, i, x, y, w, state) {
  const r = v.rows[i];
  if (state === 'hover' && i === 1) cv.fill(x, y, w, ROW_H - 1, v.hoverBg);
  if (state === 'selected' && i === 2) {
    cv.fill(x, y, w, ROW_H - 1, T.selected);
    cv.fill(x, y, 3, ROW_H - 1, T.brand);
  }
  if (state === 'bulk-selected') cv.fill(x, y, w, ROW_H - 1, T.brandSoft);
  cv.fill(x, y + ROW_H - 1, w, 1, T.border);
  let cx = x;
  for (const c of v.cols) {
    const val = c.key === 'updated' ? UPDATED[i] : r[CELL[c.key]];
    if (c.key === 'status') badge(cv, cx + 16, y + 13, val);
    else {
      const right = c.align === 'right';
      text(cv, right ? cx + c.w - 16 : cx + 16, y + 14, val, {
        size: c.key === 'id' ? 13 : 14,
        mono: c.key === 'id',
        color: c.key === 'created' || c.key === 'updated' ? T.text2 : T.text,
        align: right ? 'right' : 'left',
      });
    }
    cx += c.w;
  }
  if (state === 'focus' && i === 0) cv.ring(x + 1, y + 1, w - 2, ROW_H - 3, T.focus, 2);
}

function skeletonRow(cv, v, x, y, w) {
  cv.fill(x, y + ROW_H - 1, w, 1, T.border);
  const widths = { id: 84, customer: 168, status: 72, total: 72, created: 104, updated: 96 };
  let cx = x;
  for (const c of v.cols) {
    const bw = widths[c.key];
    const bx = c.align === 'right' ? cx + c.w - 16 - bw : cx + 16;
    if (c.key === 'status') cv.fill(bx, y + 14, bw, 20, T.skeleton, 10);
    else cv.fill(bx, y + 18, bw, 12, T.skeleton, v.skelR);
    cx += c.w;
  }
}

function pagerBottom(cv, x, y, w, n) {
  text(cv, x, y + 6, `1–${n} of 124`, { size: 13, color: T.muted });
  const labels = ['<', '1', '2', '3', '>'];
  labels.forEach((lb, k) => {
    const bx = x + w - (labels.length - k) * 40 + 8;
    const active = lb === '1';
    cv.box(bx, y, 32, 32, active ? { fill: T.brand, r: 6 } : { fill: T.surface, border: T.control, r: 6 });
    text(cv, bx + 16, y + 7, lb === '<' || lb === '>' ? 'x' : lb, { size: 13, weight: 600, color: active ? T.surface : T.text2, align: 'center' });
  });
}

function emptyState(cv, x, y, w) {
  const cx = Math.round(x + w / 2);
  cv.fill(cx - 48, y + 56, 96, 96, '#E0E7FF', 48);
  cv.box(cx - 22, y + 86, 44, 34, { fill: T.surface, border: T.brand, r: 4, t: 3 });
  cv.fill(cx - 22, y + 104, 44, 3, T.brand);
  text(cv, cx, y + 172, 'No orders yet', { size: 16, weight: 600, align: 'center' });
  text(cv, cx, y + 200, 'Orders you create or import will appear here.', { size: 14, color: T.muted, align: 'center' });
  cv.box(cx - 66, y + 236, 132, 36, { fill: T.brand, r: 6 });
  text(cv, cx, y + 244, 'Create order', { size: 14, weight: 600, color: T.surface, align: 'center' });
}

function errorAlert(cv, x, y, w) {
  cv.fill(x, y, w, 72, T.dangerSoft, 6);
  cv.fill(x, y, 4, 72, T.danger);
  cv.fill(x + 20, y + 16, 20, 20, T.danger, 10);
  cv.fill(x + 29, y + 20, 2, 8, T.surface);
  cv.fill(x + 29, y + 30, 2, 2, T.surface);
  text(cv, x + 52, y + 12, "Couldn't load orders", { size: 14, weight: 600, color: '#991B1B' });
  text(cv, x + 52, y + 36, 'Orders could not be loaded: the server returned 500. Retry.', { size: 13, color: '#7F1D1D' });
  cv.box(x + w - 100, y + 20, 84, 32, { fill: T.surface, border: T.control, r: 6 });
  text(cv, x + w - 58, y + 27, 'Retry', { size: 13, weight: 600, align: 'center' });
}

function bulkBar(cv, n) {
  cv.box(400, 808, 640, 56, { fill: '#111827', r: 10 });
  text(cv, 424, 826, `${n} selected`, { size: 14, weight: 600, color: '#F9FAFB' });
  text(cv, 540, 827, 'Clear selection', { size: 13, color: T.placeholder });
  cv.box(788, 820, 96, 32, { fill: '#1F2937', border: T.text2, r: 6 });
  text(cv, 836, 827, 'Export', { size: 13, weight: 600, color: '#F9FAFB', align: 'center' });
  cv.box(896, 820, 128, 32, { fill: T.danger, r: 6 });
  text(cv, 960, 827, 'Cancel orders', { size: 13, weight: 600, color: T.surface, align: 'center' });
}

function drawScene(kind, state) {
  const v = VARIANTS[kind];
  const cv = new Canvas(W, H, T.canvas);
  chrome(cv);
  text(cv, 264, 78, 'Orders', { size: 24, weight: v.titleWeight });
  text(cv, 264, 116, 'Track and manage customer orders', { size: 14, color: T.muted });
  toolbar(cv, v);
  const p = v.pad;
  const iL = CARD.x + p;
  const iT = CARD.y + p;
  const iW = CARD.w - 2 * p;
  const card = (h) => cv.box(CARD.x, CARD.y, CARD.w, h, { fill: T.surface, border: T.border, r: 8 });
  if (state === 'error') {
    card(2 * p + 72);
    errorAlert(cv, iL, iT, iW);
    return cv;
  }
  if (state === 'empty') {
    card(2 * p + HEAD_H + 312);
    tableHeader(cv, v, iL, iT, iW);
    emptyState(cv, iL, iT + HEAD_H, iW);
    return cv;
  }
  const loading = state === 'loading';
  const n = loading ? 8 : v.rows.length;
  const pagerH = v.pager === 'bottom' && !loading ? 48 : 0;
  card(2 * p + HEAD_H + n * ROW_H + pagerH);
  tableHeader(cv, v, iL, iT, iW);
  for (let i = 0; i < n; i++) {
    const y = iT + HEAD_H + i * ROW_H;
    if (loading) skeletonRow(cv, v, iL, y, iW);
    else row(cv, v, i, iL, y, iW, state);
  }
  if (pagerH) pagerBottom(cv, iL, iT + HEAD_H + n * ROW_H + 16, iW, n);
  if (state === 'bulk-selected') bulkBar(cv, v.rows.length);
  return cv;
}

// ---------------------------------------------------------------------------
// 4. Small JSON evidence (what figma-fetch / jira-fetch / capture would save)
// ---------------------------------------------------------------------------
const FIGMA_FILE = 'aBcD3fGh1JkLmN0pQrStUv';
const layer = (id, name, type, extra = {}) => ({ id, name, type, ...extra });

function figmaSpec() {
  return {
    fileKey: FIGMA_FILE,
    nodeId: '1204:3310',
    name: 'Orders / With data',
    frame: { width: W, height: H },
    variables: {
      '--ads-color-text-primary': '#111827', '--ads-color-text-secondary': '#6B7280',
      '--ads-color-surface-subtle': '#F9FAFB', '--ads-color-surface-hover': '#F0F4FA',
      '--ads-color-surface-selected': '#E6EEFF', '--ads-color-focus-ring': '#2563EB',
      '--ads-space-3': '12px', '--ads-space-4': '16px', '--ads-space-6': '24px',
      '--ads-radius-md': '6px', '--ads-radius-lg': '8px',
      '--ads-font-size-xl': '24px', '--ads-font-weight-semibold': 600,
    },
    layers: [
      layer('1204:3310', 'Orders / With data', 'FRAME', { bounds: [0, 0, 1440, 900], fills: ['--ads-color-bg-canvas'] }),
      layer('1204:3311', 'App header', 'INSTANCE', { component: 'AppHeader', bounds: [0, 0, 1440, 56] }),
      layer('1204:3312', 'Sidebar', 'INSTANCE', { component: 'SideNav', variantProperties: { Active: 'Orders' }, bounds: [0, 57, 232, 843] }),
      layer('1204:3314', 'Page title', 'TEXT', { characters: 'Orders', style: { fontSize: 24, fontWeight: 600, lineHeight: 32 }, tokens: { fill: '--ads-color-text-primary', fontSize: '--ads-font-size-xl', fontWeight: '--ads-font-weight-semibold' }, bounds: [264, 78, 82, 32] }),
      layer('1204:3315', 'Page subtitle', 'TEXT', { characters: 'Track and manage customer orders', tokens: { fill: '--ads-color-text-secondary' }, bounds: [264, 116, 236, 20] }),
      layer('1204:3316', 'Toolbar', 'FRAME', { layout: { mode: 'HORIZONTAL', gap: 12 }, bounds: [264, 152, 1144, 36] }),
      layer('1204:3317', 'Search', 'INSTANCE', { component: 'Input', variantProperties: { Size: 'md', Icon: 'Leading' }, characters: 'Search orders', bounds: [264, 152, 320, 36] }),
      layer('1204:3318', 'Status filter', 'INSTANCE', { component: 'Select', characters: 'All statuses', bounds: [596, 152, 168, 36] }),
      layer('1204:3319', 'New order', 'INSTANCE', { component: 'Button', variantProperties: { Variant: 'Primary', Size: 'md' }, bounds: [1288, 152, 120, 36] }),
      layer('1204:3320', 'Card', 'FRAME', { padding: 24, tokens: { padding: '--ads-space-6', radius: '--ads-radius-lg', stroke: '--ads-color-border-subtle' }, bounds: [264, 204, 1144, 520] }),
      layer('1204:3322', 'Table.Header', 'INSTANCE', { component: 'Table.Header', variantProperties: { Sticky: 'True' }, tokens: { fill: '--ads-color-surface-subtle' }, bounds: [288, 228, 1096, 40] }),
      layer('1204:3323', 'Table.HeaderCell / Total', 'INSTANCE', { component: 'Table.HeaderCell', variantProperties: { Sortable: 'True', Align: 'End' } }),
      layer('1204:3324', 'Row 1', 'INSTANCE', {
        component: 'Table.Row', variantProperties: { State: 'Default' }, bounds: [288, 268, 1096, 48],
        reactions: [{ trigger: { type: 'ON_HOVER' }, actions: [{ type: 'NODE', navigation: 'CHANGE_TO', destinationId: '1204:3431', transition: { type: 'SMART_ANIMATE', duration: 0.16, easing: { type: 'EASE_OUT' } } }] }],
      }),
      layer('1204:3325', 'Status badge', 'INSTANCE', { component: 'Badge', variantProperties: { Status: 'Success' } }),
      layer('1204:3326', 'Total', 'TEXT', { characters: '$1,240.00', style: { fontFeatureSettings: { tnum: true } } }),
      layer('1204:3340', 'Pagination', 'INSTANCE', { component: 'Pagination', variantProperties: { Position: 'Bottom' }, bounds: [288, 668, 1096, 32] }),
      layer('1204:3388', 'Orders / Empty', 'FRAME', { bounds: [0, 0, 1440, 900] }),
      layer('1204:3391', 'EmptyState', 'INSTANCE', { component: 'EmptyState', variantProperties: { Size: 'md' }, characters: 'No orders yet' }),
      layer('1204:3392', 'Create order', 'INSTANCE', { component: 'Button', variantProperties: { Variant: 'Primary', Size: 'md' } }),
      layer('1204:3402', 'Orders / Loading', 'FRAME', {
        bounds: [0, 0, 1440, 900],
        reactions: [{ trigger: { type: 'AFTER_TIMEOUT', timeout: 2 }, actions: [{ type: 'NODE', navigation: 'NAVIGATE', destinationId: '1204:3310', transition: { type: 'DISSOLVE', duration: 0.2, easing: { type: 'EASE_OUT' } } }] }],
      }),
      layer('1204:3405', 'Skeleton / Row', 'INSTANCE', { component: 'Skeleton', variantProperties: { Shape: 'Text' }, tokens: { radius: '--ads-radius-md', fill: '--ads-color-skeleton' } }),
      layer('1204:3417', 'Orders / Error', 'FRAME', { bounds: [0, 0, 1440, 900] }),
      layer('1204:3419', 'Alert', 'INSTANCE', { component: 'Alert', variantProperties: { Variant: 'Critical' }, characters: "Couldn't load orders" }),
      layer('1204:3420', 'Retry', 'INSTANCE', { component: 'Button', variantProperties: { Variant: 'Secondary', Size: 'sm' } }),
      layer('1204:3431', 'Orders / Row / State=Hover', 'COMPONENT', { component: 'Table.Row', variantProperties: { State: 'Hover' }, tokens: { fill: '--ads-color-surface-hover' } }),
      layer('1204:3440', 'Orders / Row / State=Focus', 'COMPONENT', { component: 'Table.Row', variantProperties: { State: 'Focus' }, tokens: { stroke: '--ads-color-focus-ring' }, strokeAlign: 'INSIDE', strokeWeight: 2 }),
      layer('1204:3452', 'Orders / Row / State=Selected', 'COMPONENT', { component: 'Table.Row', variantProperties: { State: 'Selected' }, tokens: { fill: '--ads-color-surface-selected' } }),
    ],
  };
}

function ticket() {
  return {
    provider: 'jira',
    key: 'ACME-482',
    url: 'https://acme.atlassian.net/browse/ACME-482',
    title: 'Orders list: table with empty, loading and error states',
    status: 'In review',
    links: { figma: `https://www.figma.com/design/${FIGMA_FILE}/Acme-Console?node-id=1204-3310`, pullRequest: 'https://github.com/acme/console/pull/1287' },
    acceptanceCriteria: [
      { id: 'AC-1', text: 'The Orders page lists orders in a table with order ID, customer, status, total and created date, newest first.' },
      { id: 'AC-2', text: "When there are no orders, show the empty state with a 'Create order' action." },
      { id: 'AC-3', text: 'When the request fails, show a retry button.' },
      { id: 'AC-4', text: 'While orders load, show skeleton rows; the skeleton must appear only after 300 ms.' },
    ],
    expectedBehaviors: [
      { acRef: 'AC-2', state: 'empty', trigger: 'GET /api/orders returns []', expected: "Empty state with a 'Create order' button" },
      { acRef: 'AC-3', state: 'error', trigger: 'GET /api/orders fails', expected: 'Error banner with a Retry button that re-requests orders' },
      { acRef: 'AC-4', state: 'loading', trigger: 'GET /api/orders is slow', expected: 'Skeleton appears only after 300 ms' },
    ],
  };
}

// What scripts/capture.mjs records: capture.json (one entry per state, with scroll) and
// computed/<state>.json { "<elementClass>": { selector, count, samples: [{ "<prop>": value, __rect, __visible }], inlineStyleOutliers } }.
const COMMIT = '9f3c2a1e7b4d8c06a5f2e19d3b7c4a8e0f6d2b51';
const CAPTURE_STATES = {
  'with-data': { driver: { fixture: 'fixtures/orders/with-data.json' }, settleMs: 250, durationMs: 2412 },
  loading: { driver: { mock: { urlPattern: '**/api/orders*', delayMs: 2000 }, wait: '[data-testid=orders-skeleton]' }, settleMs: 0, durationMs: 1873 },
  error: { driver: { mock: { urlPattern: '**/api/orders*', status: 500, body: '{"error":"internal"}', contentType: 'application/json' } }, settleMs: 250, durationMs: 2105 },
  hover: { driver: { action: 'hover', selector: '[data-testid=orders-table] tbody tr:nth-child(2)' }, settleMs: 250, durationMs: 2688 },
  focus: { driver: { action: 'keyboard', keys: 'Tab Tab Tab Tab Tab Tab' }, settleMs: 250, durationMs: 2540 },
};
// Step 2 (design backfill): the app has this state, the design does not. Captured app-only into evidence/backfill/.
const BACKFILL_STATES = {
  'bulk-selected': { driver: { action: 'click', selector: '[data-testid=orders-select-all]' }, settleMs: 250, durationMs: 2731 },
};
function backfillCapture() {
  const states = {};
  for (const [state, d] of Object.entries(BACKFILL_STATES)) {
    states[state] = {
      driver: d.driver, url: APP_URL, screenshot: `app/${state}.png`, computed: `computed/${state}.json`, dom: `dom/${state}.json`, motion: `motion/${state}.json`,
      settleMs: d.settleMs, durationMs: d.durationMs, scroll: { x: 0, y: 0 }, warnings: [],
    };
  }
  return {
    url: APP_URL, kind: 'preview', viewport: { width: W, height: H }, dpr: 1, fullPage: false, commit: COMMIT, branch: 'feat/orders-list',
    timestamp: '2026-09-22T14:29:41Z', states, degradations: [],
  };
}
function capture(apps) {
  const states = {};
  for (const [state, d] of Object.entries(CAPTURE_STATES)) {
    states[state] = {
      driver: d.driver, url: d.driver.fixture ? `${APP_URL}?fixture=${d.driver.fixture}` : APP_URL,
      screenshot: apps.includes(state) ? `app/${state}.png` : null, computed: `computed/${state}.json`, dom: `dom/${state}.json`, motion: `motion/${state}.json`,
      settleMs: d.settleMs, durationMs: d.durationMs, scroll: { x: 0, y: 0 }, warnings: [],
      // The orders page is exactly one 1440×900 screen: the full-page capture is the whole page, no panel hides content.
      ...(apps.includes(state) ? { fullPage: true, page: { width: W, height: H }, size: { width: W, height: H }, unrolled: [], clipped: [] } : {}),
    };
  }
  const reason = 'no runtime driver (needs a fixture, query, mock, storage, action or viewport)';
  states.selected = { driver: {}, url: null, screenshot: null, computed: null, dom: null, motion: null, settleMs: null, durationMs: 0, warnings: [`not captured: ${reason}`], skipped: true };
  return {
    url: APP_URL, kind: 'preview', viewport: { width: W, height: H }, dpr: 1, fullPage: true, commit: COMMIT, branch: 'feat/orders-list',
    timestamp: '2026-09-22T14:29:41Z', states,
    degradations: [{ step: 'capture:selected', reason, impact: 'State "selected" cannot be verified (CANNOT_VERIFY).' }],
  };
}

// Element boxes in screenshot pixels, from the same layout constants the app mock-ups are drawn with.
const AL = { x: CARD.x + VARIANTS.app.pad, y: CARD.y + VARIANTS.app.pad, w: CARD.w - 2 * VARIANTS.app.pad };
const box = (x, y, w, h) => ({ x: Math.floor(x), y: Math.floor(y), w: Math.ceil(w), h: Math.ceil(h) });
const rowBox = (i) => box(AL.x, AL.y + HEAD_H + i * ROW_H, AL.w, ROW_H);
const sample = (props, rect) => ({ ...props, __rect: rect, __visible: true });
const entry = (selector, count, samples, inlineStyleOutliers = 0) => ({ selector, count, samples, inlineStyleOutliers });
const measure = (s, o) => text(null, 0, 0, s, { ...o, measure: true });
const TITLE = entry('h1.page-title', 1, [sample({ 'font-size': '24px', 'font-weight': '500', 'line-height': '32px', color: 'rgb(17, 24, 39)' }, box(264, 78, measure('Orders', { size: 24, weight: 500 }), 32))]);
const card = (h) => entry('.orders-card', 1, [sample({ padding: '20px', 'border-radius': '8px', 'background-color': 'rgb(255, 255, 255)' }, box(CARD.x, CARD.y, CARD.w, h))]);
const HEADER = entry('[data-testid=orders-table] thead', 1, [sample({ 'font-size': '12px', 'font-weight': '700', 'text-transform': 'uppercase', color: 'rgb(17, 24, 39)', 'border-bottom': '2px solid rgb(209, 213, 219)' }, box(AL.x, AL.y, AL.w, HEAD_H))]);
const rows3 = (props) => [0, 1, 2].map((i) => sample(props, rowBox(i)));
const SKEL = { 'border-radius': '2px', 'background-color': 'rgb(209, 213, 219)', height: '12px' };
const COMPUTED = {
  'with-data': {
    'Page header': entry('header.page-header', 1, [sample({ display: 'flex', 'flex-direction': 'column', gap: '8px' }, box(264, 78, 1144, 58))]),
    'Page title': TITLE,
    'Search input': entry('[data-testid=orders-search] input', 1, [sample({ 'font-size': '14px', 'border-radius': '6px', color: 'rgb(17, 24, 39)' }, box(264, 152, 320, 36))]),
    Pagination: entry('[data-testid=orders-pagination]', 1, [sample({ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }, box(1060, 152, 196, 36))]),
    Card: card(2 * VARIANTS.app.pad + HEAD_H + APP_ROWS.length * ROW_H),
    'Table header': HEADER,
    'Updated header cell': entry('th[data-col=updated]', 1, [sample({ 'font-weight': '700', 'text-transform': 'uppercase' }, box(AL.x + 960, AL.y, 136, HEAD_H))]),
    'Table row': entry('.orders-row', APP_ROWS.length, rows3({ height: '48px', 'transition-property': 'background-color', 'transition-duration': '0.4s' })),
    'Status badge': entry('td.col-status .ads-badge', APP_ROWS.length, [sample({ 'background-color': 'rgb(220, 252, 231)', color: 'rgb(22, 101, 52)', 'border-radius': '11px' },
      box(AL.x + 466, AL.y + HEAD_H + 13, measure('Shipped', { size: 12, weight: 600 }) + 20, 22))]),
    'Total cell': entry('td.col-total', APP_ROWS.length, [0, 1, 2].map((i) => sample({ 'text-align': 'right', 'font-variant-numeric': 'tabular-nums' }, box(AL.x + 620, AL.y + HEAD_H + i * ROW_H, 150, ROW_H)))),
    'Table cell text': entry('tbody td', APP_ROWS.length * 6, [sample({ color: 'rgb(17, 24, 39)', 'font-size': '14px' }, box(AL.x, AL.y + HEAD_H, 150, ROW_H))]),
  },
  loading: {
    'Page title': TITLE, Card: card(2 * VARIANTS.app.pad + HEAD_H + 8 * ROW_H), 'Table header': HEADER,
    Skeleton: entry('[data-testid=orders-skeleton]', 1, [sample({ display: 'block' }, box(AL.x, AL.y + HEAD_H, AL.w, 8 * ROW_H))]),
    'Skeleton bar': entry('.orders-skeleton .ads-skeleton', 48, [sample(SKEL, box(AL.x + 16, AL.y + HEAD_H + 18, 84, 12)), sample(SKEL, box(AL.x + 166, AL.y + HEAD_H + 18, 168, 12)),
      sample({ ...SKEL, 'border-radius': '10px', height: '20px' }, box(AL.x + 466, AL.y + HEAD_H + 14, 72, 20))], 48),
  },
  error: {
    'Page title': TITLE,
    Alert: entry('[data-testid=orders-error]', 1, [sample({ 'background-color': 'rgb(254, 242, 242)', 'border-left': '4px solid rgb(220, 38, 38)', role: 'alert' }, box(AL.x, AL.y, AL.w, 72))]),
    'Retry button': entry('[data-testid=orders-error] button', 1, [sample({ 'font-size': '13px', 'font-weight': '600', 'border-radius': '6px' }, box(AL.x + AL.w - 100, AL.y + 20, 84, 32))]),
  },
  hover: {
    'Page title': TITLE, Card: card(2 * VARIANTS.app.pad + HEAD_H + APP_ROWS.length * ROW_H),
    'Table row (hover)': entry('.orders-row:hover', 1, [sample({ 'background-color': 'rgb(207, 216, 230)', 'transition-duration': '0.4s' }, rowBox(1))]),
    'Table row': entry('.orders-row', APP_ROWS.length, rows3({ 'transition-property': 'background-color', 'transition-duration': '0.4s', 'transition-timing-function': 'ease' })),
  },
  focus: {
    'Page title': TITLE,
    'Row focus ring': entry('.orders-row:focus-visible', 1, [sample({ outline: '2px solid rgb(37, 99, 235)', 'outline-offset': '-2px' }, rowBox(0))]),
  },
};
const BACKFILL_COMPUTED = {
  'bulk-selected': {
    'Page title': TITLE,
    'Bulk-action bar': entry('[data-testid=orders-bulk-bar]', 1, [sample({ 'background-color': 'rgb(17, 24, 39)', 'border-radius': '10px', position: 'fixed' }, box(400, 808, 640, 56))]),
    'Table row': entry('.orders-row', APP_ROWS.length, rows3({ 'background-color': 'rgb(238, 242, 255)' })),
  },
};
// Evidence crops come from these boxes (app side) and from the Figma layer bounds (design side).
const REGIONS = [
  { region: 'Page header', selector: 'header.page-header', text: 'Orders · Track and manage customer orders' },
  { region: 'Toolbar', selector: '[data-testid=orders-toolbar]', text: 'Search by order ID or customer · All statuses · 1–12 of 124 · New order' },
  { region: 'Table', selector: '[data-testid=orders-table]', text: 'ORDER · CUSTOMER · STATUS · TOTAL · CREATED · UPDATED' },
];
const DOM = {
  'with-data': { regions: REGIONS, table: { headerMarkup: '<thead class="orders-th"><tr><th>…', columns: ['Order', 'Customer', 'Status', 'Total', 'Created', 'Updated'], rows: 12, sortableHeaders: 0 } },
  loading: {
    regions: REGIONS.slice(0, 2).concat({ region: 'Skeleton', selector: '[data-testid=orders-skeleton]', text: '' }),
    table: { rows: 8, skeletonBars: 48 },
    timeline: [{ ms: 0, skeletonVisible: true }, { ms: 300, skeletonVisible: true }, { ms: 2010, skeletonVisible: false, rows: 12 }],
  },
  error: { regions: REGIONS.slice(0, 2).concat({ region: 'Error banner', selector: '[data-testid=orders-error]', role: 'alert', text: "Couldn't load orders · Retry" }), retry: { clicked: true, requestsAfterClick: ['GET /api/orders'] } },
  hover: { regions: REGIONS, target: '.orders-row:nth-child(2)', matches: [':hover'] },
  focus: { regions: REGIONS, activeElement: '.orders-row:nth-child(1) a.order-link', focusVisible: true },
};
// The empty state was driven on the deployed preview (orders mock []) but is not implemented, so there is no
// app/empty.png to compare: the DOM outline is the app-side evidence for DQ-001 (header over an empty body).
const EMPTY_DOM = {
  state: 'empty', root: '[data-testid=orders-page]',
  regions: REGIONS.slice(0, 2).concat({ region: 'Table', selector: '[data-testid=orders-table]', text: 'ORDER · CUSTOMER · STATUS · TOTAL · CREATED · UPDATED' }),
  table: { columns: ['Order', 'Customer', 'Status', 'Total', 'Created', 'Updated'], rows: 0 },
  emptyState: null,
};

// What capture.mjs records per state in motion/<state>.json: the computed transition / animation
// longhands of the grabbed elements and document.getAnimations() right after the state's action.
const NO_MOTION = { 'transition-property': 'none', 'transition-duration': '0s', 'transition-timing-function': 'ease', 'transition-delay': '0s', 'animation-name': 'none', 'animation-duration': '0s', 'animation-timing-function': 'ease', 'animation-delay': '0s', 'animation-iteration-count': '1' };
const mEntry = (selector, count, props) => ({ selector, count, samples: [{ ...NO_MOTION, ...props }] });
const ROW_MOTION = { 'transition-property': 'background-color', 'transition-duration': '0.4s', 'transition-timing-function': 'ease' };
const MOTION = {
  'with-data': { elements: { 'Table row': mEntry('.orders-row', APP_ROWS.length, ROW_MOTION) }, animations: [], keyframes: {} },
  loading: { elements: { Skeleton: mEntry('[data-testid=orders-skeleton]', 1, {}) }, animations: [], keyframes: {} },
  error: { elements: { Alert: mEntry('[data-testid=orders-error]', 1, {}) }, animations: [], keyframes: {} },
  hover: {
    elements: { 'Table row': mEntry('.orders-row', APP_ROWS.length, ROW_MOTION) },
    animations: [{ type: 'CSSTransition', target: '.orders-row:nth-child(2)', transitionProperty: 'background-color', durationMs: 400, delayMs: 0, easing: 'ease', iterations: 1 }],
    keyframes: {},
  },
  focus: { elements: { 'Row focus ring': mEntry('.orders-row:focus-visible', 1, {}) }, animations: [], keyframes: {} },
};
const BACKFILL_DOM = {
  'bulk-selected': { regions: REGIONS.concat({ region: 'Bulk-action bar', selector: '[data-testid=orders-bulk-bar]', text: '12 selected · Clear selection · Export · Cancel orders' }), table: { rows: 12, selectedRows: 12 } },
};
const BACKFILL_MOTION = {
  'bulk-selected': { elements: { 'Bulk-action bar': mEntry('[data-testid=orders-bulk-bar]', 1, {}) }, animations: [], keyframes: {} },
};

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// 6. Main
// ---------------------------------------------------------------------------
const FIGMA_STATES = ['with-data', 'empty', 'loading', 'error', 'hover', 'focus', 'selected'];
const APP_STATES = ['with-data', 'loading', 'error', 'hover', 'focus']; // no app/empty.png: not implemented

for (const dir of ['figma', 'app', 'diff', 'computed', 'dom', 'motion', 'backfill']) fs.rmSync(path.join(EV, dir), { recursive: true, force: true });

const images = { figma: {}, app: {} };
for (const s of FIGMA_STATES) savePng((images.figma[s] = drawScene('figma', s)).png, path.join(EV, 'figma', `${s}.png`));
for (const s of APP_STATES) savePng((images.app[s] = drawScene('app', s)).png, path.join(EV, 'app', `${s}.png`));

const diffs = {};
for (const s of FIGMA_STATES.filter((x) => APP_STATES.includes(x))) {
  const out = new PNG({ width: W, height: H });
  const n = pixelmatch(images.figma[s].png.data, images.app[s].png.data, out.data, W, H, DIFF_OPTS);
  savePng(out, path.join(EV, 'diff', `${s}.png`));
  diffs[s] = round2((n / (W * H)) * 100);
}

// Step 2 evidence: states the app has and the design lacks (app-only: no design side, no diff). The report's `backfill` block points here.
for (const s of Object.keys(BACKFILL_STATES)) {
  savePng(drawScene('app', s).png, path.join(EV, 'backfill', 'app', `${s}.png`));
  writeJson(path.join(EV, 'backfill', 'computed', `${s}.json`), BACKFILL_COMPUTED[s]);
  writeJson(path.join(EV, 'backfill', 'dom', `${s}.json`), { state: s, root: '[data-testid=orders-page]', ...BACKFILL_DOM[s] });
  writeJson(path.join(EV, 'backfill', 'motion', `${s}.json`), { state: s, ...BACKFILL_MOTION[s] });
}
writeJson(path.join(EV, 'backfill', 'capture.json'), backfillCapture());

writeJson(path.join(EV, 'figma-spec.json'), figmaSpec());
writeJson(path.join(EV, 'ticket.json'), ticket());
writeJson(path.join(EV, 'capture.json'), capture(APP_STATES));
for (const s of APP_STATES) {
  writeJson(path.join(EV, 'computed', `${s}.json`), COMPUTED[s]);
  writeJson(path.join(EV, 'dom', `${s}.json`), { state: s, root: '[data-testid=orders-page]', ...DOM[s] });
  writeJson(path.join(EV, 'motion', `${s}.json`), { state: s, ...MOTION[s] });
}
writeJson(path.join(EV, 'dom', 'empty.json'), EMPTY_DOM);

// What diff.mjs --json prints for the pairs (both sides 1440×900: nothing padded).
const band = (pct) => (pct < 1 ? 'pass' : pct <= 5 ? 'review' : 'fail');
writeJson(path.join(EV, 'diff.json'), {
  results: Object.fromEntries(Object.entries(diffs).map(([s, percent]) => [s, {
    state: s, a: `figma/${s}.png`, b: `app/${s}.png`, out: `evidence/diff/${s}.png`, width: W, height: H,
    designWidth: W, designHeight: H, appWidth: W, appHeight: H, padded: null, paddedRight: null,
    diffPixels: Math.round((percent / 100) * W * H), totalPixels: W * H, percent, band: band(percent),
  }])),
});

// The pass: walk every compared page region by region, then build the report from findings.json.
const SCRIPTS = path.resolve(HERE, '../../skills/design-qa/scripts');
const RUN_ID = JSON.parse(fs.readFileSync(path.join(HERE, '.design-qa-run.json'), 'utf8')).runId;
for (const [name, args] of [
  ['worklist.mjs', ['--dir', HERE, '--quiet']],
  ['build-report.mjs', ['--dir', HERE, '--out', REPORT_FILE, '--config', path.join(HERE, 'design-qa.config.json'), '--run', RUN_ID]],
]) {
  const res = spawnSync(process.execPath, [path.join(SCRIPTS, name), ...args], { encoding: 'utf8' });
  process.stdout.write(res.stdout);
  if (res.status !== 0) {
    process.stderr.write(res.stderr);
    throw new Error(`${name} exited ${res.status}`);
  }
}
