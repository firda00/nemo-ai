-- Self-evolving agents: the owner sets a GROWTH DIRECTION and the agent improves its own
-- config (role/tasks/tone/rules) toward it, learning from its real conversations. Each
-- evolution is stored (before/after + changelog) as a visible growth log, and can be applied
-- or rolled back. Account-scoped via RLS.
alter table public.agents add column if not exists growth_direction text;
alter table public.agents add column if not exists auto_evolve boolean not null default false;

create table if not exists public.agent_evolutions (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null default public.current_account_id() references public.accounts(id) on delete cascade,
  agent_id      uuid not null references public.agents(id) on delete cascade,
  direction     text,
  summary       text,               -- changelog joined by newlines
  prompt_before jsonb,
  prompt_after  jsonb,
  applied       boolean not null default false,
  created_at    timestamptz not null default now()
);

alter table public.agent_evolutions enable row level security;
drop policy if exists agent_evolutions_acc on public.agent_evolutions;
create policy agent_evolutions_acc on public.agent_evolutions for all
  using (account_id = public.current_account_id())
  with check (account_id = public.current_account_id());

create index if not exists agent_evolutions_agent_idx on public.agent_evolutions (agent_id, created_at desc);
