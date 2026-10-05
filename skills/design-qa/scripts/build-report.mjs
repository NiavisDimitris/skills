#!/usr/bin/env node
// Build report.json from the pass's evidence plus findings.json, the one file the agent
// writes by hand. See --help and references/report.md ("Building report.json").
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, displayPath, oneLine, parseCli, readJsonFile, runMain, scriptCommand, usageError, withFileLocks, writeJson } from './lib/args.mjs';
import { FINDINGS_KIND, buildReport, summaryLines } from './lib/build-report.mjs';
import { scorecardHeadline } from './lib/ranking.mjs';
import { shellArg } from './lib/review-context.mjs';
import { EXIT_CONFLICT, assertRunOwnsDir, callerRunId } from './lib/run-lock.mjs';
import { validateConfig } from './lib/schema-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODES = ['audit', 'fix', 'ci'];

const HELP = `Build report.json from the evidence of a pass and the findings you wrote.

Usage:
  node scripts/build-report.mjs --dir <report folder> [--findings <dir>/findings.json]
                                [--config design-qa.config.json] [--mode audit|fix|ci]
                                [--run <id>] [--out <dir>/report.json] [--check] [--quiet]

You write only findings.json (template: references/templates/findings.template.json):
the findings (judgment: title, ledger, state, severity, resolution, expected vs actual,
fix, a pin), worklist items and audit candidates covered, filed or rejected (several keys
per rejection), compare.json FAIL rows rejected, open decisions, per-state result
overrides, ledger rows, fix-loop iterations ("fixLoop": merged by iteration with the existing
report's; the findings file wins for an iteration it lists) and pass-level overrides ("pass").
Everything else is assembled from <dir>:
  state-matrix.json, backfill-candidates.json, evidence/figma-spec.json, screens.json,
  ticket.json, capture.json, design-capture.json, diff.json (diff.mjs --json output),
  compare.json, ds-audit.json, worklist.json, computed/ dom/ motion/ audit/<state>.json
  (multi-screen: evidence/screens/<id>/…), the existing report.json and the
  cumulative dismissed log (../dismissed.json).

Options:
  --dir <dir>         the report folder (required)
  --findings <file>   the findings file (default: <dir>/findings.json)
  --config <file>     design-qa.config.json: tolerances, report.topN / ranking, and
                      designSystem.knownDrifts (default: ./design-qa.config.json when present)
  --mode <mode>       meta.mode: audit (default), fix or ci (else pass.mode, else the
                      existing report's mode)
  --run <id>          this pass's run id (default: DESIGN_QA_RUN_ID); the folder's run lock
                      must name it
  --out <file>        the report to write, inside --dir (default: <dir>/report.json)
  --check             check the findings file and print what would be built; write nothing
  --fresh             build without carrying anything from an existing report.json that is
                      not provably this run's (no run lock, or no meta.runId): it is replaced
  --quiet             print problems and warnings only
  -h, --help          show this help

What the build does:
  - Pins: a finding's "pin" ({ selector } | { grab, index } | { audit } | { crop } |
    { side: "design", figmaNode }) is resolved to a crop from the grabbed boxes
    (computed/<state>.json __rect, audit/<state>.json rect), clipped to the image, on the
    app screenshot (or the design image). Several matches: the topmost is pinned and the
    choice is printed; no match: an error listing near matches.
  - Every worklist.json item is covered by a finding ({ "worklist": "<key>" }: it pins the
    finding on the item's crop when the finding has no pin) or rejected; every ds-audit.json
    candidate is filed ({ "auditKey" }) or rejected; every compare.json FAIL row is covered
    by a finding or rejected. One rejection may name several keys (auditKeys, worklist,
    compare lists) with one reason. Otherwise nothing is written.
  - Known drifts (designSystem.knownDrifts): a finding that looks like an active drift it
    does not cite fails with "this looks like KD-n"; cite it, or say why it differs in
    "notKnownDrift".
  - The whole page: a verified state whose app image is smaller than its page fails
    (unless pass.degradations has { "step": "capture-coverage:<state>", … }); captured.page carries the capture's
    page size, PNG size, fullPage and clipped panels for the validator.
  - meta, the state matrix (results from the captures and the findings), pixel diffs, ids,
    ranks and the scorecard are derived. Rebuilding in the same run keeps each finding's
    id when it is the same finding (ledger | state | selector | property) and keeps the
    backfill, triage (ticket keys included), fixLoop and recorded dismissals and
    sign-offs; what no longer fits is listed as dropped.
  - The result is validated as validate.mjs does, evidence gates as errors. report.json
    is written (atomically) only when it is valid; every problem names the place in the
    findings file to change.

Exit codes: 0 built (or --check passed) · 1 problems in the findings file or the evidence
(listed; nothing written), or a write error · 2 bad arguments, an unreadable findings or
config file · 5 another run owns the folder, or the existing report.json is not provably
this run's (another run id, no run lock, or no meta.runId: start a fresh pass with run.mjs
start, or --fresh)`;

const show = (p) => oneLine(displayPath(p));

/** A JSON file that is not a symbolic link, or null when it does not exist. */
function readOwnJson(file, label) {
  let st;
  try {
    st = lstatSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new CliError(`cannot read ${label} ${show(file)}: ${err.message}`, 1);
  }
  if (st.isSymbolicLink()) throw new CliError(`${label} ${show(file)} is a symbolic link: refused`, 1);
  if (!st.isFile()) throw new CliError(`${label} ${show(file)} is not a file`, 1);
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    throw new CliError(`${label} ${show(file)} is not valid JSON (${oneLine(err.message)}): move it away or fix it, then build again`, 1);
  }
}

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim() || null;
  } catch {
    return null;
  }
}

function skillVersion() {
  try {
    return JSON.parse(readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export async function main(argv) {
  const { values } = parseCli(argv, {
    dir: { type: 'string' },
    findings: { type: 'string' },
    config: { type: 'string' },
    mode: { type: 'string' },
    run: { type: 'string' },
    out: { type: 'string' },
    check: { type: 'boolean' },
    fresh: { type: 'boolean' },
    quiet: { type: 'boolean' },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (!values.dir) throw usageError('--dir <report folder> is required\nRun with --help for usage.');
  if (values.mode !== undefined && !MODES.includes(values.mode)) throw usageError(`--mode: expected ${MODES.join(', ')} (got "${oneLine(values.mode)}")`);
  const dir = path.resolve(values.dir);
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    throw usageError(`--dir ${show(dir)} does not exist`);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw usageError(`--dir ${show(dir)} is not a folder (a symbolic link or a file)`);
  const out = path.resolve(values.out ?? path.join(dir, 'report.json'));
  if (path.dirname(out) !== dir) throw usageError(`--out must be a file directly inside --dir (paths in report.json are relative to its folder): got ${show(out)}`);
  const findingsFile = path.resolve(values.findings ?? path.join(dir, 'findings.json'));

  let configFile = values.config ? path.resolve(values.config) : null;
  if (!configFile) {
    const local = path.resolve('design-qa.config.json');
    try {
      if (lstatSync(local).isFile()) configFile = local;
    } catch {
      // no config: defaults
    }
  }
  let config = null;
  if (configFile) {
    config = readJsonFile(configFile, 'config');
    const v = validateConfig(config);
    if (!v.valid) throw usageError(`config ${show(configFile)} is invalid:\n${v.errors.map((e) => `  ${oneLine(e.path)}: ${oneLine(e.message)}`).join('\n')}`);
  }

  // Run isolation: this pass must own the folder, and a report.json of another run is never inherited.
  const callerRun = callerRunId(values.run);
  const lock = assertRunOwnsDir(dir, { runId: callerRun });
  const runId = lock && !lock.invalid ? lock.runId : null;
  const runArg = callerRun ? ` --run ${callerRun}` : '';
  const doc = readJsonFile(findingsFile, 'findings file');
  if (doc && typeof doc === 'object' && doc.kind !== FINDINGS_KIND && 'schemaVersion' in doc && 'meta' in doc) {
    throw usageError(`${show(findingsFile)} looks like a report.json, not a findings file: write findings.json from references/templates/findings.template.json`);
  }
  const parentLog = path.join(path.dirname(dir), 'dismissed.json');

  const label = displayPath(findingsFile);
  const work = () => {
    let previous = readOwnJson(out, 'the existing report');
    const prevRun = previous?.meta?.runId ?? null;
    if (previous && runId && prevRun && prevRun !== runId) {
      throw new CliError(
        `${show(out)} belongs to run ${oneLine(prevRun)}, but ${show(dir)} is locked by run ${runId}: a fresh pass inherits nothing from another run. Start it with node scripts/run.mjs start --dir ${shellArg(displayPath(dir))} (it archives the earlier outputs), then build again`,
        EXIT_CONFLICT,
      );
    }
    // Inherit only from a report provably of this run: the folder's lock and the report name the same run.
    if (previous && !(runId && prevRun === runId)) {
      const why = !runId ? `${show(dir)} has no run lock` : `${show(out)} records no run id (meta.runId)`;
      if (!values.fresh) {
        throw new CliError(
          `${show(out)} is not provably from this run (${why}), so its ids, triage, tickets and dismissals are not carried over blindly. Start the pass with node scripts/run.mjs start --dir ${shellArg(displayPath(dir))} (it archives the earlier outputs), or pass --fresh to replace it without carrying anything`,
          EXIT_CONFLICT,
        );
      }
      previous = null;
    }
    let priorLog = null;
    try {
      priorLog = readOwnJson(parentLog, 'the dismissed log');
    } catch (err) {
      if (!values.quiet) console.error(`Warning: ${oneLine(err.message)}; earlier dismissals were not re-applied`);
    }
    const result = buildReport({
      dir,
      doc,
      findingsLabel: label,
      findingsFile,
      configFile,
      config,
      configDir: configFile ? path.dirname(configFile) : null,
      mode: values.mode ?? null,
      runId,
      now: new Date(),
      skillVersion: skillVersion(),
      localCommit: gitHead(),
      previous,
      priorLog,
    });
    if (result.valid && !values.check) writeJson(out, result.report);
    return { result, previous };
  };
  const { result, previous } = values.check ? work() : withFileLocks([out], work);

  const lines = [];
  for (const n of result.notes) lines.push(`Note: ${oneLine(n)}`);
  for (const w of result.warnings) console.error(`Warning: ${oneLine(w)}`);
  if (!result.valid) {
    if (!values.quiet) for (const l of lines) console.log(l);
    console.error(`${show(label)}: ${result.problems.length} problem(s); ${values.check ? 'the report would not be valid' : `${show(out)} was not written`}:`);
    for (const p of result.problems) {
      console.error(`  ${oneLine(p.where)}: ${oneLine(p.message)}${p.report ? ` [report.json ${oneLine(p.report)}]` : ''}`);
    }
    console.error('Change the findings file (or redo the evidence named above), then run build-report.mjs again.');
    return 1;
  }
  if (values.quiet) return 0;
  const r = result.report;
  const head = scorecardHeadline(r.scorecard);
  lines.unshift(values.check ? `Check passed: ${show(label)} would build ${show(out)}${previous ? ' (replacing the existing one)' : ''}. Nothing written.` : `Wrote ${show(out)} from ${show(label)}${runId ? ` (run ${runId})` : ''}.`, head, ...summaryLines(r, result.info));
  const cfg = configFile ? ` --config ${shellArg(displayPath(configFile))}` : '';
  const html = path.join(dir, 'report.html');
  const plan = path.join(dir, 'report-fixplan.md');
  const backfill = Array.isArray(r.backfill?.items) && r.backfill.items.length ? ` --backfill-plan ${shellArg(displayPath(path.join(dir, 'report-backfill.md')))}` : '';
  const render = `${scriptCommand('render-report.mjs')} --in ${shellArg(displayPath(out))} --out ${shellArg(displayPath(html))} --fixplan ${shellArg(displayPath(plan))}${backfill}${cfg} --embed-images --recompute --write-back${runArg}`;
  if (values.check) lines.push(`Next: ${scriptCommand('build-report.mjs')} --dir ${shellArg(displayPath(dir))}${values.findings ? ` --findings ${shellArg(label)}` : ''}${cfg}${runArg}`);
  else lines.push(`Next: ${render}`);
  console.log(lines.join('\n'));
  return 0;
}

runMain(import.meta.url, main);
