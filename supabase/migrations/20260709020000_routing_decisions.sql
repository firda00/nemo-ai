-- Routing observability: every intent-router decision (chosen teammate + confidence + whether it
-- resolved) so routing accuracy is MEASURABLE, not a claimed >95%. Accessed via service role only.
create table if not exists public.routing_decisions (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references public.accounts(id) on delete cascade,
  dialogue_id uuid,
  from_agent  uuid,
  to_agent    uuid,
  chosen      text,
  confidence  real,
  resolved    boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists routing_decisions_account_idx on public.routing_decisions(account_id, created_at desc);
alter table public.routing_decisions enable row level security;
