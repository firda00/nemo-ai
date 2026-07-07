-- Migration to support Multi-Agent Orchestration (MAS)
-- Nemo AI: Moving from single bots to Swarms of Agents

-- 1. Create Swarms table (The container for a multi-agent team)
create table public.swarms (
  id            uuid primary key default gen_random_uuid(),
  account_id   uuid not null references public.accounts(id) on delete cascade,
  name          text not null,
  description   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 2. Update Agents table for Hierarchy
-- We add swarm_id to link agents to a team, and parent_id to create Master -> Sub-agent relations.
alter table public.agents add column if not exists swarm_id uuid references public.swarms(id) on delete cascade;
alter table public.agents add column if not exists parent_id uuid references public.agents(id) on delete set null;
alter table public.agents add column if not exists role text not null default 'specialist'; -- 'master' | 'specialist' | 'reviewer'

-- 3. Link Dialogues to Swarms instead of just single agents
-- This allows the "Brain" to manage the conversation across multiple agents.
alter table public.dialogues add column if not exists swarm_id uuid references public.swarms(id) on delete cascade;

-- 4. Agent Tools table (Capability management)
create table public.agent_tools (
  id         uuid primary key default gen_random_uuid(),
  agent_id   uuid not null references public.agents(id) on delete cascade,
  tool_type  text not null, -- 'web_search' | 'pdf_reader' | 'api_call' | 'database_query'
  config_json jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

-- 5. Enhanced Message tracking for "Traces"
-- We add agent_id to messages so we know exactly which agent in the swarm spoke.
alter table public.messages add column if not exists agent_id uuid references public.agents(id) on delete set null;
alter table public.messages add column if not exists message_type text not null default 'chat'; -- 'chat' | 'system_trace' | 'internal_monologue'

-- 6. Shared Memory / Context for the Swarm
create table public.swarm_context (
  id         uuid primary key default gen_random_uuid(),
  swarm_id   uuid not null references public.swarms(id) on delete cascade,
  dialogue_id uuid not null references public.dialogues(id) on delete cascade,
  key        text not null,
  value      text,
  updated_at timestamptz not null default now(),
  unique(swarm_id, dialogue_id, key)
);

-- ---------- RLS POLICIES ----------
alter table public.swarms enable row level security;
create policy swarms_acc on public.swarms for all
  using (account_id = public.current_account_id())
  with check (account_id = public.current_account_id());

alter table public.agent_tools enable row level security;
create policy tools_acc on public.agent_tools for all
  using (agent_id in (select id from public.agents where account_id = public.current_account_id()));

alter table public.swarm_context enable row level security;
create policy context_acc on public.swarm_context for all
  using (swarm_id in (select id from public.swarms where account_id = public.current_account_id()));

-- Indices for performance
create index on public.agents (swarm_id);
create index on public.agents (parent_id);
create index on public.dialogues (swarm_id);
create index on public.messages (agent_id);
