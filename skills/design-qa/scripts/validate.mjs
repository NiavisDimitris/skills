#!/usr/bin/env node
// Validate a design-qa report.json, design-qa.config.json, state-matrix.json or decisions.json.
// Zero dependencies; the structural rules come from ../schemas/*.schema.json.
import { statSync } from 'node:fs';
import path from 'node:path';
import { CliError, displayPath, parseCli, readJsonFile, runMain, usageError } from './lib/args.mjs';
import { DECISIONS_KIND, DecisionsError, normalizeDecisions } from './lib/decisions.mjs';
import { TYPES as SCHEMA_TYPES, inferType as inferSchemaType, loadSchema, validate, validateAgainstSchema, validateConfig } from './lib/schema-check.mjs';

const TYPES = [...SCHEMA_TYPES, 'decisions'];

/** report | config | state-matrix as schema-check infers them; kind "design-qa-decisions" → decisions. */
function inferType(data) {
  if (data && typeof data === 'object' && !Array.isArray(data) && data.kind === DECISIONS_KIND) return 'decisions';
  return inferSchemaType(data);
}

/** The decisions schema, then the rules it cannot express (scripts/lib/decisions.mjs). */
function validateDecisionsFile(data) {
  const { errors, warnings } = validateAgainstSchema(data, loadSchema('decisions'));
  if (!errors.length) {
    try {
      normalizeDecisions(data);
    } catch (err) {
      if (!(err instanceof DecisionsError)) throw err;
      errors.push({ path: '(root)', message: err.message });
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

const HELP = `Validate a design-qa file.

Usage:
  node scripts/validate.mjs <file> [--type report|config|state-matrix|decisions] [--config design-qa.config.json] [--quiet] [--json]

Options:
  --type <type>      report | config | state-matrix | decisions. Inferred when omitted:
                     schemaVersion or findings → report; app or surfaces → config;
                     an array of { state, result } rows → state-matrix;
                     kind "design-qa-decisions" → decisions (the review decisions
                     document, schemas/decisions.schema.json)
  --config <file>    for reports: take tolerances.pixelDiff, report.topN and
                     report.ranking from this design-qa.config.json
                     (defaults: pass < 1%, review <= 5%, top 5)
  --quiet            print errors only (no warnings, no success line)
  --json             print { file, type, valid, errors, warnings } as JSON on stdout,
                     always: a file that is missing, not JSON or of unknown type gives
                     valid false with the error at path "(root)" (same exit codes)
  -h, --help         show this help

Report rules (schemaVersion 2.0 only; a 1.x report fails with "re-run the pass"):
required keys and enums (keys whose value may be null can be omitted); finding ids
unique and matching DQ-001; every findingIds / relatedFindings /
stateMatrix[].findings entry references an existing finding; severity PASS or
CANNOT_VERIFY ⇒ resolution NONE; BLOCKER, WARNING or DS_CANDIDATE ⇒ FIX_CODE,
INTENTIONAL, DATA, DISMISSED or UNCLASSIFIED; DISMISSED ⇒ a dismissal { kind, reason,
by, date, source } with a non-empty reason; INTENTIONAL ⇒ a signoff { by, date, reason
} with by and reason not blank (or a known drift cited in knownDrift); date-times are
RFC 3339 (2026-01-31T12:00:00Z: seconds and a time zone required); meta.source is
required and meta.figma too when the source is figma or figma-prototype (same frame);
with meta.screens every state is "<screen>/<state>" and every row / finding screen is
a listed id; rank.bucket is "fix-now" or "debt" only for FIX_CODE findings (severity
BLOCKER, WARNING or DS_CANDIDATE), "none" otherwise; with a triage block every
triageable finding (the same FIX_CODE set) has exactly one "fix-now" or "debt"
decision and no BLOCKER is debt; scorecard counts, parity (dismissed findings leave
the denominator), verdict, pixel-diff bands, state coverage, unexplained, debt,
loopClosed, dismissed and designSystem equal the values derived from the findings (see
render-report.mjs --recompute). Design backfill (step 2, optional "backfill" block):
item ids unique and matching BF-001; screens as for findings; "not-needed" needs a
reason; "figma" only with decision "build" (a frame recorded while step 1 is open,
with no loopClosed and no backfill.gate.override, is a warning: backfill.mjs --record
refuses it); no item may share a state id with a stateMatrix row (that state is
designed); scorecard.backfill exists exactly when backfill does, with derived
candidates, toBuild, built, notNeeded, pending and ready. The backfill never changes
parity, verdict, unexplained, loopClosed or designSystem. Removed 1.x values
(SYNC_FIGMA, MISSING_IN_DESIGN, mode "sync", bucket "sync-figma", captured.figma) get
a message saying what to use instead. Unknown keys, a fix-now/debt split that differs
from topN, scorecard.pixelDiff keys that are not stateMatrix states, and backfill
states that differ from a designed state only by letter case are warnings.

Exit codes: 0 valid · 1 invalid (or not JSON) · 2 bad arguments / file not found /
type cannot be inferred`;

async function main(argv) {
  const seen = { file: null, type: null };
  try {
    return await validateCli(argv, seen);
  } catch (err) {
    // --json always prints a result on stdout, failures included (same exit codes).
    if (!(err instanceof CliError) || !argv.includes('--json')) throw err;
    console.log(JSON.stringify({ ...seen, valid: false, errors: [{ path: '(root)', message: err.message }], warnings: [] }, null, 2));
    console.error(`validate.mjs: error: ${err.message}`);
    return err.exitCode;
  }
}

async function validateCli(argv, seen) {
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
  seen.file = displayPath(file);
  // A missing file (or a folder) is a usage error (2); unreadable or unparseable content is an invalid file (1).
  let stat = null;
  try {
    stat = statSync(file);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isFile()) throw usageError(`cannot read file ${file}: ${stat ? 'not a file' : 'file not found'}`);
  const data = readJsonFile(file, 'file', 1);
  const type = values.type || inferType(data);
  seen.type = type || null;
  if (!type) {
    throw usageError(`cannot infer the file type of ${displayPath(file)}; pass --type ${TYPES.join('|')}`);
  }

  let config;
  if (values.config) {
    config = readJsonFile(path.resolve(values.config), 'config', 2);
    const cv = validateConfig(config);
    if (!cv.valid) throw usageError(`--config is invalid:\n${cv.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
  }

  const result = type === 'decisions' ? validateDecisionsFile(data) : validate(data, type, { config });
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
