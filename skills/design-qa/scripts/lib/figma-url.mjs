// Figma link parsing: file key, branch key and node id.
//   https://www.figma.com/design/<fileKey>/<name>?node-id=1-23
//   https://www.figma.com/file/<fileKey>/<name>?node-id=1%3A23
//   https://www.figma.com/proto/<fileKey>/<name>?node-id=1-23&starting-point-node-id=1-2
//   https://www.figma.com/design/<fileKey>/branch/<branchKey>/<name>?node-id=…
//   https://www.figma.com/embed?embed_host=share&url=<encoded link>

const FIGMA_HOST = /(^|\.)figma\.com$/i;
const KINDS = new Set(['design', 'file', 'proto']);
const NODE_ID = /^I?\d+:\d+(;I?\d+:\d+)*$/;

/**
 * Normalise a node id to the API form "1:23". Accepts the URL form "1-23",
 * the encoded form "1%3A23" and the API form; instance ids ("I1:2;3:4") are kept.
 * Returns null for anything that is not a node id.
 */
export function normalizeNodeId(id) {
  if (id === undefined || id === null) return null;
  let s = String(id).trim();
  if (!s) return null;
  try {
    s = decodeURIComponent(s);
  } catch {
    // keep the raw value
  }
  s = s.replace(/-/g, ':');
  return NODE_ID.test(s) ? s : null;
}

/** API form "1:23" → URL form "1-23" (null when not a node id). */
export function toUrlNodeId(id) {
  const n = normalizeNodeId(id);
  return n ? n.replace(/:/g, '-') : null;
}

/**
 * Parse a Figma link. Returns null when the input is not a Figma design/file/proto link, else
 * { fileKey, mainFileKey, branchKey, nodeId, kind, fileName, url }.
 * fileKey is the key to call the REST API with (the branch key for branch links).
 */
export function parseFigmaUrl(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !FIGMA_HOST.test(url.hostname)) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0] === 'embed' && url.searchParams.get('url')) return parseFigmaUrl(url.searchParams.get('url'));
  const [kind, key] = segments;
  if (!KINDS.has(kind) || !key || !/^[A-Za-z0-9]+$/.test(key)) return null;
  let branchKey = null;
  let nameIndex = 2;
  if (segments[2] === 'branch' && segments[3] && /^[A-Za-z0-9]+$/.test(segments[3])) {
    branchKey = segments[3];
    nameIndex = 4;
  }
  let fileName = null;
  if (segments[nameIndex]) {
    try {
      fileName = decodeURIComponent(segments[nameIndex]).replace(/-/g, ' ');
    } catch {
      fileName = segments[nameIndex];
    }
  }
  const nodeParam = url.searchParams.get('node-id') ?? (kind === 'proto' ? url.searchParams.get('starting-point-node-id') : null);
  return {
    fileKey: branchKey ?? key,
    mainFileKey: key,
    branchKey,
    nodeId: normalizeNodeId(nodeParam),
    kind,
    fileName,
    url: input.trim(),
  };
}

/** Canonical design link for a file key + node id. */
export function figmaDesignUrl(fileKey, nodeId) {
  const n = toUrlNodeId(nodeId);
  return `https://www.figma.com/design/${fileKey}/${n ? `?node-id=${n}` : ''}`;
}
