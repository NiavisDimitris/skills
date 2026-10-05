#!/usr/bin/env node
// Design-system audit: every rendered element of every captured state (the whole page,
// below the fold and inside scroll containers too) checked against the design system's
// tokens and component libraries. Reads the collector's evidence/audit/<state>.json,
// writes evidence/ds-audit.json with grouped finding candidates. Never writes report.json.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { assertInsideDir, displayPath, oneLine, parseCli, readJsonFile, runMain, scriptCommand, toNumber, usageError, writeJson } from './lib/args.mjs';
import { DEFAULT_COLOR_DELTA_E } from './lib/compare.mjs';
import {
  AUDIT_CATEGORIES,
  AUDIT_NOTE,
  auditState,
  buildCandidates,
  buildTokenSet,
  designSide,
  normalizeLibraries,
  pageTokens,
  parseCssTokens,
  parseJsonTokens,
  parseKnownDrifts,
  parseTokenMapFile,
  scanRawImports,
  scanSourceImports,
  tokenComplianceSummary,
} from './lib/ds-audit.mjs';
import { pngSize } from './lib/png.mjs';
import { validateConfig } from './lib/schema-check.mjs';
import { assertRunOwnsOutput } from './lib/pass.mjs';

/** Candidates listed on stdout by default; ds-audit.json always holds all of them. */
const SHOWN_CANDIDATES = 8;
/** Fewer page variables than this (framework ones left out) is not a token set to audit against. */
const MIN_PAGE_TOKENS = 5;

const HELP = `Audit every rendered element of the captured page against the design system.

Usage:
  node scripts/ds-audit.mjs --evidence <dir>/evidence [--config design-qa.config.json] [options]

Options:
  --evidence <dir>       the capture folder (capture.json, app/, audit/); a multi-screen pass's
                         screens/<id>/ folders are audited too (required)
  --state <s>            only this state (repeatable, or comma-separated; default: every state
                         with an audit file). Multi-screen: <screen>/<state> or <state>
  --screen <id>          only this screen (repeatable)
  --config <file>        design-qa.config.json: designSystem.tokens, tokenMap, componentCatalog,
                         knownDrifts, libraries, name; tolerances.px and tolerances.colorDeltaE.
                         Paths in it are relative to its folder and must stay inside it
  --tokens <file>        a token file (repeatable; added before designSystem.tokens): JSON
                         ({ "--x": v }, W3C design tokens with $value, Style Dictionary, a theme
                         object exported to JSON) or CSS (custom properties)
  --token-map <file>     the markdown token map (default: designSystem.tokenMap)
  --catalog <file>       the component catalog (default: designSystem.componentCatalog)
  --known-drifts <file>  known drifts (default: designSystem.knownDrifts); matched as hints
  --source <dir>         also scan this checkout for imports of each library's "package"
                         (a hint from the local checkout, which may differ from the deployed build)
  --no-page-tokens       do not use the page's own :root custom properties as tokens
  --tolerance-px <n>     near-miss tolerance for lengths (default: config tolerances.px, else 1)
  --color-delta-e <n>    near-miss tolerance for colours, CIEDE2000 (default: config, else 1.5)
  --samples <n>          sample elements listed per candidate (default 5)
  --report-dir <dir>     folder evidence paths are relative to (default: the parent of --evidence)
  --out <file>           output (default: <evidence>/ds-audit.json)
  --run <id>             this pass's run id (default: DESIGN_QA_RUN_ID); refused (exit 5)
                         when the report folder's run lock names another run
  --verbose              list every candidate (default: the first ${SHOWN_CANDIDATES}; all are in the output)
  --quiet                only print errors
  -h, --help             show this help

Run it after capture, on every pass, for every state. Token sources merge in this order (the
first value of a name wins): --tokens, designSystem.tokens, the token map, the page's :root
custom properties (rootTokens; a framework's own, such as --tw-*, are left out). An MUI
theme saved as JSON is read as one (variants, shadows, spacing). A JS or TS theme module is
never run here: setup.mjs export-theme saves it as JSON, with the person's agreement. No
token source, or fewer than ${MIN_PAGE_TOKENS} page variables and nothing else: skipped, exit 2, and
ds-audit.json records skipped: { reason, fix }. The report then says "not checked" (never 0);
fix it with setup.mjs check --ask ds-tokens.

Each recorded value is a match (equals a token), a near miss (within tolerance of the nearest
token but not equal: a hand-typed value) or off-token (beyond tolerance; nearest token and
distance given: ΔE for colours, px for lengths). Typography is checked as a set against text
styles when the sources define any. A value match is a usage-unverified candidate: only an authored var(--token)
the collector traced proves the code uses the token. Components are classified by
designSystem.libraries ({ name, kind: design-system | third-party | legacy, classPrefix,
selector, package }); third-party, legacy and native controls where the catalog has a
design-system component become candidates. Identical problems (same category and value, or
the same substitution) are one candidate with a count and samples, most visible first.

ds-audit.json: { generatedAt, note, evidence, options, tokenSources, uncheckedCategories,
  libraries, summary: { elementsChecked, offTokenValues, nonSystemComponents, output, states,
  candidates, … }, states: { <state>: { … } }, groups: { tokens, components, matches },
  designAlso: [ groups the design shares: { key, kind, value, count, sample, … } ],
  candidates: [ report findings without id and rank, plus key (stable: "style:color:#3a3f47",
  "component:mui:mui-button>button"; prefixed "<screen>/" in a multi-screen pass) and _audit
  (count, samples with rects and crops, nearest token, knownDriftHint) ], sourceHints, warnings }.
${AUDIT_NOTE}

Design check: each flagged element is matched to its design counterpart (the coded
prototype's design-audit/<state>.json, else figma-spec.json values on the REST path) by
selector path, test id, text or the same place and size. The design has the same value:
not a visual difference, but token deviations and unverified usage remain candidates.
Only component groups shared by the design are listed under designAlso without candidates. Another value: a candidate
whose expected is the design's value (and its token). No design value: check the intended semantic token. Visual agreement never waives token usage.

A design system with "wraps" (built on a third-party library, same classes on the page):
the wrapped library's elements count as the design system's; on a local target (or with
--source) every file importing the wrapped library straight is a candidate (file and line).

Exit codes: 0 the audit ran (whatever it found) · 2 bad arguments, no audit files, an
unreadable input or skipped (see above) · 5 another run owns the report folder`;

const read = (file, label) => {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    throw usageError(`cannot read ${label} ${oneLine(displayPath(file))}: ${err.code === 'ENOENT' ? 'file not found' : err.message}`);
  }
};

/** Why the audit did not run and how to turn it on: ds-audit.json records it as `skipped`, exit 2. */
class Skip extends Error {}
const askStyle = () => `Turn it on: ask the person "Style values" again (${scriptCommand('setup.mjs')} check --ask ds-tokens); a theme in code they choose is saved as JSON once`;

/** A token file → parsed tokens; a JS or TS module is never run here (setup.mjs exports it, with the person's agreement). */
function loadTokenFile(file, rootFontSize) {
  const shown = oneLine(displayPath(file));
  if (/\.(m?[jt]sx?|cjs|cts|mts)$/i.test(file)) {
    throw new Skip(`${shown} is a theme in code, which the audit never runs|With the person's agreement (it runs that file once): ${scriptCommand('setup.mjs')} export-theme --from ${shown}, then list the JSON file it saves in designSystem.tokens instead`);
  }
  const text = read(file, 'token file');
  if (/\.(s?css|less)$/i.test(file)) return parseCssTokens(text, { file: displayPath(file), rootFontSize });
  let json;
  try {
    json = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw usageError(`token file ${shown} is neither CSS (.css) nor valid JSON: ${err.message}`);
  }
  return parseJsonTokens(json, { file: displayPath(file), rootFontSize });
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const fileSafe = (name) => String(name).replace(/[^A-Za-z0-9._-]+/g, '-');

/** A path from a manifest, only when it stays inside the evidence folder. */
function inside(root, rel) {
  if (typeof rel !== 'string' || !rel) return null;
  const abs = path.resolve(root, rel);
  try {
    assertInsideDir(root, abs, 'capture manifest');
  } catch {
    return null;
  }
  return existsSync(abs) ? abs : null;
}

/**
 * The design side of one state: a coded prototype's design-audit/<state>.json (listed in
 * design-capture.json), else the folder's figma-spec.json (REST values; none on the MCP
 * path), else nothing. → designSide() input plus { source, file }.
 */
function designFor(dir, state) {
  const dcapFile = path.join(dir, 'design-capture.json');
  const dcap = existsSync(dcapFile) ? readJsonFile(dcapFile, 'design capture manifest') : null;
  const entry = dcap?.states?.[state];
  const audit = inside(dir, entry?.audit) ?? (entry && entry.audit === null ? null : inside(dir, `design-audit/${fileSafe(state)}.json`));
  if (audit) return { audit: readJsonFile(audit, 'design audit file'), file: audit };
  const specFile = inside(dir, 'figma-spec.json');
  if (specFile) {
    const spec = readJsonFile(specFile, 'figma spec');
    const exp = Array.isArray(spec?.exports) ? spec.exports.find((e) => e && e.state === state) : null;
    const st = Array.isArray(spec?.states) ? spec.states.find((e) => e && e.state === state) : null;
    return { spec, nodeId: exp?.nodeId ?? st?.nodeId ?? spec?.nodeId ?? null, file: specFile };
  }
  return {};
}

/** Audit files of one capture folder: [{ state, audit, screenshot }]. */
function folderStates(dir) {
  const manifestFile = path.join(dir, 'capture.json');
  const manifest = existsSync(manifestFile) ? readJsonFile(manifestFile, 'capture manifest') : null;
  const out = new Map();
  for (const [state, entry] of Object.entries(manifest?.states ?? {})) {
    const audit = inside(dir, entry?.audit) ?? inside(dir, `audit/${fileSafe(state)}.json`);
    if (!audit) continue;
    out.set(state, { state, audit, screenshot: inside(dir, entry?.screenshot) ?? inside(dir, `app/${fileSafe(state)}.png`) });
  }
  if (isDir(path.join(dir, 'audit'))) {
    for (const f of readdirSync(path.join(dir, 'audit')).filter((x) => x.endsWith('.json')).sort()) {
      const state = f.replace(/\.json$/, '');
      if ([...out.values()].some((s) => path.basename(s.audit) === f)) continue;
      const audit = inside(dir, `audit/${f}`);
      if (audit) out.set(state, { state, audit, screenshot: inside(dir, `app/${state}.png`) });
    }
  }
  return [...out.values()];
}

async function main(argv) {
  const { values } = parseCli(argv, {
    evidence: { type: 'string' },
    state: { type: 'string', multiple: true },
    screen: { type: 'string', multiple: true },
    config: { type: 'string' },
    tokens: { type: 'string', multiple: true },
    'token-map': { type: 'string' },
    catalog: { type: 'string' },
    'known-drifts': { type: 'string' },
    source: { type: 'string' },
    'no-page-tokens': { type: 'boolean' },
    'tolerance-px': { type: 'string' },
    'color-delta-e': { type: 'string' },
    samples: { type: 'string' },
    'report-dir': { type: 'string' },
    out: { type: 'string' },
    run: { type: 'string' },
    verbose: { type: 'boolean' },
    quiet: { type: 'boolean' },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const log = values.quiet ? () => {} : (msg) => console.log(msg);
  if (!values.evidence) throw usageError('--evidence <dir> is required (see --help)');
  const evidenceDir = path.resolve(values.evidence);
  if (!isDir(evidenceDir)) throw usageError(`--evidence ${oneLine(values.evidence)} is not a folder`);
  const reportDir = path.resolve(values['report-dir'] ?? path.dirname(evidenceDir));
  const outFile = path.resolve(values.out ?? path.join(evidenceDir, 'ds-audit.json'));
  assertRunOwnsOutput(outFile, values.run);
  const samples = toNumber(values.samples ?? '5', 'samples', { min: 1, max: 50, integer: true });

  // Config: tolerances and designSystem paths (inside the config's folder only).
  let config = null;
  let configDir = process.cwd();
  if (values.config) {
    const file = path.resolve(values.config);
    config = readJsonFile(file, 'config', 2);
    const cv = validateConfig(config);
    if (!cv.valid) throw usageError(`--config is invalid:\n${cv.errors.map((e) => `  ${oneLine(e.path)}: ${oneLine(e.message)}`).join('\n')}`);
    configDir = path.dirname(file);
  }
  const ds = config?.designSystem ?? {};
  const fromConfig = (key, value) => {
    const abs = path.resolve(configDir, value);
    assertInsideDir(configDir, abs, `config designSystem.${key}`);
    return abs;
  };
  const tolerance = (flag, key, fallback) => {
    if (values[flag] !== undefined) return { value: toNumber(values[flag], flag, { min: 0 }), from: 'flag' };
    const v = config?.tolerances?.[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return { value: v, from: 'config' };
    return { value: fallback, from: 'default' };
  };
  const px = tolerance('tolerance-px', 'px', 1);
  const de = tolerance('color-delta-e', 'colorDeltaE', DEFAULT_COLOR_DELTA_E);

  // States: the root folder and each screens/<id>/ folder.
  const wantStates = (values.state ?? []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
  const wantScreens = (values.screen ?? []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
  const folders = [{ screen: null, dir: evidenceDir }];
  const screensDir = path.join(evidenceDir, 'screens');
  if (isDir(screensDir)) {
    for (const id of readdirSync(screensDir).sort()) {
      const dir = path.join(screensDir, id);
      if (!isDir(dir)) continue;
      // Never follow a symlinked screen folder out of the evidence.
      try {
        if (!realpathSync(dir).startsWith(realpathSync(evidenceDir))) continue;
      } catch {
        continue;
      }
      folders.push({ screen: id, dir });
    }
  }
  const states = [];
  for (const { screen, dir } of folders) {
    if (wantScreens.length && !wantScreens.includes(screen ?? '')) continue;
    for (const s of folderStates(dir)) {
      const id = screen ? `${screen}/${s.state}` : s.state;
      if (wantStates.length && !wantStates.includes(id) && !wantStates.includes(s.state)) continue;
      states.push({ id, name: s.state, screen, dir, evidenceRoot: evidenceDir, audit: s.audit, screenshot: s.screenshot });
    }
  }
  if (!states.length) {
    throw usageError(
      `no audit file in ${oneLine(displayPath(evidenceDir))}${wantStates.length || wantScreens.length ? ' for the states or screens asked for' : ''}: ` +
        'capture.mjs writes audit/<state>.json for every captured state (screens/<id>/audit/ in a multi-screen pass); capture the app first',
    );
  }
  const audits = states.map((s) => ({ s, audit: readJsonFile(s.audit, 'audit file') }));
  for (const { s, audit } of audits) {
    if (!Array.isArray(audit?.elements)) throw usageError(`${oneLine(displayPath(s.audit))} is not an audit file (no elements list)`);
  }
  const rootFontSize = audits[0].audit.rootFontSize || 16;

  // Token sources, highest priority first.
  const sources = [];
  const warnings = [];
  const notes = [];
  const tokenFiles = [...(values.tokens ?? []).map((f) => path.resolve(f))];
  const cfgTokens = Array.isArray(ds.tokens) ? ds.tokens : typeof ds.tokens === 'string' ? [ds.tokens] : [];
  for (const f of cfgTokens) if (typeof f === 'string' && f.trim()) tokenFiles.push(fromConfig('tokens', f));
  const tokenMapFile = values['token-map'] ? path.resolve(values['token-map']) : typeof ds.tokenMap === 'string' && ds.tokenMap ? fromConfig('tokenMap', ds.tokenMap) : null;
  let set;
  try {
    for (const file of tokenFiles) sources.push({ kind: 'tokens-file', file: displayPath(file), parsed: loadTokenFile(file, rootFontSize) });
    if (tokenMapFile) {
      if (/\.json$/i.test(tokenMapFile)) sources.push({ kind: 'token-map', file: displayPath(tokenMapFile), parsed: loadTokenFile(tokenMapFile, rootFontSize) });
      else sources.push({ kind: 'token-map', file: displayPath(tokenMapFile), parsed: parseTokenMapFile(read(tokenMapFile, 'token map'), { file: displayPath(tokenMapFile), rootFontSize }) });
    }
    if (!values['no-page-tokens']) {
      const merged = {};
      for (const { audit } of audits) Object.assign(merged, audit.rootTokens ?? {});
      // An older capture without rootTokens in the audit file: the grab's computed/<state>.json has them.
      if (!Object.keys(merged).length) {
        for (const s of states) {
          const computed = path.join(s.dir, 'computed', `${fileSafe(s.name)}.json`);
          if (existsSync(computed)) Object.assign(merged, readJsonFile(computed, 'computed styles').rootTokens ?? {});
        }
      }
      if (Object.keys(merged).length) sources.push({ kind: 'page', file: null, parsed: pageTokens(merged, { rootFontSize }) });
    }
    set = buildTokenSet(sources);
    const page = sources.find((x) => x.kind === 'page')?.parsed;
    if (!set.tokens.length && !set.textStyles.length) {
      throw new Skip(`no style values to check against: no token file is configured and ${page?.internal ? `the page's ${page.internal} CSS variables are the framework's own (--tw-… and the like)` : values['no-page-tokens'] ? 'page variables are off' : 'the page defines no CSS variables'}|${values.config ? askStyle() : 'Pass --tokens <file> or --config'}`);
    }
    if (sources.every((x) => x.kind === 'page')) {
      if (set.tokens.length < MIN_PAGE_TOKENS) throw new Skip(`the page defines only ${set.tokens.length} CSS variable${set.tokens.length === 1 ? '' : 's'} of its own${page.internal ? ` (and ${page.internal} of the framework's: --tw-… and the like)` : ''}, too few to check against; the style source is unknown|${values.config ? askStyle() : 'Pass --tokens <file> or --config'}`);
      warnings.push("only the page's own :root custom properties are tokens: any variable the app defines counts as a token. Configure designSystem.tokens for a real check");
    }
  } catch (err) {
    if (!(err instanceof Skip)) throw err;
    const [reason, fix] = err.message.split('|');
    writeJson(outFile, { generatedAt: new Date().toISOString(), tool: 'ds-audit', note: AUDIT_NOTE, evidence: displayPath(evidenceDir), skipped: { reason, fix }, summary: { states: states.length, elementsChecked: 0, offTokenValues: 0, nonSystemComponents: 0, candidates: 0 }, candidates: [], warnings });
    throw usageError(`audit skipped: ${reason}. ${fix}.`);
  }
  for (const c of set.conflicts.slice(0, 20)) warnings.push(`token ${oneLine(c.name)} has two values: ${oneLine(c.kept.value)} (${c.kept.source.kind}) is used, ${oneLine(c.ignored.value)} (${c.ignored.source.kind}) ignored`);

  // Catalog, libraries, known drifts.
  const catalogFile = values.catalog ? path.resolve(values.catalog) : typeof ds.componentCatalog === 'string' && ds.componentCatalog ? fromConfig('componentCatalog', ds.componentCatalog) : null;
  const catalog = catalogFile ? readJsonFile(catalogFile, 'component catalog') : null;
  const libraries = normalizeLibraries(ds.libraries, { dsName: ds.name ?? null, catalog });
  const driftsFile = values['known-drifts'] ? path.resolve(values['known-drifts']) : typeof ds.knownDrifts === 'string' && ds.knownDrifts ? fromConfig('knownDrifts', ds.knownDrifts) : null;
  const drifts = driftsFile && existsSync(driftsFile) ? parseKnownDrifts(read(driftsFile, 'known drifts')) : [];
  if (driftsFile && !existsSync(driftsFile)) warnings.push(`known drifts file ${oneLine(displayPath(driftsFile))} not found: no drift hints`);
  if (values.source && !isDir(path.resolve(values.source))) throw usageError(`--source ${oneLine(values.source)} is not a folder`);
  // A design system built on a third-party library renders its classes: only the source tells wrapper and raw use apart.
  let rawImports = [];
  const wrapped = libraries.filter((l) => l.wrappedBy);
  if (wrapped.length) {
    const local = states.some((s) => {
      try {
        const u = new URL(readJsonFile(path.join(s.dir, 'capture.json'), 'capture manifest')?.url);
        return u.protocol === 'file:' || /^(?:localhost|127\.[\d.]+|\[::1\])$|\.localhost$/.test(u.hostname);
      } catch {
        return false;
      }
    });
    const root = values.source ? path.resolve(values.source) : local && values.config ? configDir : null;
    const names = `${wrapped.map((l) => l.name).join(', ')} (${wrapped[0].wrappedBy} is built on it)`;
    if (root) {
      const scan = scanRawImports(root, libraries);
      rawImports = scan.hits;
      if (scan.truncated) warnings.push(`the source check of ${names} stopped after ${scan.filesScanned} files`);
      for (const w of scan.unreadExports) warnings.push(`cannot read what ${w} exports (no readable package entry or folder index for its "package" in designSystem.libraries), so every direct import of the library it wraps is a candidate`);
      if (scan.skipped.length) notes.push(`direct imports of ${scan.skipped.join(', ')} are not candidates: ${wrapped[0].wrappedBy} exports no component of that name`);
    } else warnings.push(`${names}: on a deployed page wrapper and raw use look the same, so raw use cannot be told apart (run the pass against a local checkout, or pass --source <checkout>)`);
  }
  if (!libraries.some((l) => l.kind !== 'design-system') && !catalog) warnings.push('no third-party or legacy library in designSystem.libraries and no component catalog: only native controls are classified (third-party and legacy components cannot be told apart)');

  // Audit each state.
  const rel = (abs) => (abs ? path.relative(reportDir, abs).split(path.sep).join('/') : null);
  const results = audits.map(({ s, audit }) => {
    let image = null;
    if (s.screenshot) {
      try {
        const fd = readFileSync(s.screenshot);
        image = pngSize(fd);
      } catch {
        warnings.push(`${oneLine(s.id)}: the screenshot is not a readable PNG, so candidates there have no crop`);
      }
    } else warnings.push(`${oneLine(s.id)}: no app screenshot, so candidates there have no crop`);
    if (audit.truncated) warnings.push(`${oneLine(s.id)}: the collector kept ${audit.truncated.kept} of ${audit.truncated.rendered} rendered elements (${oneLine(audit.truncated.strategy ?? '')})${audit.truncated.walk ? `; ${oneLine(audit.truncated.walk.note)}` : ''}`);
    if (audit.fullPage === false && audit.page && image && audit.page.h > image.height) warnings.push(`${oneLine(s.id)}: the screenshot shows ${image.height} of the page's ${audit.page.h}px; elements below it have no crop. Capture the whole page`);
    if (audit.stats?.authoredVars?.stoppedByBudget) warnings.push(`${oneLine(s.id)}: tracing var() references stopped at its time budget; later elements have no authored-token proof`);
    // A single-screen Figma pass keeps its spec at the evidence root; a screen folder may too.
    let d = designFor(s.dir, s.name);
    if (!d.audit && !d.spec && s.dir !== evidenceDir) d = designFor(evidenceDir, s.name);
    const design = designSide(d);
    s.designFile = d.file ?? null;
    if (design.kind === 'figma' && !design.values) warnings.push(`${oneLine(s.id)}: the Figma spec has no style values (MCP path), so no candidate can be checked against the design; check each one by hand`);
    else if (design.kind === 'none') warnings.push(`${oneLine(s.id)}: no design-side data (design-audit/ or figma-spec.json), so no candidate can be checked against the design; check each one by hand`);
    return auditState({ audit, state: { id: s.id, name: s.name, screen: s.screen }, set, libraries, catalog, image, design, tolerancePx: px.value, colorDeltaE: de.value });
  });
  const unsupported = [...new Set(results.flatMap((r) => r.unsupportedSelectors))];
  for (const sel of unsupported) warnings.push(`selector ${oneLine(sel)} needs the page to evaluate it (combinators or pseudo-classes); capture with it in the collector's selectors`);
  const byId = new Map(states.map((s) => [s.id, s]));
  const { groups, candidates, designAlso } = buildCandidates(results, {
    evidencePaths: (st) => ({ screenshot: rel(byId.get(st.id)?.screenshot), audit: rel(byId.get(st.id)?.audit) }),
    samples,
    drifts,
    tolerancePx: px.value,
    colorDeltaE: de.value,
    rawImports,
    catalog,
  });

  const sourceHints = values.source ? scanSourceImports(path.resolve(values.source), libraries) : null;

  const uncheckedCategories = {};
  for (const cat of AUDIT_CATEGORIES) {
    if (set.pools[cat].length) continue;
    if (['font-size', 'line-height', 'font-weight', 'letter-spacing', 'font-family'].includes(cat) && set.textStyles.length) continue;
    const n = results.reduce((sum, r) => sum + (r.unchecked[cat] ?? 0), 0);
    uncheckedCategories[cat] = `no ${cat} tokens in the sources${n ? `: ${n} value(s) not checked` : ''}`;
  }
  // Non-system components: the elements behind the component candidates (third-party,
  // legacy and native controls where the design system has a component), every state.
  const nonSystemComponents = candidates.filter((c) => c.ledger === 'component').reduce((n, c) => n + c._audit.count, 0);
  const stateSummary = Object.fromEntries(results.map((r) => [r.state.id, {
    screen: r.state.screen,
    audit: rel(byId.get(r.state.id).audit),
    screenshot: rel(byId.get(r.state.id).screenshot),
    designData: rel(byId.get(r.state.id).designFile),
    image: r.image,
    ...r.stats,
    offTokenMembers: r.styleMembers.filter((m) => m.status === 'off').length,
    nearMissMembers: r.styleMembers.filter((m) => m.status === 'near').length,
    libraries: r.libraries,
  }]));
  const count = (pred) => candidates.filter(pred).length;
  const summary = {
    ...tokenComplianceSummary(results),
    elementsChecked: results.reduce((n, r) => n + r.stats.elementsChecked, 0),
    offTokenValues: count((c) => c.ledger === 'style' && !['token-usage', 'wrong-token'].includes(c._audit.kind)),
    nonSystemComponents,
    output: rel(outFile),
    states: results.length,
    candidates: candidates.length,
    // The design check: candidates whose design has another value, groups the design shares
    // (not emitted: design and code agree), candidates with no design value to compare.
    designDifferent: count((c) => c._audit.designCheck === 'different'),
    designSame: count((c) => c._audit.designCheck === 'same'),
    designAlso: designAlso.length,
    designUnknown: count((c) => c._audit.designCheck === 'unknown'),
    byKind: {
      offToken: count((c) => c._audit.kind === 'off-token'),
      nearMiss: count((c) => c._audit.kind === 'near-miss'),
      textStyle: count((c) => c._audit.kind === 'text-style'),
      tokenUsage: count((c) => c._audit.kind === 'token-usage'),
      wrongToken: count((c) => c._audit.kind === 'wrong-token'),
      component: count((c) => c._audit.kind === 'component'),
    },
    bySeverity: { BLOCKER: count((c) => c.severity === 'BLOCKER'), WARNING: count((c) => c.severity === 'WARNING'), DS_CANDIDATE: count((c) => c.severity === 'DS_CANDIDATE') },
    tokenMatches: { verified: groups.matches.reduce((n, m) => n + m.verified, 0), unverified: groups.matches.reduce((n, m) => n + m.unverified, 0) },
  };
  const result = {
    generatedAt: new Date().toISOString(),
    tool: 'ds-audit',
    note: AUDIT_NOTE,
    evidence: displayPath(evidenceDir),
    reportDir: displayPath(reportDir),
    options: {
      tolerancePx: px.value,
      colorDeltaE: de.value,
      tolerancesFrom: { px: px.from, colorDeltaE: de.from },
      samples,
      config: values.config ?? null,
      tokens: tokenFiles.map((f) => displayPath(f)),
      tokenMap: tokenMapFile ? displayPath(tokenMapFile) : null,
      catalog: catalogFile ? displayPath(catalogFile) : null,
      knownDrifts: driftsFile ? displayPath(driftsFile) : null,
      pageTokens: !values['no-page-tokens'],
      source: values.source ?? null,
    },
    tokenSources: set.sources,
    textStyles: set.textStyles.length,
    uncheckedCategories,
    libraries: libraries.map(({ name, kind, classPrefix, selector, package: pkg, implicit, wraps, wrappedBy }) => ({ name, kind, classPrefix, selector, package: pkg, ...(implicit ? { implicit: true } : {}), ...(wraps ? { wraps } : {}), ...(wrappedBy ? { wrappedBy } : {}) })),
    summary,
    states: stateSummary,
    groups,
    candidates,
    designAlso,
    sourceHints,
    warnings,
  };
  writeJson(outFile, result);

  // Readable summary. Page-derived text is folded to one line.
  const src = set.sources.map((s) => `${s.kind}${s.file ? ` ${oneLine(s.file)}` : ''} (${s.tokens} tokens${s.textStyles ? `, ${s.textStyles} text styles` : ''})`).join(' · ');
  log(`Design-system audit: ${summary.states} state(s), ${summary.elementsChecked} rendered elements checked (${results.map((r) => `${oneLine(r.state.id)} ${r.stats.elementsChecked}`).join(', ')})`);
  log(`Tokens: ${src}`);
  log(`Off-token values: ${summary.offTokenValues} (${summary.byKind.offToken} off-token, ${summary.byKind.nearMiss} near miss, ${summary.byKind.textStyle} text style) · non-system components: ${summary.nonSystemComponents} in ${summary.byKind.component} candidate(s) · token matches: ${summary.tokenMatches.verified} proven by var(), ${summary.tokenMatches.unverified} by value only`);
  log(`Token compliance: ${summary.tokenUsageVerified}/${summary.tokenChecks} property/state checks have verified token usage · ${summary.tokenDeviationChecks} deviations · ${summary.tokenUsageUnverified} usage unverified (including equal rendered values). Excludes unchecked/component-covered values.`);
  log(`Design check: ${summary.designDifferent} real difference(s) (the design has another value) · ${summary.designAlso} shared component groups (not emitted) · ${summary.designUnknown} design unknown (verify semantic tokens and source before filing)`);
  if (designAlso.length) log(`${designAlso.length} shared component group(s) omitted; token contracts remain candidates`);
  if (candidates.length) {
    log(`Candidates (file as FIX_CODE, INTENTIONAL with a person's signoff, or a known drift; content is rejected DATA, never filed as DATA; refer to each by its key):`);
    const shownCandidates = values.verbose ? candidates : candidates.slice(0, SHOWN_CANDIDATES);
    for (const c of shownCandidates) {
      const hint = c._audit.knownDriftHint ? ` · maybe ${c._audit.knownDriftHint.id}` : '';
      const dc = c._audit.designCheck === 'unknown' ? ' · design unknown' : '';
      log(`  [${c.severity}] ${oneLine(c.key)} — ${oneLine(c.title)}${c.state ? ` · ${oneLine(c.state)}` : ''}${c.evidence.some((e) => e.crop) ? '' : ' · unpinned'}${dc}${hint}`);
    }
    if (shownCandidates.length < candidates.length) log(`  … ${candidates.length - shownCandidates.length} more in ${oneLine(displayPath(outFile))} (or --verbose)`);
  } else log('Candidates: none');
  // One line for every category without tokens (the reasons are in ds-audit.json).
  const unchecked = Object.keys(uncheckedCategories).map((cat) => {
    const n = results.reduce((sum, r) => sum + (r.unchecked[cat] ?? 0), 0);
    return n ? `${cat} (${n} value(s))` : cat;
  });
  if (unchecked.length) log(`Not checked, no tokens of these kinds in the sources: ${unchecked.join(', ')}`);
  for (const n of notes) log(`Note: ${n}`);
  for (const w of warnings) log(`Warning: ${w}`);
  log(`Wrote ${displayPath(outFile)}`);
  return 0;
}

runMain(import.meta.url, main);
