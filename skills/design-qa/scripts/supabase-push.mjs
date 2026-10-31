#!/usr/bin/env node
// Store a run result in Supabase (design_qa_runs, design_qa_issues) for the
// metrics views. Credentials come from the environment only.
import path from 'node:path';
import { displayPath, parseCli, readJsonFile, runMain, usageError } from './lib/args.mjs';
import { loadSchema, validateAgainstSchema } from './lib/schema-check.mjs';
import { rowsFor, supabaseConfig, upsert } from './lib/supabase.mjs';

const HELP = `Store a run result in Supabase, for the metrics views.

Usage:
  node scripts/supabase-push.mjs --result <run-result.json> [--dry-run] [--quiet]

Environment (never put these in a file you commit):
  SUPABASE_URL               https://<project>.supabase.co
  SUPABASE_SERVICE_ROLE_KEY  the project's service-role key (or SUPABASE_SECRET_KEY)

The tables and views come from supabase/migrations/ in the skill repository. Rows are
upserted on their primary keys, so pushing the same result twice is harmless.

Options:
  --dry-run    print the rows instead of sending them (needs no credentials)
  --quiet      only print errors
  -h, --help   show this help

Exit codes: 0 stored · 1 Supabase refused or could not be reached · 2 bad arguments,
invalid result or missing credentials.`;

async function main(argv) {
  const { values } = parseCli(argv, {
    result: { type: 'string' },
    'dry-run': { type: 'boolean' },
    quiet: { type: 'boolean' },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (!values.result) throw usageError('--result is required');
  const file = path.resolve(values.result);
  const result = readJsonFile(file, 'run result');
  const { errors } = validateAgainstSchema(result, loadSchema('run-result'));
  if (errors.length) throw usageError(`${displayPath(file)} is not a valid run result:\n${errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);

  const { run, issues } = rowsFor(result);
  if (values['dry-run']) {
    console.log(JSON.stringify({ design_qa_runs: [run], design_qa_issues: issues }, null, 2));
    return 0;
  }
  const config = supabaseConfig();
  await upsert(config, 'design_qa_runs', [run], 'run_id');
  await upsert(config, 'design_qa_issues', issues, 'run_id,issue_id');
  if (!values.quiet) console.log(`Stored run ${run.run_id} (${issues.length} issue rows) in ${new URL(config.url).host}`);
  return 0;
}

runMain(import.meta.url, main);
