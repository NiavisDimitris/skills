-- design-qa run results and the metrics built on them.
--
-- One row per run (design_qa_runs) and one row per issue per run
-- (design_qa_issues, a snapshot: drift over time is a plain query). Rows are
-- written by scripts/supabase-push.mjs from CI with the service-role key; RLS
-- is on with no policies, so the anon and authenticated roles see nothing.
-- Tables are prefixed so the migration can share a project with other apps.

create table if not exists public.design_qa_runs (
  run_id          uuid primary key,
  ts              timestamptz not null,
  repo            text,
  branch          text,
  commit_sha      text,
  pr_number       integer check (pr_number is null or pr_number > 0),
  feature         text not null,
  skill_version   text not null,
  mode            text,
  verdict         text,
  previous_run_id uuid,
  flagged         integer not null default 0 check (flagged >= 0),
  totals          jsonb not null default '{}'::jsonb,
  checked         jsonb not null default '[]'::jsonb,
  diff            jsonb not null default '{}'::jsonb,
  inserted_at     timestamptz not null default now()
);

create index if not exists design_qa_runs_repo_branch_ts on public.design_qa_runs (repo, branch, feature, ts desc);
create index if not exists design_qa_runs_ts on public.design_qa_runs (ts);

create table if not exists public.design_qa_issues (
  run_id    uuid not null references public.design_qa_runs (run_id) on delete cascade,
  issue_id  text not null check (issue_id ~ '^iss_[0-9a-f]{16}$'),
  type      text not null,
  category  text not null,
  severity  text not null,
  screen    text not null,
  state     text,
  status    text not null check (status in ('open', 'fixed', 'dismissed')),
  title     text,
  carried   boolean not null default false,
  primary key (run_id, issue_id)
);

create index if not exists design_qa_issues_issue on public.design_qa_issues (issue_id);
create index if not exists design_qa_issues_status on public.design_qa_issues (status);

alter table public.design_qa_runs enable row level security;
alter table public.design_qa_issues enable row level security;
revoke all on public.design_qa_runs, public.design_qa_issues from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Metrics. security_invoker: the views run with the caller's rights, so RLS
-- on the tables applies to them too (only the service role reads them).
-- An issue is identified by (repo, feature, issue_id): issue_id is unique
-- within one feature's screens and states.
-- ---------------------------------------------------------------------------

-- 1. Issues caught per run, by type (category). Carried issues were not
--    re-checked by that run, so they do not count as caught by it.
create or replace view public.design_qa_issues_per_run_by_type
with (security_invoker = true) as
select r.run_id, r.ts, r.repo, r.branch, r.pr_number, r.feature, i.category, count(*)::int as issues
from public.design_qa_runs r
join public.design_qa_issues i on i.run_id = r.run_id
where i.status in ('open', 'dismissed') and not i.carried
group by r.run_id, r.ts, r.repo, r.branch, r.pr_number, r.feature, i.category;

-- 2. Headline: design defects fixed before merge, per month. An issue fixed in
--    a pull request's runs counts once per pull request.
create or replace view public.design_qa_fixed_before_merge_monthly
with (security_invoker = true) as
select date_trunc('month', r.ts)::date as month,
       r.repo,
       count(distinct (r.pr_number, r.feature, i.issue_id))::int as fixed_before_merge,
       count(distinct r.pr_number)::int as pull_requests
from public.design_qa_runs r
join public.design_qa_issues i on i.run_id = r.run_id
where i.status = 'fixed' and r.pr_number is not null
group by 1, 2;

-- 3. Drift: open mismatches per screen, weekly, from the last run of each week
--    per repo, branch and feature. Carried issues are still believed open.
create or replace view public.design_qa_open_drift_weekly
with (security_invoker = true) as
with latest as (
  select distinct on (repo, branch, feature, date_trunc('week', ts))
         run_id, repo, branch, feature, date_trunc('week', ts)::date as week
  from public.design_qa_runs
  order by repo, branch, feature, date_trunc('week', ts), ts desc
)
select l.week, l.repo, l.branch, l.feature, i.screen, count(*)::int as open_issues
from latest l
join public.design_qa_issues i on i.run_id = l.run_id and i.status = 'open'
group by l.week, l.repo, l.branch, l.feature, i.screen;

-- 4. False positive rate: issues whose latest flagged status is dismissed,
--    over every issue ever flagged. Per repo, plus an overall row (repo null).
create or replace view public.design_qa_false_positive_rate
with (security_invoker = true) as
with last_flag as (
  select distinct on (r.repo, r.feature, i.issue_id) r.repo, i.status
  from public.design_qa_issues i
  join public.design_qa_runs r on r.run_id = i.run_id
  where i.status in ('open', 'dismissed')
  order by r.repo, r.feature, i.issue_id, r.ts desc
)
select repo,
       count(*)::int as flagged,
       count(*) filter (where status = 'dismissed')::int as dismissed,
       round(count(*) filter (where status = 'dismissed')::numeric / nullif(count(*), 0), 4) as false_positive_rate
from last_flag
group by grouping sets ((repo), ());

revoke all on public.design_qa_issues_per_run_by_type, public.design_qa_fixed_before_merge_monthly,
  public.design_qa_open_drift_weekly, public.design_qa_false_positive_rate from anon, authenticated;
