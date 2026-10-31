#!/usr/bin/env node
// Write the run result for a finished pass: stable issue ids, totals and the diff
// against the previous run on the same branch (new, fixed before merge, dismissed).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { displayPath, oneLine, parseCli, readJsonFile, runMain, toNumber, usageError, writeJson, writeText } from './lib/args.mjs';
import { buildRunResult, resolveRunContext, summaryMarkdown } from './lib/run-result.mjs';
import { loadSchema, validateAgainstSchema } from './lib/schema-check.mjs';

const HELP = `Write run-result.json for a finished pass: issues with stable ids, totals, and what changed
since the previous run on the same branch.

Usage:
  node scripts/run-result.mjs --report <dir>/report.json [options]

Options:
  --previous <file>    the previous run's run-result.json (CI downloads it). Default: the
                       existing --out file, when it is from the same branch and feature
  --no-previous        treat this as a first run
  --out <file>         default: run-result.json next to report.json
  --history <dir>      also keep a copy as <dir>/<run_id>.json, for metrics.mjs --source local
                       (default: runs/ next to the feature folder, i.e. qa-reports/runs/)
  --no-history         do not keep a copy
  --comment-md <file>  write a short Markdown summary for the PR comment
  --pr <n>             pull request number (default: from the GitHub Actions event)
  --repo <owner/name>  default: GITHUB_REPOSITORY, else the origin remote
  --branch <name>      default: the PR head branch, GITHUB_REF_NAME, else git
  --sha <sha>          default: the PR head commit, GITHUB_SHA, else git
  --quiet              only print warnings and errors
  -h, --help           show this help

Statuses: open (FIX_CODE / UNCLASSIFIED), dismissed (DISMISSED / INTENTIONAL), fixed
(open in the previous run, gone now, and its screen and state verified this run). An issue
whose state was not verified this run is carried forward as it was ("not re-checked").

Exit codes: 0 written · 1 write failed · 2 bad arguments or unreadable report.`;

async function main(argv) {
  const { values } = parseCli(argv, {
    report: { type: 'string' },
    previous: { type: 'string' },
    'no-previous': { type: 'boolean' },
    out: { type: 'string' },
    history: { type: 'string' },
    'no-history': { type: 'boolean' },
    'comment-md': { type: 'string' },
    pr: { type: 'string' },
    repo: { type: 'string' },
    branch: { type: 'string' },
    sha: { type: 'string' },
    quiet: { type: 'boolean' },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (!values.report) throw usageError('--report is required');
  if (values.previous && values['no-previous']) throw usageError('--previous and --no-previous cannot be combined');
  if (values.history && values['no-history']) throw usageError('--history and --no-history cannot be combined');
  if (values.sha && !/^[0-9a-f]{7,64}$/i.test(values.sha)) throw usageError('--sha must be a hex commit id');

  const reportFile = path.resolve(values.report);
  const report = readJsonFile(reportFile, 'report');
  const out = path.resolve(values.out ?? path.join(path.dirname(reportFile), 'run-result.json'));

  let previous = null;
  if (values.previous) previous = readJsonFile(path.resolve(values.previous), 'previous run result');
  else if (!values['no-previous'] && existsSync(out)) previous = readJsonFile(out, 'previous run result');

  const context = resolveRunContext({ cwd: path.dirname(reportFile) });
  if (values.repo) context.repo = values.repo;
  if (values.branch) context.branch = values.branch;
  if (values.sha) context.commit_sha = values.sha.toLowerCase();
  if (values.pr) context.pr_number = toNumber(values.pr, 'pr', { min: 1, integer: true });

  const { result, warnings } = buildRunResult(report, { previous, context });
  const { errors } = validateAgainstSchema(result, loadSchema('run-result'));
  if (errors.length) {
    throw usageError(`the run result does not match schemas/run-result.schema.json:\n${errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
  }

  writeJson(out, result);
  if (!values['no-history']) {
    const historyDir = path.resolve(values.history ?? path.join(path.dirname(path.dirname(reportFile)), 'runs'));
    writeJson(path.join(historyDir, `${result.run_id}.json`), result);
  }
  if (values['comment-md']) writeText(path.resolve(values['comment-md']), summaryMarkdown(result));

  for (const w of warnings) console.error(`warning: ${oneLine(w)}`);
  if (!values.quiet) {
    const d = result.diff;
    console.log(`Wrote ${displayPath(out)}: ${result.totals.flagged} issue(s) flagged`);
    if (d.first_run) console.log('First run on this branch: nothing to compare.');
    else {
      console.log(
        `Since the previous run: ${d.new.length} new, ${d.fixed.length} fixed, ${d.dismissed.length} dismissed, ${d.reopened.length} reopened, ${d.not_rechecked.length} not re-checked`,
      );
    }
  }
  return 0;
}

runMain(import.meta.url, main);
