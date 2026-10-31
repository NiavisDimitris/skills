# Metrics

Numbers that show what the QA catches, collected on every run. No time estimates: nobody times manual QA, so "hours saved" would be invented.

## The run result

After `report.json` is final, `scripts/run-result.mjs --report <dir>/report.json` writes `<dir>/run-result.json` (`schemas/run-result.schema.json`) and a copy in `qa-reports/runs/<run_id>.json`:

- `run_id`, `timestamp`, `repo`, `branch`, `commit_sha`, `pr_number` (GitHub Actions env, else git; unknown is `null`)
- `checked`: every screen and state in the state matrix, `verified` when it was captured and compared (PASS, FAIL, MISSING_IN_CODE)
- `issues`: one per `issue_id`, with `type` (`ledger:property`), `category`, `severity`, `screen`, `state`, `status`
- `totals`: flagged this run, by category, status and severity
- `diff` against the previous run on the same branch and feature

**Issues** are BLOCKER, WARNING and DS_CANDIDATE findings with resolution FIX_CODE or UNCLASSIFIED (`open`) or DISMISSED or INTENTIONAL (`dismissed`), plus one `missing-state` issue per MISSING_IN_CODE state no open finding covers. PASS, CANNOT_VERIFY, DATA and NONE are not issues.

**issue_id** = `iss_` + 16 hex of sha256(screen · state · element · ledger:property), lower-cased and whitespace-collapsed like the dismissals fingerprint. Element is the Figma node id when the finding has one, else the selector, else the Figma layer path, else the region. It does not change when findings are renumbered, when values change, or when severity changes. Without a Figma node id it changes when the selector does: a renamed class reads as one issue fixed and one new.

**Categories**: spacing, color, typography, sizing, shape (radius, border, shadow), component, missing-state, motion, structure, copy, behavior, other.

## New, fixed, dismissed

| Before | Now | Counted as |
|---|---|---|
| — | open | new |
| open | gone, and its screen and state were verified this run | **fixed** |
| open or dismissed | gone, state not verified this run | not re-checked: carried forward unchanged |
| open | dismissed | dismissed |
| dismissed | open | reopened |
| fixed | open | new (a regression) |
| open | still in the report, now PASS | fixed |
| open | still in the report, now CANNOT_VERIFY | not re-checked |
| open | still in the report, now DATA (or another non-issue) | reclassified: dropped, neither fixed nor carried |

A state that was skipped, excluded with `--states` or `CANNOT_VERIFY` never makes its issues "fixed".

A finding with no state is re-checked when any state of its screen was verified. Runs are compared only within the same branch, feature and pull request.

Locally the previous run is the existing `run-result.json` when it is from the same branch. In CI the workflow downloads the previous run's `design-qa-result` artifact (references/ci.md).

## Dismissing

Use the existing dismissal: the report's Dismiss button, `/design-qa dismiss`, or by the stable id from the PR comment:

```bash
node scripts/dismiss.mjs --report <dir>/report.json --issue-id iss_3f9a0c1d2e4b5a69 --kind not-an-issue --reason '<why>' --by '<name>'
```

Commit `qa-reports/dismissed.json` so CI re-applies it.

## Storing in Supabase

1. Apply `supabase/migrations/20261031120000_design_qa_metrics.sql` (from the skill repository) to a Supabase project: `supabase db push`, or paste it into the SQL editor.
2. Add repository secrets `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. The reference workflow stores each run with `scripts/supabase-push.mjs`; without the secrets it skips that step.

Tables `design_qa_runs` and `design_qa_issues` (a row per issue per run, status open, fixed or dismissed). RLS is on with no policies: only the service-role key reads or writes.

## The four metrics

`node scripts/metrics.mjs --source supabase` (reads the views) or `--source local --dir qa-reports` (computes the same numbers from run results on disk). `--json` for rows.

| Metric | View | Definition |
|---|---|---|
| Issues caught per run, by type | `design_qa_issues_per_run_by_type` | open or dismissed issues a run found (not carried) |
| **Design defects fixed before merge, per month** | `design_qa_fixed_before_merge_monthly` | issues marked fixed in a pull request's runs, once per PR |
| Drift | `design_qa_open_drift_weekly` | open issues per screen in the last run of each week, per repo, branch and feature |
| False positive rate | `design_qa_false_positive_rate` | issues whose latest flagged status is dismissed ÷ issues ever flagged |

Issues are told apart by repo, feature and issue_id.

**Limits.** "Before merge" means fixed in a pull request's runs; whether that pull request was merged is not checked, so fixes on a PR closed unmerged still count. The false positive rate counts every dismissal kind (not an issue, remove, intentional) as a false positive.
