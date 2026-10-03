#!/usr/bin/env node
// Validate a design-qa report.json, design-qa.config.json or state-matrix.json.
// Zero dependencies; the structural rules come from ../schemas/*.schema.json.
import path from 'node:path';
import { CliError, displayPath, parseCli, readJsonFile, runMain, usageError } from './lib/args.mjs';
import { TYPES, inferType, validate, validateConfig } from './lib/schema-check.mjs';

const HELP = `Validate a design-qa file.

Usage:
  node scripts/validate.mjs <file> [--type report|config|state-matrix] [--config design-qa.config.json] [--quiet] [--json]

Options:
  --type <type>      report | config | state-matrix. Inferred when omitted:
                     schemaVersion + findings → report; app + surfaces → config;
                     an array of { state, result } rows → state-matrix
  --config <file>    for reports: take tolerances.pixelDiff, report.topN and
                     report.ranking from this design-qa.config.json
                     (defaults: pass < 1%, review <= 5%, top 5)
  --quiet            print errors only (no warnings, no success line)
  --json             print { file, type, valid, errors, warnings } as JSON on stdout
  -h, --help         show this help

Report rules (schemaVersion 2.0 only; a 1.x report fails with "re-run the pass"):
required keys and enums (keys whose value may be null can be omitted); finding ids
unique and matching DQ-001; every findingIds / relatedFindings / stateMatrix[].findings
entry references an existing finding; severity PASS or CANNOT_VERIFY ⇒ resolution
NONE; BLOCKER, WARNING or DS_CANDIDATE ⇒ FIX_CODE, INTENTIONAL, DATA, DISMISSED or
UNCLASSIFIED; DISMISSED ⇒ a dismissal { kind, reason, by, date, source } with a
non-empty reason; meta.source is required and meta.figma too when the source is
figma or figma-prototype (same frame); with meta.screens every state is
"<screen>/<state>" and every row / finding screen is a listed id; rank.bucket is
"fix-now" or "debt" only for FIX_CODE findings (severity BLOCKER, WARNING or
DS_CANDIDATE), "none" otherwise; with a triage block every triageable finding (the
same FIX_CODE set) has exactly one "fix-now" or "debt" decision and no BLOCKER is
debt; scorecard counts, parity (dismissed findings leave the denominator), verdict,
pixel-diff bands, state coverage, unexplained, debt, loopClosed, dismissed and
designSystem equal the values derived from the findings (see render-report.mjs
--recompute). Design backfill (step 2, optional "backfill" block): item ids unique
and matching BF-001; screens as for findings; "not-needed" needs a reason; "figma"
only with decision "build", and only once step 1 is closed (loopClosed) or
backfill.gate.override is recorded; no item may share a state id with a stateMatrix
row (that state is designed); scorecard.backfill exists exactly when backfill does,
with derived candidates, toBuild, built, notNeeded, pending and ready. The backfill
never changes parity, verdict, unexplained, loopClosed or designSystem. Removed 1.x values (SYNC_FIGMA, MISSING_IN_DESIGN, mode "sync",
bucket "sync-figma", captured.figma) get a message saying what to use instead.
Unknown keys, and a fix-now/debt split that differs from topN, are warnings.

Exit codes: 0 valid · 1 invalid (or not JSON) · 2 bad arguments / file not found`;

async function main(argv) {
  const { values, positionals } = parseCli(
    argv,
    {
      type: { type: 'string' },
      config: { type: 'string' },
      quiet: { type: 'boolean' },
      json: { type: 'boolean' },
    },
    { allowPositionals: true },
  );
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (positionals.length !== 1) throw usageError('expected exactly one file to validate (see --help)');
  if (values.type && !TYPES.includes(values.type)) throw usageError(`--type must be one of ${TYPES.join(', ')} (got "${values.type}")`);

  const file = path.resolve(positionals[0]);
  let data;
  try {
    data = readJsonFile(file, 'file', 2);
  } catch (err) {
    // Unparseable JSON is an invalid file (1); a missing file is a usage error (2).
    if (err instanceof CliError && /is not valid JSON/.test(err.message)) throw new CliError(err.message, 1);
    throw err;
  }
  const type = values.type || inferType(data);
  if (!type) {
    throw usageError(`cannot infer the file type of ${displayPath(file)}; pass --type ${TYPES.join('|')}`);
  }

  let config;
  if (values.config) {
    config = readJsonFile(path.resolve(values.config), 'config', 2);
    const cv = validateConfig(config);
    if (!cv.valid) throw usageError(`--config is invalid:\n${cv.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
  }

  const result = validate(data, type, { config });
  if (values.json) {
    console.log(JSON.stringify({ file: displayPath(file), type, ...result }, null, 2));
    return result.valid ? 0 : 1;
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  for (const e of result.errors) console.error(`ERROR ${e.path}: ${e.message}`);
  if (!values.quiet) for (const w of result.warnings) console.error(`WARN  ${w.path}: ${w.message}`);
  if (!result.valid) {
    console.error(`FAIL  ${displayPath(file)} (${type}): ${plural(result.errors.length, 'error')}, ${plural(result.warnings.length, 'warning')}`);
    return 1;
  }
  if (!values.quiet) console.log(`OK    ${displayPath(file)} is a valid ${type} (${plural(result.warnings.length, 'warning')})`);
  return 0;
}

runMain(import.meta.url, main);
