// Build figma-spec.json from a Figma REST "GET /v1/files/:key/nodes" response.
import { CliError } from './args.mjs';
import { figmaMotionSpecs } from './figma-motion.mjs';
import { discoverFigmaStates } from './state-discovery.mjs';

const LAYER_KEYS = [
  'absoluteBoundingBox', 'visible', 'fills', 'strokes', 'strokeWeight', 'cornerRadius', 'rectangleCornerRadii',
  'effects', 'opacity', 'layoutMode', 'primaryAxisAlignItems', 'counterAxisAlignItems', 'paddingLeft',
  'paddingRight', 'paddingTop', 'paddingBottom', 'itemSpacing', 'layoutSizingHorizontal', 'layoutSizingVertical',
  'style', 'characters', 'componentId', 'componentName', 'variantProperties', 'boundVariables', 'reactions',
  'annotations', 'description', 'transitionNodeID', 'transitionDuration', 'transitionEasing', 'flowStartingPoints',
];
const STYLE_KEYS = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeightPx', 'letterSpacing', 'textCase', 'textAlignHorizontal'];

/** "State=Hover, Size=Large" → { State: "Hover", Size: "Large" }; null when not variant-shaped. */
export function parseVariantName(name) {
  const parts = String(name ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const out = {};
  for (const part of parts) {
    const i = part.indexOf('=');
    if (i <= 0) return null;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Variant properties of a component-set child or an instance (VARIANT component properties). */
export function variantPropertiesOf(node, parent, components = {}) {
  if (node?.componentProperties && typeof node.componentProperties === 'object') {
    const out = {};
    for (const [key, prop] of Object.entries(node.componentProperties)) {
      if (prop && prop.type === 'VARIANT') out[key.replace(/#[^#]*$/, '')] = String(prop.value);
    }
    if (Object.keys(out).length) return out;
  }
  if (node?.type === 'COMPONENT' && parent?.type === 'COMPONENT_SET') return parseVariantName(node.name);
  const comp = node?.componentId ? components[node.componentId] : null;
  if (node?.type === 'INSTANCE' && comp?.componentSetId) return parseVariantName(comp.name);
  return null;
}

function componentNameOf(node, parent, components = {}, componentSets = {}) {
  if (node?.type === 'INSTANCE' && node.componentId) {
    const comp = components[node.componentId];
    if (!comp) return null;
    return (comp.componentSetId && componentSets[comp.componentSetId]?.name) || comp.name || null;
  }
  if (node?.type === 'COMPONENT') return parent?.type === 'COMPONENT_SET' ? parent.name : node.name;
  if (node?.type === 'COMPONENT_SET') return node.name;
  return null;
}

/** Depth-first flattened layer list with the properties design QA compares. */
export function flattenLayers(root, { components = {}, componentSets = {} } = {}) {
  const layers = [];
  const walk = (node, parent, parentPath, depth) => {
    if (!node || typeof node !== 'object') return;
    const layerPath = parentPath ? `${parentPath}/${node.name}` : node.name;
    const derived = {
      visible: node.visible !== false,
      style: pickStyle(node.style),
      componentName: componentNameOf(node, parent, components, componentSets),
      variantProperties: variantPropertiesOf(node, parent, components),
      description:
        node.description ??
        ((node.type === 'COMPONENT' && components[node.id]?.description) ||
          (node.type === 'COMPONENT_SET' && componentSets[node.id]?.description) ||
          undefined),
    };
    const layer = { id: node.id, name: node.name, type: node.type, path: layerPath, depth };
    for (const key of LAYER_KEYS) {
      const value = Object.prototype.hasOwnProperty.call(derived, key) ? derived[key] : node[key];
      if (value !== undefined && value !== null && !(key === 'description' && value === '')) layer[key] = value;
    }
    layers.push(layer);
    for (const child of node.children || []) walk(child, node, layerPath, depth + 1);
  };
  walk(root, null, '', 0);
  return layers;
}

function pickStyle(style) {
  if (!style || typeof style !== 'object') return undefined;
  const out = {};
  for (const k of STYLE_KEYS) if (style[k] !== undefined) out[k] = style[k];
  return Object.keys(out).length ? out : undefined;
}

/**
 * figma-spec.json content.
 * input: { fileKey, nodeId, url, response (nodes endpoint JSON), variables, siblings, degradations, now }
 */
export function buildFigmaSpec({ fileKey, nodeId, url, response, variables = null, siblings = [], degradations = [], now = new Date() }) {
  const entry = response?.nodes?.[nodeId];
  if (!entry || !entry.document) {
    throw new CliError(`node ${nodeId} was not found in Figma file ${fileKey} (check the link's node-id and that the token can open the file)`, 1);
  }
  const doc = entry.document;
  const box = doc.absoluteBoundingBox || doc.absoluteRenderBounds || {};
  const spec = {
    fileKey,
    nodeId,
    url,
    fileName: response.name ?? null,
    lastModified: response.lastModified ?? null,
    version: response.version ?? null,
    name: doc.name,
    type: doc.type,
    frame: { width: Math.round(box.width ?? 0), height: Math.round(box.height ?? 0) },
    layers: flattenLayers(doc, entry),
    components: entry.components ?? {},
    componentSets: entry.componentSets ?? {},
    styles: entry.styles ?? {},
    variables,
    siblings,
    states: [],
    motion: [],
    exports: [],
    fetchedAt: now.toISOString(),
    degradations,
  };
  spec.states = discoverFigmaStates(spec);
  // Prototype transitions (reactions[].actions[].transition) as CSS-comparable specs.
  spec.motion = figmaMotionSpecs(spec);
  return spec;
}

/**
 * Top-level frames that share the page with nodeId (from GET /v1/files/:key?depth=2).
 * Returns [] when the node is nested deeper than a page's direct children.
 */
export function siblingFrames(fileResponse, nodeId) {
  for (const page of fileResponse?.document?.children || []) {
    const kids = page.children || [];
    if (!kids.some((k) => k.id === nodeId)) continue;
    return kids
      .filter((k) => k.id !== nodeId)
      .map((k) => ({ id: k.id, name: k.name, type: k.type, absoluteBoundingBox: k.absoluteBoundingBox ?? null }));
  }
  return [];
}
