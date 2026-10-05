#!/usr/bin/env node
// The worklist: every place where the design and the app differ, over the whole page of
// every compared state, as a short bounded list an agent decides item by item. Reads the
// report folder's evidence (never anything outside it); writes worklist.md,
// evidence/worklist.json and one small crop image per listed item.
import path from 'node:path';
import { displayPath, oneLine, parseCli, readJsonFile, runMain, toNumber, usageError } from './lib/args.mjs';
import { assertRunOwnsDir, callerRunId } from './lib/run-lock.mjs';
import { buildWorklist, WORKLIST_DEFAULTS } from './lib/worklist.mjs';

const D = WORKLIST_DEFAULTS;
const HELP = `Turn the design ↔ app comparison into a short worklist: one item per place that differs.

Usage:
  node scripts/worklist.mjs --dir <report dir> [--config design-qa.config.json]
                            [--state <s>…] [--screen <id>…] [--max-per-state n] [--max-total n] [--run <id>]

Options:
  --dir <dir>            the report folder (qa-reports/<feature>): state-matrix.json and
                         evidence/ (capture.json, app/, figma/ or design/, audit/ or computed/,
                         figma-spec.json, ds-audit.json; evidence/screens/<id>/ per screen)
  --config <file>        design-qa.config.json: tolerances.px and tolerances.colorDeltaE for
                         the value and size hints (defaults ${D.tolerancePx} px and ΔE ${D.colorDeltaE})
  --state <s>            only these states (repeatable or comma-separated; "<screen>/<state>"
                         or the state name)
  --screen <id>          only these screens (repeatable)
  --max-per-state <n>    items listed per state (default ${D.maxPerState})
  --max-total <n>        items listed in all (default ${D.maxTotal})
  --max-lines <n>        hard bound on worklist.md lines (default ${D.maxLines})
  --threshold <0..1>     pixelmatch colour threshold (default ${D.threshold})
  --diff-panel           add a third "diff" panel to each crop image (more pixels to read)
  --run <id>             this pass's run id (default: DESIGN_QA_RUN_ID); refused (exit 5) when
                         another run holds the folder, or without it while a run does
  --json                 print the summary as JSON
  --quiet                print errors only
  -h, --help             show this help

What it does, per state that has both images: aligns the design to the app capture (a
section missing or added mid-page becomes ONE missing-in-app / extra-in-app item instead of
a page of differences), pixel-diffs the whole page (both widths and heights), clusters the
differing pixels into areas (neighbours merged, speckle dropped, giant areas split along
section lines, each snapped to the element or layer that holds it), lists the design layers
and app elements in each area with deterministic hints (text on one side only, likely
DATA, value and size differences of matched pairs, layers with nothing in the app there,
clipped scroll panels, ds-audit candidates there), then merges the same difference across
the states of a screen into one item ("also in"), ranks and caps.

Writes:
  <dir>/worklist.md               the one file to read: coverage per state, then the items
  <dir>/evidence/worklist.json    { generatedAt, caps, coverage: { <state>: … }, items: [ { key,
                                  screen, state, alsoIn, kind: region | missing-in-app |
                                  extra-in-app, rect, crop, designRect, designCrop, image,
                                  images, percentOfPage, design, app, hints: [ { kind, text } ],
                                  occurrences } ], unlisted: [ …same, no image ], warnings }
  <dir>/evidence/worklist/[<screen>/]<state>/<item>.png   one crop per listed item (design |
                                  app, ≤ ${D.imageMaxWidth}×${D.imageMaxHeight} px, tall areas as -2, -3 … tiles)

rect and crop are in the state's app capture pixels (crop clipped to the image; for a
missing-in-app item, the place in the app where the design part belongs); designRect and
designCrop in the design image's pixels. Keys are stable across runs on the same evidence.
Every listed key must end up as a finding ("worklist": "<key>") or a rejection with one reason:
DATA · same · duplicate (+ duplicateOf) · known-drift (+ knownDrift) · covered-by-audit
(+ coveredBy) · matches-design · intentional · out-of-scope. Unlisted items count against
match and keep the verdict at REVIEW.

Exit codes: 0 written (whatever it found; a state that could not be compared is listed in
the coverage with the reason) · 1 cannot write · 2 bad arguments, no report folder, or no
state to compare · 4 a missing npm package (pngjs, pixelmatch) · 5 another run holds the folder`;

async function main(argv) {
  const { values } = parseCli(argv, {
    dir: { type: 'string' },
    config: { type: 'string' },
    state: { type: 'string', multiple: true },
    screen: { type: 'string', multiple: true },
    'max-per-state': { type: 'string' },
    'max-total': { type: 'string' },
    'max-lines': { type: 'string' },
    threshold: { type: 'string' },
    'diff-panel': { type: 'boolean' },
    run: { type: 'string' },
    json: { type: 'boolean' },
    quiet: { type: 'boolean' },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (!values.dir) throw usageError('--dir <report dir> is required (see --help)');
  const dir = path.resolve(values.dir);
  assertRunOwnsDir(dir, { runId: callerRunId(values.run) });
  let tolerances = {};
  if (values.config) {
    const config = readJsonFile(path.resolve(values.config), 'config', 2);
    const t = config && typeof config === 'object' ? config.tolerances ?? {} : {};
    tolerances = {
      px: Number.isFinite(t.px) && t.px >= 0 ? t.px : undefined,
      colorDeltaE: Number.isFinite(t.colorDeltaE) && t.colorDeltaE >= 0 ? t.colorDeltaE : undefined,
    };
  }
  const { data } = buildWorklist(dir, {
    states: values.state ?? [],
    screens: values.screen ?? [],
    maxPerState: toNumber(values['max-per-state'], 'max-per-state', { min: 1, max: 100, integer: true }),
    maxTotal: toNumber(values['max-total'], 'max-total', { min: 1, max: 500, integer: true }),
    maxLines: toNumber(values['max-lines'], 'max-lines', { min: 40, max: 5000, integer: true }),
    threshold: toNumber(values.threshold, 'threshold', { min: 0, max: 1 }),
    diffPanel: Boolean(values['diff-panel']),
    tolerances,
  });
  const states = Object.values(data.coverage);
  const compared = states.filter((c) => c.compared);
  const shared = data.items.filter((it) => it.alsoIn.length).length;
  const images = data.items.reduce((n, it) => n + (it.images?.length ?? 0), 0);
  const summary = {
    worklist: path.join(dir, 'worklist.md'),
    json: path.join(dir, 'evidence', 'worklist.json'),
    items: data.items.length,
    shared,
    unlisted: data.unlisted.length,
    images,
    states: states.length,
    compared: compared.length,
    notCompared: states.filter((c) => !c.compared).map((c) => ({ state: c.state, reason: c.reason })),
  };
  if (values.json) {
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }
  if (values.quiet) return 0;
  console.log(`Worklist: ${data.items.length} item(s) to decide (${shared} shared by several states), ${data.unlisted.length} more not listed, over ${compared.length} of ${states.length} state(s).`);
  for (const c of states.filter((s) => !s.compared)) console.log(`  not compared: ${oneLine(c.state)}: ${oneLine(c.reason)}`);
  console.log(`Read: ${oneLine(displayPath(summary.worklist))} (${images} crop image(s) under evidence/worklist/)`);
  return 0;
}

runMain(import.meta.url, main);
