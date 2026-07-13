-- First-party product telemetry, client error monitoring, feedback and safe rollouts.
create table if not exists public.product_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null default public.current_account_id() references public.accounts(id) on delete cascade,
  user_id uuid not null default auth.uid(),
  name text not null check (name ~ '^[a-z0-9_]{2,80}$'),
  path text,
  properties jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists product_events_account_created_idx on public.product_events(account_id, created_at desc);
create index if not exists product_events_name_created_idx on public.product_events(name, created_at desc);

create table if not exists public.client_errors (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null default public.current_account_id() references public.accounts(id) on delete cascade,
  user_id uuid not null default auth.uid(),
  fingerprint text not null,
  message text not null,
  stack text,
  path text,
  browser text,
  created_at timestamptz not null default now()
);
create index if not exists client_errors_account_created_idx on public.client_errors(account_id, created_at desc);

create table if not exists public.customer_feedback (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null default public.current_account_id() references public.accounts(id) on delete cascade,
  user_id uuid not null default auth.uid(),
  rating smallint not null check (rating in (-1, 1)),
  category text not null default 'product' check (category in ('product','agent_result','bug','idea')),
  comment text check (char_length(comment) <= 2000),
  path text,
  agent_id uuid references public.agents(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists customer_feedback_account_created_idx on public.customer_feedback(account_id, created_at desc);

create table if not exists public.feature_flags (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references public.accounts(id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9_]{2,80}$'),
  enabled boolean not null default false,
  rollout_percent smallint not null default 100 check (rollout_percent between 0 and 100),
  description text,
  updated_at timestamptz not null default now()
);
create unique index if not exists feature_flags_scope_key_uidx on public.feature_flags(coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

alter table public.product_events enable row level security;
alter table public.client_errors enable row level security;
alter table public.customer_feedback enable row level security;
alter table public.feature_flags enable row level security;

drop policy if exists product_events_acc on public.product_events;
create policy product_events_acc on public.product_events for all
  using (account_id = public.current_account_id())
  with check (account_id = public.current_account_id() and user_id = auth.uid());
drop policy if exists client_errors_acc on public.client_errors;
create policy client_errors_acc on public.client_errors for all
  using (account_id = public.current_account_id())
  with check (account_id = public.current_account_id() and user_id = auth.uid());
drop policy if exists customer_feedback_acc on public.customer_feedback;
create policy customer_feedback_acc on public.customer_feedback for all
  using (account_id = public.current_account_id())
  with check (account_id = public.current_account_id() and user_id = auth.uid());
drop policy if exists feature_flags_read on public.feature_flags;
create policy feature_flags_read on public.feature_flags for select
  using (account_id is null or account_id = public.current_account_id());

grant select, insert on public.product_events, public.client_errors, public.customer_feedback to authenticated;
grant select on public.feature_flags to authenticated;

insert into public.feature_flags(account_id, key, enabled, rollout_percent, description) values
  (null, 'email_assistant', true, 100, 'Gmail inbox triage and human-approved drafts'),
  (null, 'feedback_agent', true, 100, 'In-product feedback collection'),
  (null, 'governed_evolution', true, 100, 'Guarded agent self-improvement')
on conflict do nothing;
