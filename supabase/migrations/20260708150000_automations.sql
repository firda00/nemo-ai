-- AI-native automations: the Zapier/Make/n8n layer. An automation is a trigger + an ordered
-- chain of steps (agent / http / notify). The novelty: the owner DESCRIBES it in words and an
-- LLM builds the steps. Account-scoped via RLS.
create table if not exists public.automations (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null default public.current_account_id() references public.accounts(id) on delete cascade,
  name        text not null default 'Automation',
  description text,
  trigger     text not null default 'manual',   -- manual | webhook | schedule
  webhook_secret text,                            -- for the incoming webhook trigger
  steps       jsonb not null default '[]',        -- [{type:'agent'|'http'|'notify', ...}]
  enabled     boolean not null default true,
  last_run_at timestamptz,
  last_result jsonb,
  created_at  timestamptz not null default now()
);

alter table public.automations enable row level security;
drop policy if exists automations_acc on public.automations;
create policy automations_acc on public.automations for all
  using (account_id = public.current_account_id())
  with check (account_id = public.current_account_id());
create index if not exists automations_acc_idx on public.automations (account_id, created_at desc);
create index if not exists automations_webhook_idx on public.automations (webhook_secret) where webhook_secret is not null;
