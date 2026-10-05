// Explicit Figma/code values; unknowns are evidence gaps, never matches.
import { compareValues } from './compare.mjs';
import { designMatcher, designSide, designValueOf } from './ds-audit.mjs';
import { nodesFromAudit, nodesFromGrab } from './worklist.mjs';

export function compareFigmaValues({ state, spec, nodeId, app, ...tolerances }) {
  const design = designSide({ spec, nodeId, includeRoot: true });
  const root = spec.layers?.find(l => l.id === nodeId)?.absoluteBoundingBox ?? design.nodes[0]?.rect ?? {x:0,y:0};
  for (const n of design.nodes) {
    const b = spec.layers?.find(l => l.id === n.id)?.absoluteBoundingBox;
    if (b) n.rect = {x:b.x-root.x,y:b.y-root.y,w:b.width,h:b.height};
  }
  const nodes = app.audit ? nodesFromAudit(app.audit) : nodesFromGrab(app.computed);
  const elements = nodes.map(n => ({ ...n, s: n.props }));
  const match = designMatcher(elements, design);
  const seen = new Set();
  const style = [], structure = [];
  for (const e of elements) {
    const m = match(e);
    // A coincident background and frame do not identify the intended layer.
    const d = m?.nodes.length === 1 ? m.nodes[0] : null;
    if (d) seen.add(d.id);
    const props = new Set([...Object.keys(e.props), ...Object.keys(d?.props ?? {})]);
    for (const property of props) {
      const expected = d ? designValueOf(d, property, design) : undefined;
      const actual = e.props[property];
      const comparison = expected === undefined || actual === undefined
        ? { result: 'CANNOT_VERIFY', delta: null }
        : compareValues(property, expected, actual, tolerances);
      style.push({ state, elementClass: e.path, index: e.i, selector: e.path, text: e.text,
        figmaNodeId: d?.id ?? null, property, design: expected ?? null, app: actual ?? null,
        expectedToken: d?.vars?.[property] ?? null, actualToken: e.vars?.[property] ?? null,
        ...comparison, ...(comparison.result === 'CANNOT_VERIFY' ? { note: !d ? 'unmatched or ambiguous Figma counterpart' : 'missing Figma or code value' } : {}) });
    }
    if (d) for (const [property, key] of [['x','x'],['y','y'],['width','w'],['height','h']]) {
      style.push({ state, elementClass: e.path, index: e.i, selector: e.path, text: e.text,
        figmaNodeId: d.id, property, design: `${d.rect[key]}px`, app: `${e.rect[key]}px`,
        ...compareValues(property, `${d.rect[key]}px`, `${e.rect[key]}px`, tolerances) });
    }
  }
  for (const d of design.nodes) if (!seen.has(d.id)) structure.push({ state, elementClass: d.name,
    figmaNodeId: d.id, selector: '', design: d.name, app: null, result: 'CANNOT_VERIFY', note: 'Figma layer has no unique code counterpart' });
  if (!nodes.length || !design.nodes.length) structure.push({ state, elementClass: '(coverage)', selector: '',
    design: null, app: null, result: 'CANNOT_VERIFY', note: 'no comparable Figma layers or code elements' });
  if (!app.audit) structure.push({ state, elementClass: '(coverage)', selector: '', design: null, app: null,
    result: 'CANNOT_VERIFY', note: 'code values are sampled grabs; whole-page audit missing' });
  return { style, structure };
}
