#!/usr/bin/env node
// Print the design-qa value metrics: issues caught per run, design defects fixed
// before merge per month, open drift per screen per week, and the false positive
// rate. From Supabase (the metric views) or from run results on disk.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { displayPath, oneLine, parseCli, runMain, toNumber, usageError } from './lib/args.mjs';
import { computeMetrics, table } from './lib/metrics.mjs';
import { RUN_RESULT_SCHEMA_VERSION } from './lib/run-result.mjs';
import { selectAll, supabaseConfig } from './lib/supabase.mjs';

const HELP = `Print the design-qa value metrics.

Usage:
  node scripts/metrics.mjs [--source local|supabase] [--dir qa-reports] [--repo owner/name] [--runs N] [--json]

  --source local     read run results on disk (default): every *.json under --dir that is a
                     run result (qa-reports/runs/ keeps one per run)
  --source supabase  read the metric views; needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
  --dir <dir>        where to look with --source local (default: qa-reports)
  --repo <name>      only this repository (owner/name)
  --runs <n>         how many recent runs to list under "issues caught per run" (default 10)
  --json             print every row as JSON instead of tables
  -h, --help         show this help

Metrics:
  1. Issues caught per run, by type      open or dismissed issues each run found
  2. Fixed before merge, per month       issues open in a pull request's earlier run and gone,
                                         with their state re-checked, in a later run of it
  3. Drift: open issues per screen       last run of each week per repo, branch and feature
  4. False positive rate                 dismissed ÷ flagged (each issue's latest status)

Exit codes: 0 printed · 1 Supabase refused or could not be reached · 2 bad arguments.`;

function findRunResults(dir) {
  const out = [];
  const walk = (d, depth) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory() && depth < 4 && !['node_modules', 'evidence', '.git'].includes(entry.name)) walk(p, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.json') && statSync(p).size < 5 * 1024 * 1024) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

function loadLocal(dir) {
  if (!existsSync(dir)) throw usageError(`--dir ${displayPath(dir)} does not exist (run results are written under qa-reports/ by scripts/run-result.mjs)`);
  const runs = new Map();
  for (const file of findRunResults(dir)) {
    let data;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (data?.schemaVersion !== RUN_RESULT_SCHEMA_VERSION || !data.run_id || !Array.isArray(data.issues)) continue;
    runs.set(data.run_id, data);
  }
  return [...runs.values()];
}

async function loadSupabase(repo) {
  const config = supabaseConfig();
  const filter = repo ? `&repo=eq.${encodeURIComponent(repo)}` : '';
  const [perRun, fixed, drift, fp] = await Promise.all([
    selectAll(config, 'design_qa_issues_per_run_by_type', `select=*${filter}&order=ts.asc,category.asc`),
    selectAll(config, 'design_qa_fixed_before_merge_monthly', `select=*${filter}&order=month.asc,repo.asc`),
    selectAll(config, 'design_qa_open_drift_weekly', `select=*${filter}&order=week.asc,repo.asc,branch.asc,feature.asc,screen.asc`),
    selectAll(config, 'design_qa_false_positive_rate', `select=*&order=repo.asc.nullslast`),
  ]);
  return {
    issues_per_run_by_type: perRun,
    fixed_before_merge_monthly: fixed,
    open_drift_weekly: drift,
    false_positive_rate: repo ? fp.filter((r) => r.repo === repo) : fp,
  };
}

function print(metrics, { recentRuns }) {
  const runIds = [...new Set(metrics.issues_per_run_by_type.map((r) => r.run_id))].slice(-recentRuns);
  const perRun = metrics.issues_per_run_by_type.filter((r) => runIds.includes(r.run_id)).map((r) => ({ ...r, ts: String(r.ts).slice(0, 16).replace('T', ' ') }));
  const totalFixed = metrics.fixed_before_merge_monthly.reduce((n, r) => n + r.fixed_before_merge, 0);
  const fpAll = metrics.false_positive_rate.find((r) => r.repo === null) ?? metrics.false_positive_rate.at(-1);
  const pct = (v) => (v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(1)}%`);

  console.log(`Design QA metrics\n`);
  console.log(`Headline: ${totalFixed} design defect(s) caught and fixed before merge; false positive rate ${pct(fpAll?.false_positive_rate)}.\n`);
  console.log(`1. Issues caught per run, by type (last ${runIds.length} run(s))`);
  console.log(table(perRun, [['ts', 'run (UTC)'], ['repo', 'repo'], ['branch', 'branch'], ['pr_number', 'PR'], ['feature', 'feature'], ['category', 'type'], ['issues', 'issues']]));
  console.log(`\n2. Design defects fixed before merge, per month`);
  console.log(table(metrics.fixed_before_merge_monthly, [['month', 'month'], ['repo', 'repo'], ['fixed_before_merge', 'fixed before merge'], ['pull_requests', 'PRs']]));
  console.log(`\n3. Drift: open mismatches per screen, weekly`);
  console.log(table(metrics.open_drift_weekly, [['week', 'week of'], ['repo', 'repo'], ['branch', 'branch'], ['feature', 'feature'], ['screen', 'screen'], ['open_issues', 'open']]));
  console.log(`\n4. False positive rate (dismissed ÷ flagged)`);
  console.log(table(metrics.false_positive_rate.map((r) => ({ ...r, repo: r.repo ?? 'all', false_positive_rate: pct(r.false_positive_rate) })), [['repo', 'repo'], ['flagged', 'flagged'], ['dismissed', 'dismissed'], ['false_positive_rate', 'rate']]));
}

async function main(argv) {
  const { values } = parseCli(argv, {
    source: { type: 'string' },
    dir: { type: 'string' },
    repo: { type: 'string' },
    runs: { type: 'string' },
    json: { type: 'boolean' },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const source = values.source ?? 'local';
  if (!['local', 'supabase'].includes(source)) throw usageError(`--source must be local or supabase (got "${oneLine(source)}")`);
  if (source === 'supabase' && values.dir) throw usageError('--dir goes with --source local');
  const recentRuns = values.runs ? toNumber(values.runs, 'runs', { min: 1, integer: true }) : 10;

  let metrics;
  if (source === 'local') {
    let runs = loadLocal(path.resolve(values.dir ?? 'qa-reports'));
    if (values.repo) runs = runs.filter((r) => r.repo === values.repo);
    metrics = computeMetrics(runs);
  } else {
    metrics = await loadSupabase(values.repo);
  }
  if (values.json) console.log(JSON.stringify(metrics, null, 2));
  else print(metrics, { recentRuns });
  return 0;
}

runMain(import.meta.url, main);
