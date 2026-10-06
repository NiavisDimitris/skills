#!/usr/bin/env node
// Validate a design-qa report.json, design-qa.config.json, state-matrix.json, decisions.json or annotations.json.
// Zero dependencies; the structural rules come from ../schemas/*.schema.json.
import { statSync } from 'node:fs';
import path from 'node:path';
import { CliError, displayPath, parseCli, readJsonFile, runMain, usageError } from './lib/args.mjs';
import { ANNOTATIONS_KIND, AnnotationError, parseAnnotationsFile } from './lib/annotations.mjs';
import { DECISIONS_KIND, DecisionsError, normalizeDecisions } from './lib/decisions.mjs';
import { TYPES as SCHEMA_TYPES, inferType as inferSchemaType, loadSchema, validate, validateAgainstSchema, validateConfig, verifyBuiltFile } from './lib/schema-check.mjs';

const TYPES = [...SCHEMA_TYPES, 'decisions', 'annotations'];

/**
 * report | config | state-matrix as schema-check infers them; kind "design-qa-decisions" →
 * decisions; kind "design-qa-annotations" → annotations.
 */
function inferType(data) {
  if (data && typeof data === 'object' && !Array.isArray(data) && data.kind === DECISIONS_KIND) return 'decisions';
  if (data && typeof data === 'object' && !Array.isArray(data) && data.kind === ANNOTATIONS_KIND) return 'annotations';
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

/** The annotations schema, then the rules it cannot express (scripts/lib/annotations.mjs). */
function validateAnnotationsFile(data) {
  const { errors, warnings } = validateAgainstSchema(data, loadSchema('annotations'));
  if (!errors.length) {
    try {
      parseAnnotationsFile(data);
    } catch (err) {
      if (!(err instanceof AnnotationError)) throw err;
      errors.push({ path: '(root)', message: err.message });
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

const HELP = `Validate a design-qa file.

Usage:
  node scripts/validate.mjs <file> [--type report|config|state-matrix|decisions|annotations] [--config design-qa.config.json] [--quiet] [--json]

Options:
  --type <type>      report | config | state-matrix | decisions | annotations. Inferred when
                     omitted: schemaVersion or findings → report; app or surfaces → config;
                     an array of { state, result } rows → state-matrix;
                     kind "design-qa-decisions" → decisions (the review decisions
                     document, schemas/decisions.schema.json); kind "design-qa-annotations"
                     → annotations (<report dir>/annotations.json, the reviewer's
                     annotations that apply-decisions.mjs records,
                     schemas/annotations.schema.json)
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
decision and no BLOCKER is debt; INTENTIONAL needs a signoff or a cited known drift;
scorecard counts, match (per compared state, 100 minus the share of its page that
differs and that no settled finding or supported rejection names; null when nothing
was measured; scorecard.parity was removed), verdict
(INCOMPLETE when nothing was captured and compared: an empty state matrix, or no row
MISSING_IN_CODE or PASS / FAIL with a comparison; also, unless FAIL, when fewer than
half of the designed states have such a result; REVIEW for divergences the agent
resolved as DATA without a person's signoff, for a state captured only in
part, for differences beyond the worklist caps and for a rejected share of a state's
page above tolerances.pixelDiff.review), pixel-diff bands (a fail band is explained
only when what names its differing area is settled or ticketed), state coverage (verified = PASS or FAIL rows that were
compared; partial), unexplained, debt, loopClosed (never true when INCOMPLETE or with
an unexplained fail band), dismissed, designSystem, unpinned and rejected equal the
values derived from the findings (see render-report.mjs --recompute).
Evidence gates (errors here and when review.mjs opens a review; warnings in
render-report.mjs, dismiss, triage, apply-decisions, debt-log and jira-fetch, so
reports written before these rules still go through): the report was built by
build-report.mjs (meta.build, verified against findings.json and the evidence it names,
and against the config only by the keys that change the result: a hand edit after the
build is refused); a PASS or FAIL row was compared, not only
captured (captured.comparison: a pixel diff against a design image); a row's result follows
its findings (FAIL exactly when one is open); a DATA finding has dataReason (at least
20 characters); every open FIX_CODE finding has a pin, an evidence entry with a "state"
that is a stateMatrix row and a "crop" of at least 64 px² on an image file (not a JSON
path), unless its state is MISSING_IN_CODE with no app capture or it records
unpinnedReason (at least 20 characters: what is absent from every capture);
a crop that starts outside its image is an error and one that runs past an edge a
warning (the state's own app image size: captured.page.image, else
scorecard.pixelDiff.<state>.appWidth / appHeight, else the viewport × dpr; design
sizes from designWidth / designHeight, else the design frame); on a remote target (meta.app.url
not localhost, 127.x, [::1], *.localhost or file:) every open finding has app-side
evidence (screenshot, computed, dom, motion or diff), meta.target.kind must match the
URL, and a missing meta.degradations note about the source checkout is a warning when
the local commit is unknown or differs from the deployed one; a design image shorter
than the known design frame (stateMatrix[].designed.frame, the screen's frame,
meta.source.frame or meta.figma.frame) in height or width (designWidth) is a truncated
comparison, an error unless meta.degradations has an entry whose step is exactly
"capture-coverage:<state>" (then the state counts as captured only in part, and the
verdict is at best REVIEW; without designHeight, a frame taller than the viewport is a
warning; a padded or paddedRight entry that does not match the two sizes is a warning);
an app image of a PASS or FAIL state smaller than stateMatrix[].captured.page × dpr in
either dimension captured only part of the page (an error, same "capture-coverage:<state>" rule); a
verified state without captured.page, and captured.page.clipped above 0 without a
degradation naming the state, are warnings; open findings with no token and no component
finding while meta.tools.dsAudit is missing or "none" is a warning (no design-system
audit was run), and so is the same with audit candidates rejected. Design backfill (step 2, optional "backfill" block):
item ids unique and matching BF-001; screens as for findings; "not-needed" needs a
reason; "figma" only with decision "build" (a frame recorded while step 1 is open,
with no loopClosed and no backfill.gate.override, is a warning: backfill.mjs --record
refuses it); no item may share a state id with a stateMatrix row (that state is
designed); scorecard.backfill exists exactly when backfill does, with derived
candidates, toBuild, built, notNeeded, pending and ready. The backfill never changes
match, verdict, unexplained, loopClosed or designSystem. Removed 1.x values
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

  // The Phase 8 gate: the evidence gates are errors here (other scripts only warn, so reports
  // written before these rules can still be dismissed, triaged and applied).
  const result =
    type === 'decisions' ? validateDecisionsFile(data) : type === 'annotations' ? validateAnnotationsFile(data) : validate(data, type, { config, evidenceGates: 'error' });
  if (type === 'report') {
    // A built report is checked against the files it was built from: a hand edit after the build is refused.
    const built = await verifyBuiltFile(file, data);
    result.errors.push(...built.errors);
    result.warnings.push(...built.warnings);
    result.valid = result.errors.length === 0;
  }
  if (values.json) {
    console.log(JSON.stringify({ file: displayPath(file), type, ...result }, null, 2));
    return result.valid ? 0 : 1;
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  for (const e of result.errors) console.error(`ERROR ${e.path}: ${e.message}`);
  // Errors one per line (each must be fixed where it is); near-identical warnings grouped.
  if (!values.quiet) for (const w of groupIssues(result.warnings)) console.error(`WARN  ${w.path}: ${w.message}`);
  if (!result.valid) {
    console.error(`FAIL  ${displayPath(file)} (${type}): ${plural(result.errors.length, 'error')}, ${plural(result.warnings.length, 'warning')}`);
    return 1;
  }
  if (!values.quiet) console.log(`OK    ${displayPath(file)} is a valid ${type} (${plural(result.warnings.length, 'warning')})`);
  return 0;
}

/**
 * Issues that differ only in their array indexes (findings[0].evidence, findings[3].evidence…)
 * become one { path, message } when there are at least `min` of them: the path with [*]
 * and the indexes listed, e.g. "findings[*].evidence (5×: 0, 1, 2, 3, 7)". Others are kept as they are.
 */
function groupIssues(issues, min = 3) {
  const star = (s) => String(s).replace(/\[\d+\]/g, '[*]');
  const groups = new Map();
  for (const issue of issues) {
    const key = `${star(issue.path)}\u0000${star(issue.message)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(issue);
  }
  return [...groups.values()].flatMap((list) => {
    if (list.length < min) return list;
    const at = list.map((i) => (String(i.path).match(/\[(\d+)\]/g) ?? []).map((m) => m.slice(1, -1)).join('.'));
    const shown = at.length > 12 ? `${at.slice(0, 12).join(', ')}, …` : at.join(', ');
    return [{ path: `${star(list[0].path)} (${list.length}×: ${shown})`, message: star(list[0].message) }];
  });
}

runMain(import.meta.url, main);
