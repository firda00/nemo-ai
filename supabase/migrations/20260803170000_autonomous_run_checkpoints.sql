-- Durable checkpoints for browser-driven autonomous runs. The browser may disappear
-- between paid stages, so every completed stage is persisted before another starts.
-- Writes remain service-role only; orchestrate verifies the caller's account and user.
create table if not exists public.autonomous_run_checkpoints (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references public.accounts(id) on delete cascade,
  user_id       uuid not null,
  run_ref       uuid not null,
  context_key   text not null default 'ad-hoc',
  phase         text not null default 'team'
    check (phase in ('team', 'review', 'synth')),
  state         jsonb not null default '{}'::jsonb,
  status        text not null default 'active'
    check (status in ('active', 'completed', 'cancelled')),
  expires_at    timestamptz not null default (now() + interval '7 days'),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (account_id, run_ref)
);

create index if not exists autonomous_run_checkpoints_resume_idx
  on public.autonomous_run_checkpoints (account_id, user_id, context_key, updated_at desc)
  where status = 'active';

alter table public.autonomous_run_checkpoints enable row level security;

-- No anon/authenticated policies: state includes intermediate model output and source
-- artifacts. Authenticated access is mediated by orchestrate; workers use service_role.
revoke all on table public.autonomous_run_checkpoints from anon, authenticated;

-- A lost HTTP response after synthesis must not create and bill a second final report.
-- The run reference already groups usage; it now also idempotently identifies the output.
alter table public.research_runs add column if not exists run_ref uuid;
create unique index if not exists research_runs_account_run_ref_uidx
  on public.research_runs (account_id, run_ref)
  where run_ref is not null;
