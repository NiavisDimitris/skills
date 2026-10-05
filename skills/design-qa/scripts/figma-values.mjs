#!/usr/bin/env node
// Import CSS values extracted from saved MCP responses; never execute generated code.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { parseCli, readJsonFile, runMain, usageError, writeJson } from './lib/args.mjs';
import { insideFile } from './lib/worklist.mjs';
import { evidenceHash } from './lib/review-hash.mjs';

export function importFigmaValues(spec, entries, root) {
  if (!Array.isArray(entries) || !entries.length) throw usageError('values must be a nonempty array');
  const next = structuredClone(spec);
  const used = new Set();
  for (const row of entries) {
    const layer = next.layers?.find(l => l.id === row.nodeId);
    if (!layer) throw usageError(`unknown Figma node ${row.nodeId}`);
    if (typeof row.property !== 'string' || !/^[a-z][a-z-]*$/.test(row.property) || typeof row.value !== 'string' || !row.value.trim()) throw usageError('each value needs a CSS property and nonempty string value');
    const key = `${row.nodeId}:${row.property}`;
    if (used.has(key)) throw usageError(`duplicate value ${key}`);
    used.add(key);
    const file = insideFile(root, row.source?.file);
    const snippet = row.source?.snippet;
    const raw = row.rawValue ?? row.value;
    if (!file || typeof snippet !== 'string' || !snippet.trim() || typeof raw !== 'string' || !raw.trim()) throw usageError(`${key}: saved source file, snippet and rawValue required`);
    const bytes = readFileSync(file);
    if (!bytes.toString('utf8').includes(snippet) || !snippet.includes(raw)) throw usageError(`${key}: value evidence absent from saved response`);
    // Transport conversion is deliberately narrow: CSS values or a numeric px scalar.
    if (raw !== row.value && !(Number.isFinite(Number(raw)) && `${Number(raw)}px` === row.value)) throw usageError(`${key}: unsupported conversion; use an exact CSS value from the response`);
    layer.cssValues ??= {};
    layer.cssTokens ??= {};
    layer.cssValues[row.property] = row.value;
    if (row.token !== undefined && (typeof row.token !== 'string' || !snippet.includes(row.token))) throw usageError(`${key}: token name must occur in the saved snippet`);
    if (row.token) layer.cssTokens[row.property] = row.token;
    layer.valueEvidence ??= {};
    layer.valueEvidence[row.property] = { ...row.source, hash: evidenceHash(bytes), rawValue: raw };
  }
  return next;
}

export function validateFigmaValueEvidence(spec, root) {
  for (const layer of spec.layers ?? []) for (const [property, value] of Object.entries(layer.cssValues ?? {})) {
    const e = layer.valueEvidence?.[property];
    const file = root && insideFile(root, e?.file);
    if (!file || evidenceHash(readFileSync(file)) !== e?.hash) throw usageError(`${layer.id}:${property}: missing or stale saved Figma value evidence; reimport the value`);
    const token = layer.cssTokens?.[property];
    if (!readFileSync(file,'utf8').includes(e.snippet) || !e.snippet.includes(e.rawValue) || (token && !e.snippet.includes(token))) throw usageError(`${layer.id}:${property}: source evidence does not support value/token`);
    if (e.rawValue !== value && !(Number.isFinite(Number(e.rawValue)) && `${Number(e.rawValue)}px` === value)) throw usageError(`${layer.id}:${property}: value changed since import`);
  }
}

async function main(argv) {
  const { values } = parseCli(argv,{spec:{type:'string'},values:{type:'string'},dir:{type:'string'}});
  if (values.help) { console.log('Usage: figma-values.mjs --spec <figma-spec.json> --values <rows.json> --dir <report-dir>\nRows: [{nodeId,property,value,rawValue?,token?,source:{file,snippet}}]. Source paths are report-relative. Save raw MCP responses first. Re-run evidence and inspect again after importing.'); return 0; }
  if (!values.spec || !values.values || !values.dir) throw usageError('--spec, --values and --dir required');
  const root = path.resolve(values.dir);
  const relative = path.relative(root,path.resolve(values.spec));
  if (!insideFile(root,relative)) throw usageError('--spec must be inside --dir');
  const result = importFigmaValues(readJsonFile(values.spec,'spec'),readJsonFile(values.values,'values'),root);
  writeJson(values.spec,result);
  console.log(`Imported ${JSON.parse(readFileSync(values.values,'utf8')).length} Figma values; re-run evidence and review.`);
  return 0;
}
runMain(import.meta.url,main);
