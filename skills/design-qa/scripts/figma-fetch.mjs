#!/usr/bin/env node
// Fetch a Figma frame over the REST API: figma-spec.json (flattened layers,
// components, styles, variables, discovered states) plus a PNG per state.
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { CliError, displayPath, ensureDir, parseCli, runMain, toNumber, usageError, writeJson } from './lib/args.mjs';
import { buildFigmaSpec, siblingFrames } from './lib/figma-spec.mjs';
import { figmaDesignUrl, normalizeNodeId, parseFigmaUrl } from './lib/figma-url.mjs';
import { describeUrl, fetchWithRetry, readJsonResponse } from './lib/http.mjs';
import { decodePng } from './lib/png.mjs';
import { discoverScreens } from './lib/screens.mjs';
import { normalizeStateName, stateFromName } from './lib/state-discovery.mjs';

const HELP = `Fetch a Figma frame (spec + PNG per designed state) over the REST API.

Usage:
  node scripts/figma-fetch.mjs --url <figma-url> --out <dir> [--node <id>]
      [--states auto|<id,id,…>] [--scale 1] [--format png]
  node scripts/figma-fetch.mjs --url <page-or-section-or-frame-url> --screens auto --out <dir>

Options:
  --url <link>       Figma design/file/proto link (node-id taken from the link)
  --node <id>        node to fetch instead of the link's node-id ("1:23" or "1-23")
  --states <mode>    auto (default): discover states from variant properties named
                     State/Status, frames named like a state (Empty, Loading, Error, …),
                     prototype reactions and annotations; or a comma-separated list of
                     node ids to export as extra states (named from their layer names)
  --screens auto     multi-screen: treat the node (a page, a section, or a frame and the
                     frames beside it on its page) as several screens. Frames whose names
                     differ only by a state segment ("Cart", "Cart – Empty") are one screen
                     with several states. Writes <out>/screens.json and, per screen,
                     <out>/screens/<id>/figma-spec.json + <out>/screens/<id>/figma/<state>.png
                     (capture each screen with --out <dir>/evidence/screens/<id>)
  --scale <n>        export scale (default 1 — keep 1 to diff against DPR-1 captures)
  --format <fmt>     png (default) | jpg | svg | pdf
  --out <dir>        output directory (required)
  --quiet            only print errors
  -h, --help         show this help

Environment:
  FIGMA_TOKEN        personal access token with the file_content:read scope
                     (file_variables:read is needed for variables; Enterprise plans only)
  FIGMA_API_BASE     API base URL (default https://api.figma.com)

Writes <out>/figma-spec.json and <out>/figma/<state>.<format>. The main frame is
exported as "with-data" unless its own name maps to another state. figma-spec.json keeps
every layer's prototype reactions (with their transitions) and lists them as CSS-comparable
specs under "motion" (trigger, type, durationMs, easing; springs are approximated).
Prototype links (figma.com/proto/…) work like design links: node-id, else the
starting-point-node-id, is the frame.
Retries HTTP 429/5xx up to 3 times with backoff (Retry-After is honoured).

Exit codes: 0 ok · 1 error (node not found, render/download failure) · 2 bad arguments ·
6 authentication (FIGMA_TOKEN missing or rejected)`;

const FORMATS = ['png', 'jpg', 'svg', 'pdf'];

function fileSafe(name) {
  return String(name).replace(/[^A-Za-z0-9._-]+/g, '-');
}

function makeApi(token, base, warn) {
  return async function api(pathAndQuery, label) {
    const url = `${base}${pathAndQuery}`;
    return fetchWithRetry(
      url,
      { headers: { 'X-Figma-Token': token, Accept: 'application/json' } },
      {
        label,
        onRetry: ({ status, attempt, waitMs }) => warn(`${label}: HTTP ${status}, retry ${attempt}/3 in ${Math.round(waitMs / 100) / 10}s`),
      },
    );
  };
}

/**
 * Export and download one image per item ({ state, nodeId, name, rel, file }) with a
 * single images call. Returns the export entries (also set as item.entry); failures
 * become degradations.
 */
async function exportImages({ api, fileKey, format, scale, warn }, items, degradations) {
  const ids = [...new Set(items.map((s) => s.nodeId))];
  if (!ids.length) return [];
  const imgRes = await api(`/v1/images/${fileKey}?ids=${encodeURIComponent(ids.join(','))}&format=${format}&scale=${scale}`, 'images');
  if (imgRes.status === 401 || imgRes.status === 403) throw new CliError(`Figma rejected FIGMA_TOKEN for image export (HTTP ${imgRes.status})`, 6);
  if (!imgRes.ok) throw new CliError(`Figma image export failed: HTTP ${imgRes.status}`, 1);
  const imgJson = await readJsonResponse(imgRes, 'images');
  if (imgJson.err) warn(`Figma image export: ${imgJson.err}`);
  const urls = imgJson.images || {};
  const entries = [];
  for (const s of items) {
    const imageUrl = urls[s.nodeId];
    if (!imageUrl) {
      degradations.push({ step: 'figma-export', reason: `Figma could not render node ${s.nodeId} (${s.name})`, impact: `No reference image for state "${s.state}".` });
      continue;
    }
    // Rendered images live on a CDN: never send the token there.
    const res = await fetchWithRetry(imageUrl, {}, { label: `download ${s.state}` });
    if (!res.ok) {
      degradations.push({ step: 'figma-export', reason: `download of ${s.state} failed (HTTP ${res.status})`, impact: `No reference image for state "${s.state}".` });
      continue;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    ensureDir(path.dirname(s.file));
    writeFileSync(s.file, buffer);
    const entry = { state: s.state, nodeId: s.nodeId, name: s.name, path: s.rel, width: null, height: null };
    if (format === 'png') {
      try {
        const png = decodePng(buffer, s.rel);
        entry.width = png.width;
        entry.height = png.height;
      } catch {
        warn(`${s.rel} is not a readable PNG`);
      }
    }
    entries.push(entry);
    s.entry = entry;
  }
  return entries;
}

/**
 * --screens auto: one figma-spec.json and one image per state for every screen of the
 * fetched page/section (or of the fetched frame's page), plus screens.json.
 */
async function fetchScreens({ spec, nodesJson, variables, outDir, exporter, log, warn, values, degradations }) {
  const { api, fileKey, format } = exporter;
  const screens = discoverScreens(spec);
  if (!screens.length) {
    throw new CliError(`no screens found under ${spec.name} (${spec.nodeId}): link a page, a section or a top-level frame`, 1);
  }
  // Nodes we know by id (for sibling frames handed to state discovery).
  const known = new Map([...spec.layers, ...spec.siblings].map((l) => [l.id, l]));
  const nodes = { ...(nodesJson.nodes || {}) };
  const missing = screens.map((s) => s.nodeId).filter((id) => !nodes[id]?.document);
  if (missing.length) {
    const res = await api(`/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(missing.join(','))}&geometry=paths`, 'screen nodes');
    if (res.status === 401 || res.status === 403) throw new CliError(`Figma rejected FIGMA_TOKEN for the screen nodes (HTTP ${res.status})`, 6);
    if (!res.ok) throw new CliError(`Figma screen nodes request failed: HTTP ${res.status}`, 1);
    Object.assign(nodes, (await readJsonResponse(res, 'screen nodes')).nodes || {});
  }
  const response = { ...nodesJson, nodes };
  const specs = [];
  const items = [];
  for (const screen of screens) {
    const screenDegradations = [];
    if (!nodes[screen.nodeId]?.document) {
      degradations.push({ step: 'figma-screens', reason: `screen ${screen.name} (${screen.nodeId}) was not returned by Figma`, impact: `Screen "${screen.id}" has no spec or reference images.` });
      continue;
    }
    const siblings = screen.states
      .filter((s) => s.nodeId !== screen.nodeId)
      .map((s) => ({ id: s.nodeId, name: s.name, type: known.get(s.nodeId)?.type ?? 'FRAME', absoluteBoundingBox: known.get(s.nodeId)?.absoluteBoundingBox ?? null }));
    const sSpec = buildFigmaSpec({ fileKey, nodeId: screen.nodeId, url: figmaDesignUrl(fileKey, screen.nodeId), response, variables, siblings, degradations: screenDegradations });
    // Frames grouped as this screen's states that state discovery did not name.
    for (const st of screen.states) {
      if (!sSpec.states.some((x) => x.state === st.state)) sSpec.states.push(st);
    }
    sSpec.screen = { id: screen.id, name: screen.name };
    const dir = path.join(outDir, 'screens', screen.id);
    for (const st of sSpec.states) {
      if (st.nodeId === screen.nodeId && sSpec.type === 'COMPONENT_SET') continue;
      const rel = `figma/${fileSafe(st.state)}.${format}`;
      items.push({ ...st, rel, file: path.join(dir, rel), screenId: screen.id });
    }
    specs.push({ screen, spec: sSpec, dir, degradations: screenDegradations });
  }
  const entries = await exportImages(exporter, items, degradations);
  for (const item of items) {
    if (item.entry) specs.find((x) => x.screen.id === item.screenId).spec.exports.push(item.entry);
  }

  const index = {
    fileKey,
    nodeId: spec.nodeId,
    url: values.url,
    name: spec.name,
    type: spec.type,
    fetchedAt: spec.fetchedAt,
    screens: specs.map(({ screen, spec: sSpec }) => ({
      id: screen.id,
      name: screen.name,
      nodeId: screen.nodeId,
      designRef: screen.nodeId,
      url: sSpec.url,
      frame: sSpec.frame.width ? sSpec.frame : screen.frame,
      states: sSpec.states.map((st) => st.state),
      spec: `screens/${screen.id}/figma-spec.json`,
      images: sSpec.exports.map((e) => `screens/${screen.id}/${e.path}`),
      motion: sSpec.motion.length,
    })),
    degradations,
  };
  for (const { spec: sSpec, dir, degradations: own } of specs) {
    sSpec.degradations = own;
    writeJson(path.join(dir, 'figma-spec.json'), sSpec);
  }
  spec.screens = index.screens.map((s) => s.id);
  spec.degradations = degradations;
  writeJson(path.join(outDir, 'figma-spec.json'), spec);
  writeJson(path.join(outDir, 'screens.json'), index);

  log(`Figma: ${spec.fileName ?? fileKey} › ${spec.name} (${spec.nodeId}) — ${index.screens.length} screen(s)`);
  for (const s of index.screens) {
    log(`  ${s.id}: ${s.name} (${s.nodeId}) ${s.frame.width}×${s.frame.height} — states ${s.states.join(', ') || 'none'}; capture with --width ${s.frame.width} --height ${s.frame.height} --out <dir>/evidence/screens/${s.id}`);
  }
  for (const d of degradations) warn(`${d.step}: ${d.reason} — ${d.impact}`);
  log(`Wrote ${displayPath(path.join(outDir, 'screens.json'))}`);
  if (items.length && !entries.length) throw new CliError('no Figma image could be exported (see warnings above)', 1);
  return 0;
}

async function main(argv) {
  const { values } = parseCli(argv, {
    url: { type: 'string' },
    node: { type: 'string' },
    states: { type: 'string' },
    screens: { type: 'string' },
    scale: { type: 'string' },
    format: { type: 'string' },
    out: { type: 'string' },
    quiet: { type: 'boolean' },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const log = values.quiet ? () => {} : (msg) => console.log(msg);
  const warn = (msg) => console.error(`warning: ${msg}`);

  if (!values.url) throw usageError('--url <figma-url> is required (see --help)');
  if (!values.out) throw usageError('--out <dir> is required');
  const link = parseFigmaUrl(values.url);
  if (!link) throw usageError(`--url is not a Figma design/file/proto link: ${values.url}`);
  const nodeId = values.node ? normalizeNodeId(values.node) : link.nodeId;
  if (values.node && !nodeId) throw usageError(`--node: not a Figma node id (expected 1:23 or 1-23, got "${values.node}")`);
  if (!nodeId) throw usageError('the link has no node-id; select the frame in Figma and copy its link, or pass --node 1:23');
  const scale = toNumber(values.scale ?? '1', 'scale', { min: 0.01, max: 4 });
  const format = (values.format ?? 'png').toLowerCase();
  if (!FORMATS.includes(format)) throw usageError(`--format must be one of ${FORMATS.join(', ')} (got "${values.format}")`);
  if (scale !== 1) warn(`--scale ${scale}: diff.mjs refuses to compare images at different scales; captures run at DPR 1`);
  if (values.screens !== undefined && values.screens !== 'auto') throw usageError(`--screens: only "auto" is supported (got "${values.screens}")`);
  const screensMode = values.screens === 'auto';
  if (screensMode && values.states !== undefined && values.states !== 'auto') {
    throw usageError('--screens auto discovers each screen\'s states; it cannot be combined with an explicit --states list');
  }
  const statesMode = values.states ?? 'auto';
  let explicitIds = null;
  if (statesMode !== 'auto') {
    explicitIds = statesMode.split(',').map((s) => s.trim()).filter(Boolean).map((id) => {
      const n = normalizeNodeId(id);
      if (!n) throw usageError(`--states: "${id}" is not a node id (use auto or a comma-separated list like 1:40,1:77)`);
      return n;
    });
  }

  const token = process.env.FIGMA_TOKEN;
  if (!token) {
    throw new CliError(
      'FIGMA_TOKEN is not set. Create a personal access token in Figma (Settings → Security → Personal access tokens) with the file_content:read scope and export FIGMA_TOKEN.',
      6,
    );
  }
  const base = (process.env.FIGMA_API_BASE || 'https://api.figma.com').replace(/\/+$/, '');
  const api = makeApi(token, base, warn);
  const fileKey = link.fileKey;
  const outDir = path.resolve(values.out);
  const degradations = [];

  // 1. The frame itself.
  const nodesRes = await api(`/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&geometry=paths`, 'nodes');
  if (nodesRes.status === 401 || nodesRes.status === 403) {
    throw new CliError(
      `Figma rejected FIGMA_TOKEN (HTTP ${nodesRes.status}) for file ${fileKey}. Use a personal access token with the file_content:read scope whose owner can open the file (expired tokens also fail).`,
      6,
    );
  }
  if (nodesRes.status === 404) throw new CliError(`Figma file ${fileKey} was not found (HTTP 404); check the link`, 1);
  if (!nodesRes.ok) throw new CliError(`Figma nodes request failed: HTTP ${nodesRes.status} from ${describeUrl(nodesRes.url)}`, 1);
  const nodesJson = await readJsonResponse(nodesRes, 'nodes');

  // 2. Variables (Enterprise + file_variables:read); optional.
  let variables = null;
  const varRes = await api(`/v1/files/${fileKey}/variables/local`, 'variables');
  if (varRes.ok) {
    const json = await readJsonResponse(varRes, 'variables');
    variables = json.meta ?? json;
  } else {
    degradations.push({
      step: 'figma-variables',
      reason: `GET variables/local returned HTTP ${varRes.status}`,
      impact: 'Variable names are unavailable; boundVariables keep raw ids, so token names come from styles or the token map.',
    });
  }

  // 3. Sibling frames on the same page (state frames placed next to the main frame); optional.
  let siblings = [];
  const fileRes = await api(`/v1/files/${fileKey}?depth=2`, 'file');
  if (fileRes.ok) {
    siblings = siblingFrames(await readJsonResponse(fileRes, 'file'), nodeId);
  } else {
    degradations.push({
      step: 'figma-siblings',
      reason: `GET file?depth=2 returned HTTP ${fileRes.status}`,
      impact: 'State frames placed next to the main frame were not discovered; pass --states with their node ids.',
    });
  }

  const spec = buildFigmaSpec({ fileKey, nodeId, url: values.url, response: nodesJson, variables, siblings, degradations });
  const exporter = { api, fileKey, format, scale, warn };

  if (screensMode) return fetchScreens({ spec, nodesJson, variables, outDir, exporter, log, warn, values, degradations });

  // 4. Explicit state nodes replace auto-discovery.
  if (explicitIds) {
    const extraIds = explicitIds.filter((id) => id !== nodeId);
    let named = {};
    if (extraIds.length) {
      const res = await api(`/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(extraIds.join(','))}&depth=1`, 'state nodes');
      if (!res.ok) throw new CliError(`Figma state nodes request failed: HTTP ${res.status}`, res.status === 401 || res.status === 403 ? 6 : 1);
      named = (await readJsonResponse(res, 'state nodes')).nodes || {};
    }
    const states = [];
    const used = new Set();
    const mainState = stateFromName(spec.name) || 'with-data';
    states.push({ state: mainState, nodeId, name: spec.name, source: 'frame-name' });
    used.add(mainState);
    for (const id of extraIds) {
      const doc = named[id]?.document;
      if (!doc) {
        degradations.push({ step: 'figma-states', reason: `node ${id} not found`, impact: 'That state has no Figma reference image.' });
        continue;
      }
      let state = normalizeStateName(doc.name) || fileSafe(id);
      for (let n = 2; used.has(state); n++) state = `${normalizeStateName(doc.name)}-${n}`;
      used.add(state);
      states.push({ state, nodeId: id, name: doc.name, source: 'frame-name' });
    }
    spec.states = states;
  }

  // 5. Export one image per state.
  const exportList = spec.states.filter((s) => !(s.nodeId === nodeId && spec.type === 'COMPONENT_SET'));
  const ids = [...new Set(exportList.map((s) => s.nodeId))];
  ensureDir(path.join(outDir, 'figma'));
  spec.exports.push(
    ...(await exportImages(
      exporter,
      exportList.map((s) => ({ ...s, rel: `figma/${fileSafe(s.state)}.${format}`, file: path.join(outDir, 'figma', `${fileSafe(s.state)}.${format}`) })),
      degradations,
    )),
  );
  spec.degradations = degradations;

  const specFile = path.join(outDir, 'figma-spec.json');
  writeJson(specFile, spec);

  const mainExport = spec.exports.find((e) => e.nodeId === nodeId);
  log(`Figma: ${spec.fileName ?? fileKey} › ${spec.name} (${nodeId}) — ${spec.frame.width}×${spec.frame.height} ${spec.type.toLowerCase()}, ${spec.layers.length} layers`);
  log(`States: ${spec.states.map((s) => `${s.state} (${s.source}: ${s.name})`).join(', ') || 'none found'}`);
  if (spec.motion.length) log(`Motion: ${spec.motion.map((m) => `${m.trigger} ${m.type} ${m.durationMs ?? '?'}ms ${m.easing ?? ''}`.trim()).join(', ')}`);
  if (spec.exports.length) log(`Images: ${spec.exports.map((e) => `${e.path}${e.width ? ` ${e.width}×${e.height}` : ''}`).join(', ')}`);
  if (mainExport?.width && (mainExport.width !== Math.round(spec.frame.width * scale) || mainExport.height !== Math.round(spec.frame.height * scale))) {
    warn(`the export is ${mainExport.width}×${mainExport.height} but the frame is ${spec.frame.width}×${spec.frame.height} (effects or clipping); capture at the export size or crop before diffing`);
  }
  if (mainExport?.width && scale === 1) log(`Capture with: --width ${mainExport.width} --height ${mainExport.height}`);
  for (const d of degradations) warn(`${d.step}: ${d.reason} — ${d.impact}`);
  log(`Wrote ${displayPath(specFile)}`);
  if (ids.length && !spec.exports.length) {
    throw new CliError('no Figma image could be exported (see warnings above)', 1);
  }
  return 0;
}

runMain(import.meta.url, main);
