#!/usr/bin/env node
// Compare a design-side capture (coded prototype, capture.mjs --side design) and/or a
// Figma spec's prototype motion with the app capture: style, token, component, motion
// and structure rows per state in compare.json. Never writes report.json.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { displayPath, parseCli, readJsonFile, runMain, toNumber, usageError, writeJson } from './lib/args.mjs';
import {
  ALPHA_TOLERANCE,
  DEFAULT_COLOR_DELTA_E,
  compareFigmaMotion,
  compareState,
  dedupeMotion,
  dedupeRepeats,
  parseTokenCategories,
  parseTokenMap,
  summarize,
} from './lib/compare.mjs';
import { validateConfig } from './lib/schema-check.mjs';

const HELP = `Compare the design (coded prototype capture and/or Figma prototype motion) with the app capture.

Usage:
  node scripts/compare.mjs --design <dir>/evidence --app <dir>/evidence --out <dir>/evidence/compare.json [options]
  node scripts/compare.mjs --figma-spec <dir>/figma-spec.json --app <dir>/evidence --out <file> [options]

Options:
  --design <dir>             folder holding design-capture.json, design-computed/, design-motion/,
                             design-dom/ (capture.mjs --side design); default: --app when it has them
  --app <dir>                folder holding capture.json, computed/, motion/, dom/ (required)
  --figma-spec <file>        also check the Figma prototype's transitions (figma-spec.json "motion",
                             from reactions) against the app state whose driver performs the
                             trigger (hover → action "hover", press → "active", click → "click")
  --states <a,b>             only these states (default: every state captured on the design side)
  --token-map <file>         extra token values: JSON { "--token": "value" } or the markdown token map;
                             its section headings (## Spacing, ## Radius…) or JSON "categories"
                             set token categories
  --catalog <file>           component catalog (components.<name>.selector / className / testid /
                             testidPrefix) used to name components that carry no data-component
                             attribute; a data-testid alone never names a component
  --config <file>            design-qa.config.json: tolerances.px and tolerances.colorDeltaE
  --tolerance-px <n>         px tolerance for style values (default: config tolerances.px, else 1)
  --color-delta-e <n>        colour tolerance, CIEDE2000 ΔE (default: config tolerances.colorDeltaE,
                             else 1.5)
  --duration-tolerance-ms <n>
                             duration / delay tolerance for motion (default 20)
  --out <file>               output (default: <app>/compare.json)
  --quiet                    only print errors
  -h, --help                 show this help

Elements are compared within an element class (same --grab on both sides; see Pairing
below). Token tracing is property-aware: a value is only matched to a token whose
category fits the property (radius ↔ radius, padding / margin / gap ↔ space, colours ↔
colour, font-size ↔ type, shadow ↔ shadow / elevation, duration / easing ↔ motion), taken
from the token map's sections, else the token name, else its value; no fitting token = null
(hardcoded), never a token of another kind. Durations compare across s / ms, easings across
keywords and cubic-bezier (ease-out = cubic-bezier(0,0,0.58,1)).

Colours: hex, rgb(a), hsl(a), hwb, lab, lch, oklab, oklch, color(srgb | srgb-linear |
display-p3 | a98-rgb | prophoto-rgb | rec2020 | xyz | xyz-d50 | xyz-d65 …) and named colours,
with "none" components, percentages and "/ alpha", are converted to CIELAB (unclamped: a
display-p3 colour outside sRGB keeps its chroma) and match when the CIEDE2000 ΔE is <= the
colour tolerance and alpha differs by at most 0.01. Two fully transparent colours match
whatever their RGB. The same rule applies to every colour inside a value (box-shadow,
border, outline, background, gradients); lengths inside it use the px tolerance. A colour
within tolerance but not identical still gets a tokens row when the design value traces to
a token and no token produces the app's value (a hand-typed near miss).

compare.json: { generatedAt, design, app, figmaSpec, options: { tolerancePx, colorDeltaE,
  alphaTolerance, durationToleranceMs, tolerancesFrom: { px, colorDeltaE: "flag" | "config" |
  "default" }, config, tokenMap, catalog }, states: { "<state>": {
  style: [ { state, elementClass, index, selector, text, property, design, app, delta,
             deltaE (colour values only), result } ],
  tokens: [ { state, elementClass, index, selector, text, property, expectedToken, expectedValue,
              actualToken (null = hardcoded), actualValue, result: "FAIL", note } ],
  components: [ { state, elementClass, index, selector, text, design: { component, variant, source },
                  app: { … } | null, result } ],
  motion: [ ledgers.motion rows: { state, selector, figmaNodeId, trigger, property,
            expected: { type, durationMs, easing, delayMs, detail }, observed: { … } | null,
            result, findingIds: [], _compare: { elementClass, index, key, reasons,
            expectedText, observedText } } ],
  structure: [ { state, source: computed|dom, elementClass, index, selector, text|role+name,
                 design, app, result: "FAIL" | "CANNOT_VERIFY",
                 note: "missing in app" | "extra in app" | "not sampled in the app: …" | … } ] } },
  (an element missing or hidden on one side is a structure row only, never a component row;
  text is the design element's text)
  figmaMotion: [ motion rows from --figma-spec ], missingInApp: [ states designed but not
  captured in the app ], summary: { states, style, tokens, components, motion, structure,
repeatsDropped } }. A style, token, component or structure FAIL that repeats an earlier state's
row (same element: element class, index, selector and text; same property and values) is
dropped: one difference, one row.

Pairing: samples of one element class pair by equal text first, then the remaining samples
of both sides in order (texts may be data). When a side's selector matched more elements than
the grab limit captured (count > samples), a leftover on the other side may be one of the
unsampled elements: a CANNOT_VERIFY structure row ("not sampled …"), not missing / extra.
observed null = the app does not animate at all (missing motion, FAIL); expected.type "none"
= the app animates where the design does not (extra motion, FAIL). A motion checked under
an interaction (hover, focus, press, click) is listed in that state only; other repeats of
the same element + property keep the first state's row. Turn FAIL rows into findings; the
motion rows can be pasted into ledgers.motion.

Exit codes: 0 ok (differences are data, not errors) · 2 bad arguments or unreadable captures`;

const SIDES = {
  design: { manifest: 'design-capture.json', computed: 'design-computed', motion: 'design-motion', dom: 'design-dom' },
  app: { manifest: 'capture.json', computed: 'computed', motion: 'motion', dom: 'dom' },
};

function readOptional(file, label) {
  return file && existsSync(file) ? readJsonFile(file, label) : null;
}

/** { states: { <state>: { driver, computed, motion, dom } } } for one capture folder. */
function loadSide(dir, side) {
  const names = SIDES[side];
  const manifest = readOptional(path.join(dir, names.manifest), `${side} manifest`);
  const states = {};
  if (manifest?.states) {
    for (const [state, entry] of Object.entries(manifest.states)) {
      if (!entry?.computed) continue;
      states[state] = {
        driver: entry.driver ?? {},
        computed: readOptional(path.join(dir, entry.computed), `${side} computed`),
        motion: readOptional(entry.motion ? path.join(dir, entry.motion) : null, `${side} motion`),
        dom: readOptional(entry.dom ? path.join(dir, entry.dom) : null, `${side} dom`),
      };
    }
  } else if (existsSync(path.join(dir, names.computed))) {
    // No manifest (MCP / built-in browser capture): use the files that exist.
    for (const file of readdirSync(path.join(dir, names.computed)).filter((f) => f.endsWith('.json'))) {
      const state = file.replace(/\.json$/, '');
      states[state] = {
        driver: {},
        computed: readJsonFile(path.join(dir, names.computed, file), `${side} computed`),
        motion: readOptional(path.join(dir, names.motion, file), `${side} motion`),
        dom: readOptional(path.join(dir, names.dom, file), `${side} dom`),
      };
    }
  }
  return { manifest, states };
}

/** design-qa.config.json, validated; tolerances.px and tolerances.colorDeltaE must be numbers >= 0. */
function loadConfig(file) {
  const config = readJsonFile(file, 'config', 2);
  const cv = validateConfig(config);
  if (!cv.valid) throw usageError(`--config is invalid:\n${cv.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
  for (const key of ['px', 'colorDeltaE']) {
    const v = config?.tolerances?.[key];
    if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) {
      throw usageError(`--config: tolerances.${key} must be a number >= 0 (got ${JSON.stringify(v)})`);
    }
  }
  return config;
}

async function main(argv) {
  const { values } = parseCli(argv, {
    design: { type: 'string' },
    app: { type: 'string' },
    'figma-spec': { type: 'string' },
    states: { type: 'string' },
    'token-map': { type: 'string' },
    catalog: { type: 'string' },
    config: { type: 'string' },
    'tolerance-px': { type: 'string' },
    'color-delta-e': { type: 'string' },
    'duration-tolerance-ms': { type: 'string' },
    out: { type: 'string' },
    quiet: { type: 'boolean' },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const log = values.quiet ? () => {} : (msg) => console.log(msg);
  if (!values.app) throw usageError('--app <dir> is required (see --help)');
  const appDir = path.resolve(values.app);
  const config = values.config ? loadConfig(path.resolve(values.config)) : null;
  const tolerance = (flag, key, fallback) => {
    if (values[flag] !== undefined) return { value: toNumber(values[flag], flag, { min: 0 }), from: 'flag' };
    if (config?.tolerances?.[key] !== undefined) return { value: config.tolerances[key], from: 'config' };
    return { value: fallback, from: 'default' };
  };
  const px = tolerance('tolerance-px', 'px', 1);
  const deltaE = tolerance('color-delta-e', 'colorDeltaE', DEFAULT_COLOR_DELTA_E);
  const tolerancePx = px.value;
  const colorDeltaE = deltaE.value;
  const durationToleranceMs = toNumber(values['duration-tolerance-ms'] ?? '20', 'duration-tolerance-ms', { min: 0 });
  const only = values.states ? values.states.split(',').map((s) => s.trim()).filter(Boolean) : null;

  const app = loadSide(appDir, 'app');
  if (!Object.keys(app.states).length) throw usageError(`no app capture in ${values.app} (expected capture.json or computed/<state>.json)`);
  const designDir = path.resolve(values.design ?? values.app);
  const design = loadSide(designDir, 'design');
  const figmaSpec = values['figma-spec'] ? readJsonFile(path.resolve(values['figma-spec']), 'figma spec') : null;
  if (!Object.keys(design.states).length && !figmaSpec) {
    throw usageError(`no design capture in ${values.design ?? values.app} (expected design-capture.json or design-computed/; capture the prototype with capture.mjs --side design) and no --figma-spec`);
  }
  let tokenMap = {};
  let tokenCategories = null;
  if (values['token-map']) {
    const file = path.resolve(values['token-map']);
    try {
      const text = readFileSync(file, 'utf8');
      const format = file.endsWith('.json') ? 'json' : null;
      tokenMap = parseTokenMap(text, { format });
      tokenCategories = parseTokenCategories(text, { format });
    } catch (err) {
      throw usageError(`--token-map ${values['token-map']}: ${err.message}`);
    }
  }
  const catalog = values.catalog ? readJsonFile(path.resolve(values.catalog), 'component catalog') : null;

  const states = {};
  const missingInApp = [];
  for (const [state, d] of Object.entries(design.states)) {
    if (only && !only.includes(state)) continue;
    const a = app.states[state];
    if (!a) {
      missingInApp.push(state);
      continue;
    }
    states[state] = compareState({ state, design: d, app: a, tokenMap, tokenCategories, catalog, tolerancePx, colorDeltaE, durationToleranceMs });
  }
  if (only) {
    for (const state of only) {
      if (!design.states[state] && figmaSpec === null) throw usageError(`--states: "${state}" was not captured on the design side`);
    }
  }
  dedupeMotion(states);
  const { dropped: repeatsDropped } = dedupeRepeats(states);
  const appStates = Object.fromEntries(Object.entries(app.states).filter(([s]) => !only || only.includes(s)));
  const figmaMotion = figmaSpec ? compareFigmaMotion(figmaSpec, appStates, { durationToleranceMs }) : [];

  const outFile = path.resolve(values.out ?? path.join(appDir, 'compare.json'));
  const result = {
    generatedAt: new Date().toISOString(),
    design: Object.keys(design.states).length ? { dir: displayPath(designDir), url: design.manifest?.url ?? null, source: design.manifest?.source ?? null } : null,
    app: { dir: displayPath(appDir), url: app.manifest?.url ?? null },
    figmaSpec: values['figma-spec'] ? displayPath(path.resolve(values['figma-spec'])) : null,
    options: {
      tolerancePx,
      colorDeltaE,
      alphaTolerance: ALPHA_TOLERANCE,
      durationToleranceMs,
      tolerancesFrom: { px: px.from, colorDeltaE: deltaE.from },
      config: values.config ?? null,
      tokenMap: values['token-map'] ?? null,
      catalog: values.catalog ?? null,
    },
    states,
    figmaMotion,
    missingInApp,
    summary: { ...summarize(states, figmaMotion), repeatsDropped },
  };
  writeJson(outFile, result);

  const s = result.summary;
  log(
    `Compared ${s.states} state(s): style ${s.style.fail} FAIL / ${s.style.pass} PASS · tokens ${s.tokens.fail} mismatch(es) (${s.tokens.hardcoded} hardcoded) · ` +
      `components ${s.components.fail} FAIL · motion ${s.motion.fail} FAIL (${s.motion.missing} missing, ${s.motion.extra} extra), ${s.motion.cannotVerify} cannot verify · ` +
      `structure ${s.structure.missingInApp} missing / ${s.structure.extraInApp} extra in app` +
      (s.structure.cannotVerify ? `, ${s.structure.cannotVerify} not sampled (cannot verify)` : ''),
  );
  log(`Tolerances: ${tolerancePx}px (${px.from}), colour ΔE ${colorDeltaE} (${deltaE.from}), alpha ${ALPHA_TOLERANCE}`);
  if (repeatsDropped) log(`Dropped ${repeatsDropped} row(s) repeating an earlier state's difference`);
  if (missingInApp.length) log(`Designed but not captured in the app: ${missingInApp.join(', ')}`);
  log(`Wrote ${displayPath(outFile)}`);
  return 0;
}

runMain(import.meta.url, main);
