// Fixture report folders for build-report tests: the evidence a pass leaves behind
// (state-matrix.json, figma-spec.json, capture.json with the whole-page facts, grabs,
// diff.json, PNGs), written into a temp folder. Not a test file (the npm test glob is
// tests/*.test.mjs). Generic names only (Acme, ABC-123).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createPng, writePng } from '../../../skills/design-qa/scripts/lib/png.mjs';

export const W = 1440;
export const TALL = 2000;
export const SHORT = 900;
export const LOCAL_COMMIT = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
/** The run that owns every fixture folder (its lock is written unless lock: false). */
export const RUN_ID = '20261004T100000Z-abc123';

const json = (file, data) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};
const png = (file, w, h) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writePng(file, createPng(w, h, [250, 250, 250, 255]));
};

const sample = (rect, el, extra = {}) => ({ ...extra, __rect: rect, __visible: rect.w > 0 && rect.h > 0, __el: { tag: 'div', id: null, classes: [], component: null, variant: null, testid: null, role: null, text: '', selector: 'div', ...el }, __vars: {} });

/** The grabs of the with-data state: a title, three rows (one far below the fold), a status badge, a hidden element. */
export function grabs() {
  return {
    title: { selector: 'h1', count: 1, samples: [sample({ x: 120, y: 96, w: 400, h: 36 }, { tag: 'h1', text: 'Orders', selector: 'h1' }, { 'font-size': '28px', 'font-weight': '600' })] },
    row: {
      selector: '[data-testid=order-row]',
      count: 3,
      samples: [
        sample({ x: 120, y: 300, w: 1200, h: 48 }, { testid: 'order-row', classes: ['row'], selector: 'div.row' }),
        sample({ x: 120, y: 348, w: 1200, h: 48 }, { testid: 'order-row', classes: ['row'], selector: 'div.row' }),
        sample({ x: 120, y: 1500, w: 1200, h: 48 }, { testid: 'order-row', classes: ['row'], selector: 'div.row' }),
      ],
    },
    badge: { selector: '[data-testid=status-badge]', count: 1, samples: [sample({ x: 1300, y: 1700, w: 66, h: 23 }, { tag: 'span', testid: 'status-badge', classes: ['pill', 'pill-green'], selector: 'span.pill.pill-green' }, { 'border-radius': '999px' })] },
    footer: { selector: 'footer', count: 1, samples: [sample({ x: 0, y: 1900, w: W + 300, h: 100 }, { tag: 'footer', selector: 'footer' })] },
    ghost: { selector: '[data-testid=ghost]', count: 1, samples: [sample({ x: 0, y: 0, w: 0, h: 0 }, { testid: 'ghost' })] },
    missing: { selector: '[data-testid=nothing]', count: 0, samples: [] },
    rootTokens: { '--acme-radius-md': '6px' },
  };
}

function dom() {
  return { url: 'http://localhost:5173/orders', title: 'Acme · Orders', elements: [{ role: 'heading', name: 'Orders', text: 'Orders', visible: true, level: 1 }], texts: ['Orders'] };
}

/** One capture folder's states: with-data (tall, whole page) and empty (one screen). */
function captureFolder(base, { url, failures = {}, clipped = false, partial = false, top = null }) {
  const states = {};
  const entry = (state, h, { clip = [] } = {}) => {
    const imageH = partial && state === 'with-data' ? SHORT : h;
    png(path.join(base, 'app', `${state}.png`), W, imageH);
    json(path.join(base, 'computed', `${state}.json`), state === 'with-data' ? grabs() : { title: grabs().title, rootTokens: {} });
    json(path.join(base, 'dom', `${state}.json`), dom());
    json(path.join(base, 'motion', `${state}.json`), { state, side: 'app', elements: {}, animations: [] });
    return {
      driver: state === 'with-data' ? {} : { query: '?empty=1' },
      url: state === 'with-data' ? url : `${url}?empty=1`,
      frame: { width: W, height: h },
      viewport: { width: W, height: Math.min(h, 1440) },
      fullPage: !partial,
      page: { width: W, height: h },
      size: { width: W, height: imageH },
      unrolled: [],
      clipped: clip,
      screenshot: `app/${state}.png`,
      computed: `computed/${state}.json`,
      dom: `dom/${state}.json`,
      motion: `motion/${state}.json`,
      settleMs: 250,
      durationMs: 900,
      scroll: { x: 0, y: 0 },
      signedIn: null,
      warnings: [],
      degradations: [],
    };
  };
  for (const [state, h] of [['with-data', TALL], ['empty', SHORT]]) {
    if (failures[state]) {
      states[state] = { driver: {}, url, screenshot: null, computed: null, dom: null, motion: null, settleMs: 250, durationMs: 0, warnings: [], error: failures[state].detail, failure: failures[state] };
    } else {
      states[state] = entry(state, h, { clip: clipped && state === 'with-data' ? [{ selector: 'div.side-panel', axis: 'y', hiddenPx: 640, rect: { x: 1100, y: 200, w: 340, h: 600 } }] : [] });
    }
  }
  json(path.join(base, 'capture.json'), {
    side: 'app', url, kind: url.startsWith('http://localhost') ? 'local' : 'staging', frame: { width: W, height: TALL }, viewport: { width: W, height: 1440 }, dpr: 1,
    fullPage: !partial, viewportOnly: partial, maxViewportHeight: null, preCapture: null, signInChecks: {}, commit: LOCAL_COMMIT, branch: 'main',
    timestamp: '2026-10-04T10:00:00.000Z', failure: top, states, degradations: [],
  });
  // Pixel diffs for the captured states (diff.mjs --json output saved as diff.json).
  const results = {};
  for (const [state, h] of [['with-data', TALL], ['empty', SHORT]]) {
    if (failures[state]) continue;
    const appH = partial && state === 'with-data' ? SHORT : h;
    png(path.join(base, 'diff', `${state}.png`), W, Math.max(h, appH));
    results[state] = {
      state, width: W, height: Math.max(h, appH), designWidth: W, appWidth: W, designHeight: h, appHeight: appH,
      padded: appH < h ? { side: 'app', rows: h - appH } : null, paddedRight: null,
      percent: state === 'with-data' ? 3.2 : 0.2, band: state === 'with-data' ? 'review' : 'pass', pixelBand: state === 'with-data' ? 'review' : 'pass',
      structuralPercent: 0, structuralBand: 'pass', structuralRegions: [], maskedPercent: 0, out: path.join(base, 'diff', `${state}.png`),
    };
  }
  json(path.join(base, 'diff.json'), { results, worst: null });
}

function figmaSpec(nodeId, name) {
  return {
    fileKey: 'AbCdEf123456', nodeId, url: `https://www.figma.com/design/AbCdEf123456/Orders?node-id=${nodeId.replace(':', '-')}`, name,
    frame: { width: W, height: TALL },
    layers: [
      { id: nodeId, name, type: 'FRAME', absoluteBoundingBox: { x: 100, y: 200, width: W, height: TALL } },
      { id: '1:10', name: 'Title', type: 'TEXT', absoluteBoundingBox: { x: 220, y: 296, width: 400, height: 36 } },
    ],
    exports: [],
  };
}

function matrixRows(screen = null) {
  const id = (s) => (screen ? `${screen}/${s}` : s);
  const sc = screen ? { screen } : {};
  return [
    { state: id('with-data'), ...sc, label: 'With data', designed: { nodeId: '1:2', name: 'Orders – With data', frame: { width: W, height: TALL } }, specified: { acRef: 'AC-1', text: 'Orders are listed.' }, implemented: { driver: 'fixture', detail: 'fixture rich-orders' }, captured: null, result: 'CANNOT_VERIFY', note: 'pending capture', findings: [] },
    { state: id('empty'), ...sc, label: 'Empty', designed: { nodeId: '1:3', name: 'Orders – Empty', frame: { width: W, height: SHORT } }, specified: null, implemented: { driver: 'query', detail: 'query ?empty=1' }, captured: null, result: 'CANNOT_VERIFY', note: 'pending capture', findings: [] },
    { state: id('error'), ...sc, label: 'Error', designed: { nodeId: '1:4', name: 'Orders – Error', frame: { width: W, height: SHORT } }, specified: null, implemented: null, captured: null, result: 'MISSING_IN_CODE', note: 'Designed, no branch in code.', findings: [] },
  ];
}

const KNOWN_DRIFTS = `# Known drifts — Acme DS

## Entries

### KD-1 — Page title weight is 600; Figma shows 700

- **Scope**: the page title (h1) on list pages.
- **Design**: 28px / 36px, weight 700.
- **Code**: 28px / 36px, weight 600.
- **Why accepted**: the variable font renders 700 too heavy on Windows.
- **Signed off**: Dana Lee (Design lead), 2026-05-02.
- **Status**: active.

### KD-2 — Card shadow uses one layer

- **Scope**: shadow on cards.
- **Design**: two stacked drop shadows.
- **Code**: one shadow.
- **Status**: retired 2026-06-01.
`;

/**
 * A report folder under <root>/qa-reports/<slug>/ plus <root>/design-qa.config.json and the
 * known-drifts file. Options: multi (two screens: orders, details), url (the app URL;
 * remote when not localhost), failures ({ state: failure }), top (capture.json failure),
 * clipped, partial (with-data captured viewport-only), audit (ds-audit.json candidates),
 * compare (compare.json states), backfill (backfill-candidates.json), worklist (worklist.json items;
 * false: no worklist.json), lock (false: no run lock).
 */
export function makePass(root, opts = {}) {
  const slug = opts.slug ?? 'abc-123';
  const dir = path.join(root, 'qa-reports', slug);
  const url = opts.url ?? 'http://localhost:5173/orders';
  mkdirSync(dir, { recursive: true });
  json(path.join(root, 'design-qa.config.json'), {
    app: { baseUrl: 'http://localhost:5173' },
    surfaces: { orders: { route: '/orders', screens: opts.multi ? { orders: { route: '/orders' }, details: { route: '/orders/1' } } : undefined } },
    designSystem: { name: 'Acme DS', knownDrifts: 'design-qa/known-drifts.md' },
    report: { topN: 5 },
  });
  mkdirSync(path.join(root, 'design-qa'), { recursive: true });
  writeFileSync(path.join(root, 'design-qa', 'known-drifts.md'), KNOWN_DRIFTS);
  json(path.join(dir, 'evidence', 'ticket.json'), { provider: 'jira', key: 'ABC-123', url: 'https://acme.atlassian.net/browse/ABC-123', title: 'Orders list', acceptanceCriteria: [] });
  if (opts.multi) {
    const screens = ['orders', 'details'];
    json(path.join(dir, 'state-matrix.json'), screens.flatMap((s) => matrixRows(s)));
    json(path.join(dir, 'evidence', 'figma-spec.json'), { ...figmaSpec('1:1', 'Orders flow'), screens });
    json(path.join(dir, 'evidence', 'screens.json'), {
      fileKey: 'AbCdEf123456', nodeId: '1:1', url: 'https://www.figma.com/design/AbCdEf123456/Orders?node-id=1-1', name: 'Orders flow', type: 'SECTION',
      screens: [
        { id: 'orders', name: 'Orders', nodeId: '1:2', designRef: '1:2', frame: { width: W, height: TALL }, states: ['with-data', 'empty', 'error'], spec: 'screens/orders/figma-spec.json' },
        { id: 'details', name: 'Order details', nodeId: '2:2', designRef: '2:2', frame: { width: W, height: TALL }, variantOf: 'orders', states: ['with-data', 'empty', 'error'], spec: 'screens/details/figma-spec.json' },
      ],
      degradations: [],
    });
    for (const s of screens) {
      const base = path.join(dir, 'evidence', 'screens', s);
      json(path.join(base, 'figma-spec.json'), figmaSpec(s === 'orders' ? '1:2' : '2:2', s));
      png(path.join(base, 'figma', 'with-data.png'), W, TALL);
      png(path.join(base, 'figma', 'empty.png'), W, SHORT);
      captureFolder(base, { url: `${url}${s === 'details' ? '/1' : ''}`, failures: opts.failures ?? {}, clipped: opts.clipped, partial: opts.partial, top: opts.top ?? null });
    }
  } else {
    json(path.join(dir, 'state-matrix.json'), matrixRows());
    json(path.join(dir, 'evidence', 'figma-spec.json'), figmaSpec('1:2', 'Orders – With data'));
    png(path.join(dir, 'evidence', 'figma', 'with-data.png'), W, TALL);
    png(path.join(dir, 'evidence', 'figma', 'empty.png'), W, SHORT);
    png(path.join(dir, 'evidence', 'figma', 'error.png'), W, SHORT);
    captureFolder(path.join(dir, 'evidence'), { url, failures: opts.failures ?? {}, clipped: opts.clipped, partial: opts.partial, top: opts.top ?? null });
    if (opts.audit) {
      json(path.join(dir, 'evidence', 'audit', 'with-data.json'), {
        version: 1, fullPage: true, elements: [
          { i: 0, p: -1, d: 3, path: 'main > section.orders > span[data-testid="status-badge"]', tag: 'span', id: null, cls: ['pill', 'pill-green'], role: null, attrs: { 'data-testid': 'status-badge' }, rect: { x: 1300, y: 1700, w: 66, h: 23 }, vis: { x: 1300, y: 1700, w: 66, h: 23 }, s: {} },
          { i: 1, p: -1, d: 3, path: 'main > section.orders > button.export', tag: 'button', id: null, cls: ['export'], role: null, attrs: {}, rect: { x: 1200, y: 120, w: 120, h: 36 }, vis: { x: 1200, y: 120, w: 120, h: 36 }, s: {} },
        ],
      });
    }
  }
  if (opts.audit) {
    json(path.join(dir, 'evidence', 'ds-audit.json'), {
      generatedAt: '2026-10-04T10:05:00.000Z',
      tool: 'ds-audit',
      summary: { elementsChecked: 1480, offTokenValues: 2, nonSystemComponents: 1, output: 'evidence/ds-audit.json', states: 1, candidates: opts.audit.length },
      candidates: opts.audit,
    });
  }
  if (opts.worklist !== false) {
    // The worklist compared every captured state (coverage: compared true), with these items.
    const captured = (opts.multi ? ['orders', 'details'] : [null]).flatMap((sc) => ['with-data', 'empty'].filter((st) => !(opts.failures ?? {})[st]).map((st) => (sc ? `${sc}/${st}` : st)));
    const coverage = Object.fromEntries(captured.map((st) => [st, { state: st, compared: true, reason: null, identical: false, unlistedItems: 0, unlistedPercentOfPage: 0 }]));
    json(path.join(dir, 'evidence', 'worklist.json'), { generatedAt: '2026-10-04T10:07:00.000Z', caps: { items: 40 }, coverage, items: Array.isArray(opts.worklist) ? opts.worklist : [], unlisted: [] });
  }
  if (opts.lock !== false) json(path.join(dir, '.design-qa-run.json'), { kind: 'design-qa-run', version: 1, runId: RUN_ID, label: null, status: 'active', startedAt: '2026-10-04T10:00:00.000Z' });
  if (opts.compare) json(path.join(dir, 'evidence', 'compare.json'), { generatedAt: '2026-10-04T10:06:00.000Z', options: {}, states: opts.compare, figmaMotion: [], missingInApp: [], summary: {} });
  if (opts.backfill) json(path.join(dir, 'backfill-candidates.json'), { generatedAt: '2026-10-04T10:00:00Z', surface: 'orders', candidates: opts.backfill });
  return { root, dir, config: path.join(root, 'design-qa.config.json'), findingsFile: path.join(dir, 'findings.json') };
}

/** An audit candidate as ds-audit.mjs writes it (a finding without id and rank, pinned, with a key). */
export function auditCandidate(key, overrides = {}) {
  return {
    key,
    title: 'Status badge radius is a hardcoded 999px, not --acme-radius-md',
    ledger: 'style',
    severity: 'WARNING',
    resolution: 'FIX_CODE',
    region: 'Orders table',
    element: { selector: 'main > section.orders > span[data-testid="status-badge"]', figmaLayerPath: null, figmaNodeId: null },
    property: 'border-radius',
    expected: { value: '6px', token: '--acme-radius-md', source: 'design-rules' },
    actual: { value: '999px', token: null, source: { file: null, line: null, snippet: null } },
    delta: '+993px',
    tolerance: '1px',
    fix: { summary: 'Use --acme-radius-md', patchHint: 'border-radius: var(--acme-radius-md)', files: [], effort: 2 },
    state: 'with-data',
    evidence: [{ type: 'screenshot', path: 'evidence/app/with-data.png', crop: { x: 1300, y: 1700, w: 66, h: 23 }, state: 'with-data' }],
    signoff: null,
    knownDrift: null,
    acRef: null,
    _audit: { kind: 'off-token', count: 3 },
    ...overrides,
  };
}

/** A worklist item as scripts/worklist.mjs writes it (crop in the state's capture pixels, already clipped). */
export function worklistItem(key, overrides = {}) {
  return {
    key, screen: null, state: 'with-data', alsoIn: [], kind: 'region',
    rect: { x: 100, y: 1480, w: 1240, h: 90 }, crop: { x: 100, y: 1480, w: 1240, h: 90 }, image: 'evidence/app/with-data.png',
    percentOfPage: 3.9, design: [{ text: 'Order #1042' }], app: [{ text: 'Order #1042' }], hints: [{ kind: 'size', text: 'rows are 4 px shorter' }],
    ...overrides,
  };
}

/** A pinned style finding on the page title (selector pin). */
export function titleFinding(overrides = {}) {
  return {
    ref: 'title-size',
    title: 'Page title is 28px instead of heading/lg (32px)',
    ledger: 'style',
    state: 'with-data',
    severity: 'WARNING',
    region: 'Header',
    property: 'font-size',
    expected: { value: '32px', token: 'heading/lg' },
    actual: { value: '28px', token: null, source: { file: 'src/orders/OrdersPage.tsx', line: 12 } },
    fix: { summary: 'Use the heading/lg text style on the page title' },
    pin: { selector: 'h1' },
    ...overrides,
  };
}
