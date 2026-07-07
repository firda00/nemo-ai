-- Autonomous ops watchdog log. A scheduled agent (ops-watchdog edge function) checks the
-- site, edge functions, VPS worker, DB and the support queue every ~10 min and writes one
-- row here. Platform-wide health (not account-scoped): the watchdog writes with the service
-- role; any signed-in user may read the latest status for the monitoring page.

create table if not exists public.ops_checks (
  id         uuid primary key default gen_random_uuid(),
  status     text not null default 'ok',          -- ok | warn | down
  summary    text not null default '',
  details    jsonb not null default '{}'::jsonb,   -- per-check {name: {ok, info}}
  created_at timestamptz not null default now()
);

alter table public.ops_checks enable row level security;

drop policy if exists ops_checks_read on public.ops_checks;
create policy ops_checks_read on public.ops_checks for select
  using (auth.role() = 'authenticated');

create index if not exists ops_checks_idx on public.ops_checks (created_at desc);
