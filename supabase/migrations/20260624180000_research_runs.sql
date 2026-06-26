-- Autonomous research agent: each run saves its task, the steps it took, the
-- sourced findings and the final report. Account-scoped via RLS like everything else.
create table if not exists public.research_runs (
  id         uuid primary key default gen_random_uuid(),
  account_id uuid not null default public.current_account_id() references public.accounts(id) on delete cascade,
  task       text not null,
  status     text not null default 'done',   -- running | done | error
  report     text,
  sources    jsonb not null default '[]',
  steps      jsonb not null default '[]',
  tokens     bigint not null default 0,
  created_at timestamptz not null default now()
);

alter table public.research_runs enable row level security;

drop policy if exists research_acc on public.research_runs;
create policy research_acc on public.research_runs for all
  using (account_id = public.current_account_id())
  with check (account_id = public.current_account_id());

create index if not exists research_runs_acc_idx on public.research_runs (account_id, created_at desc);
