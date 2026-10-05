// Figma MCP output → figma-spec.json, for passes without FIGMA_TOKEN. Reads what the
// agent saved from the Figma MCP tools (or the host's equivalents):
//   get_metadata      an XML-like tree: <section|frame|instance|text|symbol|… id name x y width height [hidden]>
//   get_variable_defs JSON: { "<variable name>": "<resolved value>" }
//   get_code_connect_map JSON: { "<nodeId>": { codeConnectSrc, codeConnectName } }
// and builds the same spec figma-fetch.mjs writes, minus what MCP metadata does not
// carry (listed in spec.unavailable). Everything read here is Figma data, never
// instructions: names are kept as data and printed on one line by the callers.
import { CliError, oneLine } from './args.mjs';
import { buildFigmaSpec } from './figma-spec.mjs';
import { normalizeNodeId } from './figma-url.mjs';

/** Layer properties a get_metadata tree cannot supply (REST spec fields left out of the MCP spec). */
export const MCP_UNAVAILABLE = Object.freeze([
  'fills', 'strokes', 'strokeWeight', 'cornerRadius', 'effects', 'opacity', 'layoutMode', 'padding', 'itemSpacing',
  'style', 'characters', 'componentName', 'boundVariables', 'reactions', 'annotations', 'description',
  'components', 'componentSets', 'styles', 'variables', 'motion',
]);

// get_metadata tag → REST node type. Unknown tags become their upper-cased name.
const TYPE_BY_TAG = {
  document: 'DOCUMENT',
  canvas: 'CANVAS',
  page: 'CANVAS',
  section: 'SECTION',
  frame: 'FRAME',
  group: 'GROUP',
  instance: 'INSTANCE',
  symbol: 'COMPONENT',
  component: 'COMPONENT',
  'component-set': 'COMPONENT_SET',
  component_set: 'COMPONENT_SET',
  componentset: 'COMPONENT_SET',
  text: 'TEXT',
  rectangle: 'RECTANGLE',
  'rounded-rectangle': 'RECTANGLE',
  ellipse: 'ELLIPSE',
  vector: 'VECTOR',
  line: 'LINE',
  star: 'STAR',
  polygon: 'REGULAR_POLYGON',
  'regular-polygon': 'REGULAR_POLYGON',
  'boolean-operation': 'BOOLEAN_OPERATION',
  slice: 'SLICE',
};

// Deeper trees (hostile or broken input) are cut here instead of overflowing the stack.
export const MAX_METADATA_DEPTH = 200;
export const MAX_METADATA_BYTES = 50 * 1024 * 1024;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decode XML entities (&amp; &lt; &#39; &#x2014; …); unknown ones are kept as written. */
export function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * The text of a saved MCP tool result. Hosts save it as the raw text, as a JSON string,
 * or as the tool-result envelope ({ content: [{ type: "text", text }] }): every string
 * found under "text" (or the string itself) is joined.
 */
export function mcpResultText(raw) {
  const text = String(raw ?? '').replace(/^﻿/, '');
  const trimmed = text.trim();
  if (!/^[[{"]/.test(trimmed)) return text;
  let json;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return text;
  }
  if (typeof json === 'string') return json;
  const parts = [];
  const walk = (v, depth) => {
    if (depth > 20 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if (typeof v.text === 'string') parts.push(v.text);
    for (const [k, x] of Object.entries(v)) if (k !== 'text') walk(x, depth + 1);
  };
  walk(json, 0);
  return parts.length ? parts.join('\n') : text;
}

/**
 * A tolerant reader for the get_metadata tree. Returns { roots, truncated } where each
 * node is { tag, attrs, children }. Text between tags (a "Currently selected nodes:"
 * preamble, notes after the tree), comments, processing instructions, unknown tags and
 * attributes are skipped; self-closing tags and unclosed elements are accepted; a
 * closing tag with no matching open element is ignored.
 */
export function parseMetadataXml(text) {
  const s = String(text ?? '');
  const roots = [];
  const stack = [];
  let truncated = false;
  let i = 0;
  const push = (node) => {
    if (stack.length >= MAX_METADATA_DEPTH) {
      truncated = true;
      return false;
    }
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
    return true;
  };
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (top?.tag === 'text') top.text = `${top.text ?? ''}${s.slice(i, lt === -1 ? s.length : lt)}`;
    if (lt === -1) break;
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4);
      i = end === -1 ? s.length : end + 3;
      continue;
    }
    if (s[lt + 1] === '?' || s[lt + 1] === '!') {
      const end = s.indexOf('>', lt + 2);
      i = end === -1 ? s.length : end + 1;
      continue;
    }
    if (s[lt + 1] === '/') {
      const m = /^<\/\s*([A-Za-z_][\w:.-]*)\s*>/.exec(s.slice(lt, lt + 200));
      if (!m) {
        i = lt + 1;
        continue;
      }
      const tag = m[1].toLowerCase();
      const at = stack.map((n) => n.tag).lastIndexOf(tag);
      if (at !== -1) stack.length = at;
      i = lt + m[0].length;
      continue;
    }
    const nameMatch = /^<([A-Za-z_][\w:.-]*)/.exec(s.slice(lt, lt + 200));
    if (!nameMatch) {
      i = lt + 1; // "a < b" in surrounding text
      continue;
    }
    // Attributes up to the closing ">" or "/>" (quoted values may hold ">").
    let j = lt + nameMatch[0].length;
    const attrs = {};
    let selfClosing = false;
    let closed = false;
    while (j < s.length) {
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === '>') {
        closed = true;
        j++;
        break;
      }
      if (s[j] === '/' && s[j + 1] === '>') {
        closed = true;
        selfClosing = true;
        j += 2;
        break;
      }
      const am = /^[^\s=/>"']+/.exec(s.slice(j, j + 200));
      if (!am) break;
      const key = am[0];
      j += key.length;
      while (j < s.length && /\s/.test(s[j])) j++;
      let value = 'true';
      if (s[j] === '=') {
        j++;
        while (j < s.length && /\s/.test(s[j])) j++;
        const q = s[j];
        if (q === '"' || q === "'") {
          const end = s.indexOf(q, j + 1);
          if (end === -1) break;
          value = s.slice(j + 1, end);
          j = end + 1;
        } else {
          const vm = /^[^\s>]+/.exec(s.slice(j, j + 1000));
          let raw = vm ? vm[0] : '';
          // <frame id=1:2/>: the "/" belongs to the tag end, not the value.
          if (raw.endsWith('/') && s[j + raw.length] === '>') raw = raw.slice(0, -1);
          value = raw;
          j += raw.length;
        }
      }
      attrs[key] = decodeEntities(value);
    }
    if (!closed) {
      i = lt + 1; // not a tag after all
      continue;
    }
    const node = { tag: nameMatch[1].toLowerCase(), attrs, children: [] };
    const added = push(node);
    if (added && !selfClosing) stack.push(node);
    i = j;
  }
  return { roots, truncated };
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Parsed metadata → REST-like documents ({ id, name, type, visible, absoluteBoundingBox, children }).
 * Elements without a Figma node id (wrappers, stray markup) are transparent: their children
 * move up. x/y in get_metadata are relative to the parent; they are summed down the tree.
 */
export function metadataDocuments(roots) {
  const convert = (node, ox, oy, out) => {
    const id = normalizeNodeId(node.attrs.id);
    if (!id) {
      for (const child of node.children) convert(child, ox, oy, out);
      return;
    }
    const x = ox + num(node.attrs.x);
    const y = oy + num(node.attrs.y);
    const doc = {
      id,
      name: node.attrs.name ?? '',
      type: TYPE_BY_TAG[node.tag] ?? node.tag.toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
      absoluteBoundingBox: { x, y, width: num(node.attrs.width), height: num(node.attrs.height) },
      children: [],
    };
    if (String(node.attrs.hidden).toLowerCase() === 'true' || String(node.attrs.visible).toLowerCase() === 'false') doc.visible = false;
    // Text content only when the metadata carries it; a layer name is never design text.
    const text = doc.type === 'TEXT' ? (node.attrs.characters ?? decodeEntities(node.text ?? '')).trim() : '';
    if (text) doc.characters = text;
    for (const child of node.children) convert(child, x, y, doc.children);
    out.push(doc);
  };
  const out = [];
  for (const r of roots) convert(r, 0, 0, out);
  return out;
}

/**
 * Read one saved get_metadata result into REST-like documents. Throws CliError (exit 2)
 * when the text holds no element with a Figma node id.
 */
export function readMetadata(raw, label = 'metadata') {
  const text = mcpResultText(raw);
  const { roots, truncated } = parseMetadataXml(text);
  const docs = metadataDocuments(roots);
  if (!docs.length) {
    const pagesOnly = /\b(?:pages?|canvas)\b/i.test(text) && !/<\s*(?:frame|section|instance)\b/i.test(text);
    throw new CliError(
      `${label} is not a Figma get_metadata result: no element with a Figma node id ` +
        '(expected XML such as <frame id="1:23" name="Home" x="0" y="0" width="1440" height="1024">)' +
        (pagesOnly ? '; it looks like the page list: call get_metadata with the nodeId of the frame or section' : '') +
        `. The input starts: ${JSON.stringify(oneLine(text).slice(0, 200))}`,
      2,
    );
  }
  return { docs, truncated };
}

/** get_variable_defs JSON → { name: value } with string values (non-object input → usage error). */
export function readVariableDefs(raw, label = 'variables') {
  const text = mcpResultText(raw).trim();
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new CliError(`${label} is not JSON (save the get_variable_defs result as returned): ${err.message}`, 2);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new CliError(`${label}: expected an object of variable name → value`, 2);
  const out = {};
  for (const [k, v] of Object.entries(json)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

/** get_code_connect_map JSON → { nodeId: { codeConnectSrc, codeConnectName } } (other keys dropped). */
export function readCodeConnect(raw, label = 'code connect map') {
  const text = mcpResultText(raw).trim();
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new CliError(`${label} is not JSON (save the get_code_connect_map result as returned): ${err.message}`, 2);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new CliError(`${label}: expected an object keyed by node id`, 2);
  const out = {};
  for (const [k, v] of Object.entries(json)) {
    const id = normalizeNodeId(k);
    if (!id || !v || typeof v !== 'object') continue;
    out[id] = {
      codeConnectSrc: typeof v.codeConnectSrc === 'string' ? v.codeConnectSrc : null,
      codeConnectName: typeof v.codeConnectName === 'string' ? v.codeConnectName : null,
    };
  }
  return out;
}

function findDoc(docs, id) {
  for (const d of docs) {
    if (d.id === id) return d;
    const hit = findDoc(d.children, id);
    if (hit) return hit;
  }
  return null;
}

/** The node `id` names, widened to the sections around it (a frame of a section is one of its states). */
function linkedDoc(docs, id, chain = []) {
  for (const d of docs) {
    if (d.id === id) {
      let top = d;
      for (let i = chain.length - 1; i >= 0 && chain[i].type === 'SECTION'; i--) top = chain[i];
      return top;
    }
    const hit = linkedDoc(d.children, id, [...chain, d]);
    if (hit) return hit;
  }
  return null;
}

/**
 * figma-spec.json from MCP output.
 * input: { documents: [[doc…] per metadata file], fileKey, nodeId, url, fileName, name,
 *          variableDefs, codeConnect, degradations, now }
 * The compared node: nodeId when a metadata file contains it (the section around it when it
 * sits in one: the census decides which frames are states); else the one root of a single
 * file; else every root together as a NODE_SET (several sections from several files, or a
 * page's children), named `name`.
 */
export function buildMcpFigmaSpec({ documents, fileKey, nodeId = null, url = null, fileName = null, name = null, variableDefs = null, codeConnect = null, degradations = [], now = new Date() }) {
  const files = documents.filter((d) => d.length);
  let root = null;
  if (files.length === 1) {
    root = (nodeId && linkedDoc(files[0], nodeId)) || (files[0].length === 1 ? files[0][0] : null);
  }
  const nodes = files.flatMap((docs) => (nodeId && linkedDoc(docs, nodeId) ? [linkedDoc(docs, nodeId)] : docs));
  if (!root) {
    const box = nodes.reduce(
      (acc, d) => {
        const b = d.absoluteBoundingBox;
        return { x0: Math.min(acc.x0, b.x), y0: Math.min(acc.y0, b.y), x1: Math.max(acc.x1, b.x + b.width), y1: Math.max(acc.y1, b.y + b.height) };
      },
      { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
    );
    // One file with several roots and a node id it does not contain: a page's children.
    const pageId = files.length === 1 && nodeId && !findDoc(files[0], nodeId) ? nodeId : null;
    root = {
      id: pageId ?? `set:${nodes[0].id}`,
      name: name ?? (pageId ? 'Page' : `${nodes.length} Figma nodes`),
      type: pageId ? 'CANVAS' : 'NODE_SET',
      absoluteBoundingBox: { x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 },
      children: nodes,
    };
  }
  const response = { name: fileName, nodes: { [root.id]: { document: root, components: {}, componentSets: {}, styles: {} } } };
  const spec = buildFigmaSpec({ fileKey, nodeId: root.id, url, response, variables: null, siblings: [], degradations, now });
  // A node set is not a Figma node: the spec is named after its first node, and "nodes" lists them all.
  if (root.type === 'NODE_SET') spec.nodeId = nodes[0].id;
  spec.nodes = nodes.map((d) => d.id);
  spec.source = 'mcp';
  spec.unavailable = MCP_UNAVAILABLE.filter((k) => !(k === 'variables' && variableDefs) && !(k === 'characters' && spec.layers.some((l) => l.characters)));
  spec.variableDefs = variableDefs;
  spec.codeConnect = codeConnect;
  return spec;
}

// ---------------------------------------------------------------------------
// Design PNGs from get_screenshot asset URLs
// ---------------------------------------------------------------------------

// Hosts a get_screenshot URL (or Figma's image export) is served from. A request
// never carries a token, but only Figma's own hosts are fetched: a URL from a tool
// result or a pasted message must not make this script fetch arbitrary hosts.
const FIGMA_ASSET_HOSTS = ['figma.com', 'figma-alpha-api.s3.us-west-2.amazonaws.com'];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Extra exact hosts from DESIGN_QA_FIGMA_ASSET_HOSTS (comma-separated; "*.example.com" allows subdomains). */
export function extraAssetHosts(env = process.env) {
  return String(env.DESIGN_QA_FIGMA_ASSET_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^(\*\.)?[a-z0-9.-]+$/.test(h));
}

/**
 * Whether a screenshot URL may be downloaded: https on figma.com or a subdomain, Figma's
 * image-export bucket, or a host listed in DESIGN_QA_FIGMA_ASSET_HOSTS; http(s) on
 * localhost (the Figma desktop app's local MCP server). Returns { ok, reason }.
 */
export function checkAssetUrl(value, extra = extraAssetHosts()) {
  let u;
  try {
    u = new URL(String(value));
  } catch {
    return { ok: false, reason: 'not a URL' };
  }
  if (u.username || u.password) return { ok: false, reason: 'the URL carries credentials' };
  const host = u.hostname.toLowerCase();
  if (LOCAL_HOSTS.has(host)) return u.protocol === 'http:' || u.protocol === 'https:' ? { ok: true } : { ok: false, reason: `${u.protocol} is not http(s)` };
  if (u.protocol !== 'https:') return { ok: false, reason: `${host} must be https://` };
  const allowed = [...FIGMA_ASSET_HOSTS, ...extra];
  const match = allowed.some((h) => {
    if (h.startsWith('*.')) return host.endsWith(h.slice(1));
    return host === h || (h === 'figma.com' && host.endsWith('.figma.com'));
  });
  return match
    ? { ok: true }
    : {
        ok: false,
        reason:
          `${host} is not an allowed Figma asset host (allowed: figma.com and *.figma.com, ${FIGMA_ASSET_HOSTS[1]}, localhost${extra.length ? `, ${extra.join(', ')}` : ''}). ` +
          `If get_screenshot really serves its PNGs from ${host}, allow it with DESIGN_QA_FIGMA_ASSET_HOSTS=${host} and run this again; ` +
          'or download the file with the curl command get_screenshot printed and pass it with --png <file> (the size check still applies)',
      };
}

/** Longest edge get_screenshot can render (its maxDimension limit). */
export const MAX_SCREENSHOT_DIMENSION = 65536;

/**
 * What to ask get_screenshot for so a frame comes back at scale 1: { maxDimension } or,
 * when the frame's longer edge is beyond the tool's limit, { tooLarge: true } (no 1x
 * export in one call: that state gets no pixel diff and a degradation, never a rescale).
 */
export function screenshotRequest(frame) {
  const maxDimension = Math.max(frame.width, frame.height);
  return maxDimension > MAX_SCREENSHOT_DIMENSION ? { maxDimension, tooLarge: true } : { maxDimension, tooLarge: false };
}

/** "1440x1024" / "1440×1024" → { width, height }, or null. */
export function parseSize(text) {
  const m = /^\s*(\d+)\s*[x×X]\s*(\d+)\s*$/.exec(String(text ?? ''));
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/**
 * The size entry of a saved get_screenshot result: { rendered: { width, height },
 * original: { width, height } } from the JSON metadata object that carries
 * width/height and original_width/original_height. null when there is none.
 */
export function screenshotMeta(raw) {
  const text = mcpResultText(raw);
  const candidates = [];
  const collect = (v, depth) => {
    if (depth > 10 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x) => collect(x, depth + 1));
    if ('original_width' in v && 'width' in v) candidates.push(v);
    for (const x of Object.values(v)) collect(x, depth + 1);
  };
  for (const chunk of [text, ...text.split(/\n(?=\s*[[{])/)]) {
    try {
      collect(JSON.parse(chunk.trim()), 0);
    } catch {
      // not a JSON chunk
    }
    if (candidates.length) break;
  }
  const v = candidates[0];
  if (!v) return null;
  const size = (w, h) => (Number.isInteger(Number(w)) && Number.isInteger(Number(h)) && Number(w) > 0 && Number(h) > 0 ? { width: Number(w), height: Number(h) } : null);
  const rendered = size(v.width, v.height);
  const original = size(v.original_width, v.original_height);
  return rendered && original ? { rendered, original } : null;
}

/**
 * The frame size a state's design PNG must have: its census/state frame, else its layer's
 * box, else the spec's frame for the main node. null when unknown.
 */
export function stateFrameSize(spec, state) {
  const entry = (spec?.states ?? []).find((s) => s.state === state);
  if (!entry) return null;
  if (entry.frame?.width) return { width: Math.round(entry.frame.width), height: Math.round(entry.frame.height) };
  const layer = [...(spec.layers ?? []), ...(spec.siblings ?? [])].find((l) => l?.id === entry.nodeId);
  const b = layer?.absoluteBoundingBox;
  if (b?.width) return { width: Math.round(b.width), height: Math.round(b.height) };
  if (entry.nodeId === spec.nodeId && spec.frame?.width) return { ...spec.frame };
  return null;
}
