import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assertInsideDir, writeFileAtomic, writeJson, writeText } from './args.mjs';
import { cropPng, composePanels, encodePng } from './png.mjs';

import { evidenceHash, reviewDigest } from './review-hash.mjs';
export { evidenceHash, reviewDigest } from './review-hash.mjs';

// Original scale, both widths/heights, no masks or ranking: all pixels are reviewable.
export function writeComparisonReview(ev, units, resolveUnit, items) {
  const states = {};
  for (const [index, u] of units.entries()) {
    const files = resolveUnit(ev, u);
    const sources = {};
    const images = [];
    const record = states[u.id] = { sources, images, complete: false, reason: null };
    const addSource = rel => {
      if (rel && ev.abs(rel)) sources[rel] = evidenceHash(readFileSync(ev.abs(rel)));
    };
    for (const rel of [files.design, files.app, files.audit, files.computed,
      path.posix.join(u.prefix, 'figma-spec.json'), path.posix.join(u.prefix, 'compare.json')]) addSource(rel);
    addSource('evidence/figma-spec.json');
    for (const layer of files.spec?.layers ?? []) for (const v of Object.values(layer.valueEvidence ?? {})) {
      addSource(v.file);
      if (sources[v.file] !== v.hash) record.reason = 'imported Figma value evidence changed; reimport';
    }
    addSource(path.posix.join(u.prefix, 'capture.json'));
    addSource(path.posix.join(u.prefix, 'design-capture.json'));
    for (const rel of [files.designAudit, files.designComputed]) addSource(rel);
    if (!files.design || !files.app) { record.reason = 'missing design or app image'; continue; }
    const d = ev.png(files.design), a = ev.png(files.app);
    const w = Math.max(d.width, a.width), h = Math.max(d.height, a.height);
    const count = Math.ceil(w / 600) * Math.ceil(h / 800);
    if (count > 512) { record.reason = `full state requires ${count} tiles; split the capture into sections`; continue; }
    for (let y = 0; y < h; y += 800) for (let x = 0; x < w; x += 600) {
      const rect = { x, y, w: Math.min(600, w-x), h: Math.min(800, h-y) };
      const png = composePanels([{ png: cropPng(d, rect), label: `Design ${x},${y}` }, { png: cropPng(a, rect), label: `Code ${x},${y}` }]);
      const rel = `evidence/comparison-review/state-${index}/${x}-${y}.png`;
      const bytes = encodePng(png);
      const target = path.join(ev.dir, rel);
      assertInsideDir(ev.dir, target, 'comparison review image');
      writeFileAtomic(target, bytes);
      images.push({ path: rel, hash: evidenceHash(bytes), rect });
    }
    for (const item of items.filter(it => it.state === u.id || it.alsoIn?.includes(u.id))) {
      for (const image of item.images ?? []) {
        if (!images.some(i => i.path === image.path)) images.push({ path: image.path, hash: evidenceHash(readFileSync(ev.abs(image.path))) });
      }
    }
    const comparePath = path.posix.join(u.prefix, 'compare.json');
    const values = ev.json(comparePath)?.states?.[u.local];
    record.valuesFile = comparePath;
    record.valuesAvailable = Boolean(values);
    if (values) {
      const cell = v => String(v ?? 'unknown').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\r\n]+/g, ' ');
      const ledger = ['| Node / selector | Property | Figma | Code | Delta | Figma token / code token | Result |', '|---|---|---|---|---|---|---|',
        ...(values.style ?? []).map(r => `| ${cell(r.figmaNodeId)} / ${cell(r.selector)} | ${cell(r.property)} | ${cell(r.design)} | ${cell(r.app)} | ${cell(r.deltaE ?? r.delta)} | ${cell(r.expectedToken)} / ${cell(r.actualToken)} | ${cell(r.result)} |`),
        ...(values.structure ?? []).map(r => `| ${cell(r.figmaNodeId)} / ${cell(r.selector)} | structure | ${cell(r.design)} | ${cell(r.app)} | — | — | ${cell(r.result)}: ${cell(r.note)} |`)];
      const rel = `evidence/comparison-review/state-${index}/values.md`;
      assertInsideDir(ev.dir, path.join(ev.dir, rel), 'comparison values');
      writeText(path.join(ev.dir, rel), ledger.join('\n')+'\n');
      addSource(rel);
      record.valuesLedger = rel;
    }
    record.complete = !record.reason;
    record.digest = reviewDigest(record);
  }
  writeJson(path.join(ev.dir, 'evidence/comparison-review.json'), { version: 1, states });
  writeText(path.join(ev.dir, 'comparison-review.md'), ['# Required side-by-side and value review',
    'Open EVERY image below. Review EVERY compare.json style/structure row, including PASS and CANNOT_VERIFY. File differences and resolve missing values. Record each state in findings.json.comparisons only after inspection.',
    ...Object.entries(states).flatMap(([state, r]) => [`\n## ${state}`, `Values: ${r.valuesLedger ?? r.valuesFile ?? "missing"}`, `Digest: ${r.digest ?? 'unavailable'}; complete: ${r.complete}${r.reason ? ` (${r.reason})` : ''}`, ...r.images.map(i => `- ${i.path}`)]),
    '\nRecord: "comparisons": { "<state>": { "digest": "<digest>", "images": ["<every path>"], "valuesReviewed": true } }. Re-capture invalidates the record.'
  ].join('\n')+'\n');
  return states;
}
