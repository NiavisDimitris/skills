-- Anonymous design-qa usage counts, for the maintainer's own Supabase project
-- (not a team's metrics project). Written only by the telemetry-ingest Edge
-- Function with the service role; RLS on with no policies.
--
-- A row holds counts and the plugin version, and the day it arrived. No IP
-- address, user, repository, path or timestamp finer than the day is stored.

create table if not exists public.design_qa_telemetry (
  id              bigint generated always as identity primary key,
  received_on     date not null default current_date,
  plugin_version  text not null check (plugin_version ~ '^(unknown|\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?)$'),
  runs            integer not null check (runs between 1 and 1000),
  issues          integer not null check (issues between 0 and 100000),
  issues_by_type  jsonb not null default '{}'::jsonb,
  fixed           integer not null check (fixed between 0 and 100000),
  dismissed       integer not null check (dismissed between 0 and 100000)
);

create index if not exists design_qa_telemetry_received_on on public.design_qa_telemetry (received_on);

alter table public.design_qa_telemetry enable row level security;
revoke all on public.design_qa_telemetry from anon, authenticated;

-- Daily totals: what the maintainer reads.
create or replace view public.design_qa_telemetry_daily
with (security_invoker = true) as
select received_on as day,
       plugin_version,
       sum(runs)::int as runs,
       sum(issues)::int as issues,
       sum(fixed)::int as fixed,
       sum(dismissed)::int as dismissed
from public.design_qa_telemetry
group by 1, 2;

revoke all on public.design_qa_telemetry_daily from anon, authenticated;
