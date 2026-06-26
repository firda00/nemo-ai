-- Phase 2 · Step 1 — agent kinds, detailed settings, departments + memory.
-- Account-scoped via RLS like the rest of the schema (NEMO_AI_SPEC §7).

-- ---------- agents: kind + detailed (optional) settings ----------
-- `type` was added live earlier but never captured in a migration file — make it
-- idempotent here so the file-based migrations are complete.
alter table public.agents add column if not exists type    text not null default 'chat';
alter table public.agents add column if not exists country text;   -- where the business/agent operates
alter table public.agents add column if not exists purpose text;   -- what the agent is used for
alter table public.agents add column if not exists niche   text;   -- industry / sphere (tailors prompts + team)

-- ---------- departments (a manager agent's team of sub-agents) ----------
create table if not exists public.departments (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null default public.current_account_id() references public.accounts(id) on delete cascade,
  main_agent_id uuid references public.agents(id) on delete set null,
  name          text not null default 'Bo''lim',
  niche         text,
  created_at    timestamptz not null default now()
);

create table if not exists public.sub_agents (
  id            uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  account_id    uuid not null default public.current_account_id() references public.accounts(id) on delete cascade,
  role          text not null,                       -- domain role chosen by the manager
  name          text,
  prompt        jsonb not null default '{"role":"","tasks":"","tone":"","rules":""}',
  model         text not null default 'google/gemma-4-31b-it:free',
  status        text not null default 'active',      -- active | paused
  created_at    timestamptz not null default now()
);

-- ---------- agent memory (self-improving agents) ----------
create table if not exists public.agent_memory (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null default public.current_account_id() references public.accounts(id) on delete cascade,
  agent_id    uuid not null references public.agents(id) on delete cascade,
  dialogue_id uuid references public.dialogues(id) on delete set null,
  summary     text not null,
  created_at  timestamptz not null default now()
);

create index if not exists departments_acc_idx  on public.departments (account_id, created_at desc);
create index if not exists sub_agents_dept_idx   on public.sub_agents (department_id);
create index if not exists agent_memory_agent_idx on public.agent_memory (agent_id, created_at desc);

-- ---------- RLS ----------
alter table public.departments  enable row level security;
alter table public.sub_agents   enable row level security;
alter table public.agent_memory enable row level security;

drop policy if exists departments_acc on public.departments;
create policy departments_acc on public.departments for all
  using (account_id = public.current_account_id())
  with check (account_id = public.current_account_id());

drop policy if exists sub_agents_acc on public.sub_agents;
create policy sub_agents_acc on public.sub_agents for all
  using (account_id = public.current_account_id())
  with check (account_id = public.current_account_id());

drop policy if exists agent_memory_acc on public.agent_memory;
create policy agent_memory_acc on public.agent_memory for all
  using (account_id = public.current_account_id())
  with check (account_id = public.current_account_id());
